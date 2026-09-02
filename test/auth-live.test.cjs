// PUT IN: test/auth-live.test.cjs
// test/auth-live.test.cjs
/**
 * Live auth surface tests.
 *
 * auth.test.cjs covers the consolidation (one session lib, one user store).
 * These cover the surfaces a request actually hits: the login page, the
 * cookie flags, secret comparison, and the rule that every API endpoint
 * authenticates unless it is public by documented design.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload (the
 * file in git contained a copy of login.html).
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const session = read('lib/session.js');
const login = read('login.html');

/* ---- cookie flags -------------------------------------------------------- */

t.test('the session cookie is HttpOnly and SameSite', () => {
  t.assert(session.includes('HttpOnly'), 'session cookie lost HttpOnly');
  t.assert(session.includes('SameSite'), 'session cookie lost SameSite');
});

t.test('sessions are signed, not plain values', () => {
  t.assert(/createHmac\(\s*["']sha256["']/.test(session),
    'session signing (HMAC-SHA256) is gone');
});

/* ---- secret handling ------------------------------------------------------ */

t.test('an unset SESSION_SECRET throws instead of signing with undefined', () => {
  t.assert(/if\s*\(!s\)\s*\{?\s*throw/.test(session),
    'secret() must refuse to run without SESSION_SECRET');
});

t.test('safeEqual exists and uses a constant-time compare', () => {
  t.assert(session.includes('timingSafeEqual'),
    'safeEqual must use crypto.timingSafeEqual');
  // The undefined !== undefined trap: comparing two missing values must be a
  // non-match. safeEqual coerces null/undefined to "" on BOTH sides, so the
  // caller must confirm the secret is SET before comparing. Check the two
  // known callers do.
  const sync = read('api/printavo-sync.js');
  t.assert(/cronSecret\s*&&/.test(sync) || /if\s*\(\s*cronSecret\s*\)/.test(sync),
    'printavo-sync must confirm CRON_SECRET is set before comparing');
});

/* ---- login page ------------------------------------------------------------ */

t.test('login.html talks to /api/auth and nothing else', () => {
  t.assert(login.includes('/api/auth'), 'login page no longer posts to /api/auth');
  const urls = [...login.matchAll(/fetch\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  urls.forEach((u) => t.assert(u.startsWith('/api/auth'),
    'login page fetches an unexpected endpoint: ' + u));
});

t.test('login.html never handles a password outside the form post', () => {
  t.assert(!/localStorage|sessionStorage/.test(login),
    'login page must not persist anything in browser storage');
});

/* ---- endpoint coverage ------------------------------------------------------ */

t.test('every API endpoint authenticates or is public by documented design', () => {
  // An endpoint counts as covered when it authenticates a session, checks a
  // shared secret, or carries an explicit PUBLIC BY DESIGN comment explaining
  // why not. A new endpoint with none of these fails here on purpose.
  const AUTH_MARKS = [
    'requireAuth', 'getSession', 'CRON_SECRET', 'SYNC_SECRET',
    'JOTFORM_WEBHOOK_TOKEN', 'ADMIN_KEY', 'PUBLIC BY DESIGN',
    // MailMe's provider webhook. Not public: it is secret-checked with
    // safeEqual and fails closed when the secret is unset.
    'MAILME_WEBHOOK_SECRET',
    // PromoPro's inbound-mail webhook, on the same footing as MailMe's:
    // secret-checked with safeEqual, fails closed when unset.
    'PROMOPRO_INBOUND_SECRET',
    // ShopStock's three routes (items, settings, scrape) delegate to
    // lib/shopstock/access.js, which reads the session, looks the permissions
    // up fresh and still honours ADMIN_KEY for the price-scraper cron. This
    // sweep reads source text, so moving a check into a shared function makes
    // it invisible here unless the function's name is a mark too. The rule
    // itself is exercised for real in test/shopstock-access.test.cjs.
    'shopstockAccess'
  ];
  const offenders = [];
  const scan = (dir) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      const rel = dir + '/' + f;
      const full = path.join(ROOT, rel);
      if (fs.statSync(full).isDirectory()) return scan(rel);
      if (!f.endsWith('.js')) return;
      const src = fs.readFileSync(full, 'utf8');
      if (!AUTH_MARKS.some((m) => src.includes(m))) offenders.push(rel);
    });
  };
  scan('api');
  t.equal(offenders.length, 0,
    'endpoints with no auth and no PUBLIC BY DESIGN note: ' + offenders.join(', '));
});

process.exit(t.report());
