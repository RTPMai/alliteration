// api/mailme/webhook.js — tracking event receiver.
//
// POST from the sending provider. This is the ONLY unauthenticated route in
// MailMe, because the provider's servers cannot hold a shell session cookie.
// It is therefore the only route an outsider can reach, and it is secured by
// a shared secret instead:
//
//   MAILME_WEBHOOK_SECRET   sent as ?secret= or the x-mailme-secret header
//
// FAIL CLOSED, like every other secret check in this repo: the secret must be
// SET before it is compared, or an unset env var would make `undefined ===
// undefined` true and let anyone post fake events. safeEqual from
// lib/session.js is the standard, and it is used here for the same reason it
// exists there: a plain === leaks how many leading characters matched.
//
// Without this guard, anyone who found the URL could forge opens and clicks,
// or worse, forge unsubscribes for customers who never asked to leave.
//
// PROVIDER: Resend. normalizeEvent() reads Resend's actual shape first
// (a "data" wrapper, event type prefixed "email.", recipients in data.to as
// an array, and campaignId/contactId carried as data.tags entries set at
// send time in lib/mailme/send.js) and falls back to the flatter Postmark/
// SendGrid-style shapes so this receiver isn't locked to one vendor if that
// ever changes.
//
// SIGNATURE VERIFICATION: Resend signs webhook bodies via Svix
// (svix-id / svix-timestamp / svix-signature headers) if a signing secret is
// configured in the Resend dashboard. The shared-secret check below (
// MAILME_WEBHOOK_SECRET) is the baseline and stays regardless; Svix
// verification can be layered on top later without changing this file's
// shape, and is worth adding before this domain sends real cold volume.
//
// ESM handler.

import { safeEqual } from "../../lib/session.js";
import {
  appendCampaignEvents, suppressEmail, recordWebhookHeartbeat, lookupSentMessage,
} from "../../lib/mailme/store.js";
import { EVENT_TYPES, normalizeEmail, decodeTagValueStrict } from "../../lib/mailme/schema.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function authorized(req) {
  const expected = process.env.MAILME_WEBHOOK_SECRET;
  // MUST be set. An unset secret denies everything rather than allowing it.
  if (!expected) return false;
  const supplied = (req.headers && req.headers["x-mailme-secret"]) ||
    (req.query && req.query.secret) || "";
  return safeEqual(supplied, expected);
}

// Provider payloads differ in field names but carry the same facts. This maps
// the common shapes onto our own event vocabulary; unknown types are dropped
// rather than stored as junk that would skew aggregation.
//
// Resend's own type strings ("email.delivered", "email.opened", ...) have
// their "email." prefix stripped before this lookup, so they land on the
// same aliases as everyone else's flatter "delivered" / "opened" strings.
const TYPE_ALIASES = {
  sent: "sent",
  delivered: "delivered", delivery: "delivered",
  delayed: "delayed", deliverydelayed: "delayed",
  open: "open", opened: "open",
  click: "click", clicked: "click",
  bounce: "bounce", bounced: "bounce", hardbounce: "bounce", "hard_bounce": "bounce",
  complaint: "complaint", complained: "complaint", spamcomplaint: "complaint", "spam_complaint": "complaint", spamreport: "complaint",
  unsubscribe: "unsubscribe", unsubscribed: "unsubscribe", subscriptionchange: "unsubscribe",
};

/** Pull { campaignId, contactId } out of Resend's tags array, which is how
 *  lib/mailme/send.js attaches them to every outgoing message. */
/**
 * Tags arrive in one of two shapes depending on the provider and, for
 * Resend, on the direction of travel: the SEND api takes an array of
 * { name, value }, but the WEBHOOK payload delivers the same tags as a
 * plain object. Reading only the array form is why events were arriving
 * and being counted as orphaned: the tags were present, just not in the
 * shape this looked for.
 */
function tagsToMap(tags) {
  const out = {};
  if (Array.isArray(tags)) {
    tags.forEach((t) => { if (t && t.name) out[t.name] = t.value; });
  } else if (tags && typeof tags === "object") {
    Object.keys(tags).forEach((k) => { out[k] = tags[k]; });
  }
  return out;
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Resend wraps the actual payload in `data`; other providers (Postmark,
  // SendGrid) send it flat. Fold both into one shape to read from.
  const d = (raw.data && typeof raw.data === "object") ? raw.data : raw;

  const rawType = String(
    raw.type || raw.event || raw.RecordType || raw.eventType || ""
  ).trim().toLowerCase().replace(/^email\./, "").replace(/[\s-]+/g, "");

  const type = TYPE_ALIASES[rawType];
  // EVENT_TYPES doesn't carry "sent" or "delayed" (they're not tracked
  // outcomes, just useful to not misclassify as unknown); only forward the
  // types the rest of the app actually aggregates.
  if (!type || !EVENT_TYPES.includes(type)) return null;

  // Resend's recipient is data.to, an ARRAY (a message can have multiple
  // recipients in general, though this app's own sends are always one-to-
  // one). Other providers send a single string field under various names.
  const toRaw = Array.isArray(d.to) ? d.to[0] : d.to;
  const email = normalizeEmail(
    toRaw || raw.email || raw.Email || raw.Recipient || raw.recipient || ""
  );

  const tags = tagsToMap(d.tags);

  // Tag values are base64url-encoded on the way out (see encodeTagValue in
  // schema.js: Resend rejects the colon in our "source:localId" contact
  // ids). Decode them back so events attribute to the real contact id that
  // the rest of the app uses. The plain-text fallbacks stay for any other
  // provider shape, and for events sent before the encoding existed.
  const decodedCampaign = tags.campaignId ? decodeTagValueStrict(tags.campaignId) : null;
  const decodedContact = tags.cid ? decodeTagValueStrict(tags.cid) : null;

  return {
    type,
    // Kept so an event whose tags did not survive can still be attributed
    // via the message index written at send time.
    messageId: d.email_id || d.id || raw.email_id || null,
    campaignId: decodedCampaign || tags.campaignId || raw.campaignId || raw.CampaignId || (raw.metadata && raw.metadata.campaignId) || null,
    contactId: decodedContact || tags.contactId || raw.contactId || raw.ContactId || (raw.metadata && raw.metadata.contactId) || null,
    email: email || null,
    linkUrl: type === "click" ? (d.link || raw.linkUrl || raw.url || raw.OriginalLink || null) : null,
    reason: (d.bounce && d.bounce.message) || raw.reason || raw.Description || raw.Details || null,
    at: raw.created_at || d.created_at || raw.at || raw.timestamp || raw.ReceivedAt || new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // A GET with the right secret is a REACHABILITY TEST you can run from a
  // browser address bar. It proves three things at once that were otherwise
  // impossible to separate: the URL resolves, the deploy is live, and the
  // secret matches. Without it, "no call has ever been received" could mean
  // the provider is not calling OR that it is calling something that never
  // reaches this code, and there was no way to tell which.
  //
  // Recorded as a reachability check, never as event data, so it cannot be
  // mistaken for the provider working.
  if (req.method === "GET") {
    if (!authorized(req)) {
      await recordWebhookHeartbeat({
        ok: false,
        test: true,
        reason: "A browser test reached this endpoint but the secret did not match.",
      });
      return res.status(401).json({ error: "Unauthorized" });
    }
    await recordWebhookHeartbeat({
      ok: true,
      test: true,
      stored: 0,
      reason: "Reachability test passed: the URL and secret are correct. This was a manual browser check, not a real provider event.",
    });
    return res.status(200).json({
      ok: true,
      message: "MailMe webhook is reachable and the secret is correct. Real events must be POSTed.",
    });
  }

  if (req.method !== "POST") {
    // Recorded too: something is calling with the wrong method, which is a
    // different fault from nothing calling at all.
    await recordWebhookHeartbeat({
      ok: false,
      reason: `A ${req.method} request arrived. Webhook events must be POSTed.`,
    });
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!authorized(req)) {
    // Recorded, because a rejected call is the single most useful thing to
    // know when Results stays empty: it proves the provider IS configured
    // and calling, and narrows the fault to the secret. The RESPONSE stays
    // terse either way, since telling a prober whether the secret is set is
    // information worth withholding.
    await recordWebhookHeartbeat({
      ok: false,
      reason: process.env.MAILME_WEBHOOK_SECRET
        ? "A call arrived but the secret did not match. Check the secret in the provider's webhook URL against MAILME_WEBHOOK_SECRET in Vercel."
        : "A call arrived but MAILME_WEBHOOK_SECRET is not set in Vercel, so everything is rejected.",
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = parseBody(req);
    // Providers send either one event or a batch; accept both.
    const incoming = Array.isArray(body) ? body
      : Array.isArray(body.events) ? body.events
      : [body];

    const normalized = incoming.map(normalizeEvent).filter(Boolean);

    // Anything the tags could not identify gets a second chance against the
    // message index. Tags are the fast path; this is the reliable one.
    for (const e of normalized) {
      if (e.campaignId || !e.messageId) continue;
      const hit = await lookupSentMessage(e.messageId);
      if (hit) {
        e.campaignId = hit.campaignId;
        if (!e.contactId) e.contactId = hit.contactId;
      }
    }
    if (!normalized.length) return res.status(200).json({ ok: true, stored: 0, ignored: incoming.length });

    // Group by campaign so each campaign key is written once, not once per
    // event. A batch of 500 opens should be a couple of writes, not 500.
    const byCampaign = new Map();
    let orphaned = 0;

    for (const e of normalized) {
      if (!e.campaignId) { orphaned++; continue; }
      if (!byCampaign.has(e.campaignId)) byCampaign.set(e.campaignId, []);
      byCampaign.get(e.campaignId).push(e);
    }

    let stored = 0;
    for (const [campaignId, events] of byCampaign) {
      stored += await appendCampaignEvents(campaignId, events);
    }

    // SUPPRESSION IS APPLIED IMMEDIATELY, not on the next sync. An
    // unsubscribe that only takes effect later is an unsubscribe that can be
    // violated by a send in between. Bounces and complaints suppress too:
    // continuing to mail a hard-bounced address is what gets a sending
    // domain blocked.
    const suppressing = normalized.filter(
      (e) => ["unsubscribe", "bounce", "complaint"].includes(e.type) && e.email);

    for (const e of suppressing) {
      const status = e.type === "unsubscribe" ? "unsubscribed"
        : e.type === "bounce" ? "bounced" : "complained";
      await suppressEmail(e.email, { status, reason: e.reason, by: "provider-webhook" });
    }

    const summary = {
      ok: true,
      stored,
      suppressed: suppressing.length,
      orphaned,
      ignored: incoming.length - normalized.length,
    };

    await recordWebhookHeartbeat({
      ...summary,
      // "Received but stored nothing" is its own failure mode, worth being
      // able to see: events arriving with no campaign tag, or of a type
      // this app does not track.
      reason: stored === 0
        ? `Received ${incoming.length} event(s) but stored none (${orphaned} with no campaign tag, ${incoming.length - normalized.length} of an untracked type).`
        : null,
      types: normalized.map((e) => e.type),
    });

    return res.status(200).json(summary);
  } catch (e) {
    console.error("mailme webhook error:", e);
    // Recorded, or a crash mid-processing would look identical to never
    // being called: the provider would be retrying against a 500 and the
    // app would still report silence.
    await recordWebhookHeartbeat({
      ok: false,
      reason: `A call arrived and was authorized, but processing failed: ${e.message}`,
    });
    return res.status(500).json({ error: e.message });
  }
}
