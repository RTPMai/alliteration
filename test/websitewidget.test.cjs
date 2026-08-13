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
const apiRoute = read('api/websitewidget.js');
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
  t.assert(/wwStats:\s*'\/api\/websitewidget'/.test(apiJs),
    'ENDPOINTS.wwStats must point at /api/websitewidget');
  t.assert(apiJs.includes("'/api/websitewidget'") && /LIVE_PREFIXES\s*=\s*\[[\s\S]*?'\/api\/websitewidget'[\s\S]*?\]/.test(apiJs),
    '/api/websitewidget must be listed in LIVE_PREFIXES or the app will silently mock forever');
});

t.test('websitewidget has a MOCK shape so offline dev still works', () => {
  t.assert(apiJs.includes('[ENDPOINTS.wwStats]:'), 'MOCK_DATA needs a shape for ENDPOINTS.wwStats');
});

t.test('the hub sample-data banner tracks websitewidget too', () => {
  t.assert(/websitewidget:\s*\[ENDPOINTS\.wwStats\]/.test(apiJs),
    'appsOnSampleData should include websitewidget so the banner is accurate before GA4 is configured');
});

/* ---- API route ------------------------------------------------------------- */

t.test('api/websitewidget.js requires a session', () => {
  t.assert(apiRoute.includes('requireAuth'), 'the route must call requireAuth, same as every other app route');
});

t.test('api/websitewidget.js is GET only', () => {
  t.assert(/req\.method !== ["']GET["']/.test(apiRoute), 'non-GET requests should be rejected');
});

t.test('api/websitewidget.js always answers cleanly, even before GA4 is configured', () => {
  t.assert(apiRoute.includes('isConfigured()'), 'the route must check isConfigured() before calling GA4');
  t.assert(/status\(200\)\.json\(emptyStats/.test(apiRoute),
    'an unconfigured GA4 should return a normal 200 with configured:false, not an error');
});

t.test('api/websitewidget.js fails open on a GA4 error rather than 500ing the dashboard', () => {
  t.assert(/catch\s*\(e\)/.test(apiRoute), 'the route must catch GA4 failures');
  t.assert(/status\(200\)\.json\(\{\s*\.\.\.emptyStats/.test(apiRoute),
    'a GA4 error should still answer 200 with an empty read, not take the dashboard down');
});

t.test('api/websitewidget.js caches through the shared store, not ad hoc', () => {
  t.assert(apiRoute.includes('getCached') && apiRoute.includes('setCached'),
    'the route should read/write through lib/websitewidget/store.js');
  t.assert(apiRoute.includes("fresh === '1'") || apiRoute.includes('fresh ='),
    '?fresh=1 should be able to bypass the cache, matching the ops sync convention');
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

t.test('the stats cache is keyed per site, not shared across sites', () => {
  t.assert(/cacheKey\(siteId,\s*days\)/.test(store),
    'caching by day range alone would leak one site\u2019s cached numbers onto another site\u2019s tab');
});

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

process.exit(t.report());
