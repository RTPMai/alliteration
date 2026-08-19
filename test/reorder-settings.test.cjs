/**
 * Reorder timing settings, moved out of MailMe and into BackBone (Aug 2026).
 *
 * The thing worth testing here is not the arithmetic, it is the MOVE: an
 * install that had tuned these numbers while they lived in MailMe's settings
 * blob must keep them, and a threshold set that would make a state
 * unreachable must be refused rather than stored.
 *
 * Pure functions are called for real. The KV-backed read/write is not
 * exercised (no Upstash in the test environment); mergeReorder and
 * validateReorder are where every decision actually lives.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

import('../lib/reorder-settings.js').then((r) => {

  /* ---- defaults and merging -------------------------------------------- */

  t.test('defaults match what MailMe shipped, so nothing shifts on deploy', () => {
    const d = r.REORDER_DEFAULTS;
    t.equal(d.dueAt, 1.0, 'due at one times the gap');
    t.equal(d.overdueAt, 1.5, 'overdue at one and a half');
    t.equal(d.lapsedAt, 3.0, 'lapsed at three');
    t.equal(d.minOrders, 3, 'three orders before a median means anything');
    t.equal(d.minGapDays, 7, 'medians under a week are noise');
  });

  t.test('an empty store falls back to the legacy MailMe values, not defaults', () => {
    // THE MIGRATION. Ryan may have tuned these in MailMe already. If the move
    // silently reset them to defaults, every Due/Overdue pill in the app would
    // change meaning overnight with nothing on screen explaining why.
    const legacy = { dueAt: 1.2, overdueAt: 2.0, lapsedAt: 4.0, minOrders: 5, minGapDays: 14 };
    const merged = r.mergeReorder(null, legacy);
    t.equal(merged.dueAt, 1.2, 'the tuned value survives the move');
    t.equal(merged.lapsedAt, 4.0, 'so does the lapsed threshold');
    t.equal(merged.minOrders, 5, 'and the minimum order count');
  });

  t.test('a stored value beats the legacy fallback', () => {
    // Once BackBone saves, the old MailMe blob must stop having any say.
    // Otherwise a reset back to defaults would be undone by the fallback.
    const legacy = { dueAt: 1.2, lapsedAt: 4.0 };
    const merged = r.mergeReorder({ dueAt: 1.0, lapsedAt: 3.0 }, legacy);
    t.equal(merged.dueAt, 1.0, 'the stored value wins');
    t.equal(merged.lapsedAt, 3.0, 'on every field, not just the first');
  });

  t.test('a partial stored blob is completed from defaults, not left undefined', () => {
    // A field added later would otherwise come back undefined and turn every
    // comparison against it into NaN, quietly marking nobody due.
    const merged = r.mergeReorder({ dueAt: 1.1 });
    t.equal(merged.dueAt, 1.1, 'the stored field is kept');
    t.equal(merged.minGapDays, 7, 'the absent one falls back to the default');
    t.assert(isFinite(merged.overdueAt), 'no field comes back non-numeric');
  });

  t.test('junk values do not poison the settings', () => {
    const merged = r.mergeReorder({ dueAt: 'soon', minOrders: null, lapsedAt: NaN });
    t.equal(merged.dueAt, 1.0, 'a non-numeric string falls back');
    t.equal(merged.minOrders, 3, 'so does null');
    t.assert(isFinite(merged.lapsedAt), 'and NaN never reaches the stored shape');
  });

  /* ---- validation ------------------------------------------------------ */

  t.test('out-of-order thresholds are refused, because they hide a state', () => {
    // reorderStatus() tests lapsed, then overdue, then due, and returns the
    // first match. If overdue sat above lapsed, nothing could ever BE overdue
    // and there would be no error to explain why.
    const bad = r.validateReorder(r.mergeReorder({ dueAt: 1, overdueAt: 4, lapsedAt: 2 }));
    t.assert(bad, 'an out-of-order set is rejected');
    t.assert(/increase/i.test(bad), 'the message says what the rule is');

    const ok = r.validateReorder(r.mergeReorder({ dueAt: 1, overdueAt: 1.5, lapsedAt: 3 }));
    t.equal(ok, null, 'an increasing set passes');
  });

  t.test('equal thresholds are allowed', () => {
    // Deliberate: "treat due and overdue the same" is a legitimate choice,
    // and it is not the same mistake as inverting them.
    t.equal(r.validateReorder(r.mergeReorder({ dueAt: 1, overdueAt: 1, lapsedAt: 1 })), null,
      'equal thresholds are a valid, if blunt, configuration');
  });

  t.test('zero and negative values are refused', () => {
    t.assert(r.validateReorder(r.mergeReorder({ dueAt: 0 })), 'zero is not a multiple');
    t.assert(r.validateReorder(r.mergeReorder({ minOrders: 0 })), 'judging on zero orders is meaningless');
    t.assert(r.validateReorder(r.mergeReorder({ minGapDays: -1 })), 'a negative gap is nonsense');
  });

  /* ---- wiring ---------------------------------------------------------- */

  t.test('the route exists and gates writes harder than reads', () => {
    t.assert(exists('api/reorder-settings.js'), 'api/reorder-settings.js is missing');
    const src = read('api/reorder-settings.js');
    t.assert(src.includes('requireAuth'), 'the route must require a session');
    t.assert(/superuser|admin/.test(src),
      'writing must be gated: these thresholds change what everyone sees at once');
  });

  t.test('MailMe reads the shared store instead of its own settings blob', () => {
    const src = read('lib/mailme/store.js');
    t.assert(src.includes('reorder-settings.js'),
      'MailMe must read reorder timing from the shared store');
    t.assert(!/reorderStatus\(c, \{ \.\.\.settings\.reorder/.test(src),
      'MailMe must no longer read reorder timing out of its own settings');
  });

  t.test('MailMe no longer accepts a reorder patch, but does not reject one either', () => {
    // An old tab still holding the previous Settings screen would otherwise
    // have its entire save fail over one field that simply moved.
    const src = read('lib/mailme/settings.js');
    t.assert(!/patch\.reorder\s*=/.test(src),
      'MailMe must not write reorder timing any more');
    t.assert(!/Reorder thresholds must increase/.test(src),
      'the validation moved with the setting; two copies would drift');
  });

  t.test('BackBone owns the editing surface', () => {
    const tpl = read('apps/backbone/template.js');
    ['reorderDue', 'reorderOverdue', 'reorderLapsed', 'reorderMinOrders', 'reorderMinGap']
      .forEach((id) => t.assert(tpl.includes(id), 'BackBone Settings is missing the ' + id + ' field'));
    const main = read('apps/backbone/main.js');
    t.assert(main.includes('ENDPOINTS.reorderSettings'),
      'BackBone must read and write through the seam, not a literal path');
  });

  t.test('the seam knows the endpoint and marks it live', () => {
    const src = read('js/api.js');
    t.assert(/reorderSettings:\s*'\/api\/reorder-settings'/.test(src),
      'ENDPOINTS.reorderSettings is missing');
    t.assert(src.includes("'/api/reorder-settings'"),
      "'/api/reorder-settings' must be in LIVE_PREFIXES or it runs on mock data");
  });

  t.report();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
