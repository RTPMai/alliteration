// lib/mailme/resend-client.js — thin wrapper around Resend's REST API.
//
// Plain fetch(), not the resend npm package: this repo has no build step and
// exactly one real dependency (@vercel/blob), so a hand-rolled client that
// speaks Resend's documented HTTP API directly avoids adding a second one.
//
// RESEND_API_KEY is an env var, never a Settings field. Settings is user-
// editable data in KV; an API key does not belong there, same reasoning as
// every other secret in this repo (SYNC_SECRET, CRON_SECRET, etc.).
//
// FAILS CLOSED: every function throws if the key is missing rather than
// silently no-op-ing, so a misconfigured deploy surfaces immediately instead
// of quietly dropping mail.
//
// ESM. Do NOT convert to module.exports.

const API_BASE = "https://api.resend.com";

export function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function apiKey() {
  const k = process.env.RESEND_API_KEY;
  if (!k) throw new Error("RESEND_API_KEY is not set");
  return k;
}

async function resendFetch(path, opts) {
  const r = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(opts && opts.headers),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || `Resend API error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Send up to 100 emails in one call via Resend's batch endpoint. Each item:
 *   { from, to, subject, html, text, tags, headers, reply_to }
 * Returns Resend's array of { id } results in the same order as input, or
 * throws on a request-level failure (a single bad address inside a batch is
 * reported per-item by Resend, not thrown).
 */
export async function sendBatch(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  if (messages.length > 100) {
    throw new Error("Resend's batch endpoint accepts at most 100 messages per call");
  }
  const result = await resendFetch("/emails/batch", {
    method: "POST",
    body: JSON.stringify(messages),
  });
  return Array.isArray(result && result.data) ? result.data : [];
}

/** Send a single email. Used for the "send a test to myself" path. */
export async function sendOne(message) {
  return resendFetch("/emails", { method: "POST", body: JSON.stringify(message) });
}

/**
 * THE BODY OF A RECEIVED EMAIL, which the webhook does not carry.
 *
 * Resend's inbound webhook (email.received) is metadata ONLY: who it is from,
 * who it was addressed to, the subject, and a list of attachments. The message
 * itself has to be fetched afterwards with the id from the payload.
 *
 * This is not a detail. Without this call a captured vendor reply records the
 * subject and nothing the vendor actually wrote, which is exactly what it did:
 * "the vendor replied" with no way to find out what they said.
 *
 * Returns { text, html, ok, error }. Never throws: a reply we cannot read the
 * body of is still a reply, and losing it because this call failed would be
 * worse than showing the subject alone.
 */
export async function getReceivedEmail(id) {
  const emailId = String(id || "").trim();
  if (!emailId) return { ok: false, text: "", html: "", error: "no email id on the webhook payload" };
  if (!resendConfigured()) return { ok: false, text: "", html: "", error: "RESEND_API_KEY is not set" };

  try {
    const body = await resendFetch(`/emails/receiving/${encodeURIComponent(emailId)}`, { method: "GET" });
    // The payload has been a bare object and a { data: {...} } wrapper at
    // different times in Resend's own examples, so read both rather than
    // depending on which one arrives.
    const d = (body && body.data && typeof body.data === "object") ? body.data : body;
    return {
      ok: true,
      text: typeof (d && d.text) === "string" ? d.text : "",
      html: typeof (d && d.html) === "string" ? d.html : "",
      error: "",
    };
  } catch (e) {
    return { ok: false, text: "", html: "", error: (e && e.message) || String(e) };
  }
}

/**
 * Plain text out of an HTML mail body, for when that is all there is.
 *
 * Deliberately small: strip the parts that are never content, put line breaks
 * where the markup implied them, and unescape the handful of entities that
 * actually turn up. A vendor reply is a paragraph or two, not a newsletter.
 */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * List sending domains and their verification state, so the app can tell
 * Ryan whether mail.pmapparel.com / outreach.pmapparel.com are actually
 * ready to send from, rather than him having to check the Resend dashboard.
 * Returns [] (not a throw) on failure, since this is a status check that
 * should degrade quietly if the API key isn't set yet.
 */
export async function listDomains() {
  if (!resendConfigured()) return [];
  try {
    const result = await resendFetch("/domains", { method: "GET" });
    return Array.isArray(result && result.data) ? result.data : [];
  } catch (e) {
    console.error("[mailme] resend listDomains failed:", e && e.message);
    return [];
  }
}

/**
 * Like listDomains(), but says WHY it came back empty.
 *
 * listDomains() returns [] for "the key is not set", "Resend is down" and
 * "you have no domains" alike. That is fine for a status panel, and wrong
 * for anything that blocks a send on the answer: a Resend outage then looks
 * exactly like an unverified domain, and the app refuses to send with a
 * message that is not true.
 *
 * Existing callers are untouched. This is the version to use when the answer
 * gates an action.
 */
export async function listDomainsResult() {
  if (!resendConfigured()) return { reachable: false, reason: "no API key set", domains: [] };
  try {
    const result = await resendFetch("/domains", { method: "GET" });
    return { reachable: true, reason: "", domains: Array.isArray(result && result.data) ? result.data : [] };
  } catch (e) {
    console.error("[mailme] resend listDomains failed:", e && e.message);
    return { reachable: false, reason: (e && e.message) || "could not reach Resend", domains: [] };
  }
}

/**
 * Verification status ("verified" | "pending" | "not_started" | "failed")
 * for one domain name, or null if Resend doesn't know about it yet.
 *
 * FIXED Aug 2026: the comparison is case-insensitive. Domain names are
 * case-insensitive by spec, Resend stores them lower-cased, and a
 * from-address typed as "someone@PMApparel.com" therefore matched nothing
 * and reported a verified domain as missing.
 */
export async function domainStatus(domainName) {
  const want = String(domainName || "").trim().toLowerCase();
  const domains = await listDomains();
  const d = domains.find((x) => String(x.name || "").trim().toLowerCase() === want);
  return d ? { name: d.name, status: d.status, region: d.region } : null;
}

/**
 * The gating version: distinguishes "not verified" from "could not check".
 * Returns { reachable, found, status }.
 */
export async function domainStatusChecked(domainName) {
  const want = String(domainName || "").trim().toLowerCase();
  const res = await listDomainsResult();
  if (!res.reachable) return { reachable: false, found: false, status: null, reason: res.reason };
  const d = res.domains.find((x) => String(x.name || "").trim().toLowerCase() === want);
  return { reachable: true, found: !!d, status: d ? d.status : null, reason: "" };
}
