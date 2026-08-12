// api/websitewidget.js — GA4 site stats for PMApparel.com.
//
// GET only, session-gated to any signed-in user (this is aggregate site
// traffic, not customer or pay data — same access level as ShopStock or
// GivingGauge, not CrewCore-level restricted).
//
// Query params:
//   range=7|30|90   days back, default 30
//   fresh=1         bypass the cache and pull live
//
// Response shape, always:
//   { configured: bool, generatedAt, days, totals, trend, channels, topPages }
// When GA4 isn't configured yet, configured is false and the numeric fields
// are zero/empty rather than invented — the app shows a setup message, not
// fake traffic.

import { requireAuth } from "../lib/session.js";
import { isConfigured, fetchSiteStats } from "../lib/websitewidget/ga4.js";
import { getCached, setCached } from "../lib/websitewidget/store.js";

const ALLOWED_RANGES = [7, 30, 90];

function emptyStats(days) {
  return {
    configured: false,
    generatedAt: new Date().toISOString(),
    days,
    totals: { activeUsers: 0, newUsers: 0, sessions: 0, pageViews: 0 },
    trend: [],
    channels: [],
    topPages: []
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = req.query || {};
  let days = parseInt(query.range, 10);
  if (!ALLOWED_RANGES.includes(days)) days = 30;
  const fresh = query.fresh === "1" || query.fresh === "true";

  if (!isConfigured()) {
    return res.status(200).json(emptyStats(days));
  }

  try {
    if (!fresh) {
      const cached = await getCached(days);
      if (cached) {
        return res.status(200).json({ configured: true, generatedAt: cached.cachedAt, ...cached });
      }
    }

    const stats = await fetchSiteStats(days);
    await setCached(days, stats);
    return res.status(200).json({ configured: true, generatedAt: new Date().toISOString(), ...stats });
  } catch (e) {
    console.error("websitewidget route error:", e);
    // Fail open with a clear flag rather than a 500: a GA4 hiccup shouldn't
    // take the whole dashboard down, and the app can show "temporarily
    // unavailable" from configured:true + an empty payload just as easily
    // as from an HTTP error.
    return res.status(200).json({ ...emptyStats(days), configured: true, error: e.message });
  }
}
