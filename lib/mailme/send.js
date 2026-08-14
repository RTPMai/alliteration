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

import { resendConfigured, sendBatch, sendOne, domainStatus } from "./resend-client.js";
import {
  complianceBlockers, coldDailyCap, applyEligibility,
} from "./audience.js";
import {
  identityForCampaign, selectRecipients, resolveList, COLD_SOURCES, resolveReplyTo, composeFrom, encodeTagValue, listUnsubscribeHeaders,
  campaignSourceConflict, normalizeEmail,
} from "./schema.js";
import { makeToken } from "./unsub-token.js";
import {
  getCampaign, applyCampaignPatch, resolveContacts, getList,
  getSuppression, recordSends, saveSettings, getSettings,
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
export async function sendReadiness(settings, identity) {
  const blockers = complianceBlockers(settings).slice();

  if (!identity) {
    blockers.push({
      field: "identity",
      text: "This campaign has no sending identity. Pick which brand it sends as, or add one in MailMe Settings.",
    });
    return blockers;
  }

  const from = (identity.fromAddress || "").trim();
  if (!from) {
    blockers.push({
      field: `identity.${identity.key}.fromAddress`,
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
  // Plain text keeps the markdown-lite syntax as-written (**bold**, [text]
  // (url), "- item") rather than stripping it — all three read fine as plain
  // text, and stripping them would mean the HTML and text versions no longer
  // say the same thing.
  return footerLines.length ? `${body}\n\n---\n${footerLines.join("\n")}` : body;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * Inline markdown-lite: **bold** and [link text](https://...). Runs AFTER
 * escapeHtml on the surrounding text, so this is matching against already-
 * escaped content — none of *, [, ], (, ) get touched by escapeHtml, so the
 * patterns below still line up correctly. Only http(s) links are honored;
 * anything else (a stray `javascript:` or a malformed URL) is left as plain
 * bracketed text rather than becoming a live link.
 */
function renderInline(escapedText) {
  let out = escapedText.replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>");

  // Explicit [text](url) first, so its URL is already inside an href by the
  // time bare-URL autolinking runs and cannot be matched a second time.
  const linked = [];
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => {
    linked.push(`<a href="${escapeAttr(url)}" style="color:#3a6fb0">${text}</a>`);
    return `\u0000LINK${linked.length - 1}\u0000`;
  });

  // Bare URLs. People paste a link and expect it to be clickable; requiring
  // markdown for the common case is the wrong default.
  //
  // Trailing punctuation is excluded from the match, because a URL at the
  // end of a sentence would otherwise swallow the full stop, and a URL in
  // parentheses would swallow the closing bracket. Both produce a broken
  // link, which is worse than no link.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, (m, before, url) => {
    let tail = "";
    const trailing = url.match(/[.,;:!?)\]]+$/);
    if (trailing) {
      tail = trailing[0];
      url = url.slice(0, -tail.length);
    }
    return `${before}<a href="${escapeAttr(url)}" style="color:#3a6fb0">${url}</a>${tail}`;
  });

  return out.replace(/\u0000LINK(\d+)\u0000/g, (m, i) => linked[Number(i)]);
}

/**
 * The composer is still a plain textarea — no toolbar, no image upload, no
 * template picker — but it now understands three bits of lightweight
 * markdown, which covers the two things people actually ask for (emphasis
 * and a real link) without the cost of a full rich-text editor: **bold**,
 * [link text](https://example.com), and a block of lines starting with
 * "- " becomes a bullet list. Everything else renders as plain paragraphs,
 * same as before.
 */
function renderMarkdownLiteHtml(text) {
  const paragraphs = String(text || "").split(/\n{2,}/);
  return paragraphs.map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const isBulletBlock = lines.length > 0 && lines.every((l) => /^-\s+/.test(l));
    if (isBulletBlock) {
      const items = lines
        .map((l) => `<li>${renderInline(escapeHtml(l.replace(/^-\s+/, "")))}</li>`)
        .join("");
      return `<ul style="margin:0 0 12px 20px;padding:0">${items}</ul>`;
    }
    return `<p style="margin:0 0 12px">${renderInline(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
}

export function buildHtml(campaign, contact, settings, unsubToken) {
  const body = renderMarkdownLiteHtml(personalize(campaign.body, contact));
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
// After this many consecutive runs that sent nothing and failed something,
// the cron stops picking the campaign up. A misconfiguration would
// otherwise retry every 15 minutes forever, burning provider quota and
// filling logs. Pressing Send by hand always runs regardless and clears the
// counter, so a genuine transient outage is one click to resume.
export const MAX_CONSECUTIVE_FAILED_RUNS = 3;

export async function sendCampaign(id, session, opts) {
  const campaign = await getCampaign(id);
  if (!campaign) return { ok: false, reason: "not_found" };
  // "scheduled" is treated like a fresh draft here: a scheduled campaign
  // that hasn't started sending yet gets a fresh eligibility snapshot, same
  // as a draft would. The only difference between draft and scheduled is
  // WHO/WHAT triggers this call — a person pressing Send, vs. the cron in
  // api/mailme/cron-send.js noticing scheduledAt has passed.
  if (!["draft", "scheduled", "sending"].includes(campaign.status)) {
    return { ok: false, reason: "not_sendable", detail: `Campaign is already ${campaign.status}.` };
  }

  const { recipients, missingList, settings } = await recipientsFor(campaign);
  if (missingList) return { ok: false, reason: "missing_list" };

  // Identity first: whether a mixed audience is allowed depends on which
  // domain the campaign is going out over.
  const identity = identityForCampaign(campaign, settings);

  const conflict = campaignSourceConflict(recipients, identity);
  if (conflict) return { ok: false, reason: "source_conflict", detail: conflict };
  const readiness = await sendReadiness(settings, identity);
  if (readiness.length) return { ok: false, reason: "not_ready", blockers: readiness };

  // Build or resume the queue. A fresh draft or scheduled campaign snapshots
  // eligible recipient ids now; a campaign already "sending" continues from
  // what is left.
  let queue;
  let sentIds;
  if (campaign.status === "draft" || campaign.status === "scheduled") {
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

  // The cold ramp is about what is actually being sent, not what the
  // audience setting says. A mixed campaign carrying even one cold prospect
  // takes the cold cap, because that is the conservative number and the
  // whole point of the ramp is protecting the domain.
  const isCold = COLD_SOURCES.includes(campaign.source) ||
    recipients.some((r) => COLD_SOURCES.includes(r.source));
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
  // Contacts whose batch was accepted by Resend, and contacts whose batch
  // was rejected. Kept apart because a rejected contact must NOT be treated
  // as mailed: it stays in the queue for a retry, and it must not count
  // against the frequency cap, or a failed send would silently make someone
  // ineligible for the next real one.
  const sentContacts = [];
  const failedContacts = [];

  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const chunk = toSend.slice(i, i + BATCH_SIZE);
    const messages = chunk.map((contact) => {
      const token = makeToken(contact.id);
      // Reply-To is per RECIPIENT, not per campaign: with the account-manager
      // mode, two people on the same send can have different AMs, and each
      // should reply to their own.
      const replyTo = resolveReplyTo(contact, settings);
      const unsubHeaders = listUnsubscribeHeaders(settings, token);
      return {
        from: composeFrom(identity, contact, settings),
        to: contact.email,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(unsubHeaders ? { headers: unsubHeaders } : {}),
        subject: personalize(campaign.subject, contact),
        html: buildHtml(campaign, contact, settings, token),
        text: buildText(campaign, contact, settings, token),
        // "cid" carries the base64url-encoded contact id. Campaign ids are
        // already MM-00001 style and need no encoding, but they are guarded
        // the same way so a future id format cannot break sending.
        tags: [
          { name: "campaignId", value: encodeTagValue(campaign.id) },
          { name: "cid", value: encodeTagValue(contact.id) },
        ],
      };
    });

    try {
      const sent = await sendBatch(messages);
      results.sent += sent.length || chunk.length;
      sentContacts.push(...chunk);
    } catch (e) {
      results.failed += chunk.length;
      failedContacts.push(...chunk);
      // One message per distinct failure reason. A 100-message batch that
      // fails for one reason should not produce a hundred identical lines.
      if (!results.providerErrors.includes(e.message)) results.providerErrors.push(e.message);
    }
  }

  const newSentIds = sentIds.concat(sentContacts.map((c) => c.id));
  // Only successes touch the frequency cap.
  if (sentContacts.length) await recordSends(sentContacts.map((c) => c.id));

  // Failures go back on the FRONT of the queue so a retry picks them up
  // before moving on to anyone new.
  const stillQueued = failedContacts.map((c) => c.id).concat(remainingIds);

  const done = stillQueued.length === 0;
  const now = new Date().toISOString();

  // A run that sent nothing and failed something is a failed run. Any
  // success at all clears the counter: partial progress means the setup
  // works and something transient hit the rest.
  const priorFailedRuns = (campaign.sendState && campaign.sendState.failedRuns) || 0;
  const failedRuns = (results.sent === 0 && results.failed > 0) ? priorFailedRuns + 1 : 0;

  const patch = {
    status: done ? "sent" : "sending",
    sentAt: done ? (campaign.sentAt || now) : campaign.sentAt,
    sendState: { queue: stillQueued, sentIds: newSentIds, lastRunAt: now, failedRuns },
    // Cleared once real sending has actually started: a "scheduled for X"
    // label would be stale and misleading on a campaign that's already
    // sending or sent, whether it left "scheduled" on time via the cron or
    // early via someone pressing Send manually.
    scheduledAt: null,
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
    remaining: stillQueued.length,
    providerErrors: results.providerErrors,
    failedRuns,
    autoRetryStopped: failedRuns >= MAX_CONSECUTIVE_FAILED_RUNS,
  };
}

/**
 * Send ONE preview copy of a campaign to an arbitrary address (meant to be
 * your own inbox). Deliberately lighter-weight than sendReadiness/
 * sendCampaign: it does NOT check compliance blockers or domain
 * verification, because the whole point is to preview what needs fixing
 * before those are true. It DOES still require a provider connection and a
 * from-address, since without those there's nothing to actually send with.
 *
 * Never touches suppression, the send queue, recipient counts, or campaign
 * status — a test send is not a real send and must leave no trace on any of
 * the numbers a real send would move.
 */
export async function sendTestEmail(campaignId, toEmail) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: "not_found" };

  const to = normalizeEmail(toEmail);
  if (!to) return { ok: false, reason: "invalid_email" };

  const settings = await getSettings();
  const identity = identityForCampaign(campaign, settings);

  const blockers = [];
  if (!resendConfigured()) {
    blockers.push({ field: "provider", text: "No email provider is connected yet (RESEND_API_KEY is not set)." });
  }
  const from = (identity && identity.fromAddress ? identity.fromAddress : "").trim();
  if (!from) {
    blockers.push({
      field: `identity.${identity ? identity.key : "none"}.fromAddress`,
      text: `Set a from-address for ${identity.label} in MailMe Settings before sending a test.`,
    });
  }
  if (blockers.length) return { ok: false, reason: "not_ready", blockers };

  // A synthetic contact so {{first_name}} / {{company_name}} render
  // something sensible in the preview, and so the unsubscribe link is real
  // (if you click it in a test, it unsubscribes this fake id, not a real
  // customer — harmless either way, but worth knowing).
  const previewContact = { id: `test:${to}`, email: to, contact_name: "", company_name: "Test Company" };
  const token = makeToken(previewContact.id);

  // The preview contact has no account manager, so this resolves to the
  // fixed address when one is set and is omitted otherwise. That mirrors
  // what a real recipient with no AM on file would get.
  const testReplyTo = resolveReplyTo(previewContact, settings);

  const message = {
    from: composeFrom(identity, previewContact, settings) || from,
    to,
    ...(testReplyTo ? { reply_to: testReplyTo } : {}),
    subject: `[TEST] ${personalize(campaign.subject, previewContact)}`,
    html: buildHtml(campaign, previewContact, settings, token),
    text: buildText(campaign, previewContact, settings, token),
    tags: [
      { name: "campaignId", value: encodeTagValue(campaign.id) },
      { name: "test", value: "true" },
    ],
  };

  try {
    const result = await sendOne(message);
    return { ok: true, id: result && result.id };
  } catch (e) {
    return { ok: false, reason: "provider_error", detail: e.message };
  }
}
