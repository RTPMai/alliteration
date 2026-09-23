// PUT IN: test/crewcore-pay-period.test.cjs
/**
 * CrewCore Time Clock: the pay period view (Sep 23 2026).
 *
 * Ryan's ask: a filter that shows the whole pay period. P&M pays the 1st
 * through the 15th, and the 16th through the end of the month.
 *
 * The part worth guarding is overtime. It is owed past 40 hours in a WORK
 * WEEK, and a pay period is 13 to 16 days long. Adding up the period and
 * calling everything past 40 overtime would put the whole shop in overtime
 * every payday. So overtime stays weekly, uses the whole week even when part
 * of it fell last period, and is reported in the period the week ends in.
 * Every overtime hour lands in exactly one period.
 *
 * Real calls: the pure functions, then the route itself with signed sessions
 * over a fake Upstash.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* ---- fake Upstash ------------------------------------------------------- */

const kv = new Map();
global.fetch = async (url, opts) => {
  const raw = String(url);
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM) {
    kv.set(decodeURIComponent(setM[1]),
      typeof (opts && opts.body) === 'string' ? opts.body : JSON.stringify(opts && opts.body));
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-crewcore-pay-period';

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

async function call(handler, { as, method = 'GET', query = {} }) {
  const cookie = await makeCookie(as);
  const res = fakeRes();
  await handler({ method, query, body: null, headers: { cookie } }, res);
  return res;
}

// The harness has equal() only, so compare shapes as JSON.
function same(a, b, msg) { t.equal(JSON.stringify(a), JSON.stringify(b), msg); }

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const tcl = await import(path.join(ROOT, 'lib/crewcore/timeclock.js'));
  const {
    payPeriodFor, shiftPayPeriod, datesInWindow, isDateString,
    payPeriodReadStart, summarizePeriod, localToIso,
  } = tcl;

  // A shift typed as Central wall-clock time, the way the correction form
  // takes it, so no test depends on daylight saving arithmetic.
  let n = 0;
  const sh = (date, inT, outT) => ({
    id: 'S' + (n += 1), employee_id: 'EMP-1',
    in_at: localToIso(date, inT), out_at: localToIso(date, outT), source: 'kiosk',
  });
  const days = (dates, inT, outT) => dates.map((d) => sh(d, inT, outT));

  /* ---- where the periods fall ---------------------------------------- */

  t.test('the 1st through the 15th is one period', () => {
    same(payPeriodFor('2026-09-01'), { start: '2026-09-01', end: '2026-09-15' });
    same(payPeriodFor('2026-09-15'), { start: '2026-09-01', end: '2026-09-15' });
  });

  t.test('the 16th through the last day of the month is the other', () => {
    same(payPeriodFor('2026-09-16'), { start: '2026-09-16', end: '2026-09-30' });
    same(payPeriodFor('2026-10-31'), { start: '2026-10-16', end: '2026-10-31' });
  });

  t.test('February ends on the 28th, or the 29th in a leap year', () => {
    same(payPeriodFor('2027-02-20'), { start: '2027-02-16', end: '2027-02-28' });
    same(payPeriodFor('2028-02-20'), { start: '2028-02-16', end: '2028-02-29' });
  });

  t.test('Prev and Next step one period, across months and years', () => {
    same(shiftPayPeriod('2026-09-16', -1), { start: '2026-09-01', end: '2026-09-15' });
    same(shiftPayPeriod('2026-09-01', -1), { start: '2026-08-16', end: '2026-08-31' });
    same(shiftPayPeriod('2026-12-20', 1), { start: '2027-01-01', end: '2027-01-15' });
    same(shiftPayPeriod('2026-09-20', 0), { start: '2026-09-16', end: '2026-09-30' });
    same(shiftPayPeriod('2026-09-20', 4), { start: '2026-11-16', end: '2026-11-30' });
  });

  t.test('a year is 24 periods with no gaps and no overlaps', () => {
    let p = payPeriodFor('2026-01-01');
    let count = 0;
    let dayCount = 0;
    while (p.start < '2027-01-01') {
      const next = shiftPayPeriod(p.start, 1);
      const after = datesInWindow(p.end, next.start);
      t.equal(after.length, 2, `${p.end} must be followed directly by ${next.start}`);
      dayCount += datesInWindow(p.start, p.end).length;
      count += 1;
      p = next;
    }
    t.equal(count, 24);
    t.equal(dayCount, 365);
  });

  t.test('only real dates are accepted', () => {
    t.assert(isDateString('2026-09-23'));
    t.assert(!isDateString('2026-02-30'), 'Feb 30 is not a date');
    t.assert(!isDateString('9/23/2026'));
    t.assert(!isDateString(''));
  });

  /* ---- overtime stays weekly ------------------------------------------ */

  // Sep 16 2026 is a Wednesday. With a Sunday week start the period touches
  // three work weeks: Sep 13-19 (started last period), Sep 20-26, and
  // Sep 27-Oct 3 (finishes next period).
  const SEP = [
    ...days(['2026-09-14', '2026-09-15'], '07:00', '15:00'),                // 16h, last period
    ...days(['2026-09-16', '2026-09-17', '2026-09-18'], '06:00', '16:00'),  // 30h
    ...days(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'], '07:00', '16:00'), // 45h
    ...days(['2026-09-28', '2026-09-29', '2026-09-30'], '06:00', '16:00'),  // 30h
  ];
  const OCT = [
    ...days(['2026-09-28', '2026-09-29', '2026-09-30'], '06:00', '16:00'),  // 30h, last period
    ...days(['2026-10-01', '2026-10-02'], '06:00', '16:00'),                // 20h
  ];

  t.test('hours in the period are only the days in the period', () => {
    const s = summarizePeriod(SEP, { start: '2026-09-16', end: '2026-09-30' });
    t.equal(s.total_hours, 105, 'Sep 14 and 15 belong to the last period');
    t.equal(s.days['2026-09-15'], undefined);
    t.equal(s.days['2026-09-16'], 10);
    t.equal(Object.keys(s.days).length, 15);
  });

  t.test('overtime is past 40 in a work week, not past 40 in the period', () => {
    const s = summarizePeriod(SEP, { start: '2026-09-16', end: '2026-09-30' });
    // Week of Sep 13: 16 + 30 = 46, so 6. Week of Sep 20: 45, so 5.
    // Week of Sep 27 is not over yet. Naive period math would say 65.
    t.equal(s.overtime_hours, 11);
  });

  t.test('the first week counts the days worked last period', () => {
    const s = summarizePeriod(SEP, { start: '2026-09-16', end: '2026-09-30' });
    const first = s.weeks[0];
    t.equal(first.start, '2026-09-13');
    t.equal(first.hours, 46);
    t.equal(first.overtime, 6);
    t.assert(first.counted);
  });

  t.test('a week that ends next period is listed but not counted here', () => {
    const s = summarizePeriod(SEP, { start: '2026-09-16', end: '2026-09-30' });
    const last = s.weeks[s.weeks.length - 1];
    t.equal(last.start, '2026-09-27');
    t.assert(!last.counted, 'its overtime belongs to the period it ends in');
    t.equal(last.overtime, 0);
  });

  t.test('that week lands next period, whole, exactly once', () => {
    const s = summarizePeriod(OCT, { start: '2026-10-01', end: '2026-10-15' });
    t.equal(s.total_hours, 20);
    t.equal(s.weeks[0].start, '2026-09-27');
    t.equal(s.weeks[0].hours, 50);
    t.equal(s.overtime_hours, 10);
  });

  t.test('a Monday week start moves the week lines, not the period', () => {
    const s = summarizePeriod(SEP, { start: '2026-09-16', end: '2026-09-30', weekStartDay: 1 });
    t.equal(s.total_hours, 105);
    t.equal(s.weeks[0].start, '2026-09-14');
    t.equal(s.weeks[0].hours, 46);
    t.equal(s.overtime_hours, 11);
  });

  t.test('the read reaches back to the start of the first work week', () => {
    t.equal(payPeriodReadStart({ start: '2026-09-16', end: '2026-09-30' }, 0), '2026-09-13');
    t.equal(payPeriodReadStart({ start: '2026-09-16', end: '2026-09-30' }, 1), '2026-09-14');
    t.equal(payPeriodReadStart({ start: '2026-11-01', end: '2026-11-15' }, 0), '2026-11-01');
  });

  t.test('a missed clock-out last period is not flagged in this one', () => {
    const stale = { id: 'OLD', employee_id: 'EMP-1', in_at: localToIso('2026-09-14', '07:00'), out_at: null };
    const s = summarizePeriod([stale, ...SEP], {
      start: '2026-09-16', end: '2026-09-30', now: new Date('2026-10-05T12:00:00Z'),
    });
    t.equal(s.flags.length, 0);
    t.equal(s.open_shifts, 0);
  });

  t.test('a missed clock-out inside the period is flagged', () => {
    const stale = { id: 'OPEN', employee_id: 'EMP-1', in_at: localToIso('2026-09-22', '07:00'), out_at: null };
    const s = summarizePeriod([stale], {
      start: '2026-09-16', end: '2026-09-30', now: new Date('2026-10-05T12:00:00Z'),
    });
    t.equal(s.flags.length, 1);
    t.equal(s.flags[0].kind, 'missed_out');
  });

  /* ---- the route --------------------------------------------------------- */

  const route = (await import(path.join(ROOT, 'api/crewcore/timecards.js'))).default;
  const store = await import(path.join(ROOT, 'lib/crewcore/timeclock-store.js'));

  kv.set('alliteration:users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan', superuser: true },
    sasha: { username: 'sasha', name: 'Sasha', role: 'employee' },
  }));
  kv.set('crewcore_data:employee_index', JSON.stringify(['EMP-1']));
  kv.set('crewcore_data:employee:EMP-1', JSON.stringify({
    id: 'EMP-1', name: 'Sasha', username: 'sasha', status: 'active', department: 'Embroidery',
  }));
  for (const s of SEP) {
    await store.addShift({ employee_id: 'EMP-1', in_at: s.in_at, out_at: s.out_at });
  }

  const ADMIN = { username: 'ryan', name: 'Ryan' };
  const SASHA = { username: 'sasha', name: 'Sasha', role: 'employee' };

  await check('the route returns the whole pay period', async () => {
    const res = await call(route, { as: ADMIN, query: { period: '2026-09-23' } });
    t.equal(res.statusCode, 200);
    t.equal(res.body.mode, 'period');
    same(res.body.period, { start: '2026-09-16', end: '2026-09-30' });
    t.equal(res.body.dates.length, 15);
    t.equal(res.body.dates[0], '2026-09-16');
    t.equal(res.body.week_key, null);
  });

  await check('the route counts period hours and weekly overtime', async () => {
    const res = await call(route, { as: ADMIN, query: { period: '2026-09-16' } });
    const row = res.body.rows[0];
    t.equal(row.summary.total_hours, 105);
    t.equal(row.summary.overtime_hours, 11);
    t.equal(res.body.totals.hours, 105);
    t.equal(res.body.totals.overtime, 11);
  });

  await check('the shift list shows only shifts inside the period', async () => {
    const res = await call(route, { as: ADMIN, query: { period: '2026-09-16' } });
    const dates = res.body.rows[0].shifts.map((s) => s.date);
    t.equal(dates.length, 11);
    t.assert(!dates.includes('2026-09-14') && !dates.includes('2026-09-15'),
      'the lookback days decide overtime but are not listed');
  });

  await check('"current" resolves to the period today is in', async () => {
    const res = await call(route, { as: ADMIN, query: { period: 'current' } });
    t.equal(res.statusCode, 200);
    same(res.body.period, payPeriodFor(tcl.localToday()));
  });

  await check('a nonsense period is refused, not guessed at', async () => {
    const res = await call(route, { as: ADMIN, query: { period: '2026-02-30' } });
    t.equal(res.statusCode, 400);
  });

  await check('an employee gets their own pay period, same numbers', async () => {
    const res = await call(route, { as: SASHA, query: { period: '2026-09-16' } });
    t.equal(res.statusCode, 200);
    t.equal(res.body.scope, 'own');
    t.equal(res.body.rows.length, 1);
    t.equal(res.body.rows[0].summary.overtime_hours, 11);
  });

  await check('the week view is unchanged when no period is asked for', async () => {
    const res = await call(route, { as: ADMIN, query: { week: '2026-09-20' } });
    t.equal(res.body.mode, 'week');
    t.equal(res.body.week_key, '2026-09-20');
    t.equal(res.body.period, null);
    t.equal(res.body.rows[0].summary.total_hours, 45);
    t.equal(res.body.rows[0].summary.overtime_hours, 5);
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-pay-period could not run: ' + (e && e.stack || e));
  process.exit(1);
});
