// api/mailme/campaigns.js — campaign drafts and results.
//
// GET    -> list campaigns, or ?id=MM-00001 for one with resolved recipients
//           and aggregated RESULTS (opens, clicks, per-link breakdown).
// POST   -> create a draft.
// PATCH  -> edit a draft. Sent campaigns are locked.
// DELETE -> delete a draft. Sent campaigns are never deletable.
//
// SENDING. A campaign only ever leaves draft status through the dedicated
// `action=send` path below, never through a plain PATCH — refuseSend() still
// blocks PATCH/POST from setting status directly, so the only way a real
// email goes out is the explicit send trigger, which re-checks compliance,
// domain verification, and suppression itself right before dispatch (see
// lib/mailme/send.js). Anyone with ordinary MailMe edit access (same gate as
// building and editing a draft) can send, not just superusers — the safety
// property here is the pre-send checks, not restricting who can click the
// button.
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
  applyCampaignPatch, resolveContacts, getList, campaignResults,
} from "../../lib/mailme/store.js";
import {
  validateCampaignPatch, selectRecipients, resolveList,
  computeRates, deliverabilityWarnings, identityForCampaign, campaignSourceConflict,
  identityAudienceWarning, sendingIdentities, COLD_SOURCES,
  SUPPRESSED_STATUSES, SOURCE_LABELS,
} from "../../lib/mailme/schema.js";
import {
  applyEligibility, complianceBlockers, coldDailyCap, OPEN_RATE_CAVEAT, primaryMetric,
} from "../../lib/mailme/audience.js";
import { sendCampaign, sendReadiness, sendTestEmail } from "../../lib/mailme/send.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function sendFailureMessage(result) {
  switch (result.reason) {
    case "not_found": return "Campaign not found";
    case "not_sendable": return result.detail || "This campaign cannot be sent from its current status.";
    case "missing_list": return "The list this campaign points at no longer exists.";
    case "source_conflict": return result.detail;
    case "not_ready": return "This campaign isn't ready to send yet. See the blockers list.";
    case "no_recipients": return "There is nobody left to send this campaign to.";
    default: return "Could not send this campaign.";
  }
}

function testFailureMessage(result) {
  switch (result.reason) {
    case "not_found": return "Campaign not found";
    case "invalid_email": return "That doesn't look like a valid email address.";
    case "not_ready": return "Can't send a test yet. See the blockers list.";
    case "provider_error": return "Resend rejected the test send: " + (result.detail || "unknown error");
    default: return "Could not send a test.";
  }
}

/**
 * Resolve a campaign's audience. A saved list takes precedence over ad-hoc
 * tags; suppression is applied by selectRecipients either way, so no path
 * through this function can return an opted-out address.
 */
/**
 * Why a contact who IS on the list did not make it into the send.
 *
 * selectRecipients drops people silently, which is fine for computing a
 * send but terrible for explaining one: a list of three showing one
 * recipient looks broken. This re-derives each drop so the panel can say
 * which filter removed whom.
 */
function exclusionReason(contact, campaign) {
  if (SUPPRESSED_STATUSES.includes(contact.status)) {
    return contact.status === "unsubscribed"
      ? "Unsubscribed" : `Not mailable (${contact.status})`;
  }
  if (campaign.source && contact.source !== campaign.source) {
    const label = (SOURCE_LABELS[campaign.source] || campaign.source);
    const own = (SOURCE_LABELS[contact.source] || contact.source);
    return `This campaign is going to ${label}, and this contact is a ${own}`;
  }
  const tags = (campaign.segmentTags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (tags.length) return "Does not match the campaign's segment tags";
  return "Excluded by this campaign's audience";
}

async function recipientsFor(campaign) {
  const { contacts, settings } = await resolveContacts();

  let pool;
  let list = null;
  let candidates;
  if (campaign.listId) {
    list = await getList(campaign.listId);
    if (!list) return { recipients: [], held: [], missingList: true, settings };
    candidates = resolveList(list, contacts);
    pool = selectRecipients(candidates, { source: campaign.source });
  } else {
    candidates = contacts;
    pool = selectRecipients(contacts, {
      source: campaign.source,
      segmentTags: campaign.segmentTags,
    });
  }

  // Only meaningful for a LIST: "everyone mailable" minus a filter is not a
  // surprising number, but "my list of three" minus a filter is.
  const inPool = new Set(pool.map((c) => String(c.id)));
  const filteredOut = list
    ? candidates.filter((c) => !inPool.has(String(c.id)))
        .map((c) => ({ ...c, heldReason: exclusionReason(c, campaign) }))
    : [];

  // Suppression has already been applied by selectRecipients and is absolute.
  // Eligibility is the SOFTER layer on top: frequency cap, open quotes,
  // failed verification, and one-email-per-mailbox. Held contacts are
  // returned rather than silently dropped so "why is this person not in my
  // send?" is answerable.
  const { send, held: eligibilityHeld } = applyEligibility(pool, { policy: settings.policy });
  const held = filteredOut.concat(eligibilityHeld);
  return { recipients: send, held, list, settings };
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

        const { recipients, held, list, missingList, settings } = await recipientsFor(campaign);
        const { stats, links } = await campaignResults(id, recipients.length);

        // The cold ramp: a brand-new sending domain must not go from zero to
        // hundreds of cold emails in a day, which is itself a spam signal.
        // Matches lib/mailme/send.js: any cold recipient at all puts the
        // send on the cold ramp, so the plan shown here is the plan used.
        const isCold = COLD_SOURCES.includes(campaign.source) ||
          recipients.some((r) => COLD_SOURCES.includes(r.source));
        const rampDay = settings.coldStartedAt
          ? Math.floor((Date.now() - new Date(settings.coldStartedAt)) / 86400000) : 0;
        const dailyCap = isCold
          ? coldDailyCap(rampDay, settings.policy)
          : settings.policy.clientDailyCap;

        const identity = identityForCampaign(campaign, settings);
        const sendBlockers = await sendReadiness(settings, identity);
        const queueRemaining = campaign.sendState ? campaign.sendState.queue.length : null;

        return res.status(200).json({
          campaign,
          list: list || null,
          missingList: !!missingList,
          recipientCount: recipients.length,
          heldCount: (held || []).length,
          held: (held || []).slice(0, 50),
          identity,
          identities: sendingIdentities(settings),
          identityWarning: identityAudienceWarning(recipients, identity),
          conflict: campaignSourceConflict(recipients, identity),
          // Two blocker lists on purpose: `blockers` is the CAN-SPAM-only set
          // (unchanged shape, still used by Settings' own checklist), while
          // `sendBlockers` is everything that actually stands between this
          // campaign and a real send, including provider/domain readiness.
          blockers: complianceBlockers(settings),
          sendBlockers,
          canSend: sendBlockers.length === 0 && !campaignSourceConflict(recipients, identity) && recipients.length > 0,
          sendPlan: {
            dailyCap,
            isCold,
            rampDay,
            days: dailyCap > 0 ? Math.ceil(recipients.length / dailyCap) : 0,
            queueRemaining,
          },
          results: {
            stats,
            links,
            rates: computeRates(stats),
            warnings: deliverabilityWarnings(stats),
            primary: primaryMetric(stats),
            openRateCaveat: OPEN_RATE_CAVEAT,
          },
        });
      }

      // The list view needs a recipient count per campaign, but not the full
      // event aggregation for each — that stays on the detail read.
      const campaigns = await listCampaigns();
      const { contacts, settings } = await resolveContacts();
      const withCounts = await Promise.all(campaigns.map(async (c) => {
        let recipients;
        if (c.listId) {
          const l = await getList(c.listId);
          recipients = l ? selectRecipients(resolveList(l, contacts), { source: c.source }) : [];
        } else {
          recipients = selectRecipients(contacts, { source: c.source, segmentTags: c.segmentTags });
        }
        const { send } = applyEligibility(recipients, { policy: settings.policy });
        return { ...c, recipientCount: send.length, heldCount: recipients.length - send.length };
      }));

      return res.status(200).json({ campaigns: withCounts });
    }

    if (!(await canEditMailMe(sess))) {
      return res.status(403).json({ error: "Your role is read-only in MailMe" });
    }

    const action = (req.query && req.query.action) || parseBody(req).action;

    const refuseSend = (body) => (body.status && body.status !== "draft")
      ? "Campaigns can only be saved as drafts here. Use the send action to actually send one."
      : null;

    // The ONLY path that can turn a draft into a real send. Gated on the same
    // MailMe edit access as everything else in this file (the canEditMailMe
    // check above already ran) — anyone who can build and edit a campaign can
    // also send it. Real safety comes from sendCampaign() itself re-checking
    // compliance, domain verification and suppression right before dispatch,
    // not from restricting who can press the button.
    if (req.method === "POST" && action === "send") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing campaign id" });

      const result = await sendCampaign(id, sess);
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 409;
        return res.status(status).json({ error: sendFailureMessage(result), reason: result.reason, blockers: result.blockers });
      }
      return res.status(200).json({ ok: true, ...result });
    }

    // A preview copy to one address, deliberately lighter-weight than a real
    // send — see sendTestEmail's own comment for exactly what it skips and
    // why. Never moves a campaign's status, queue, or stats.
    if (req.method === "POST" && action === "test") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      const to = body.to || (req.query && req.query.to);
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      if (!to) return res.status(400).json({ error: "Missing test recipient email" });

      const result = await sendTestEmail(id, to);
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 400;
        return res.status(status).json({ error: testFailureMessage(result), reason: result.reason, blockers: result.blockers });
      }
      return res.status(200).json({ ok: true, id: result.id });
    }

    // Moves a DRAFT to "scheduled" with a future send time. Only a draft can
    // be scheduled (locked the same way a draft is locked from PATCH edits
    // once it's anything else). The actual firing happens later, either via
    // api/mailme/cron-send.js noticing scheduledAt has passed, or via the
    // ordinary send action if someone wants to fire it early.
    if (req.method === "POST" && action === "schedule") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing campaign id" });

      const campaign = await getCampaign(id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      if (campaign.status !== "draft") {
        return res.status(409).json({ error: "Only a draft can be scheduled." });
      }

      const when = new Date(body.scheduledAt);
      if (!body.scheduledAt || isNaN(when.getTime())) {
        return res.status(400).json({ error: "Provide a valid date and time to schedule for." });
      }
      if (when.getTime() <= Date.now()) {
        return res.status(400).json({ error: "Scheduled time must be in the future." });
      }

      const result = await applyCampaignPatch(id, { status: "scheduled", scheduledAt: when.toISOString() });
      return res.status(200).json({ ok: true, campaign: result.campaign });
    }

    // Reverts a scheduled campaign back to a plain, editable draft.
    if (req.method === "POST" && action === "unschedule") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing campaign id" });

      const campaign = await getCampaign(id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      if (campaign.status !== "scheduled") {
        return res.status(409).json({ error: "This campaign isn't scheduled." });
      }

      const result = await applyCampaignPatch(id, { status: "draft", scheduledAt: null });
      return res.status(200).json({ ok: true, campaign: result.campaign });
    }

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
