// api/mailme/campaigns.js — MailMe campaign drafts.
//
// GET    -> list campaigns (newest first), or ?id=MM-00001 for one plus its
//           resolved recipient count.
// POST   -> create a draft.
// PATCH  -> edit a draft (?id= or body id). Sent campaigns are locked.
// DELETE -> delete a draft. Sent campaigns are never deletable.
//
// SENDING IS NOT WIRED, ON PURPOSE. There is no send action here and no
// provider client anywhere in lib/mailme/. Three things must exist before a
// single real email leaves this app, and none of them is code I can write
// unilaterally:
//
//   1. A sending provider account (Postmark / Resend / SendGrid) and its API
//      key in the Vercel environment.
//   2. A sending domain authenticated with SPF, DKIM and DMARC. Sending
//      P&M's customer list from an unauthenticated domain is the fastest
//      way to poison the pmapparel.com sending reputation, which is very
//      hard to undo and affects ordinary business email too, not just
//      marketing.
//   3. A working unsubscribe path — the public tokenized page plus the
//      webhook receiver that records the result — because CAN-SPAM requires
//      a functioning opt-out in every commercial message.
//
// A "preview recipients" count is provided instead, so the segment logic can
// be built and verified against the real roster with zero delivery risk.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import {
  listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  resolveContacts,
} from "../../lib/mailme/store.js";
import {
  validateCampaignPatch, SUPPRESSED_STATUSES, selectRecipients,
} from "../../lib/mailme/schema.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// selectRecipients lives in lib/mailme/schema.js — it is pure, and keeping it
// there lets test/mailme.test.cjs exercise the suppression rule directly
// instead of pattern-matching this file's source.

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
        const { contacts } = await resolveContacts();
        const recipients = selectRecipients(contacts, campaign.segmentTags);
        return res.status(200).json({
          campaign,
          recipientCount: recipients.length,
          suppressedCount: contacts.length - contacts.filter(
            (c) => !SUPPRESSED_STATUSES.includes(c.status)).length,
        });
      }
      return res.status(200).json({ campaigns: await listCampaigns() });
    }

    // Everything past here changes data.
    if (!(await canEditMailMe(sess))) {
      return res.status(403).json({ error: "Your role is read-only in MailMe" });
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      // Reject an explicit send attempt loudly rather than ignoring the
      // field, so nobody believes a campaign went out when it did not.
      if (body.status && body.status !== "draft") {
        return res.status(400).json({
          error: "Sending is not enabled yet. Campaigns can only be saved as drafts.",
        });
      }

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

      if (body.status && body.status !== "draft") {
        return res.status(400).json({
          error: "Sending is not enabled yet. Campaigns can only be saved as drafts.",
        });
      }

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
