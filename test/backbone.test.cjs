/**
 * BackBone contract tests.
 *
 * Locks the Jul 25-27 dashboard and metric work: the cash-collected series,
 * the staleness stamp, the cron, and the masonry/pin layout. Each of these
 * shipped because a silent failure mode cost real time (July read $31k while
 * the month was past $190k); these keep the fixes from regressing quietly.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('apps/backbone/main.js');
const styles = read('apps/backbone/styles.js');
const sync = read('api/printavo-sync.js');
const vercel = JSON.parse(read('vercel.json'));

/* ---- cash collected ----------------------------------------------------- */

t.test('ops sync writes cashByMonth', () => {
  t.assert(sync.includes('cashByMonth'), 'api/printavo-sync.js no longer produces cashByMonth');
});

t.test('cash phase excludes non-payment transaction types', () => {
  ['Refund', 'Return', 'Void', 'Dispute'].forEach((kind) => {
    t.assert(sync.includes(kind),
      'the cash phase no longer screens out ' + kind + ' transactions');
  });
});

t.test('dashboard prefers cashByMonth with salesByMonth as fallback', () => {
  t.assert(/cashByMonth[\s\S]{0,200}salesByMonth/.test(main),
    'main.js should pick cashByMonth when present and fall back to salesByMonth');
});

/* ---- staleness stamp ---------------------------------------------------- */

t.test('the ops data stamp exists and turns amber past 48 hours', () => {
  t.assert(main.includes('Data through'), 'the "Data through" stamp is gone');
  t.assert(/ageHours\s*<=\s*48/.test(main),
    'the 48 hour staleness threshold is gone; a dead cron would go unnoticed again');
  t.assert(/Stale[\s\S]{0,200}var\(--amber\)|var\(--amber\)[\s\S]{0,200}Stale/.test(main),
    'the stale state should render in amber');
});

/* ---- cron --------------------------------------------------------------- */

t.test('vercel.json carries the daily ops cron', () => {
  const crons = vercel.crons || [];
  const ops = crons.find((c) => String(c.path).includes('printavo-sync') &&
    String(c.path).includes('mode=ops'));
  t.assert(ops, 'the daily ops cron is missing from vercel.json');
  t.equal(ops.schedule, '0 11 * * *', 'ops cron schedule changed');
});

t.test('the sync accepts Vercel cron auth and fails closed', () => {
  t.assert(sync.includes('CRON_SECRET'), 'CRON_SECRET handling is gone from the sync');
  t.assert(sync.includes('safeEqual'),
    'the sync must compare secrets with safeEqual (set-before-compare, constant time)');
});

/* ---- masonry and pin layout --------------------------------------------- */

t.test('DASH_ROW in main.js matches grid-auto-rows in styles.js', () => {
  const row = main.match(/DASH_ROW\s*=\s*(\d+)/);
  t.assert(row, 'DASH_ROW constant is missing from main.js');
  const css = styles.match(/data-masonry="1"\]\s*\{\s*grid-auto-rows\s*:\s*(\d+)px/);
  t.assert(css, 'grid-auto-rows for the masonry grid is missing from styles.js');
  t.equal(row[1], css[1],
    'DASH_ROW and grid-auto-rows disagree; masonry spans will missize every card');
});

t.test('masonry is gated on the data-masonry attribute', () => {
  t.assert(main.includes('data-masonry') || main.includes('dataset.masonry'),
    'masonry must be opt-in via data-masonry so a JS failure degrades to plain rows');
});

t.test('the page width cap stayed removed', () => {
  t.assert(!/\.dash\s*\{[^}]*max-width\s*:\s*1440px/.test(styles),
    'the 1440px cap on .dash came back');
});

t.test('full width pin persists in the layout blob', () => {
  t.assert(/l\.full/.test(main), 'the width pin (l.full) is gone from layout persistence');
});

/* ---- rail badge --------------------------------------------------------- */

t.test('the inbox count goes through ctx.setBadge, not a dead DOM id', () => {
  t.assert(!main.includes('$id("inboxNavBadge")'),
    'updateInboxBadge is back to looking up #inboxNavBadge, which no template declares');
  t.assert(/ctx\.setBadge/.test(main),
    'the inbox new-count should reach the rail via ctx.setBadge');
});

/* ---- ops chaining (Jul 31 fix) ------------------------------------------ */
/* The daily cron did ONE ~4-minute chunk per DAY, so a multi-chunk ops pull
 * never finished and the dashboard stamp froze at Jul 27. The fix makes a
 * cron-initiated run fire its own next chunk. These lock the three legs of
 * that fix: the chain fires on every partial, it cannot loop forever, and a
 * days-old partial restarts fresh instead of resuming a dead cursor. */

t.test('every ops partial return fires the self-continue chain', () => {
  const partials = (sync.match(/status: "partial", phase/g) || []).length;
  const chains = (sync.match(/await continueOps\(\)/g) || []).length;
  t.assert(partials >= 3, 'expected the three ops phase partial returns');
  t.assert(chains >= partials - 2, // incremental/reconcile partials do not chain
    'an ops partial return no longer calls continueOps(); the cron will freeze again');
  t.assert(/chainDepth\s*\+\s*1/.test(sync),
    'the chained call must increment the depth counter');
});

t.test('the ops chain has a hard depth cap', () => {
  t.assert(/CHAIN_MAX/.test(sync) && /chainDepth\s*<\s*CHAIN_MAX/.test(sync),
    'continueOps can loop forever without a CHAIN_MAX guard');
});

t.test('ops partial saves are stamped and stale partials restart fresh', () => {
  t.assert(!/kvSet\("backbone_ops_partial",\s*acc\)/.test(sync),
    'a partial save bypasses saveOpsPartial and will carry no freshness stamp');
  t.assert(/OPS_RESUME_WINDOW_MS/.test(sync),
    'the ops partial no longer has a freshness window; day-old cursors will be resumed');
});

process.exit(t.report());
