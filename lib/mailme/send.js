// lib/mailme/send.js — turns a draft campaign into real outgoing email.
//
// This is the file that did not exist while "SENDING IS NOT WIRED" was true
// in api/mailme/campaigns.js. It exists now that a provider (Resend) is
// connected, but it still refuses to send on its own authority: every call
// re-checks compliance, domain verification, and suppression immediately
// before dispatch, because a campaign can sit as a draft for weeks and
// anything could have changed by the time someone presses Send.
//
// DAILY CAPS AND MULTI-DAY SENDS. A cold list or a client list bigger than
// its daily cap cannot go out in one call — see coldDailyCap / clientDailyCap
// in audience.js. sendCampaign() sends AT MOST one day's worth per call and
// persists the remaining queue on the campaign record (sendState.queue), the
// same partial-progress pattern the BackBone ops sync uses for the same
// reason: a call that stops partway must be resumable, not restart from zero.
//
// SUPPRESSION IS RE-CHECKED AT DISPATCH, not just at queue-build time. The
// queue is built once from an eligibility snapshot, but each id in it is
// re-verified against live suppression right before it goes out, because a
// webhook unsubscribe/bounce/complaint can land in the KV store at any
// moment, including mid-send.
//
// ESM. Do NOT convert to module.exports.

import { resendConfigured, sendBatch, domainStatus } from "./resend-client.js";
import {
  complianceBlockers, coldDailyCap, applyEligibility,
} from "./audience.js";
import {
  SENDING_IDENTITIES, identityForSource, selectRecipients, resolveList,
  campaignSourceConflict, normalizeEmail,
} from "./schema.js";
import { makeToken } from "./unsub-token.js";
import {
  getCampaign, applyCampaignPatch, resolveContacts, getList,
  getSuppression, recordSends, saveSettings,
} from "./store.js";

const BATCH_SIZE = 100; // Resend's batch endpoint ceiling.

/**
 * Everything that must be true before ONE email can go out for a given
 * sending identity ("warm" | "cold"). Combines the existing CAN-SPAM
 * blockers with the two things unique to actually dispatching: a real
 * from-address, and the matching domain showing verified in Resend.
 *
 * Async because domain verification is a live check against the Resend API,
 * not something stored locally — a status the app claimed and cached could
 * go stale the moment DNS actually finishes propagating (or breaks).
 */
export async function sendReadiness(settings, identityKey) {
  const blockers = complianceBlockers(settings).slice();
  const identity = SENDING_IDENTITIES[identityKey];

  const from = (settings.fromAddress && settings.fromAddress[identityKey]) || "";
  if (!from.trim()) {
    blockers.push({
      field: `fromAddress.${identityKey}`,
      text: `A from-address is needed for ${identity.label} (${identity.domain}) before it can send. Set it in MailMe Settings.`,
    });
  }

  if (!resendConfigured()) {
    blockers.push({
      field: "provider",
      text: "No email provider is connected yet (RESEND_API_KEY is not set in Vercel).",
    });
  } else {
    const status = await domainStatus(identity.domain);
    if (!status || status.status !== "verified") {
      blockers.push({
        field: "domain",
        text: `${identity.domain} is not verified in Resend yet (status: ${status ? status.status : "not added to Resend"}). ` +
          "Add the DNS records Resend gives you for this domain and wait for it to show verified.",
      });
    }
  }

  return blockers;
}

// ---- Personalization ------------------------------------------------------

function firstName(contact) {
  const n = String((contact && contact.contact_name) || "").trim();
  return n ? n.split(/\s+/)[0] : "";
}

export function personalize(text, contact) {
  return String(text || "")
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName(contact) || "there")
    .replace(/\{\{\s*company_name\s*\}\}/gi, (contact && contact.company_name) || "");
}

/** Plain-text body plus the compliance footer, as Resend's `text` field. */
function buildText(campaign, contact, settings, unsubToken) {
  const body = personalize(campaign.body, contact);
  const who = settings.companyName || settings.fromName || "";
  const a = settings.postalAddress || {};
  const addr = [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode]
    .filter((x) => String(x || "").trim()).join(", ");
  const base = String(settings.unsubscribeUrl || "").replace(/\/+$/, "");
  const footerLines = [];
  if (who || addr) footerLines.push([who, addr].filter(Boolean).join(" \u00b7 "));
  if (base) footerLines.push(`Unsubscribe: ${base}?t=${unsubToken}`);
  return footerLines.length ? `${body}\n\n---\n${footerLines.join("\n")}` : body;
}

/** Very small text-to-html: paragraphs and the footer as a lighter block.
 *  MailMe's composer is plain text, so this is deliberately minimal rather
 *  than a rich HTML editor nobody asked for. */
function buildHtml(campaign, contact, settings, unsubToken) {
  const body = personalize(campaign.body, contact)
    .split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  const who = settings.companyName || settings.fromName || "";
  const a = settings.postalAddress || {};
  const addr = [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode]
    .filter((x) => String(x || "").trim()).join(", ");
  const base = String(settings.unsubscribeUrl || "").replace(/\/+$/, "");
  const footer = `
    <p style="color:#8a94a3;font-size:12px;margin-top:24px">
      ${escapeHtml([who, addr].filter(Boolean).join(" \u00b7 "))}
      ${base ? `<br><a href="${escapeAttr(`${base}?t=${unsubToken}`)}" style="color:#8a94a3">Unsubscribe</a>` : ""}
    </p>`;
  return `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#1c2430">${body}${footer}</div>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ---- Recipient resolution (mirrors api/mailme/campaigns.js GET) -----------

async function recipientsFor(campaign) {
  const { contacts, settings } = await resolveContacts();
  let pool;
  let list = null;
  if (campaign.listId) {
    list = await getList(campaign.listId);
    if (!list) return { recipients: [], held: [], missingList: true, settings };
    pool = selectRecipients(resolveList(list, contacts), { source: campaign.source });
  } else {
    pool = selectRecipients(contacts, { source: campaign.source, segmentTags: campaign.segmentTags });
  }
  const { send, held } = applyEligibility(pool, { policy: settings.policy });
  return { recipients: send, held, list, settings };
}

// ---- Orchestration ----------------------------------------------------

/**
 * Send one day's worth of a campaign. Call again to continue a multi-day
 * cold ramp or a client list bigger than its daily cap; each call is
 * idempotent with respect to the queue (a contact only ever leaves the queue
 * once it has actually been handed to Resend).
 */
export async function sendCampaign(id, session) {
  const campaign = await getCampaign(id);
  if (!campaign) return { ok: false, reason: "not_found" };
  if (!["draft", "sending"].includes(campaign.status)) {
    return { ok: false, reason: "not_sendable", detail: `Campaign is already ${campaign.status}.` };
  }

  const { recipients, missingList, settings } = await recipientsFor(campaign);
  if (missingList) return { ok: false, reason: "missing_list" };

  const conflict = campaignSourceConflict(recipients);
  if (conflict) return { ok: false, reason: "source_conflict", detail: conflict };

  const identity = identityForSource(campaign.source);
  const readiness = await sendReadiness(settings, identity.key);
  if (readiness.length) return { ok: false, reason: "not_ready", blockers: readiness };

  // Build or resume the queue. A fresh draft snapshots eligible recipient
  // ids now; a campaign already "sending" continues from what is left.
  let queue;
  let sentIds;
  if (campaign.status === "draft") {
    queue = recipients.map((r) => r.id);
    sentIds = [];
  } else {
    const state = campaign.sendState || { queue: [], sentIds: [] };
    queue = state.queue.slice();
    sentIds = state.sentIds.slice();
  }

  if (!queue.length) {
    return { ok: false, reason: "no_recipients" };
  }

  const isCold = identity.key === "cold";
  const rampDay = settings.coldStartedAt
    ? Math.floor((Date.now() - new Date(settings.coldStartedAt)) / 86400000) : 0;
  const dailyCap = isCold ? coldDailyCap(rampDay, settings.policy) : settings.policy.clientDailyCap;

  const todayIds = queue.slice(0, Math.max(0, dailyCap));
  const remainingIds = queue.slice(todayIds.length);

  // Re-verify suppression right now, not from the snapshot above, and drop
  // anything no longer eligible (opted out, bounced, or complained since the
  // queue was built) instead of mailing it.
  const suppression = await getSuppression();
  const byId = new Map(recipients.map((r) => [r.id, r]));
  const toSend = todayIds
    .map((cid) => byId.get(cid))
    .filter((c) => c && !suppression[normalizeEmail(c.email)]);
  const skippedSuppressed = todayIds.length - toSend.length;

  const results = { sent: 0, failed: 0, providerErrors: [] };

  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const chunk = toSend.slice(i, i + BATCH_SIZE);
    const messages = chunk.map((contact) => {
      const token = makeToken(contact.id);
      return {
        from: settings.fromAddress[identity.key],
        to: contact.email,
        subject: personalize(campaign.subject, contact),
        html: buildHtml(campaign, contact, settings, token),
        text: buildText(campaign, contact, settings, token),
        tags: [
          { name: "campaignId", value: String(campaign.id) },
          { name: "contactId", value: String(contact.id) },
        ],
      };
    });

    try {
      const sent = await sendBatch(messages);
      results.sent += sent.length || chunk.length;
    } catch (e) {
      results.failed += chunk.length;
      results.providerErrors.push(e.message);
    }
  }

  const newSentIds = sentIds.concat(toSend.map((c) => c.id));
  await recordSends(toSend.map((c) => c.id));

  const done = remainingIds.length === 0;
  const now = new Date().toISOString();

  const patch = {
    status: done ? "sent" : "sending",
    sentAt: done ? (campaign.sentAt || now) : campaign.sentAt,
    sendState: { queue: remainingIds, sentIds: newSentIds, lastRunAt: now },
  };
  await applyCampaignPatch(id, patch);

  if (isCold && !settings.coldStartedAt) {
    await saveSettings({ coldStartedAt: now });
  }

  return {
    ok: true,
    done,
    sentThisRun: results.sent,
    failedThisRun: results.failed,
    skippedSuppressed,
    remaining: remainingIds.length,
    providerErrors: results.providerErrors,
  };
}
