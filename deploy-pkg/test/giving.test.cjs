/**
 * GivingGauge contract tests.
 *
 * Two bug classes live here, both of the "quietly wrong number" kind:
 *   1. A frozen "today" shipped once and inflated every lead-time score a
 *      little more each real day that passed.
 *   2. Matched accounts stored a snapshot of roster figures at match time,
 *      so an old match scored against stale revenue and recency.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const app = read('apps/givinggauge.js');
const match = read('api/customer-match.js');

/* ---- the frozen date ---------------------------------------------------- */

t.test('TODAY is computed, never a hardcoded date literal', () => {
  t.assert(!/TODAY\s*=\s*['"]\d{4}-\d{2}-\d{2}['"]/.test(app),
    'TODAY is a hardcoded date string again; lead-time scores will drift daily');
  t.assert(/TODAY\s*=\s*\(function/.test(app) || /TODAY\s*=\s*new Date/.test(app),
    'TODAY should be derived from the live local date');
});

t.test('the engine is still driven by { today } so tests can pin a date', () => {
  t.assert(/today:\s*TODAY/.test(app),
    'engine.evaluate should receive { today: TODAY }');
});

/* ---- account refresh ---------------------------------------------------- */

t.test('matched accounts are refreshed on queue load', () => {
  t.assert(app.includes('refreshMatchedAccounts'),
    'refreshMatchedAccounts is gone; old matches will score on stale figures');
  t.assert(/await\s+refreshMatchedAccounts\(\)/.test(app),
    'refreshMatchedAccounts must actually run during mount');
});

t.test('the refresh keeps identity fields and only updates figures', () => {
  ['lifetimeRevenue', 'daysSinceLastOrder', 'ytdRevenue'].forEach((k) => {
    t.assert(app.includes(k), 'refresh no longer carries ' + k);
  });
  t.assert(!/r\.account\s*=\s*fresh/.test(app),
    'refresh must merge figures into the stored account, not replace it wholesale');
});

t.test('the customer match endpoint answers id refreshes', () => {
  t.assert(exists('api/customer-match.js'),
    'api/customer-match.js is missing; ENDPOINTS.bbCustomerMatch would 404');
  t.assert(/req\.query\s*&&\s*req\.query\.ids/.test(match) || /query\.ids/.test(match),
    'the ?ids= refresh mode is gone from api/customer-match.js');
});

t.test('the endpoint filename matches the route', () => {
  // The file spent time as api/customer-merch.js, which 404s the route the
  // app calls. Vercel routes by filename; there is no rewrite for this.
  t.assert(!exists('api/customer-merch.js'),
    'api/customer-merch.js is back; the route is /api/customer-match');
});

/* ---- seam --------------------------------------------------------------- */

t.test('requests and refreshes go through the seam', () => {
  t.assert(app.includes('ctx.api.get(ENDPOINTS.ggRequests'),
    'requests must come through ctx.api with ENDPOINTS.ggRequests');
  t.assert(app.includes('ENDPOINTS.bbCustomerMatch'),
    'the refresh must use ENDPOINTS.bbCustomerMatch, not a literal path');
});

process.exit(t.report());
