// api/websitewidget/stats.js — GA4 site stats, for whichever site is requested.
//
// Lives alongside api/websitewidget/sites.js rather than as a flat
// api/websitewidget.js: Vercel treats a file and a same-named folder as a
// route conflict once the .js extension is stripped (both would resolve to
// /api/websitewidget), so once a second route was needed, the folder form
// is the only one that works. Every other multi-route app in this repo
// (MailMe, CrewCore, TravelTrack) already follows this shape.
//
// GET only, session-gated to any signed-in user (this is aggregate site
// traffic, not customer or pay data — same access level as ShopStock or
// GivingGauge, not CrewCore-level restricted).
//
// Query params:
//   site=<id>       which configured site (see lib/websitewidget/sites-store.js).
//                    Required once more than one site exists; if omitted and
//                    exactly one site is configured, that one is used.
//   range=7|30|90   days back, default 30
//   compare=none|previous|year
//                    add a comparison period. "previous" is the matching
//                    window immediately before; "year" is the same window
//                    52 weeks back, so weekdays line up. Default none.
//   fresh=1         bypass the cache and pull live
//
// Response shape, always:
//   { configured, siteId, generatedAt, days, compare, period, priorPeriod,
//     totals, priorTotals, deltas, trend, priorTrend, channels, topPages }
// Every window ends YESTERDAY, not today. A part-day measured against a
// full one is not a comparison, it is a fake decline. See periodWindows()
// in lib/websitewidget/ga4.js.
// configured is false when the shared GA4 service account isn't set up yet,
// OR when no sites have been added yet. Either way the numeric fields are
// zero/empty rather than invented — the app shows a setup message, not fake
// traffic. A per-site GA4 error (e.g. the service account was never granted
// access on that property) is reported via `error`, not by inventing zeros
// silently: configured stays true so the dashboard shell renders, but the
// message explains what to fix.

import { requireAuth } from "../../lib/session.js";
import { isConfigured, fetchSiteStats, COMPARE_MODES, periodWindows, BREAKDOWNS } from "../../lib/websitewidget/ga4.js";
import { getSites, getSite } from "../../lib/websitewidget/sites-store.js";
import { getCached, setCached } from "../../lib/websitewidget/store.js";

const ALLOWED_RANGES = [7, 30, 90];

function emptyStats(siteId, days, compare = "none") {
  const windows = periodWindows(days, compare);
  return {
    configured: false,
    siteId: siteId || null,
    generatedAt: new Date().toISOString(),
    days,
    compare,
    period: windows.current,
    priorPeriod: windows.prior,
    totals: { activeUsers: 0, newUsers: 0, sessions: 0, pageViews: 0 },
    priorTotals: null,
    deltas: null,
    engagement: null,
    priorEngagement: null,
    engagementDeltas: null,
    trend: [],
    priorTrend: null,
    failed: {},
    // Every breakdown the catalogue defines gets an empty array, so the view
    // never has to guard against a missing key. Driven off BREAKDOWNS rather
    // than listed by hand, so a new card cannot be forgotten here.
    ...Object.fromEntries(Object.keys(BREAKDOWNS).map((n) => [n, []]))
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
  const compare = COMPARE_MODES.includes(query.compare) ? query.compare : "none";

  if (!isConfigured()) {
    return res.status(200).json(emptyStats(query.site, days, compare));
  }

  let sites;
  try {
    sites = await getSites();
  } catch (e) {
    console.error("websitewidget sites lookup error:", e);
    return res.status(200).json({ ...emptyStats(query.site, days, compare), configured: true, error: e.message });
  }

  if (!sites.length) {
    return res.status(200).json(emptyStats(query.site, days, compare));
  }

  let siteId = query.site;
  if (!siteId) {
    // No site specified: fine when there is exactly one, ambiguous otherwise.
    if (sites.length === 1) {
      siteId = sites[0].id;
    } else {
      return res.status(400).json({ error: "Multiple sites configured; a ?site= id is required", sites: sites.map((s) => s.id) });
    }
  }

  const site = sites.find((s) => s.id === siteId);
  if (!site) {
    return res.status(404).json({ error: `Unknown site "${siteId}"` });
  }

  try {
    if (!fresh) {
      const cached = await getCached(site.id, days, compare);
      if (cached) {
        return res.status(200).json({ configured: true, siteId: site.id, generatedAt: cached.cachedAt, ...cached });
      }
    }

    const stats = await fetchSiteStats(site.propertyId, days, compare);
    await setCached(site.id, days, stats, compare);
    return res.status(200).json({ configured: true, siteId: site.id, generatedAt: new Date().toISOString(), ...stats });
  } catch (e) {
    console.error("websitewidget route error:", e);
    // Fail open with a clear flag rather than a 500: a GA4 hiccup (or a site
    // that hasn't been granted Viewer access yet) shouldn't take the whole
    // dashboard down. configured stays true and the message says what's wrong.
    return res.status(200).json({ ...emptyStats(site.id, days, compare), configured: true, error: e.message });
  }
}
