// test/websitewidget.test.cjs
/**
 * WebsiteWidget contract tests.
 *
 * Covers: the app follows the shell's app contract, the seam rule (no direct
 * fetch()), the registry is un-stubbed correctly, tokens.css carries the
 * theme block, the API route authenticates and always answers cleanly
 * (never invents numbers when GA4 isn't configured), and the GA4 client
 * fails closed rather than throwing when env vars are absent.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const app = read('apps/websitewidget.js');
const apiRoute = read('api/websitewidget/stats.js');
const ga4 = read('lib/websitewidget/ga4.js');
const store = read('lib/websitewidget/store.js');
const registry = read('js/registry.js');
const apiJs = read('js/api.js');
const tokens = read('css/tokens.css');

/* ---- app contract -------------------------------------------------------- */

t.test('apps/websitewidget.js exists and follows the app contract', () => {
  ['export default', "id: 'websitewidget'", 'mount', 'showView', 'styles:', 'template:']
    .forEach((k) => t.assert(app.includes(k), 'apps/websitewidget.js is missing ' + k));
});

t.test('websitewidget fetches through the seam, never fetch() directly', () => {
  // shell.test.cjs already scans every app file (comments stripped) for a
  // real fetch() call; this just confirms the seam call itself is present.
  t.assert(app.includes('ctx.api.get(ENDPOINTS.wwStats'),
    'the dashboard must load through ctx.api with ENDPOINTS.wwStats');
});

t.test('websitewidget scopes DOM lookups to its root', () => {
  t.assert(/const \$ = \(sel\) => root\.querySelector\(sel\)/.test(app),
    'DOM lookups must be scoped to ctx.root, not document, since several apps mount at once');
});

t.test('websitewidget shows a plain setup notice, not invented numbers, when unconfigured', () => {
  t.assert(app.includes('data.configured'), 'the view must branch on the configured flag');
  t.assert(app.includes("Not connected yet") || app.includes("isn't wired up"),
    'an unconfigured GA4 state should say so plainly, not render zeros as if they were real');
});

/* ---- registry ------------------------------------------------------------- */

t.test('websitewidget registry entry is no longer a stub', () => {
  const block = registry.slice(registry.indexOf("id: 'websitewidget'"), registry.indexOf("id: 'websitewidget'") + 1300);
  t.assert(/stub:\s*false/.test(block), 'websitewidget should be un-stubbed now that it is built');
  t.assert(!/stubNote:/.test(block), 'a live app should not still carry a stubNote');
});

t.test('websitewidget has a Manage Sites view alongside Dashboard', () => {
  const block = registry.slice(registry.indexOf("id: 'websitewidget'"), registry.indexOf("id: 'websitewidget'") + 1300);
  t.assert(/\['settings',\s*'Manage Sites'\]/.test(block),
    'the registry should declare a settings view for adding/editing sites');
});

t.test('websitewidget keeps its confirmed accent color', () => {
  const block = registry.slice(registry.indexOf("id: 'websitewidget'"), registry.indexOf("id: 'websitewidget'") + 400);
  t.assert(block.includes('#00BBB4'), 'websitewidget accent should stay the confirmed teal from the logo file');
});

t.test('tokens.css themes websitewidget', () => {
  t.assert(tokens.includes('body[data-app="websitewidget"]'),
    'css/tokens.css has no theme block for websitewidget');
});

/* ---- seam / ENDPOINTS ------------------------------------------------------ */

t.test('js/api.js exposes ENDPOINTS.wwStats and routes it live', () => {
  t.assert(/wwStats:\s*'\/api\/websitewidget\/stats'/.test(apiJs),
    'ENDPOINTS.wwStats must point at /api/websitewidget/stats');
  t.assert(/LIVE_PREFIXES\s*=\s*\[[\s\S]*?'\/api\/websitewidget\/'[\s\S]*?\]/.test(apiJs),
    '/api/websitewidget/ must be listed in LIVE_PREFIXES or the app will silently mock forever');
});

t.test('no flat api/websitewidget.js exists alongside the api/websitewidget/ folder', () => {
  // The exact bug this guards against: Vercel treats a file and a
  // same-named folder as the SAME route once the .js is stripped, so
  // api/websitewidget.js + api/websitewidget/sites.js fails to deploy with
  // "conflicting paths." Both routes must live inside the folder.
  t.assert(!exists('api/websitewidget.js'),
    'a flat api/websitewidget.js has come back — it will collide with the api/websitewidget/ folder and fail to deploy');
  t.assert(exists('api/websitewidget/stats.js'), 'api/websitewidget/stats.js is missing');
});

t.test('websitewidget has a MOCK shape so offline dev still works', () => {
  t.assert(apiJs.includes('[ENDPOINTS.wwStats]:'), 'MOCK_DATA needs a shape for ENDPOINTS.wwStats');
});

t.test('the hub sample-data banner tracks websitewidget too', () => {
  t.assert(/websitewidget:\s*\[ENDPOINTS\.wwStats\]/.test(apiJs),
    'appsOnSampleData should include websitewidget so the banner is accurate before GA4 is configured');
});

/* ---- API route ------------------------------------------------------------- */

t.test('api/websitewidget/stats.js requires a session', () => {
  t.assert(apiRoute.includes('requireAuth'), 'the route must call requireAuth, same as every other app route');
});

t.test('api/websitewidget/stats.js is GET only', () => {
  t.assert(/req\.method !== ["']GET["']/.test(apiRoute), 'non-GET requests should be rejected');
});

t.test('api/websitewidget/stats.js always answers cleanly, even before GA4 is configured', () => {
  t.assert(apiRoute.includes('isConfigured()'), 'the route must check isConfigured() before calling GA4');
  t.assert(/status\(200\)\.json\(emptyStats/.test(apiRoute),
    'an unconfigured GA4 should return a normal 200 with configured:false, not an error');
});

t.test('api/websitewidget/stats.js fails open on a GA4 error rather than 500ing the dashboard', () => {
  t.assert(/catch\s*\(e\)/.test(apiRoute), 'the route must catch GA4 failures');
  t.assert(/status\(200\)\.json\(\{\s*\.\.\.emptyStats/.test(apiRoute),
    'a GA4 error should still answer 200 with an empty read, not take the dashboard down');
});

t.test('api/websitewidget/stats.js caches through the shared store, not ad hoc', () => {
  t.assert(apiRoute.includes('getCached') && apiRoute.includes('setCached'),
    'the route should read/write through lib/websitewidget/store.js');
  t.assert(apiRoute.includes("fresh === '1'") || apiRoute.includes('fresh ='),
    '?fresh=1 should be able to bypass the cache, matching the ops sync convention');
});

t.test('the dashboard can actually reach the cache bypass', () => {
  // The API honouring fresh=1 is only half of it. For a long time the route
  // supported the bypass, loadStats() took a `fresh` argument, and every
  // single call site passed false, so there was no way to force a live pull
  // from the screen. That gap only showed itself when a site's GA4 property
  // id was corrected and the dashboard kept serving the stale answer for ten
  // minutes with no way out. So this pins the whole chain, not just the end
  // of it: a control exists, and something passes true.
  t.assert(/id="wwRefresh"/.test(app),
    'the dashboard needs a refresh control');
  t.assert(/loadStats\(true\)/.test(app),
    'something must call loadStats(true); a fresh flag nothing ever sets is not a feature');
  t.assert(/params\.fresh = '1'/.test(app),
    'loadStats must translate that flag into the fresh=1 the route reads');
});

/* ---- GA4 client ------------------------------------------------------------- */

t.test('lib/websitewidget/ga4.js exists and exposes isConfigured + fetchSiteStats', () => {
  t.assert(exists('lib/websitewidget/ga4.js'), 'lib/websitewidget/ga4.js is missing');
  ['export function isConfigured', 'export async function fetchSiteStats']
    .forEach((k) => t.assert(ga4.includes(k), 'lib/websitewidget/ga4.js is missing ' + k));
});

t.test('ga4.js never throws just from missing env vars', () => {
  t.assert(/if \(!clientEmail \|\| !privateKey\) return null/.test(ga4),
    'creds() must return null rather than throw when env vars are unset, so isConfigured() can answer false cleanly');
});

t.test('ga4.js no longer ties a property id to the shared service account', () => {
  t.assert(!ga4.includes('GA4_PROPERTY_ID'),
    'the property id moved to lib/websitewidget/sites-store.js — ga4.js should only read the two shared credential env vars');
  t.assert(/fetchSiteStats\(propertyId/.test(ga4),
    'fetchSiteStats should take propertyId as a parameter, not read a single env var');
});

t.test('ga4.js unescapes a literal backslash-n in the pasted private key', () => {
  t.assert(ga4.includes("replace(/\\\\n/g"),
    'a private key pasted with escaped newlines (common in Vercel env var UI) must be unescaped before signing');
});

t.test('ga4.js signs with RS256 via built-in crypto, no new dependency', () => {
  t.assert(ga4.includes('RSA-SHA256'), 'the JWT assertion must be signed with RSA-SHA256');
  t.assert(!/require\(['"]jsonwebtoken['"]\)/.test(ga4) && !ga4.includes("from 'googleapis'"),
    'no new npm dependency should be needed for this: Node crypto module signs RS256 natively');
});

t.test('ga4.js requests read-only analytics scope only', () => {
  t.assert(ga4.includes('analytics.readonly'),
    'the service account should only ever request the read-only scope');
});

/* ---- KV cache ------------------------------------------------------------- */

/* ---- KV cache ------------------------------------------------------------- */

t.test('lib/websitewidget/store.js fails open when KV is not configured', () => {
  t.assert(store.includes('if (!cfg) return null'), 'getCached must return null, not throw, when KV is unset');
  t.assert(/if \(!cfg\) return;/.test(store), 'setCached must no-op, not throw, when KV is unset');
});

t.test('lib/websitewidget/store.js uses its own key prefix, not the shell users/roles one', () => {
  t.assert(store.includes('websitewidget_data:'), 'the cache should live under its own prefix, matching the other apps data namespaces');
});

// Superseded a regex over the source of store.js. Grepping for the shape of
// a key proves the letters are in the file, not that two different requests
// get two different keys. This calls the real function.
// (Real assertions live in the async block at the bottom of this file.)

/* ---- multi-site sites store ------------------------------------------------ */

const sitesStore = read('lib/websitewidget/sites-store.js');

t.test('lib/websitewidget/sites-store.js exists and exposes the full CRUD set', () => {
  t.assert(exists('lib/websitewidget/sites-store.js'), 'lib/websitewidget/sites-store.js is missing');
  ['export async function getSites', 'export async function getSite', 'export async function addSite',
    'export async function updateSite', 'export async function deleteSite']
    .forEach((k) => t.assert(sitesStore.includes(k), 'lib/websitewidget/sites-store.js is missing ' + k));
});

t.test('sites-store migrates a legacy GA4_PROPERTY_ID into the sites list exactly once', () => {
  t.assert(sitesStore.includes('GA4_PROPERTY_ID'),
    'an existing single-site deploy (PMApparel.com via env var) must not silently lose its config on this upgrade');
  t.assert(sitesStore.includes("id: \"pmapparel\""),
    'the migrated legacy site should keep a stable, recognizable id');
});

t.test('sites-store requires a label and a property id to add a site', () => {
  t.assert(sitesStore.includes('Site label is required'), 'addSite must reject a missing label');
  t.assert(sitesStore.includes('GA4 property id is required'), 'addSite must reject a missing property id');
});

t.test('sites-store generates unique ids so two sites cannot collide', () => {
  t.assert(sitesStore.includes('uniqueId'), 'addSite should not trust a slug to already be unique');
});

/* ---- sites API route -------------------------------------------------------- */

const sitesRoute = read('api/websitewidget/sites.js');

t.test('api/websitewidget/sites.js exists and requires a session for every method', () => {
  t.assert(exists('api/websitewidget/sites.js'), 'api/websitewidget/sites.js is missing');
  t.assert(sitesRoute.includes('requireAuth'), 'the route must call requireAuth, same as every other app route');
});

t.test('reading the site list does not require admin, but changing it does', () => {
  t.assert(/req\.method === ["']GET["'][\s\S]{0,80}getSites/.test(sitesRoute),
    'GET should not be gated behind isAdmin — the dashboard needs the list to build its site tabs for everyone');
  t.assert(/if \(!isAdmin\) return res\.status\(403\)/.test(sitesRoute),
    'POST/PATCH/DELETE must be blocked for non-admins — this changes what data source the whole team reads from');
});

t.test('the sites route supports add, edit, and remove', () => {
  ['req.method === "POST"', 'req.method === "PATCH"', 'req.method === "DELETE"']
    .forEach((k) => t.assert(sitesRoute.includes(k), 'api/websitewidget/sites.js is missing ' + k));
});

/* ---- multi-site dashboard behavior ----------------------------------------- */

t.test('the dashboard renders a tab per configured site and reloads stats on switch', () => {
  t.assert(app.includes('wwSiteTabs'), 'apps/websitewidget.js should render a site-tab bar');
  t.assert(app.includes('ctx.activeSiteId = btn.dataset.site'),
    'clicking a site tab must switch the active site before reloading stats');
  t.assert(/ctx\.api\.get\(ENDPOINTS\.wwStats,\s*params\)/.test(app),
    'stats must be requested with a site param, not just a day range');
});

t.test('the app loads the site list before the first stats fetch', () => {
  const mountBody = app.slice(app.indexOf('async mount(ctx)'));
  const loadSitesIdx = mountBody.indexOf('await loadSites()');
  const loadStatsIdx = mountBody.indexOf('await loadStats(false)');
  t.assert(loadSitesIdx !== -1 && loadStatsIdx !== -1 && loadSitesIdx < loadStatsIdx,
    'loadSites() must run before the first loadStats() call, or there is no active site to request stats for');
});

t.test('Manage Sites is gated to admins, matching the API', () => {
  t.assert(app.includes("ctx.perms.superuser") || app.includes('data_scope'),
    'the settings view must check the same admin condition the API enforces, so a non-admin never sees edit controls it cannot use');
  t.assert(app.includes('Managing sites is limited to admins'),
    'a non-admin should see a plain message, not a broken or empty form');
});

t.test('a per-site GA4 error is shown distinctly from "not configured"', () => {
  t.assert(app.includes("Couldn't read this site's data") || app.includes('data.error'),
    'a 403/denied-access error for one site should explain itself, not look identical to GA4 never having been set up');
});

/* ---- the real logic, called rather than grepped ------------------------- */

(async () => {
  const ga4 = await import('../lib/websitewidget/ga4.js');
  const cache = await import('../lib/websitewidget/store.js');

  /* -- cache keys -- */

  t.test('the stats cache is keyed per site, not shared across sites', () => {
    t.assert(cache.cacheKey('pmapparel', 30, 'none') !== cache.cacheKey('iowaondemand', 30, 'none'),
      'two sites over the same range must not share a cache entry, or one site\u2019s numbers show on the other\u2019s tab');
    t.assert(cache.cacheKey('pmapparel', 7, 'none') !== cache.cacheKey('pmapparel', 30, 'none'),
      'two ranges must not share a cache entry');
  });

  t.test('the cache key separates comparison modes', () => {
    // Same site, same range, different question. Without the mode in the key
    // a "vs last year" load serves whatever "vs previous" cached, for ten
    // minutes, with no sign anything is wrong.
    const none = cache.cacheKey('pmapparel', 30, 'none');
    const prev = cache.cacheKey('pmapparel', 30, 'previous');
    const year = cache.cacheKey('pmapparel', 30, 'year');
    t.assert(new Set([none, prev, year]).size === 3, 'all three comparison modes need distinct cache keys');
  });

  /* -- period windows -- */

  const AUG20 = new Date('2026-08-20T15:00:00Z'); // 10 AM Central, mid-morning

  t.test('a window ends yesterday, never today', () => {
    // The whole point of the comparison work. A window ending today holds a
    // part-day, and a part-day against a full period reads as a drop that
    // did not happen.
    const w = ga4.periodWindows(30, 'none', AUG20);
    t.equal(w.current.endDate, '2026-08-19', 'the window should end on the last complete day');
  });

  t.test('a window covers exactly the number of days asked for', () => {
    const w7 = ga4.periodWindows(7, 'none', AUG20);
    t.equal(w7.current.startDate, '2026-08-13');
    t.equal(w7.current.endDate, '2026-08-19'); // 13th through 19th inclusive is 7 days
    const w30 = ga4.periodWindows(30, 'none', AUG20);
    t.equal(w30.current.startDate, '2026-07-21');
  });

  t.test('windows are computed in Central time, not the server\u2019s UTC', () => {
    // 00:30 UTC on Aug 21 is still 7:30 PM Central on Aug 20. Off a UTC
    // clock "yesterday" would be Aug 20, a day still in progress in Iowa,
    // and the last bar of the chart would be a partial day pretending to be
    // whole.
    const lateUtc = new Date('2026-08-21T00:30:00Z');
    const w = ga4.periodWindows(7, 'none', lateUtc);
    t.equal(w.current.endDate, '2026-08-19', 'the Central date has not rolled over yet, so yesterday is still the 19th');
  });

  t.test('the previous period abuts the current one without overlapping it', () => {
    const w = ga4.periodWindows(30, 'previous', AUG20);
    t.equal(w.prior.endDate, '2026-07-20', 'the prior window must end the day before the current one starts');
    t.equal(w.prior.startDate, '2026-06-21');
    t.assert(w.prior.endDate < w.current.startDate, 'the two windows must not share a day');
  });

  t.test('a year comparison shifts 364 days so the weekdays line up', () => {
    // 364 is 52 weeks exactly. Web traffic is strongly weekly, so a 365-day
    // shift slides a Saturday into the slot being compared with a Monday.
    const w = ga4.periodWindows(30, 'year', AUG20);
    const end = new Date(w.current.endDate + 'T12:00:00Z');
    const priorEnd = new Date(w.prior.endDate + 'T12:00:00Z');
    t.equal(priorEnd.getUTCDay(), end.getUTCDay(), 'the prior window must end on the same weekday');
    t.equal((end - priorEnd) / 86400000, 364, 'the shift should be 364 days, not 365');
  });

  t.test('the prior window is the same length as the current one', () => {
    ['previous', 'year'].forEach((mode) => {
      [7, 30, 90].forEach((days) => {
        const w = ga4.periodWindows(days, mode, AUG20);
        const span = (a, b) => (new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000;
        t.equal(span(w.prior.startDate, w.prior.endDate), span(w.current.startDate, w.current.endDate),
          'comparing windows of different lengths would make the percentage meaningless (' + mode + '/' + days + ')');
      });
    });
  });

  t.test('no comparison mode means no prior window at all', () => {
    t.equal(ga4.periodWindows(30, 'none', AUG20).prior, null);
    t.equal(ga4.periodWindows(30, 'nonsense', AUG20).prior, null, 'an unrecognised mode should fall back to none, not throw');
  });

  t.test('window math survives a daylight-saving change', () => {
    // Central moved off DST on Nov 1, 2026. Day arithmetic anchored at
    // midnight can slip an hour across a date boundary here and silently
    // drop or repeat a day mid-range.
    const nov = new Date('2026-11-05T15:00:00Z');
    const w = ga4.periodWindows(30, 'previous', nov);
    t.equal(w.current.endDate, '2026-11-04');
    t.equal(w.current.startDate, '2026-10-06'); // Oct 6 through Nov 4 is 30 days across the change
    t.equal(w.prior.endDate, '2026-10-05');
  });

  /* -- missing days in the trend -- */

  t.test('a day GA4 omits is filled in as zero, not dropped', () => {
    // Found live on Aug 20, 2026: PMApparel's 7 day chart drew SIX bars.
    // Sunday the 16th had no sessions, GA4 returned no row for it, and the
    // day silently vanished. The flat spot is the news; dropping it hides it.
    const w = { startDate: '2026-08-13', endDate: '2026-08-19' };
    const sparse = [
      { date: '20260813', sessions: 2, users: 2 },
      { date: '20260814', sessions: 3, users: 3 },
      { date: '20260815', sessions: 1, users: 1 },
      // 20260816 absent, exactly as GA4 returns it
      { date: '20260817', sessions: 40, users: 33 },
      { date: '20260818', sessions: 35, users: 30 },
      { date: '20260819', sessions: 44, users: 31 },
    ];
    const dense = ga4.fillTrendGaps(sparse, w);
    t.equal(dense.length, 7, 'a 7 day window must produce 7 bars');
    t.equal(dense[3].date, '20260816', 'the missing day belongs in position 3');
    t.equal(dense[3].sessions, 0);
    t.equal(dense[3].users, 0);
    t.equal(dense[5].sessions, 35, 'real days must not be shifted by the insert');
  });

  t.test('filling gaps keeps the two periods aligned day for day', () => {
    // The reason this matters beyond the chart looking right. The overlay
    // pairs periods by position. One missing day in one period and not the
    // other shifts everything after it, so a Monday gets measured against a
    // Sunday and the 364-day weekday alignment is wasted.
    const cur = ga4.fillTrendGaps(
      [{ date: '20260813', sessions: 2, users: 2 }, { date: '20260819', sessions: 44, users: 31 }],
      { startDate: '2026-08-13', endDate: '2026-08-19' }
    );
    const prior = ga4.fillTrendGaps(
      [{ date: '20260806', sessions: 5, users: 5 }],
      { startDate: '2026-08-06', endDate: '2026-08-12' }
    );
    t.equal(cur.length, prior.length, 'both series must be the same length to pair by index');
    cur.forEach((d, i) => {
      const a = new Date(d.date.slice(0,4) + '-' + d.date.slice(4,6) + '-' + d.date.slice(6,8) + 'T12:00:00Z');
      const b = new Date(prior[i].date.slice(0,4) + '-' + prior[i].date.slice(4,6) + '-' + prior[i].date.slice(6,8) + 'T12:00:00Z');
      t.equal(a.getUTCDay(), b.getUTCDay(), 'position ' + i + ' must pair the same weekday');
    });
  });

  t.test('an entirely empty period still produces a full row of zeros', () => {
    // Exactly the state Iowa On Demand and Flyover Con were in on day one.
    // An empty array would draw no chart at all rather than a flat one.
    const dense = ga4.fillTrendGaps([], { startDate: '2026-08-13', endDate: '2026-08-19' });
    t.equal(dense.length, 7);
    t.equal(dense.reduce((n, d) => n + d.sessions, 0), 0);
  });

  t.test('gap filling spans a month boundary correctly', () => {
    const dense = ga4.fillTrendGaps([], { startDate: '2026-07-29', endDate: '2026-08-02' });
    t.equal(dense.length, 5);
    t.equal(dense[0].date, '20260729');
    t.equal(dense[2].date, '20260731', 'July has 31 days');
    t.equal(dense[3].date, '20260801');
  });

  /* -- deltas -- */

  t.test('a delta reports direction and magnitude off the prior figure', () => {
    const d = ga4.deltaOf(120, 100);
    t.equal(d.diff, 20);
    t.equal(d.pct, 20);
    t.equal(d.basis, 'ok');
    t.equal(ga4.deltaOf(80, 100).pct, -20);
  });

  t.test('a zero baseline gives no percentage rather than a made-up one', () => {
    // 5 sessions against 0 is not "up 100%" and not "up infinity". Either
    // number reads as measured fact on a dashboard. The honest answer is
    // that there is nothing to divide by.
    const d = ga4.deltaOf(5, 0);
    t.equal(d.pct, null);
    t.equal(d.basis, 'no-baseline');
    t.equal(d.diff, 5, 'the raw difference is still real and still worth showing');
  });

  t.test('zero against zero is flat, not an error', () => {
    const d = ga4.deltaOf(0, 0);
    t.equal(d.pct, null);
    t.equal(d.basis, 'flat');
  });

  /* -- breakdown comparison -- */

  t.test('a breakdown row picks up its prior figure by key, not by position', () => {
    // Rows are ordered by size, and the order changes between periods. Zipping
    // two lists by index would compare organic search against direct.
    const now = [{ channel: 'Direct', sessions: 90 }, { channel: 'Organic Search', sessions: 50 }];
    const was = [{ channel: 'Organic Search', sessions: 40 }, { channel: 'Direct', sessions: 100 }];
    const merged = ga4.compareSeries(now, was, 'channel', 'sessions');
    t.equal(merged[0].channel, 'Direct');
    t.equal(merged[0].prior, 100);
    t.equal(merged[0].delta.pct, -10);
    t.equal(merged[1].prior, 40);
  });

  t.test('a row with no prior match reports unknown, not zero', () => {
    // A page that did not exist last year has no prior figure. Folding that
    // in as zero produces a confident "up from nothing" on a page that may
    // simply not have been captured, and the reverse case invents a -100%.
    const merged = ga4.compareSeries(
      [{ path: '/new-landing-page', views: 300 }],
      [],
      'path', 'views'
    );
    t.equal(merged[0].prior, null, 'absent must stay absent, never collapse to 0');
    t.equal(merged[0].delta, null);
  });

  t.test('a genuine zero in the prior period is kept apart from a missing row', () => {
    const merged = ga4.compareSeries(
      [{ path: '/a', views: 10 }, { path: '/b', views: 10 }],
      [{ path: '/a', views: 0 }],
      'path', 'views'
    );
    t.equal(merged[0].prior, 0, 'GA4 returned a row saying zero, which is a fact');
    t.equal(merged[0].delta.basis, 'no-baseline');
    t.equal(merged[1].prior, null, 'GA4 returned nothing at all, which is not a fact about the number');
  });

  /* -- the breakdown catalogue -- */

  t.test('every breakdown declares the fields the view reads off it', () => {
    // The cards are generated from this table, so a half-filled entry is a
    // card that renders blank labels rather than an error anyone would notice.
    Object.entries(ga4.BREAKDOWNS).forEach(([name, spec]) => {
      t.assert(Array.isArray(spec.dims) && spec.dims.length >= 1, name + ' needs at least one GA4 dimension');
      t.assert(typeof spec.metric === 'string' && spec.metric, name + ' needs a metric');
      t.assert(typeof spec.key === 'string' && spec.key, name + ' needs a key field');
      t.assert(typeof spec.value === 'string' && spec.value, name + ' needs a value field');
      t.assert(typeof spec.limit === 'number' && spec.limit > 0, name + ' needs a row limit');
      t.assert(spec.key !== spec.value, name + ' cannot use one field for both label and number');
    });
  });

  t.test('the catalogue still covers the two original cards', () => {
    // channels and topPages were hand-written before the table existed. If a
    // refactor drops them from the catalogue the dashboard loses them silently.
    t.assert(ga4.BREAKDOWNS.channels, 'channels must stay in the catalogue');
    t.assert(ga4.BREAKDOWNS.topPages, 'topPages must stay in the catalogue');
    t.equal(ga4.BREAKDOWNS.channels.key, 'channel');
    t.equal(ga4.BREAKDOWNS.topPages.value, 'views');
  });

  t.test('the new reports are all present', () => {
    ['landingPages', 'devices', 'visitorType', 'places', 'events'].forEach((n) => {
      t.assert(ga4.BREAKDOWNS[n], n + ' should be in the catalogue');
    });
  });

  t.test('comparison works on every catalogue entry, not just the first two', () => {
    // compareSeries is keyed by field name, so a card whose key field is
    // wrong compares nothing and silently shows dashes forever.
    Object.entries(ga4.BREAKDOWNS).forEach(([name, spec]) => {
      const now = [{ [spec.key]: 'X', [spec.value]: 10 }];
      const was = [{ [spec.key]: 'X', [spec.value]: 5 }];
      const merged = ga4.compareSeries(now, was, spec.key, spec.value);
      t.equal(merged[0].delta.pct, 100, name + ' should compare its own rows');
    });
  });

  t.test('a multi-dimension breakdown joins its parts into one label', () => {
    // "Springfield" is not an answer. places uses city plus region so two
    // Springfields stay apart.
    t.assert(ga4.BREAKDOWNS.places.dims.length === 2, 'places should carry a second dimension');
    t.equal(ga4.BREAKDOWNS.places.dims[0], 'city', 'city must be first, since only the first dimension can be filtered');
  });

  /* -- failure isolation, the property the whole layout depends on -- */

  // Exercises the REAL fetchSiteStats against a stand-in GA4 that rejects one
  // dimension and one metric, which is what Google does when a field is
  // renamed. Ten reports now go out per window using names that cannot be
  // verified from a test environment, so the thing worth pinning is not that
  // the names are right, it is that being wrong costs one card instead of the
  // page. Under the previous Promise.all, one 400 blanked everything.
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const savedFetch = globalThis.fetch;
  const savedEmail2 = process.env.GA4_CLIENT_EMAIL;
  const savedKey2 = process.env.GA4_PRIVATE_KEY;
  process.env.GA4_CLIENT_EMAIL = 'stub@stub.iam.gserviceaccount.com';
  process.env.GA4_PRIVATE_KEY = privateKey;

  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    const dims = (body.dimensions || []).map((d) => d.name);
    if (dims.includes('landingPage')) {
      return new Response('{"error":{"message":"not a valid dimension"}}', { status: 400 });
    }
    if ((body.metrics || []).some((m) => m.name === 'engagementRate')) {
      return new Response('{"error":{"message":"not a valid metric"}}', { status: 400 });
    }
    const mk = (names, rows) => JSON.stringify({
      dimensionHeaders: names.map((n) => ({ name: n })),
      metricHeaders: (body.metrics || []).map((m) => ({ name: m.name })),
      rows
    });
    if (!dims.length) {
      return new Response(mk([], [{ dimensionValues: [], metricValues: (body.metrics || []).map(() => ({ value: '42' })) }]), { status: 200 });
    }
    if (dims[0] === 'date') {
      return new Response(mk(['date'], [{ dimensionValues: [{ value: '20260819' }], metricValues: [{ value: '44' }, { value: '31' }] }]), { status: 200 });
    }
    return new Response(mk(dims, [{ dimensionValues: dims.map(() => ({ value: 'Alpha' })), metricValues: [{ value: '7' }] }]), { status: 200 });
  };

  const isolated = await ga4.fetchSiteStats('123', 7, 'none');

  globalThis.fetch = savedFetch;
  if (savedEmail2 !== undefined) process.env.GA4_CLIENT_EMAIL = savedEmail2; else delete process.env.GA4_CLIENT_EMAIL;
  if (savedKey2 !== undefined) process.env.GA4_PRIVATE_KEY = savedKey2; else delete process.env.GA4_PRIVATE_KEY;

  t.test('one rejected dimension costs one card, not the dashboard', () => {
    t.equal(isolated.totals.sessions, 42, 'the headline numbers must survive a broken breakdown');
    t.equal(isolated.trend.length, 7, 'the chart must survive too');
    t.assert(isolated.failed.landingPages, 'the rejected section must report itself as failed');
  });

  t.test('the sections Google accepted still carry their rows', () => {
    ['channels', 'topPages', 'devices', 'visitorType', 'places', 'events'].forEach((n) => {
      t.assert((isolated[n] || []).length > 0, n + ' should still have data');
      t.assert(!isolated.failed[n], n + ' should not be marked failed');
    });
  });

  t.test('a failed section is null or empty, never a confident zero', () => {
    // The distinction the whole app runs on. A card that could not be read
    // must not render as "0 visits from phones", which is a claim.
    t.equal(isolated.engagement, null, 'unreadable engagement must be null, not zeroes');
    t.assert(isolated.failed.engagement, 'and it must say why');
    t.equal((isolated.landingPages || []).length, 0);
  });

  t.test('the failure message names what went wrong', () => {
    t.assert(/400/.test(isolated.failed.landingPages),
      'the message should carry enough to act on, not just "error"');
  });

  /* -- connection probe -- */

  // The harness runs t.test synchronously and does not await a returned
  // promise, so anything async has to be resolved out here first and only
  // asserted inside. A promise handed to t.test passes whatever it does.
  const savedEmail = process.env.GA4_CLIENT_EMAIL;
  const savedKey = process.env.GA4_PRIVATE_KEY;
  delete process.env.GA4_CLIENT_EMAIL;
  delete process.env.GA4_PRIVATE_KEY;
  const probeNoCreds = await ga4.probeProperty('123456');
  if (savedEmail !== undefined) process.env.GA4_CLIENT_EMAIL = savedEmail;
  if (savedKey !== undefined) process.env.GA4_PRIVATE_KEY = savedKey;

  t.test('probeProperty tells missing credentials apart from a bad property id', () => {
    // Each of these is a different fix in a different place: one is Vercel
    // env vars, one is the number typed in the form, one is a permission in
    // analytics.google.com. "Error" alone sends someone to the wrong one.
    t.equal(probeNoCreds.ok, false);
    t.equal(probeNoCreds.status, 'no-credentials');
    t.assert(/GA4_CLIENT_EMAIL/.test(probeNoCreds.message),
      'the message should name the thing that is missing');
  });

  t.test('probeProperty never throws, it returns a status', () => {
    // It is called from a settings form. A throw there is a blank box.
    const p = ga4.probeProperty('');
    t.assert(p && typeof p.then === 'function', 'probeProperty should return a promise');
  });

  const probeEmpty = await ga4.probeProperty('');
  t.test('probeProperty asks for a property id before calling Google', () => {
    t.equal(probeEmpty.ok, false);
    t.assert(probeEmpty.status === 'no-property-id' || probeEmpty.status === 'no-credentials',
      'an empty id should be refused locally, not spent on a GA4 call');
  });

  process.exit(t.report());
})();
