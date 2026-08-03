// api/mailme/campaigns.js — campaign drafts and results.
//
// GET    -> list campaigns, or ?id=MM-00001 for one with resolved recipients
//           and aggregated RESULTS (opens, clicks, per-link breakdown).
// POST   -> create a draft.
// PATCH  -> edit a draft. Sent campaigns are locked.
// DELETE -> delete a draft. Sent campaigns are never deletable.
//
// SENDING IS NOT WIRED, ON PURPOSE. No send action, no provider client. Three
// things must exist before one real email leaves this app:
//
//   1. A provider account (Postmark / Resend / SendGrid) and its API key.
//   2. TWO authenticated sending domains, one per audience. Cold outreach
//      bounces and draws complaints at rates a client list never does, and
//      mailbox providers score reputation per DOMAIN. Sending cold mail from
//      the domain that also sends quotes and invoices risks putting ordinary
//      customer email in spam folders. See SENDING_IDENTITIES in schema.js.
//   3. The tokenized unsubscribe page and the webhook receiver, since
//      CAN-SPAM requires a working opt-out in every commercial message.
//
// Results are computed from raw events every read rather than stored on the
// campaign: a counter that drifts from its events is a number nobody can
// audit.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import {
  listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  resolveContacts, getList, campaignResults,
} from "../../lib/mailme/store.js";
import {
  validateCampaignPatch, selectRecipients, resolveList,
  computeRates, deliverabilityWarnings, identityForSource, campaignSourceConflict,
} from "../../lib/mailme/schema.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/**
 * Resolve a campaign's audience. A saved list takes precedence over ad-hoc
 * tags; suppression is applied by selectRecipients either way, so no path
 * through this function can return an opted-out address.
 */
async function recipientsFor(campaign) {
  const { contacts } = await resolveContacts();

  if (campaign.listId) {
    const list = await getList(campaign.listId);
    if (!list) return { recipients: [], missingList: true };
    const members = resolveList(list, contacts);
    return { recipients: selectRecipients(members, { source: campaign.source }), list };
  }

  return {
    recipients: selectRecipients(contacts, {
      source: campaign.source,
      segmentTags: campaign.segmentTags,
    }),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;
  if (!(await requireMailMe(sess, res))) return;

  try {
    if (req.method === "GET") {
      const id = req.query && req.query.id;

      if (id) {
        const campaign = await getCampaign(id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });

        const { recipients, list, missingList } = await recipientsFor(campaign);
        const { stats, links } = await campaignResults(id, recipients.length);

        return res.status(200).json({
          campaign,
          list: list || null,
          missingList: !!missingList,
          recipientCount: recipients.length,
          identity: identityForSource(campaign.source),
          conflict: campaignSourceConflict(recipients),
          results: {
            stats,
            links,
            rates: computeRates(stats),
            warnings: deliverabilityWarnings(stats),
          },
        });
      }

      // The list view needs a recipient count per campaign, but not the full
      // event aggregation for each — that stays on the detail read.
      const campaigns = await listCampaigns();
      const { contacts } = await resolveContacts();
      const withCounts = await Promise.all(campaigns.map(async (c) => {
        let recipients;
        if (c.listId) {
          const l = await getList(c.listId);
          recipients = l ? selectRecipients(resolveList(l, contacts), { source: c.source }) : [];
        } else {
          recipients = selectRecipients(contacts, { source: c.source, segmentTags: c.segmentTags });
        }
        return { ...c, recipientCount: recipients.length };
      }));

      return res.status(200).json({ campaigns: withCounts });
    }

    if (!(await canEditMailMe(sess))) {
      return res.status(403).json({ error: "Your role is read-only in MailMe" });
    }

    const refuseSend = (body) => (body.status && body.status !== "draft")
      ? "Sending is not enabled yet. Campaigns can only be saved as drafts."
      : null;

    if (req.method === "POST") {
      const body = parseBody(req);
      const refusal = refuseSend(body);
      if (refusal) return res.status(400).json({ error: refusal });

      const { ok, errors, patch } = validateCampaignPatch(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!patch.subject || !patch.body) {
        return res.status(400).json({ error: "A campaign needs both a subject and a body" });
      }

      const campaign = await createCampaign(patch, sess);
      return res.status(201).json({ ok: true, campaign });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const refusal = refuseSend(body);
      if (refusal) return res.status(400).json({ error: refusal });

      const { ok, errors, patch } = validateCampaignPatch(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const result = await updateCampaign(id, patch);
      if (!result.ok) {
        if (result.reason === "not_found") return res.status(404).json({ error: "Campaign not found" });
        return res.status(409).json({ error: "Only drafts can be edited" });
      }
      return res.status(200).json({ ok: true, campaign: result.campaign });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const result = await deleteCampaign(id);
      if (!result.ok) {
        if (result.reason === "not_found") return res.status(404).json({ error: "Campaign not found" });
        return res.status(409).json({ error: "Sent campaigns cannot be deleted" });
      }
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme campaigns route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
