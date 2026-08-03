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
// WHAT IT DOES NOT DO YET: no provider is chosen, so normalizeEvent() below
// handles the common shapes (Postmark, Resend, SendGrid) rather than one
// vendor's exact payload. When the provider is picked, verify its real
// signature scheme here too — most providers sign the raw body, which is
// strictly better than a shared secret in a query string.
//
// ESM handler.

import { safeEqual } from "../../lib/session.js";
import { appendCampaignEvents, suppressEmail } from "../../lib/mailme/store.js";
import { EVENT_TYPES, normalizeEmail } from "../../lib/mailme/schema.js";

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
const TYPE_ALIASES = {
  delivered: "delivered", delivery: "delivered",
  open: "open", opened: "open",
  click: "click", clicked: "click",
  bounce: "bounce", bounced: "bounce", hardbounce: "bounce", "hard_bounce": "bounce",
  complaint: "complaint", spamcomplaint: "complaint", "spam_complaint": "complaint", spamreport: "complaint",
  unsubscribe: "unsubscribe", unsubscribed: "unsubscribe", subscriptionchange: "unsubscribe",
};

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;

  const rawType = String(
    raw.type || raw.event || raw.RecordType || raw.eventType || ""
  ).trim().toLowerCase().replace(/[\s-]+/g, "");

  const type = TYPE_ALIASES[rawType];
  if (!type || !EVENT_TYPES.includes(type)) return null;

  const email = normalizeEmail(
    raw.email || raw.Email || raw.Recipient || raw.recipient || raw.to || ""
  );

  return {
    type,
    campaignId: raw.campaignId || raw.CampaignId || (raw.metadata && raw.metadata.campaignId) || null,
    contactId: raw.contactId || raw.ContactId || (raw.metadata && raw.metadata.contactId) || null,
    email: email || null,
    linkUrl: type === "click" ? (raw.linkUrl || raw.url || raw.OriginalLink || raw.link || null) : null,
    reason: raw.reason || raw.Description || raw.Details || null,
    at: raw.at || raw.timestamp || raw.ReceivedAt || new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!authorized(req)) {
    // Deliberately terse. A detailed error tells a prober whether the secret
    // is set, which is information worth withholding.
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = parseBody(req);
    // Providers send either one event or a batch; accept both.
    const incoming = Array.isArray(body) ? body
      : Array.isArray(body.events) ? body.events
      : [body];

    const normalized = incoming.map(normalizeEvent).filter(Boolean);
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

    return res.status(200).json({
      ok: true,
      stored,
      suppressed: suppressing.length,
      orphaned,
      ignored: incoming.length - normalized.length,
    });
  } catch (e) {
    console.error("mailme webhook error:", e);
    return res.status(500).json({ error: e.message });
  }
}
