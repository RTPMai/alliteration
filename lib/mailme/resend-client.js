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

/** Verification status ("verified" | "pending" | "not_started" | "failed")
 *  for one domain name, or null if Resend doesn't know about it yet. */
export async function domainStatus(domainName) {
  const domains = await listDomains();
  const d = domains.find((x) => x.name === domainName);
  return d ? { name: d.name, status: d.status, region: d.region } : null;
}
