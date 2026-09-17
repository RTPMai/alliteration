// PUT IN: lib/reviews/schema.js
// lib/reviews/schema.js: RaveReviews: the review request email after pickup.
//
// WHAT THIS REPLACES. Two Printavo automations ("ZAP> Order Shipped" and
// "ZAP> Order Ready for Pick Up") emailed a Zapier parser when an order hit
// ORDER SHIPPED or PICKED-UP. Zapier looked the invoice up, waited three
// days, and sent the customer a plain text email from Outlook asking for a
// Google review. Nothing remembered who had already reviewed, so a repeat
// customer was asked on every order forever.
//
// PURE. No imports, no Node builtins, no storage. The screen imports this
// file straight into the browser (for the placeholders and defaults) and the
// tests call every rule in it directly. Anything that decides WHETHER an
// email goes out lives here, so the cron, the Send now button and the tests
// all ask the same function and cannot disagree.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "reviews_data";

export const keys = {
  record: (id) => `${KEY_PREFIX}:req:${id}`,
  index: () => `${KEY_PREFIX}:index`,          // sorted set, score = detected time
  queue: () => `${KEY_PREFIX}:queue`,          // set of ids still waiting to send
  seen: () => `${KEY_PREFIX}:seen`,            // hash: printavo invoice id -> first seen
  reviewed: () => `${KEY_PREFIX}:reviewed`,    // hash: email -> { at, by, note }
  lastSent: () => `${KEY_PREFIX}:last_sent`,   // hash: email -> ISO of last request sent
  settings: () => `${KEY_PREFIX}:settings`,
  state: () => `${KEY_PREFIX}:state`,
  lock: (id) => `${KEY_PREFIX}:lock:${id}`,
};

export const STATUSES = ["queued", "sent", "skipped", "cancelled", "failed"];

// A send that errors is retried on the next run. Three strikes and it stops
// and waits for a person, so one bad address cannot fail every run forever.
export const MAX_ATTEMPTS = 3;

export const PLACEHOLDERS = [
  { key: "{first_name}", label: "Customer first name (\"there\" if Printavo has none)" },
  { key: "{visual_id}", label: "Printavo invoice number" },
  { key: "{order_nickname}", label: "Printavo order nickname" },
];

// Word for word from the Zapier step, Sep 17 2026.
export const DEFAULT_SUBJECT = "{visual_id} - {order_nickname}";

export const DEFAULT_BODY = [
  "Hey {first_name},",
  "",
  "We hope you\u2019re enjoying your recent order from P&M Apparel.",
  "",
  "If anything missed the mark, please let us know. We want every order to be right, and we are always happy to fix issues quickly.",
  "",
  "If everything landed the way it should, we would really appreciate a quick Google review. It helps others find us and helps our team keep doing what we do well.",
  "",
  "You can leave a review here:",
  "https://www.google.com/maps/place//data=!4m3!3m2!1s0x87ee82254922cdef:0x555585b24fe33cf9!12e1?source=g.page.m.dd._&laa=lu-desktop-reviews-dialog-review-solicitation",
  "",
  "And if you know someone else who could use custom apparel, referrals from happy customers mean a lot to us.",
  "",
  "Thanks again for choosing P&M Apparel.",
  "",
  "Cheers,",
  "The P&M Apparel Team",
].join("\n");

// The two Printavo statuses the old automations fired on, as they are named
// there. Matching ignores the emoji and case (see normStatus), so these can
// be typed plainly in Settings.
export const DEFAULT_STATUSES = ["ORDER SHIPPED", "PICKED-UP"];

export const DEFAULT_SETTINGS = {
  // OFF until somebody turns it on. Detection still runs and fills the queue,
  // so the first thing anyone sees is what WOULD go out, not what already did.
  enabled: false,
  delayDays: 3,
  fromName: "P&M Apparel",
  fromEmail: "Ryan@pmapparel.com",
  replyTo: "Ryan@pmapparel.com",
  subject: DEFAULT_SUBJECT,
  body: DEFAULT_BODY,
  statuses: DEFAULT_STATUSES.slice(),
  // Repeat customers are asked again on a new order unless they have left a
  // review. This only stops the SAME address getting two in quick succession,
  // which is what two orders picked up the same week would otherwise do.
  // 0 turns it off.
  repeatGapDays: 7,
  // How far back (by Printavo production date) each check looks. Orders do
  // not sit at PICKED-UP forever in a way that matters here; a bounded window
  // keeps each check to a few Printavo calls instead of every invoice ever.
  lookbackDays: 45,
  // Resend's free tier is 100 emails a day, shared with MailMe and PromoPro.
  // Four runs a day at this cap stays under it.
  maxPerRun: 20,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "🙌 PICKED-UP 🙌" and "picked up" are the same status. */
export function normStatus(s) {
  return String(s || "")
    .replace(/[^\x00-\x7F]/g, " ")
    .replace(/[\s\-_]+/g, " ")
    .replace(/[^A-Za-z0-9()%& ]/g, "")
    .trim()
    .toUpperCase();
}

export function isTriggerStatus(name, statuses) {
  const n = normStatus(name);
  if (!n) return false;
  return (statuses || []).some((s) => normStatus(s) === n);
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** Lowercased and trimmed, or "" when it is not an email address at all. */
export function normalizeEmail(e) {
  const v = String(e == null ? "" : e).trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : "";
}

/**
 * First name from what Printavo gives us. A real firstName wins; otherwise the
 * first word of the full name. Returns "" rather than guessing from an email.
 */
export function firstNameOf(contact) {
  const c = contact || {};
  const first = String(c.firstName || "").trim();
  if (first) return first.split(/\s+/)[0];
  const full = String(c.fullName || "").trim();
  return full ? full.split(/\s+/)[0] : "";
}

function fill(template, rec) {
  const first = String((rec && rec.first_name) || "").trim();
  return String(template || "")
    .split("{first_name}").join(first || "there")
    .split("{visual_id}").join(String((rec && rec.visual_id) || "").trim())
    .split("{order_nickname}").join(String((rec && rec.order_nickname) || "").trim());
}

/**
 * The email exactly as the customer gets it. A blank nickname would leave
 * "54781 - " in the subject, so a dangling separator is trimmed off either end.
 */
export function renderEmail(settings, rec) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  let subject = fill(s.subject, rec).replace(/\s+/g, " ").trim();
  subject = subject.replace(/^[\s\-\u2013\u2014:|]+/, "").replace(/[\s\-\u2013\u2014:|]+$/, "").trim();
  if (!subject) subject = "Your recent order from P&M Apparel";
  const text = fill(s.body, rec).replace(/\r\n/g, "\n");
  const name = String(s.fromName || "").replace(/[<>"]/g, "").trim();
  const from = name ? `${name} <${s.fromEmail}>` : s.fromEmail;
  return { from, subject, text, replyTo: s.replyTo || "" };
}

export function sendAfterFor(detectedAtIso, delayDays) {
  const t = new Date(detectedAtIso).getTime();
  const d = Number.isFinite(Number(delayDays)) ? Number(delayDays) : DEFAULT_SETTINGS.delayDays;
  return new Date(t + d * DAY_MS).toISOString();
}

/**
 * One queued request from one Printavo order. `order` is what
 * lib/reviews/printavo.js hands back.
 */
export function buildRecord(order, settings, nowIso) {
  const o = order || {};
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  return {
    id: String(o.invoiceId),
    invoice_id: String(o.invoiceId),
    visual_id: o.visualId != null ? String(o.visualId) : "",
    order_nickname: String(o.nickname || "").trim(),
    customer_name: String(o.fullName || "").trim(),
    first_name: firstNameOf({ firstName: o.firstName, fullName: o.fullName }),
    email: normalizeEmail(o.email),
    email_raw: String(o.email || "").trim(),
    trigger_status: String(o.statusName || "").trim(),
    detected_at: nowIso,
    send_after: sendAfterFor(nowIso, s.delayDays),
    status: "queued",
    sent_at: null,
    message_id: null,
    skip_reason: null,
    skipped_at: null,
    cancelled_at: null,
    cancelled_by: null,
    attempts: 0,
    last_error: null,
    history: [{ at: nowIso, what: "queued", by: "printavo" }],
  };
}

export function isDue(rec, nowMs) {
  return !!rec && rec.status === "queued" && new Date(rec.send_after).getTime() <= nowMs;
}

/**
 * THE SKIP RULES, checked at SEND time, never at intake. A customer who
 * reviews on day two must not get asked on day three because they were
 * queued on day zero.
 *
 * ctx: { reviewed, suppression, lastSent } are maps keyed by lowercased email,
 * plus settings and now (ms). Returns a reason in plain words, or null to send.
 */
export function decideSkip(rec, ctx) {
  const c = ctx || {};
  const s = Object.assign({}, DEFAULT_SETTINGS, c.settings || {});
  const email = normalizeEmail(rec && rec.email);
  if (!email) {
    return rec && rec.email_raw
      ? `The Printavo contact's email is not a usable address (${rec.email_raw})`
      : "No email on the Printavo contact";
  }
  if (c.reviewed && c.reviewed[email]) return "Already left a review";

  const sup = c.suppression && c.suppression[email];
  if (sup) {
    const why = (sup && sup.status) || "unsubscribed";
    return `On MailMe's do not email list (${why})`;
  }

  const gap = Number(s.repeatGapDays) || 0;
  const last = c.lastSent && c.lastSent[email];
  if (gap > 0 && last) {
    const since = (Number(c.now) || Date.now()) - new Date(last).getTime();
    if (since >= 0 && since < gap * DAY_MS) {
      const days = Math.floor(since / DAY_MS);
      const when = days === 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;
      return `Already sent a request to this address ${when}`;
    }
  }
  return null;
}

/**
 * Settings as a whole, judged after the patch is applied, so a request that
 * only mentions one field cannot leave another one broken.
 */
export function validateSettings(patch, current) {
  const base = Object.assign({}, DEFAULT_SETTINGS, current || {});
  const p = patch && typeof patch === "object" ? patch : {};
  const next = Object.assign({}, base);
  const errors = [];

  if ("enabled" in p) next.enabled = p.enabled === true;

  const intIn = (k, lo, hi, label) => {
    if (!(k in p)) return;
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${label} must be a whole number from ${lo} to ${hi}`);
    else next[k] = n;
  };
  intIn("delayDays", 0, 60, "Days to wait");
  intIn("repeatGapDays", 0, 365, "Days between requests to the same address");
  intIn("lookbackDays", 7, 365, "Days to look back in Printavo");
  intIn("maxPerRun", 1, 100, "Emails per run");

  ["fromName", "fromEmail", "replyTo", "subject", "body"].forEach((k) => {
    if (k in p) next[k] = String(p[k] == null ? "" : p[k]);
  });
  next.fromName = next.fromName.replace(/[<>"\r\n]/g, "").trim();
  next.subject = next.subject.replace(/[\r\n]+/g, " ").trim();
  next.body = next.body.replace(/\r\n/g, "\n");

  if ("statuses" in p) {
    const list = Array.isArray(p.statuses) ? p.statuses : String(p.statuses || "").split(/\n|,/);
    const clean = [];
    list.forEach((x) => {
      const raw = String(x || "").trim();
      if (raw && !clean.some((y) => normStatus(y) === normStatus(raw))) clean.push(raw);
    });
    next.statuses = clean;
  }

  if (!normalizeEmail(next.fromEmail)) errors.push("From address must be an email address");
  else if (!/@pmapparel\.com$/i.test(next.fromEmail.trim())) {
    errors.push("From address must be on pmapparel.com, the domain verified in Resend");
  }
  if (next.replyTo && !normalizeEmail(next.replyTo)) errors.push("Reply-to must be an email address or blank");
  if (!next.subject) errors.push("Subject cannot be blank");
  if (!next.body.trim()) errors.push("Email text cannot be blank");
  if (!next.statuses.length) errors.push("At least one Printavo status has to trigger the email");

  next.fromEmail = next.fromEmail.trim();
  next.replyTo = next.replyTo.trim();
  return { ok: errors.length === 0, errors, settings: next };
}

/** Counts for the filter chips. */
export function countByStatus(records) {
  const out = { all: 0 };
  STATUSES.forEach((st) => { out[st] = 0; });
  (records || []).forEach((r) => {
    if (!r) return;
    out.all++;
    if (out[r.status] != null) out[r.status]++;
  });
  return out;
}
