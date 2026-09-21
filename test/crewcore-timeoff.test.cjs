// PUT IN: test/crewcore-timeoff.test.cjs
/**
 * CrewCore time off (Sep 21 2026).
 *
 * Ryan's calls: CrewCore tracks PTO balances, Ryan or Megan approve (nobody
 * else), PTO only, a lump sum every Jan 1 in hours, carryover up to a cap.
 * Amounts from the Handbook: 10 days for a new hire prorated, 15 after a full
 * year.
 *
 * Two halves. The arithmetic is called directly from lib/crewcore/pto.js.
 * The route is CALLED with real signed sessions over a fake Upstash, because
 * "who may approve" is the kind of rule that reads right in source and still
 * lets the wrong person through.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* ---- fake Upstash ------------------------------------------------------- */

const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';

// Fake Resend. Every email "sent" lands here; resendDown makes it fail.
const sentMail = [];
let resendDown = false;

global.fetch = async (url, opts) => {
  const raw = String(url);
  if (raw.startsWith('https://api.resend.com/')) {
    if (resendDown) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'Resend is down' }) };
    sentMail.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'em_' + sentMail.length }) };
  }
  // Notifications talk to Upstash through /pipeline (INCR for the id, SET
  // and GET for records and the index). Enough of it to raise one.
  if (/\/pipeline$/.test(raw)) {
    const cmds = JSON.parse(opts.body);
    const out = cmds.map(([op, key, val]) => {
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      return { result: null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-crewcore-timeoff';
process.env.RESEND_API_KEY = 're_test_key';

const THIS_YEAR = new Date().getFullYear();

// The first Monday in June this year, so a week of weekdays is the same
// length whatever year the suite runs in.
function plus(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
const MON = (() => { let d = `${THIS_YEAR}-06-01`; while (new Date(d + 'T00:00:00Z').getUTCDay() !== 1) d = plus(d, 1); return d; })();
const DAYS = (n) => ({ type: 'all_days', start_date: MON, return_date: plus(MON, n) });

function seed({ approvers = ['ryan', 'megan'] } = {}) {
  kv.clear();
  sentMail.length = 0;
  resendDown = false;
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  superuser: true },
    megan: { username: 'megan', name: 'Megan' },
    jacob: { username: 'jacob', name: 'Jacob', superuser: true },
    sasha: { username: 'sasha', name: 'Sasha' },
    dana:  { username: 'dana',  name: 'Dana' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({ id: 'EMP-1', name: 'Sasha Smith', username: 'sasha', email: 'sasha@example.com', status: 'active', start_date: '2015-03-01', hourly_rate: 24, notes: 'private' }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({ id: 'EMP-2', name: 'Dana', username: 'dana', status: 'active', start_date: '2018-06-01' }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({ id: 'EMP-3', name: 'Megan', username: 'megan', email: 'megan@pmapparel.com', status: 'active', start_date: '2000-01-01' }));
  kv.set(CC + ':employee:EMP-4', JSON.stringify({ id: 'EMP-4', name: 'Jacob', username: 'jacob', status: 'active', start_date: '2019-01-01' }));
  kv.set(CC + ':pto_policy', JSON.stringify({ start_year: THIS_YEAR, approvers, versions: {} }));
}

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

async function call(handler, { as, method = 'GET', query = {}, body = null }) {
  const cookie = await makeCookie(as);
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie } }, res);
  return res;
}

const RYAN = { username: 'ryan', name: 'Ryan' };
const MEGAN = { username: 'megan', name: 'Megan' };
const JACOB = { username: 'jacob', name: 'Jacob' };
const SASHA = { username: 'sasha', name: 'Sasha' };
const DANA = { username: 'dana', name: 'Dana' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

function notesFor(user) {
  const out = [];
  kv.forEach((v, k) => {
    if (k.startsWith('notifications_data:note:')) {
      const n = JSON.parse(v);
      if (n.assignedTo === user) out.push(n);
    }
  });
  return out;
}

(async () => {
  const pto = await import(path.join(ROOT, 'lib/crewcore/pto.js'));
  const mail = await import(path.join(ROOT, 'lib/crewcore/pto-email.js'));
  const route = (await import(path.join(ROOT, 'api/crewcore/timeoff.js'))).default;
  const users = await import(path.join(ROOT, 'lib/users.js'));
  const reg = await import(path.join(ROOT, 'js/registry.js'));

  const doc = (versions, extra) => Object.assign({ start_year: 2026, approvers: [], versions: versions || {} }, extra || {});

  /* ==== 1. Grants ========================================================= */

  await check('a new hire gets the Handbook 80 hours, prorated from the start date', async () => {
    const p = pto.cleanPolicy(pto.DEFAULT_POLICY);
    t.equal(pto.grantFor({ start_date: '2026-01-01' }, 2026, p), 80, 'Jan 1 start is a full year');
    // Jul 2 2026 leaves 183 of 365 days: 80 * 183/365 = 40.1, nearest hour 40
    t.equal(pto.grantFor({ start_date: '2026-07-02' }, 2026, p), 40);
    t.equal(pto.grantFor({ start_date: '2026-12-31' }, 2026, p), 0, 'one day of 80 hours rounds to 0');
  });

  await check('proration can be switched off, and then a new hire gets the full amount', async () => {
    const p = pto.cleanPolicy({ ...pto.DEFAULT_POLICY, prorate_first_year: false });
    t.equal(pto.grantFor({ start_date: '2026-07-02' }, 2026, p), 80);
  });

  await check('the 120 hour tier starts on the first Jan 1 AFTER a full year, not before', async () => {
    const p = pto.cleanPolicy(pto.DEFAULT_POLICY);
    // Hired Mar 2025: Jan 1 2026 is under a year, so still the new hire tier.
    t.equal(pto.grantFor({ start_date: '2025-03-10' }, 2026, p), 80);
    t.equal(pto.grantFor({ start_date: '2025-03-10' }, 2027, p), 120);
    // Hired Jan 1 2025: exactly one full year on Jan 1 2026.
    t.equal(pto.grantFor({ start_date: '2025-01-01' }, 2026, p), 120);
  });

  await check('nobody is granted hours for a year before they started', async () => {
    t.equal(pto.grantFor({ start_date: '2027-02-01' }, 2026, pto.DEFAULT_POLICY), 0);
  });

  await check('more tiers are honoured, highest one reached wins', async () => {
    const p = pto.cleanPolicy({ tiers: [{ min_years: 0, hours: 80 }, { min_years: 1, hours: 120 }, { min_years: 10, hours: 160 }] });
    t.equal(pto.grantFor({ start_date: '2015-03-01' }, 2026, p), 160, '10 full years by Jan 1 2026');
    t.equal(pto.grantFor({ start_date: '2016-03-01' }, 2026, p), 120, '9 full years');
  });

  /* ==== 2. The ledger ===================================================== */

  await check('pending hours are shown but never taken off the balance', async () => {
    const b = pto.ptoBalance({
      employee: { start_date: '2015-01-01' },
      requests: [
        { start_date: '2026-05-04', end_date: '2026-05-04', hours: 8, status: 'approved' },
        { start_date: '2026-06-01', end_date: '2026-06-02', hours: 16, status: 'pending' },
        { start_date: '2026-07-01', end_date: '2026-07-01', hours: 8, status: 'denied' },
        { start_date: '2026-08-01', end_date: '2026-08-01', hours: 8, status: 'cancelled' },
      ],
      policyDoc: doc(),
    }, 2026);
    t.equal(b.start, 120);
    t.equal(b.used, 8);
    t.equal(b.pending, 16);
    t.equal(b.balance, 112, 'only approved hours come out');
    t.equal(b.after_pending, 96);
  });

  await check('unused hours carry over up to the cap and the rest lapses', async () => {
    const d = doc({ 2026: { carryover_cap_hours: 40 } });
    const rows = pto.ptoLedger({
      employee: { start_date: '2015-01-01' },
      requests: [{ start_date: '2026-05-04', end_date: '2026-05-05', hours: 16, status: 'approved' }],
      policyDoc: d, throughYear: 2027,
    });
    t.equal(rows[0].balance, 104, '2026: 120 minus 16');
    t.equal(rows[1].carried, 40, 'capped at 40');
    t.equal(rows[1].lapsed, 64);
    t.equal(rows[1].balance, 160, '2027: 120 granted plus 40 carried');
  });

  await check('a cap of 0 (the Handbook today) carries nothing', async () => {
    const rows = pto.ptoLedger({ employee: { start_date: '2015-01-01' }, policyDoc: doc(), throughYear: 2027 });
    t.equal(rows[1].carried, 0);
    t.equal(rows[1].balance, 120);
  });

  await check('a negative year carries nothing forward, it does not eat next year', async () => {
    const rows = pto.ptoLedger({
      employee: { start_date: '2015-01-01' },
      requests: [{ start_date: '2026-05-04', end_date: '2026-05-29', hours: 160, status: 'approved' }],
      policyDoc: doc({ 2026: { carryover_cap_hours: 40 } }), throughYear: 2027,
    });
    t.equal(rows[0].balance, -40, 'the overdraw is reported, not clamped away');
    t.equal(rows[1].carried, 0);
    t.equal(rows[1].balance, 120);
  });

  await check('a starting balance from QuickBooks replaces that one year, then the rules take over', async () => {
    const rows = pto.ptoLedger({
      employee: { start_date: '2015-01-01', pto_opening: { year: 2026, hours: 37.5 } },
      requests: [{ start_date: '2026-11-27', end_date: '2026-11-27', hours: 8, status: 'approved' }],
      policyDoc: doc({ 2026: { carryover_cap_hours: 40 } }), throughYear: 2027,
    });
    t.equal(rows[0].source, 'opening');
    t.equal(rows[0].grant, 0, 'no grant on top of the starting balance');
    t.equal(rows[0].balance, 29.5);
    t.equal(rows[1].carried, 29.5);
    t.equal(rows[1].balance, 149.5);
  });

  await check('adjustments land in their own year', async () => {
    const b = pto.ptoBalance({
      employee: { start_date: '2015-01-01' },
      adjustments: [{ year: 2026, hours: 6, reason: 'event' }, { year: 2025, hours: 50, reason: 'old' }, { year: 2026, hours: -2, reason: 'fix' }],
      policyDoc: doc(),
    }, 2026);
    t.equal(b.adjusted, 4);
    t.equal(b.balance, 124);
  });

  await check('changing the cap in 2027 does not rewrite what carried out of 2025', async () => {
    let d = doc({}, { start_year: 2025 });
    d = pto.withPolicyVersion(d, 2025, { carryover_cap_hours: 16 }, 'ryan');
    d = pto.withPolicyVersion(d, 2027, { carryover_cap_hours: 80 }, 'ryan');
    const rows = pto.ptoLedger({ employee: { start_date: '2015-01-01' }, policyDoc: d, throughYear: 2027 });
    t.equal(rows[1].carried, 16, 'Jan 1 2026 used the cap in force for 2026');
    t.equal(rows[2].carried, 80, 'Jan 1 2027 uses the new cap');
  });

  await check('the first policy save freezes the defaults for years already tracked', async () => {
    const d = pto.withPolicyVersion(doc({}, { start_year: 2026 }), 2027, { tiers: [{ min_years: 0, hours: 200 }] }, 'ryan');
    t.equal(pto.policyForYear(d, 2026).tiers[0].hours, 80, '2026 keeps the Handbook numbers');
    t.equal(pto.policyForYear(d, 2027).tiers[0].hours, 200);
  });

  await check('saving one field keeps the rest of the version', async () => {
    const v = pto.validatePolicy({ carryover_cap_hours: 24 });
    t.assert(v.ok);
    t.equal(Object.keys(v.policy).join(), 'carryover_cap_hours', 'only what was sent');
    let d = pto.withPolicyVersion(doc(), 2026, { tiers: [{ min_years: 0, hours: 60 }, { min_years: 3, hours: 100 }] }, 'ryan');
    d = pto.withPolicyVersion(d, 2026, v.policy, 'ryan');
    t.equal(pto.policyForYear(d, 2026).tiers.length, 2, 'tiers survived a cap-only save');
    t.equal(pto.policyForYear(d, 2026).carryover_cap_hours, 24);
  });

  /* ==== 3. Validation ===================================================== */

  await check('a request across New Year is refused and asked to be split', async () => {
    const v = pto.validateRequest({ start_date: '2026-12-30', end_date: '2027-01-02', hours: 16 });
    t.equal(v.ok, false);
    t.assert(/two requests/.test(v.errors.join()), v.errors.join());
  });

  await check('a half day is fine, more hours than the days hold is not', async () => {
    t.assert(pto.validateRequest({ start_date: '2026-05-04', end_date: '2026-05-04', hours: 4 }).ok);
    t.equal(pto.validateRequest({ start_date: '2026-05-04', end_date: '2026-05-04', hours: 25 }).ok, false);
    t.equal(pto.validateRequest({ start_date: '2026-05-05', end_date: '2026-05-04', hours: 8 }).ok, false);
    t.equal(pto.validateRequest({ start_date: '2026-05-04', hours: 0 }).ok, false);
  });

  await check('the hours estimate counts weekdays only', async () => {
    // Fri May 1 to Mon May 4 2026: Fri + Mon
    t.equal(pto.estimateHours('2026-05-01', '2026-05-04', pto.DEFAULT_POLICY), 16);
    t.equal(pto.estimateHours('2026-05-02', '2026-05-03', pto.DEFAULT_POLICY), 0, 'a weekend is 0');
  });

  await check('an adjustment needs a reason and cannot be zero', async () => {
    t.equal(pto.validateAdjustment({ year: 2026, hours: 4 }).ok, false);
    t.equal(pto.validateAdjustment({ year: 2026, hours: 0, reason: 'x' }).ok, false);
    t.assert(pto.validateAdjustment({ year: 2026, hours: -4, reason: 'correction' }).ok);
  });

  await check('a policy with no 0-year tier is refused, or new hires get nothing', async () => {
    const v = pto.validatePolicy({ tiers: [{ min_years: 1, hours: 120 }] });
    t.equal(v.ok, false);
  });

  await check('an empty approver list means nobody approves, never "any admin"', async () => {
    t.equal(pto.canApprove('ryan', doc()), false);
    t.equal(pto.canApprove('Ryan ', doc({}, { approvers: ['ryan'] })), true, 'username match ignores case and spaces');
    t.equal(pto.canApprove('', doc({}, { approvers: ['ryan'] })), false);
  });

  await check('an employee can cancel their own request only while it is pending', async () => {
    const own = { isOwner: true };
    t.equal(pto.requestActions({ status: 'pending' }, own).cancel, true);
    t.equal(pto.requestActions({ status: 'approved' }, own).cancel, false);
    t.equal(pto.requestActions({ status: 'approved' }, { isApprover: true }).cancel, true);
    t.equal(pto.requestActions({ status: 'pending' }, own).approve, false);
  });

  /* ==== 4. The route ====================================================== */

  await check('an employee requests time off, it lands pending, and both approvers hear about it', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { ...DAYS(2), note: 'dentist' } });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.request.status, 'pending');
    t.equal(r.body.request.employee_id, 'EMP-1');
    t.equal(notesFor('ryan').length, 1);
    t.equal(notesFor('megan').length, 1);
    const n = notesFor('ryan')[0];
    t.assert(!/dentist/.test(n.title + n.detail), 'the note never goes into a notification everyone can read');
  });

  await check('an employee sees only their own balance and requests, no pay or notes', async () => {
    seed();
    await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: DANA, method: 'POST', body: DAYS(1) });
    const r = await call(route, { as: DANA });
    t.equal(r.body.scope, 'self');
    t.equal(r.body.requests.length, 1);
    t.equal(r.body.requests[0].employee_id, 'EMP-2');
    t.equal(r.body.team, undefined);
    t.equal(r.body.balance.pending, 8);
  });

  await check('an employee cannot approve, even their own request', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    const r = await call(route, { as: SASHA, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 403);
  });

  await check('a CrewCore admin who is not on the approver list cannot approve', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    const r = await call(route, { as: JACOB, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 403, 'Admin flag alone is not approval rights');
    const g = await call(route, { as: JACOB });
    t.equal(g.body.scope, 'team', 'but an admin can see the team');
  });

  await check('Megan approves without the Admin flag, the hours come off, and Sasha is told', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(2) });
    const r = await call(route, { as: MEGAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 200, JSON.stringify(r.body));
    t.equal(r.body.request.status, 'approved');
    t.equal(r.body.request.decided_by, 'megan');
    const mine = await call(route, { as: SASHA });
    t.equal(mine.body.balance.used, 16);
    t.equal(mine.body.balance.pending, 0);
    t.equal(notesFor('sasha').length, 1);
    t.assert(/approved/.test(notesFor('sasha')[0].title));
  });

  await check('with no approvers set, nobody can approve, not even Ryan', async () => {
    seed({ approvers: [] });
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    t.equal(made.body.approvers_set, false, 'the screen is told so it can say it');
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 403);
  });

  await check('a decided request cannot be decided again', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'deny', id: made.body.request.id } });
    const r = await call(route, { as: MEGAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 409);
  });

  await check('an employee cannot cancel an approved request; an approver can', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    const id = made.body.request.id;
    await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'approve', id } });
    const no = await call(route, { as: SASHA, method: 'POST', body: { action: 'cancel', id } });
    t.equal(no.statusCode, 403);
    const yes = await call(route, { as: RYAN, method: 'POST', body: { action: 'cancel', id } });
    t.equal(yes.body.request.status, 'cancelled');
  });

  await check('an employee cannot request on somebody else\'s behalf', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { employee_id: 'EMP-2', start_date: `${THIS_YEAR}-06-01`, hours: 8 } });
    t.equal(r.statusCode, 403);
  });

  await check('an approver can log a phoned-in sick day as already approved', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { employee_id: 'EMP-2', start_date: `${THIS_YEAR}-06-01`, hours: 8, approved: true } });
    t.equal(r.statusCode, 201);
    t.equal(r.body.request.status, 'approved');
    t.equal(notesFor('megan').length, 0, 'nothing to approve, so nobody is nudged');
  });

  await check('an employee asking for approved:true still lands in the queue', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { ...DAYS(1), approved: true } });
    t.equal(r.body.request.status, 'pending');
  });

  await check('going over the balance warns, it does not block', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { type: 'all_days', start_date: MON, return_date: plus(MON, 35) } });
    t.equal(r.statusCode, 201);
    t.equal(r.body.over_by, 80, 'Sasha has 120, asked for 200');
  });

  await check('only approvers adjust a balance', async () => {
    seed();
    const no = await call(route, { as: JACOB, method: 'POST', body: { action: 'adjust', employee_id: 'EMP-1', year: THIS_YEAR, hours: 4, reason: 'event' } });
    t.equal(no.statusCode, 403);
    const yes = await call(route, { as: MEGAN, method: 'POST', body: { action: 'adjust', employee_id: 'EMP-1', year: THIS_YEAR, hours: 4, reason: 'event' } });
    t.equal(yes.statusCode, 201);
    const mine = await call(route, { as: SASHA });
    t.equal(mine.body.balance.balance, 124, '120 granted + 4 adjusted');
  });

  await check('the starting balance action is gone, but ones already entered still count', async () => {
    seed();
    const op = await call(route, { as: RYAN, method: 'POST', body: { action: 'opening', employee_id: 'EMP-1', year: THIS_YEAR, hours: 30 } });
    t.equal(op.statusCode, 400, 'no longer an action');
    const e = JSON.parse(kv.get(CC + ':employee:EMP-1'));
    e.pto_opening = { year: THIS_YEAR, hours: 30 };
    kv.set(CC + ':employee:EMP-1', JSON.stringify(e));
    const mine = await call(route, { as: SASHA });
    t.equal(mine.body.balance.balance, 30);
  });

  /* ---- PTO exempt ------------------------------------------------------- */

  await check('an exempt person has no balance and their time off is approved on the spot', async () => {
    seed();
    const e = JSON.parse(kv.get(CC + ':employee:EMP-3'));
    e.pto_exempt = true;
    kv.set(CC + ':employee:EMP-3', JSON.stringify(e));
    const r = await call(route, { as: MEGAN, method: 'POST', body: DAYS(5) });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.request.status, 'approved');
    t.equal(r.body.over_by, 0, 'no balance to go over');
    t.equal(notesFor('ryan').length, 0, 'nobody is asked');
    const team = await call(route, { as: RYAN });
    const m = team.body.team.find((p) => p.id === 'EMP-3');
    t.equal(m.pto_exempt, true);
    t.equal(m.balance, null);
    const out = team.body.requests.filter((q) => q.employee_id === 'EMP-3' && q.status === 'approved');
    t.equal(out.length, 1, 'still on who is out');
  });

  await check('an exempt employee who is not an approver sees the exempt screen, no balance', async () => {
    seed();
    const e = JSON.parse(kv.get(CC + ':employee:EMP-2'));
    e.pto_exempt = true;
    kv.set(CC + ':employee:EMP-2', JSON.stringify(e));
    const mine = await call(route, { as: DANA });
    t.equal(mine.body.scope, 'self');
    t.equal(mine.body.exempt, true);
    t.equal(mine.body.balance, null);
    const r = await call(route, { as: DANA, method: 'POST', body: DAYS(1) });
    t.equal(r.body.request.status, 'approved');
    t.equal(r.body.request.decided_by, 'exempt');
  });

  await check('exempt only skips the queue for the exempt person, nobody else', async () => {
    seed();
    const e = JSON.parse(kv.get(CC + ':employee:EMP-3'));
    e.pto_exempt = true;
    kv.set(CC + ':employee:EMP-3', JSON.stringify(e));
    const r = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    t.equal(r.body.request.status, 'pending');
  });

  await check('the team view carries names and hours, never pay or notes', async () => {
    seed();
    const r = await call(route, { as: RYAN });
    t.equal(r.body.scope, 'team');
    const s = r.body.team.find((p) => p.id === 'EMP-1');
    t.equal(s.hourly_rate, undefined);
    t.equal(s.notes, undefined);
    t.equal(s.balance.start, 120);
  });

  await check('only a CrewCore admin edits the policy; an approver without the flag cannot', async () => {
    seed();
    const no = await call(route, { as: MEGAN, method: 'PATCH', body: { carryover_cap_hours: 40 } });
    t.equal(no.statusCode, 403);
    const yes = await call(route, { as: RYAN, method: 'PATCH', body: { carryover_cap_hours: 40, approvers: ['Megan', 'ryan'] } });
    t.equal(yes.statusCode, 200, JSON.stringify(yes.body));
    t.equal(yes.body.policy.carryover_cap_hours, 40);
    t.equal(yes.body.policy_doc.approvers.join(), 'megan,ryan');
  });

  await check('the first read pins the year tracking started, so Jan 1 cannot forget it', async () => {
    seed();
    kv.delete(CC + ':pto_policy');
    await call(route, { as: SASHA });
    const stored = JSON.parse(kv.get(CC + ':pto_policy'));
    t.equal(stored.start_year, THIS_YEAR);
  });

  /* ==== 4b. Request types (the old Jotform's five) ====================== */

  await check('each request type works out its own hours from an 8 to 5 day with lunch 12 to 1', async () => {
    const p = pto.DEFAULT_POLICY;
    t.equal(pto.hoursForRequest({ type: 'half_day', half: 'morning' }, p), 4);
    t.equal(pto.hoursForRequest({ type: 'arrive_late', arrive_at: '10:00' }, p), 2);
    t.equal(pto.hoursForRequest({ type: 'arrive_late', arrive_at: '13:30' }, p), 4.5, 'lunch in the gap is not time off');
    t.equal(pto.hoursForRequest({ type: 'leave_early', leave_at: '15:00' }, p), 2);
    t.equal(pto.hoursForRequest({ type: 'leave_early', leave_at: '11:00' }, p), 5, 'not 6: lunch is not counted');
    t.equal(pto.hoursForRequest({ type: 'appointment', leave_at: '13:00', return_at: '15:00' }, p), 2);
    t.equal(pto.hoursForRequest({ type: 'appointment', leave_at: '11:30', return_at: '13:30' }, p), 1, 'half hour either side of lunch');
    t.equal(pto.hoursForRequest({ type: 'appointment', leave_at: '06:00', return_at: '09:00' }, p), 1, 'before the shift does not count');
  });

  await check('all day(s) runs from the first day off up to the day back at work', async () => {
    // Mon to back Wed = Mon + Tue. Fri to back Mon = Fri only.
    t.equal(pto.hoursForRequest({ type: 'all_days', start_date: '2026-06-01', return_date: '2026-06-03' }, pto.DEFAULT_POLICY), 16);
    t.equal(pto.hoursForRequest({ type: 'all_days', start_date: '2026-06-05', return_date: '2026-06-08' }, pto.DEFAULT_POLICY), 8);
    const v = pto.validateRequest({ type: 'all_days', start_date: '2026-06-05', return_date: '2026-06-08' }, pto.DEFAULT_POLICY);
    t.equal(v.record.end_date, '2026-06-07', 'last day off is the day before coming back');
    t.equal(v.record.hours, 8);
  });

  await check('a different shift in Settings changes the math', async () => {
    const p = { ...pto.DEFAULT_POLICY, shift_start: '07:00', shift_end: '15:30', lunch_start: '11:00', lunch_end: '11:30' };
    t.equal(pto.hoursForRequest({ type: 'leave_early', leave_at: '13:30' }, p), 2);
    t.equal(pto.hoursForRequest({ type: 'arrive_late', arrive_at: '12:00' }, p), 4.5);
  });

  await check('each type asks for its own fields, like the Jotform did', async () => {
    const p = pto.DEFAULT_POLICY;
    t.equal(pto.validateRequest({ type: 'half_day', start_date: '2026-06-01' }, p).ok, false, 'morning or afternoon required');
    t.equal(pto.validateRequest({ type: 'arrive_late', start_date: '2026-06-01' }, p).ok, false, 'arrival time required');
    t.equal(pto.validateRequest({ type: 'appointment', start_date: '2026-06-01', leave_at: '15:00', return_at: '14:00' }, p).ok, false, 'back after leaving');
    t.equal(pto.validateRequest({ type: 'all_days', start_date: '2026-06-03', return_date: '2026-06-03' }, p).ok, false, 'back after the first day off');
    t.equal(pto.validateRequest({ type: 'leave_early', start_date: '2026-06-01', leave_at: '17:30' }, p).ok, false, 'leaving after the day ends is 0 hours');
    t.equal(pto.validateRequest({ type: 'vacation', start_date: '2026-06-01' }, p).ok, false, 'unknown type');
  });

  await check('an employee cannot set their own hours; the math wins', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { type: 'leave_early', start_date: MON, leave_at: '15:00', hours: 0.25 } });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.request.hours, 2);
  });

  await check('an employee has to pick a type', async () => {
    seed();
    const r = await call(route, { as: SASHA, method: 'POST', body: { start_date: MON, hours: 8 } });
    t.equal(r.statusCode, 400);
  });

  await check('an approver can override the hours, and it is marked as overridden', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { ...DAYS(5), employee_id: 'EMP-2', hours: 32, approved: true } });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.request.hours, 32, 'a holiday inside the week');
    t.equal(r.body.request.hours_computed, 40);
    t.equal(r.body.request.hours_overridden, true);
  });

  await check('a partial day says what kind in the notification', async () => {
    seed();
    await call(route, { as: SASHA, method: 'POST', body: { type: 'appointment', start_date: MON, leave_at: '13:00', return_at: '15:00', reason: 'dentist' } });
    const n = notesFor('megan')[0];
    t.assert(/Appointment 1:00 PM to 3:00 PM/.test(n.detail), n.detail);
    t.assert(!/dentist/.test(n.title + n.detail), 'the reason still stays out');
  });

  await check('shift times in Settings are checked', async () => {
    t.equal(pto.validatePolicy({ shift_start: '17:00', shift_end: '08:00' }).ok, false);
    t.equal(pto.validatePolicy({ shift_start: '8am' }).ok, false);
    const v = pto.validatePolicy({ shift_start: '07:00', shift_end: '15:30' });
    t.assert(v.ok);
    t.equal(v.policy.shift_start, '07:00');
  });

  /* ==== 4c. Emailing the employee ======================================= */

  await check('approving emails the employee, from the default address, replies to the approver', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: { ...DAYS(2), note: 'dentist' } });
    const r = await call(route, { as: MEGAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 200);
    t.equal(sentMail.length, 1);
    const m = sentMail[0];
    t.equal(m.to[0], 'sasha@example.com');
    t.equal(m.from, 'P&M Apparel <Ryan@pmapparel.com>');
    t.equal(m.reply_to, 'megan@pmapparel.com', 'replies go to whoever decided');
    t.assert(/approved/.test(m.subject), m.subject);
    t.assert(/Hi Sasha,/.test(m.text), 'first name only');
    t.assert(/You have 104 hours of PTO left/.test(m.text), m.text);
    t.assert(!/dentist/.test(m.text + m.html), 'the reason they gave is not in the email');
    t.equal(r.body.request.email.sent, true, 'recorded on the request so the screen can say so');
  });

  await check('a denial carries the approver\'s note', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'deny', id: made.body.request.id, note: 'Big order that week' } });
    t.assert(/denied/.test(sentMail[0].subject));
    t.assert(/Big order that week/.test(sentMail[0].text));
    t.assert(!/PTO left/.test(sentMail[0].text), 'no balance line on a denial');
  });

  await check('cancelling your own request sends nothing; an approver cancelling does', async () => {
    seed();
    const a = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: SASHA, method: 'POST', body: { action: 'cancel', id: a.body.request.id } });
    t.equal(sentMail.length, 0);
    const b = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: RYAN, method: 'POST', body: { action: 'cancel', id: b.body.request.id } });
    t.equal(sentMail.length, 1);
    t.assert(/cancelled/.test(sentMail[0].subject));
  });

  await check('time off an approver logs for somebody is emailed to them', async () => {
    seed();
    await call(route, { as: RYAN, method: 'POST', body: { employee_id: 'EMP-1', type: 'half_day', half: 'afternoon', start_date: MON, approved: true } });
    t.equal(sentMail.length, 1);
    t.assert(/logged for you/.test(sentMail[0].subject), sentMail[0].subject);
    t.assert(/Half day, afternoon/.test(sentMail[0].text));
  });

  await check('no email on the roster record: the decision stands and the reason is recorded', async () => {
    seed();
    const made = await call(route, { as: DANA, method: 'POST', body: DAYS(1) });
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 200);
    t.equal(r.body.request.status, 'approved');
    t.equal(sentMail.length, 0);
    t.equal(r.body.request.email.sent, false);
    t.assert(/no email on their roster record/.test(r.body.request.email.why));
  });

  await check('Resend failing never costs the approval', async () => {
    seed();
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    resendDown = true;
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(r.statusCode, 200);
    t.equal(r.body.request.status, 'approved');
    t.equal(r.body.request.email.sent, false);
    t.assert(/Resend is down/.test(r.body.request.email.why), r.body.request.email.why);
  });

  await check('the from-address is a setting, and must be an address', async () => {
    seed();
    const bad = await call(route, { as: RYAN, method: 'PATCH', body: { email_from: 'hr at pmapparel' } });
    t.equal(bad.statusCode, 400);
    await call(route, { as: RYAN, method: 'PATCH', body: { email_from: 'hr@pmapparel.com' } });
    const made = await call(route, { as: SASHA, method: 'POST', body: DAYS(1) });
    await call(route, { as: RYAN, method: 'POST', body: { action: 'decide', decision: 'approve', id: made.body.request.id } });
    t.equal(sentMail[0].from, 'P&M Apparel <hr@pmapparel.com>');
    t.equal(sentMail[0].reply_to, 'hr@pmapparel.com', 'Ryan has no roster email here, so replies go to the from-address');
  });

  await check('the email says partial days in words', async () => {
    const m = mail.buildDecisionEmail({
      request: { type: 'leave_early', start_date: '2026-10-02', end_date: '2026-10-02', leave_at: '15:00', hours: 2 },
      event: 'approved', firstName: 'Sasha', byName: 'Megan',
    });
    t.assert(/Friday, October 2, 2026/.test(m.text), m.text);
    t.assert(/Leaving 3:00 PM/.test(m.text));
    t.assert(/2 hours/.test(m.text));
    t.assert(/Megan approved/.test(m.html));
  });

  /* ==== 5. Who gets the tab ============================================== */

  await check('every CrewCore account gets Time Off, even one narrowed by hand before it existed', async () => {
    seed();
    const u = JSON.parse(kv.get(P + 'users'));
    u.dana.access = { apps: ['crewcore'], views: { crewcore: ['dashboard', 'stipend'] } };
    u.sasha.access = { apps: ['crewcore'] };
    kv.set(P + 'users', JSON.stringify(u));
    const dana = await users.permsFor ? await users.permsFor('dana') : null;
    if (!dana) throw new Error('permsFor is not exported from lib/users.js');
    t.assert(dana.tabs.includes('crewcore:timeoff'), JSON.stringify(dana.tabs));
    t.assert(!dana.tabs.includes('crewcore:roster'), 'the ceiling still holds');
    t.assert(!dana.tabs.includes('crewcore:reviews'), 'her narrowing is still honoured, Time Off is added, nothing else is');
    const views = reg.allowedViews({ tabs: dana.tabs }, 'crewcore');
    t.assert(views.includes('timeoff'), 'and the rail draws it: ' + views.join());
  });

  await check('an account without CrewCore does not get Time Off', async () => {
    seed();
    const u = JSON.parse(kv.get(P + 'users'));
    u.dana.access = { apps: ['shopstock'] };
    kv.set(P + 'users', JSON.stringify(u));
    const dana = await users.permsFor('dana');
    t.assert(!dana.tabs.includes('crewcore:timeoff'), JSON.stringify(dana.tabs));
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-timeoff could not run: ' + (e && e.stack || e));
  process.exit(1);
});
