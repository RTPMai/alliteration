// lib/websitewidget/store.js — short-lived cache for GA4 pulls.
//
// The Data API is rate-limited and a dashboard load fires four reports at
// once (see lib/websitewidget/ga4.js), so every page view re-fetching live
// is wasteful for data that only changes hour to hour anyway. Cache the
// shaped result in KV for a few minutes; ?fresh=1 bypasses it, same
// convention as BackBone's ops sync.
//
// Own key prefix, same direct-fetch-to-Upstash approach as lib/kv.js, kept
// separate rather than sharing lib/kv.js's `keys` object since that one is
// scoped to shell users/roles.

const PREFIX = "websitewidget_data:";
const TTL_SECONDS = 10 * 60; // 10 minutes

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

function cacheKey(days) {
  return `${PREFIX}stats:${days}`;
}

export async function getCached(days) {
  const cfg = config();
  if (!cfg) return null; // fail open: no KV configured just means no cache, not an error

  try {
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(cacheKey(days))}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      cache: "no-store"
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.result == null) return null;
    const parsed = typeof body.result === "string" ? JSON.parse(body.result) : body.result;
    if (!parsed || !parsed.cachedAt) return null;
    const ageSeconds = (Date.now() - new Date(parsed.cachedAt).getTime()) / 1000;
    if (ageSeconds > TTL_SECONDS) return null;
    return parsed;
  } catch (e) {
    return null; // a corrupt or unreachable cache should never block a fresh pull
  }
}

export async function setCached(days, stats) {
  const cfg = config();
  if (!cfg) return;

  const payload = { ...stats, cachedAt: new Date().toISOString() };
  try {
    await fetch(`${cfg.url}/set/${encodeURIComponent(cacheKey(days))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // Caching is a speed optimization, not a correctness requirement — a
    // failed write here should never surface as an error to the caller.
  }
}
