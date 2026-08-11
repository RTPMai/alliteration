// lib/rate-limit.js — small shared Upstash-backed rate limiter.
//
// Used to slow down two things: brute-forcing a login password, and spamming
// the public donation intake webhook. Not a WAF, just a cheap trip-wire —
// track hits against a key over a fixed window, refuse once the count is
// too high.
//
// FIXED WINDOW, not sliding. Simple, and good enough for this purpose: worst
// case someone gets two windows' worth of attempts back to back at the
// boundary, which is not meaningfully different from raising the limit a
// bit. A sliding-window or token-bucket scheme would be more precise and is
// not worth the extra complexity here.
//
// FAILS OPEN. If Upstash is unreachable, isRateLimited() returns false (not
// limited) rather than throwing. The alternative — locking everyone out
// because the rate limiter itself is down — is worse than the brute-force
// risk this exists to reduce, especially since login already depends on the
// same KV instance to read user records; if KV is down, login fails on its
// own regardless of what this returns.
//
// ESM. Do NOT convert to module.exports.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PREFIX = "alliteration:ratelimit:";

async function pipeline(commands) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Redis pipeline failed: ${r.status}`);
  return r.json();
}

/**
 * Increment the counter under `key` and return the new count. On the counter's
 * first increment in a fresh window, sets it to expire after `windowSeconds`.
 *
 * Throws if KV isn't configured or the request fails — callers should treat
 * that as "couldn't check, decide what to do" rather than call this directly
 * for a pass/fail answer. Use isRateLimited() for that.
 */
export async function bump(key, windowSeconds) {
  if (!KV_URL || !KV_TOKEN) throw new Error("Storage not configured");
  const full = PREFIX + key;

  const [incrResult] = await pipeline([["INCR", full]]);
  const count = Number(incrResult && incrResult.result);

  if (count === 1) {
    // First hit — start the clock. If two requests race here and both see
    // count===1, EXPIRE just gets set twice to the same value; harmless.
    await pipeline([["EXPIRE", full, String(windowSeconds)]]);
  }

  return Number.isFinite(count) ? count : 0;
}

/**
 * True if `key` has been hit more than `max` times in the last `windowSeconds`.
 * Fails OPEN (returns false) if the rate-limit check itself can't run.
 */
export async function isRateLimited(key, max, windowSeconds) {
  try {
    const count = await bump(key, windowSeconds);
    return count > max;
  } catch (e) {
    console.warn("[rate-limit] check failed, failing open:", e.message);
    return false;
  }
}

/**
 * Clear a key's counter early — e.g. after a successful login, so a few
 * mistyped passwords right before the right one don't count against the
 * user later in the same window.
 */
export async function resetKey(key) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await pipeline([["DEL", PREFIX + key]]);
  } catch (e) {
    console.warn("[rate-limit] reset failed (non-fatal):", e.message);
  }
}
