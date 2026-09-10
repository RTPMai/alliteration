// PUT IN: test/crewcore-week-start.test.cjs
/**
 * The pay week is a reporting choice. It must never be a storage key.
 *
 * WHAT HAPPENED (Sep 10 2026). The week key was computed from the shop's
 * configurable week start and baked into the storage key. Switching the
 * setting from Sunday to Monday made every bucket ever written unreachable in
 * one click: the reader asked for Monday-anchored keys that had never been
 * written, found nothing, and every employee showed 0.00 for every week going
 * back to the beginning. No error. Nothing deleted. It just went quiet, which
 * is the worst way for a payroll screen to fail.
 *
 * These are real calls against a fake Upstash. Every one of them would have
 * caught it.
 */

const t = require('./harness.cjs');

const kv = new Map();
global.fetch = async (url, opts) => {
  const u = String(url);
  const setAt = u.match(/\/set\/(.+)$/);
  if (setAt) {
    kv.set(decodeURIComponent(setAt[1]),
      typeof (opts && opts.body) === 'string' ? opts.body : JSON.stringify(opts && opts.body));
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

(async () => {
  const tcl = await import('../lib/crewcore/timeclock.js');
  const store = await import('../lib/crewcore/timeclock-store.js');
  const {
    STORAGE_WEEK_START, storageKeyFor, isStorageKey, storageKeysForWindow,
    payWeekWindow, weekKeyFor, dayOfWeek, timeKeys,
  } = tcl;
  const { listWeek, listRange, migrateBuckets, addShift, listWeekKeys } = store;

  // Central time. 14:00 UTC is mid-morning in Chicago all year, so these
  // dates never slide across a local midnight.
  const at = (date, hhmm = '14:00') => `${date}T${hhmm}:00.000Z`;

  function seedBucket(empId, weekKey, shifts) {
    kv.set(timeKeys.week(empId, weekKey), JSON.stringify(shifts));
    const idx = JSON.parse(kv.get(timeKeys.weekIndex(empId)) || '[]');
    if (!idx.includes(weekKey)) idx.push(weekKey);
    idx.sort();
    kv.set(timeKeys.weekIndex(empId), JSON.stringify(idx));
  }
  const shift = (id, date, outHH = '22:00') =>
    ({ id, employee_id: 'EMP-1', in_at: at(date), out_at: at(date, outHH), source: 'kiosk' });

  // ---- the anchor ---------------------------------------------------------

  t.test('the storage anchor is Sunday and is not a setting', () => {
    t.equal(STORAGE_WEEK_START, 0);
    t.equal(storageKeyFor('2026-09-10'), '2026-09-06', 'a Thursday files under its Sunday');
    t.equal(dayOfWeek(storageKeyFor('2026-09-07')), 0, 'always a Sunday');
    t.assert(isStorageKey('2026-09-06'), 'a Sunday is a storage key');
    t.assert(!isStorageKey('2026-09-07'), 'a Monday is not');
  });

  t.test('a Monday pay week straddles two Sunday buckets', () => {
    const w = payWeekWindow('2026-09-07');           // Mon 7th
    t.equal(w.end, '2026-09-13', 'through Sunday the 13th');
    const keys = storageKeysForWindow(w.start, w.end);
    t.equal(keys.join(','), '2026-09-06,2026-09-13',
      'so a read has to collect both, which is the whole fix');
  });

  // ---- reading ------------------------------------------------------------

  await t.test('a Monday pay week returns exactly its seven days', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [
      shift('s-sun', '2026-09-06'),   // Sunday, belongs to the PREVIOUS pay week
      shift('s-mon', '2026-09-07'),
      shift('s-fri', '2026-09-11'),
    ]);
    seedBucket('EMP-1', '2026-09-13', [
      shift('s-sun13', '2026-09-13'), // Sunday, the LAST day of this pay week
      shift('s-mon14', '2026-09-14'), // next pay week
    ]);

    const rows = await listWeek('EMP-1', '2026-09-07');
    t.equal(rows.map((r) => r.id).join(','), 's-mon,s-fri,s-sun13',
      'Monday through Sunday, across both buckets, and nothing either side');
  });

  await t.test('changing the pay week start hides nothing', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [shift('a', '2026-09-08'), shift('b', '2026-09-10')]);

    const sunday = await listWeek('EMP-1', weekKeyFor('2026-09-09', 0));
    const monday = await listWeek('EMP-1', weekKeyFor('2026-09-09', 1));
    t.equal(sunday.length, 2, 'a Sunday-start week sees both');
    t.equal(monday.length, 2, 'and so does a Monday-start week');
  });

  await t.test('every shift carries its own storage key, not the window', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [shift('early', '2026-09-11')]);
    seedBucket('EMP-1', '2026-09-13', [shift('late', '2026-09-13')]);
    const rows = await listWeek('EMP-1', '2026-09-07');
    t.equal(rows.find((r) => r.id === 'early').week_key, '2026-09-06');
    t.equal(rows.find((r) => r.id === 'late').week_key, '2026-09-13',
      'an edit or delete has to look in the bucket the row is really in');
  });

  await t.test('a range report spans buckets and respects its edges', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [shift('in1', '2026-09-09'), shift('out1', '2026-09-06')]);
    seedBucket('EMP-1', '2026-09-13', [shift('in2', '2026-09-15'), shift('out2', '2026-09-19')]);
    const rows = await listRange('EMP-1', '2026-09-09', '2026-09-15');
    t.equal(rows.map((r) => r.id).join(','), 'in1,in2');
  });

  // ---- writing ------------------------------------------------------------

  await t.test('a manually added shift files under the storage anchor', async () => {
    kv.clear();
    const out = await addShift(
      { employee_id: 'EMP-1', in_at: at('2026-09-10'), out_at: at('2026-09-10', '18:00') },
      { by: 'ryan' });
    t.equal(out.week_key, '2026-09-06', 'the Sunday of that week, whatever Settings says');
    t.assert((await listWeekKeys('EMP-1')).includes('2026-09-06'));
  });

  // ---- THE MIGRATION ------------------------------------------------------

  await t.test('orphaned Monday buckets are re-filed and become readable', async () => {
    kv.clear();
    // What a week written while the setting said Monday looks like on disk.
    seedBucket('EMP-1', '2026-09-07', [shift('m1', '2026-09-08'), shift('m2', '2026-09-13')]);

    const before = await listWeek('EMP-1', '2026-09-07');
    t.equal(before.length, 2, 'the migration ran on read and they came back');

    const keys = await listWeekKeys('EMP-1');
    t.assert(keys.every(isStorageKey), 'the index holds only Sunday keys now: ' + keys.join(','));
    t.assert(keys.includes('2026-09-06') && keys.includes('2026-09-13'),
      'and the rows went to the buckets their own dates belong to');
  });

  await t.test('re-filing merges rather than overwriting', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [shift('sunday-bucket', '2026-09-09')]);
    seedBucket('EMP-1', '2026-09-07', [shift('monday-bucket', '2026-09-09')]);
    await migrateBuckets('EMP-1');
    const rows = await listRange('EMP-1', '2026-09-06', '2026-09-12');
    t.equal(rows.map((r) => r.id).sort().join(','), 'monday-bucket,sunday-bucket',
      'a bucket that already had rows keeps them');
  });

  await t.test('the migration is idempotent and never duplicates a shift', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-07', [shift('only', '2026-09-08')]);
    await migrateBuckets('EMP-1');
    const first = await listRange('EMP-1', '2026-09-01', '2026-09-30');
    const second = await migrateBuckets('EMP-1');
    const after = await listRange('EMP-1', '2026-09-01', '2026-09-30');
    t.equal(second.moved, 0, 'nothing left to move');
    t.equal(after.length, first.length, 'and no copies made');
    t.equal(after.length, 1);
  });

  await t.test('an account that never saw the change is untouched', async () => {
    kv.clear();
    seedBucket('EMP-1', '2026-09-06', [shift('fine', '2026-09-09')]);
    const out = await migrateBuckets('EMP-1');
    t.equal(out.moved, 0);
    t.equal(out.buckets, 0, 'which is almost every account, and it costs one read');
  });

  await t.test('somebody clocked in through the change can still clock out', async () => {
    kv.clear();
    const open = { id: 'open-1', employee_id: 'EMP-1', in_at: at('2026-09-08'), out_at: null };
    seedBucket('EMP-1', '2026-09-07', [open]);
    kv.set(timeKeys.open('EMP-1'), JSON.stringify({ week_key: '2026-09-07', shift_id: 'open-1' }));

    await migrateBuckets('EMP-1');
    const ptr = JSON.parse(kv.get(timeKeys.open('EMP-1')));
    t.equal(ptr.week_key, '2026-09-06', 'the pointer follows the row into its new bucket');
    t.equal(ptr.shift_id, 'open-1');
    const rows = await getRows('2026-09-06');
    t.assert(rows.some((r) => r.id === 'open-1'), 'and the row is really there');
  });

  async function getRows(weekKey) {
    return JSON.parse(kv.get(timeKeys.week('EMP-1', weekKey)) || '[]');
  }

  process.exit(t.report());
})();
