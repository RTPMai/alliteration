// PUT IN: test/crewcore-ira.test.cjs
/**
 * CrewCore SIMPLE IRA sign-up (Sep 30 2026, Ryan's call: "Election + packet
 * status").
 *
 * The rules are real calls into lib/crewcore/ira.js. The access checks CALL
 * the real route handlers (api/crewcore/ira.js, api/crewcore/employees.js,
 * api/crewcore/settings.js) with real signed sessions over a fake Upstash,
 * the same way crewcore-timeoff.test.cjs does.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';

global.fetch = async (url, opts) => {
  const raw = String(url);
  // Notifications talk to Upstash through /pipeline.
  if (/\/pipeline$/.test(raw)) {
    const cmds = JSON.parse(opts.body);
    const out = cmds.map(([op, key, val]) => {
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
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
process.env.SESSION_SECRET = 'test-secret-for-crewcore-ira';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  superuser: true },
    megan: { username: 'megan', name: 'Megan', superuser: true },
    sasha: { username: 'sasha', name: 'Sasha' },
    dana:  { username: 'dana',  name: 'Dana' },
    boss:  { username: 'boss',  name: 'Boss' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4', 'EMP-5']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({ id: 'EMP-1', name: 'Sasha Smith', username: 'sasha', status: 'active', start_date: '2015-03-01', reports_to: 'EMP-5' }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({ id: 'EMP-2', name: 'Dana Jones', username: 'dana', status: 'active', start_date: '2018-06-01',
    ira: { status: 'enrolled', contribution_type: 'percent', contribution: 4, packet_returned: false, history: [] } }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({ id: 'EMP-3', name: 'Ryan Toney', username: 'ryan', status: 'active', start_date: '2000-01-01' }));
  kv.set(CC + ':employee:EMP-4', JSON.stringify({ id: 'EMP-4', name: 'Megan Griffith', username: 'megan', status: 'active', start_date: '2000-01-01' }));
  // A supervisor with no admin flag, so "supervisor views" are covered.
  kv.set(CC + ':employee:EMP-5', JSON.stringify({ id: 'EMP-5', name: 'Boss Person', username: 'boss', status: 'active', start_date: '2010-01-01' }));
  kv.set(CC + ':pto_policy', JSON.stringify({ start_year: 2026, approvers: ['ryan', 'megan'], versions: {} }));
}

function stored(id) {
  const raw = kv.get(CC + ':employee:' + id);
  return raw ? JSON.parse(raw) : null;
}

function notices() {
  const out = [];
  for (const [k, v] of kv.entries()) {
    if (/^notifications_data:note:/.test(k) && typeof v === 'string' && v.includes('"assignedTo"')) {
      try { out.push(JSON.parse(v)); } catch (e) { /* not a record */ }
    }
  }
  return out;
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
const SASHA = { username: 'sasha', name: 'Sasha' };
const DANA = { username: 'dana', name: 'Dana' };
const BOSS = { username: 'boss', name: 'Boss' };

(async () => {
  const ira = await import(path.join(ROOT, 'lib/crewcore/ira.js'));
  const schema = await import(path.join(ROOT, 'lib/crewcore/schema.js'));
  const route = (await import(path.join(ROOT, 'api/crewcore/ira.js'))).default;
  const employees = (await import(path.join(ROOT, 'api/crewcore/employees.js'))).default;
  const settings = (await import(path.join(ROOT, 'api/crewcore/settings.js'))).default;
  const timeoff = (await import(path.join(ROOT, 'api/crewcore/timeoff.js'))).default;
  const { validateIraElection: v } = ira;

  /* ---- validation ------------------------------------------------------ */

  await t.test('a choice is required', () => {
    t.equal(v({}).ok, false);
    t.equal(v({ status: 'maybe' }).ok, false);
    t.equal(v({ status: 'undecided' }).ok, false, 'undecided is not something you pick');
  });

  await t.test('0% and 101% are refused, 100% and 0.01% are fine', () => {
    t.equal(v({ status: 'enrolled', percent: 0 }).ok, false, '0%');
    t.equal(v({ status: 'enrolled', percent: '0' }).ok, false, '"0"');
    t.equal(v({ status: 'enrolled', percent: 101 }).ok, false, '101%');
    t.equal(v({ status: 'enrolled', percent: -3 }).ok, false, 'negative');
    t.equal(v({ status: 'enrolled', percent: 100 }).ok, true, '100%');
    t.equal(v({ status: 'enrolled', percent: 0.01 }).value.contribution, 0.01);
  });

  await t.test('percent keeps at most two decimals', () => {
    t.equal(v({ status: 'enrolled', percent: '3.125' }).ok, false);
    const ok = v({ status: 'enrolled', percent: '3.5%' });
    t.equal(ok.ok, true, 'a typed % sign is fine');
    t.equal(ok.value.contribution_type, 'percent');
    t.equal(ok.value.contribution, 3.5);
  });

  await t.test('dollars go to the cent and must be more than 0', () => {
    t.equal(v({ status: 'enrolled', dollars: 0 }).ok, false);
    t.equal(v({ status: 'enrolled', dollars: '12.345' }).ok, false);
    t.equal(v({ status: 'enrolled', dollars: 'abc' }).ok, false);
    const ok = v({ status: 'enrolled', dollars: '$1,050.25' });
    t.equal(ok.ok, true);
    t.equal(ok.value.contribution_type, 'dollars');
    t.equal(ok.value.contribution, 1050.25);
  });

  await t.test('enrolled needs exactly one of percent or dollars', () => {
    const both = v({ status: 'enrolled', percent: 3, dollars: 50 });
    t.equal(both.ok, false);
    t.assert(both.errors.join(' ').includes('not both'), 'says why');
    t.equal(v({ status: 'enrolled' }).ok, false, 'neither');
    t.equal(v({ status: 'enrolled', percent: '', dollars: '' }).ok, false, 'blank both');
  });

  await t.test('declined ignores any amount or start date sent with it', () => {
    const r = v({ status: 'declined', percent: 500, dollars: 'junk', start_date: 'nope' });
    t.equal(r.ok, true);
    t.equal(r.value.contribution, null);
    t.equal(r.value.contribution_type, null);
    t.equal(r.value.start_date, null);
  });

  await t.test('start date is optional and must be a real date', () => {
    t.equal(v({ status: 'enrolled', percent: 3, start_date: '2026-02-30' }).ok, false);
    t.equal(v({ status: 'enrolled', percent: 3, start_date: '10/1/2026' }).ok, false);
    t.equal(v({ status: 'enrolled', percent: 3, start_date: '2026-10-01' }).value.start_date, '2026-10-01');
    t.equal(v({ status: 'enrolled', percent: 3, start_date: '' }).value.start_date, null);
  });

  /* ---- applying ------------------------------------------------------- */

  await t.test('history is kept and capped', () => {
    let emp = { id: 'E', ira: null };
    for (let i = 1; i <= ira.IRA_HISTORY_CAP + 7; i++) {
      emp = { ...emp, ira: ira.applyElection(emp, v({ status: 'enrolled', percent: i }).value, { by: 'sasha', now: '2026-09-30T00:00:' + String(i).padStart(2, '0') + 'Z' }) };
    }
    t.equal(emp.ira.history.length, ira.IRA_HISTORY_CAP);
    t.assert(emp.ira.history[ira.IRA_HISTORY_CAP - 1].what.includes((ira.IRA_HISTORY_CAP + 7) + '%'), 'the newest is kept');
    t.assert(!emp.ira.history.some((h) => / 1% /.test(h.what + ' ')), 'the oldest is dropped');
  });

  await t.test('the same choice twice is not a second history line', () => {
    const e1 = { ira: ira.applyElection({}, v({ status: 'declined' }).value, { by: 'x' }) };
    const e2 = ira.applyElection(e1, v({ status: 'declined' }).value, { by: 'x' });
    t.equal(e2.history.length, 1);
  });

  await t.test('changing after the packet came back flags a new packet', () => {
    let emp = { ira: ira.applyElection({}, v({ status: 'enrolled', percent: 3 }).value, { by: 'sasha' }) };
    t.equal(ira.packetOutstanding(emp.ira), true, 'enrolled, no packet yet');
    emp = { ira: ira.markPacket(emp, true, { by: 'ryan' }) };
    t.equal(emp.ira.packet_returned, true);
    t.equal(emp.ira.packet_by, 'ryan');
    t.equal(ira.packetOutstanding(emp.ira), false, 'packet in hand');
    emp = { ira: ira.applyElection(emp, v({ status: 'enrolled', dollars: 40 }).value, { by: 'sasha' }) };
    t.equal(emp.ira.packet_returned, true, 'the old packet is still on file');
    t.equal(emp.ira.changed_after_packet, true);
    t.equal(ira.packetOutstanding(emp.ira), true, 'counts as a packet to collect again');
    emp = { ira: ira.markPacket(emp, true, { by: 'ryan' }) };
    t.equal(emp.ira.changed_after_packet, false, 'marking it returned clears the flag');
    // Declining after a packet also needs paperwork for payroll.
    emp = { ira: ira.applyElection(emp, v({ status: 'declined' }).value, { by: 'sasha' }) };
    t.equal(emp.ira.changed_after_packet, true);
    t.equal(ira.packetOutstanding(emp.ira), true);
  });

  await t.test('labels the screen and the sheet share', () => {
    t.equal(ira.iraLabel(null), 'Not chosen yet');
    t.equal(ira.iraLabel({ status: 'declined' }), 'Declined');
    t.equal(ira.iraLabel({ status: 'enrolled', contribution_type: 'percent', contribution: 3 }), 'Enrolled, 3% of each paycheck');
    t.equal(ira.iraLabel({ status: 'enrolled', contribution_type: 'dollars', contribution: 50 }), 'Enrolled, $50.00 per paycheck');
    t.assert(ira.iraPlanInfo(3).some((l) => l.includes('up to 3%')), 'the match shows in the plan info');
    t.assert(!ira.iraPlanInfo(3).join(' ').includes('\u2014'), 'no em dashes in staff-facing text');
  });

  await t.test('the notification never carries the amount, the name or the choice', () => {
    // Notifications are team-visible. Who enrolled or declined a retirement
    // plan belongs on the admin-only sign-up sheet, not in everyone's feed.
    const n = ira.iraNoticeText('Sasha Smith', { status: 'enrolled', contribution_type: 'dollars', contribution: 75 });
    t.equal(n.title, 'IRA sign-up: a choice to review, packet to collect');
    t.assert(!/75|Sasha|enroll|declin/i.test(n.title + n.detail), 'no amount, name or choice');
    const d = ira.iraNoticeText('Dana', { status: 'declined' });
    t.equal(d.title, 'IRA sign-up: a choice to review');
    t.assert(!/Dana|declin/i.test(d.title + d.detail), 'a decline is not announced either');
  });

  /* ---- the sign-up sheet --------------------------------------------- */

  await t.test('each choice names its box on the paper Salary Deferral Election page', () => {
    const v = ira.validateIraElection;
    const first = ira.applyElection({}, v({ status: 'enrolled', percent: 4, start_date: '2026-11-01' }).value);
    t.equal(first.form_box, 'A', 'first time enrolling is box A');
    t.equal(ira.formInstructions(first),
      'On the Salary Deferral Election page, check box A (New election for a new account), write 4%, effective date 11/01/2026, then sign and date it. Include the American Funds application pages if you have never had this account.');
    const change = ira.applyElection({ ira: first }, v({ status: 'enrolled', dollars: 50 }).value);
    t.equal(change.form_box, 'B', 'a new amount is box B');
    t.assert(/write \$50\.00, and fill in an effective date/.test(ira.formInstructions(change)), 'asks for a date when none was given');
    const stop = ira.applyElection({ ira: change }, v({ status: 'declined', start_date: '2027-01-01' }).value);
    t.equal(stop.form_box, 'D', 'declining after enrolling is box D');
    t.equal(stop.start_date, '2027-01-01', 'a stop keeps its effective date');
    const never = ira.applyElection({}, v({ status: 'declined' }).value);
    t.equal(never.form_box, 'E', 'a first-time no is box E');
    t.assert(!/effective/.test(ira.formInstructions(never)), 'box E has no date');
    t.equal(ira.formInstructions(null), '');
    t.assert(!/\u2014/.test(ira.formInstructions(first) + ira.STOP_WARNING), 'no em dashes');
  });

  await t.test('summary counts leave out terminated people', () => {
    const s = ira.iraSummary([
      { id: '1', name: 'A', status: 'active', ira: { status: 'enrolled', contribution_type: 'percent', contribution: 3, packet_returned: false } },
      { id: '2', name: 'B', status: 'active', ira: { status: 'enrolled', contribution_type: 'percent', contribution: 3, packet_returned: true } },
      { id: '3', name: 'C', status: 'on_leave', ira: { status: 'declined' } },
      { id: '4', name: 'D', status: 'active' },
      { id: '5', name: 'E', status: 'terminated', ira: { status: 'enrolled', contribution_type: 'percent', contribution: 3 } },
      { id: '6', name: 'F', status: 'active', ira: { status: 'declined', packet_returned: true, changed_after_packet: true } },
    ]);
    t.equal(s.counts.total, 5);
    t.equal(s.counts.enrolled, 2);
    t.equal(s.counts.declined, 2);
    t.equal(s.counts.undecided, 1);
    t.equal(s.counts.packet_outstanding, 2, 'A has none in, F changed after theirs');
    t.assert(!s.rows.some((r) => r.id === '5'), 'terminated is not on the sheet');
    const csv = ira.iraSummaryCsv(s);
    t.equal(csv.split('\n').length, 6, 'header plus five rows');
    t.assert(csv.split('\n')[1].startsWith('A,'), 'rows sorted by name');
  });

  /* ---- settings ------------------------------------------------------- */

  await t.test('the packet link defaults to the Drive PDF and only takes web links', () => {
    t.equal(schema.defaultSettings().ira_packet_url, ira.DEFAULT_IRA_PACKET_URL);
    t.equal(schema.defaultSettings().ira_match_percent, 3);
    t.equal(schema.validateSettings({ ira_packet_url: 'javascript:alert(1)' }).ok, false);
    t.equal(schema.validateSettings({ ira_packet_url: 'ftp://x.test/a.pdf' }).ok, false);
    t.equal(schema.validateSettings({ ira_packet_url: '' }).ok, false);
    t.equal(schema.validateSettings({ ira_packet_url: 'https://drive.google.com/x' }).patch.ira_packet_url, 'https://drive.google.com/x');
    t.equal(schema.validateSettings({ ira_match_percent: 101 }).ok, false);
    t.equal(schema.validateSettings({ ira_match_percent: 4 }).patch.ira_match_percent, 4);
  });

  await t.test('the generic employee validator never copies an ira object', () => {
    const r = schema.validateEmployee({ name: 'X', start_date: '2020-01-01', ira: { status: 'enrolled', packet_returned: true } });
    t.equal(r.ok, true);
    t.equal('ira' in r.record, false);
    t.equal('ira' in schema.stripAdminFields({ id: '1', ira: { status: 'declined' } }), false);
  });

  /* ---- the route: access --------------------------------------------- */

  seed();

  await t.test('an employee sees their own IRA and the plan, nothing else', async () => {
    const r = await call(route, { as: SASHA });
    t.equal(r.statusCode, 200);
    t.equal(r.body.employee_id, 'EMP-1');
    t.equal(r.body.ira, null);
    t.equal(r.body.plan.packet_url, ira.DEFAULT_IRA_PACKET_URL);
    t.equal(r.body.plan.match_percent, 3);
    t.equal('hourly_rate' in r.body, false);
  });

  await t.test('an employee cannot read another employee\'s IRA', async () => {
    const r = await call(route, { as: SASHA, query: { employee_id: 'EMP-2' } });
    t.equal(r.statusCode, 403);
    t.equal(JSON.stringify(r.body).includes('percent'), false);
    const own = await call(route, { as: SASHA, query: { employee_id: 'EMP-1' } });
    t.equal(own.statusCode, 200, 'their own id is fine');
  });

  await t.test('a supervisor cannot read their report\'s IRA either', async () => {
    const r = await call(route, { as: BOSS, query: { employee_id: 'EMP-1' } });
    t.equal(r.statusCode, 403);
  });

  await t.test('only an admin gets the sign-up sheet', async () => {
    t.equal((await call(route, { as: SASHA, query: { sheet: '1' } })).statusCode, 403);
    t.equal((await call(route, { as: BOSS, query: { sheet: '1' } })).statusCode, 403);
    const r = await call(route, { as: RYAN, query: { sheet: '1' } });
    t.equal(r.statusCode, 200);
    t.equal(r.body.counts.enrolled, 1);
    t.equal(r.body.counts.packet_outstanding, 1);
  });

  await t.test('an employee cannot mark their own packet returned', async () => {
    const r = await call(route, { as: DANA, method: 'POST', body: { action: 'packet', returned: true } });
    t.equal(r.statusCode, 403);
    const r2 = await call(route, { as: DANA, method: 'POST', body: { action: 'packet', employee_id: 'EMP-2', returned: true } });
    t.equal(r2.statusCode, 403);
    t.equal(stored('EMP-2').ira.packet_returned, false, 'nothing was written');
  });

  await t.test('nor through the generic employee update', async () => {
    const r = await call(employees, { as: DANA, method: 'PATCH', query: { id: 'EMP-2' }, body: { ira: { packet_returned: true } } });
    t.equal(r.statusCode, 403);
    // Even an admin's generic PATCH does not write ira.
    const a = await call(employees, { as: RYAN, method: 'PATCH', query: { id: 'EMP-2' }, body: { ira: { status: 'declined', packet_returned: true } } });
    t.equal(a.statusCode, 200);
    t.equal(stored('EMP-2').ira.status, 'enrolled');
    t.equal(stored('EMP-2').ira.packet_returned, false);
  });

  await t.test('an employee cannot make a choice for somebody else', async () => {
    const r = await call(route, { as: SASHA, method: 'POST', body: { status: 'declined', employee_id: 'EMP-2' } });
    t.equal(r.statusCode, 403);
    t.equal(stored('EMP-2').ira.status, 'enrolled');
  });

  await t.test('an employee enrolls themselves and the approvers are told, without the amount', async () => {
    const before = notices().length;
    const r = await call(route, { as: SASHA, method: 'POST', body: { status: 'enrolled', dollars: '62.50' } });
    t.equal(r.statusCode, 200);
    t.equal(r.body.ira.status, 'enrolled');
    t.equal(r.body.ira.contribution, 62.5);
    t.equal(r.body.notified, 2, 'Ryan and Megan');
    t.equal(stored('EMP-1').ira.elected_by, 'sasha');
    const fresh = notices().slice(before);
    t.equal(fresh.length, 2);
    t.assert(fresh.every((n) => n.title === 'IRA sign-up: a choice to review, packet to collect'), 'the neutral wording');
    t.assert(fresh.every((n) => !/Sasha/.test(n.title + n.detail)), 'no name in a team-visible notice');
    t.assert(fresh.every((n) => !/62/.test(n.title + n.detail)), 'no amount in the notification');
    t.equal(fresh.map((n) => n.assignedTo).sort().join(','), 'megan,ryan');
  });

  await t.test('the same choice again is quiet', async () => {
    const before = notices().length;
    const r = await call(route, { as: SASHA, method: 'POST', body: { status: 'enrolled', dollars: '62.50' } });
    t.equal(r.body.unchanged, true);
    t.equal(notices().length, before);
  });

  await t.test('bad input is refused with a plain reason', async () => {
    const r = await call(route, { as: SASHA, method: 'POST', body: { status: 'enrolled', percent: 3, dollars: 5 } });
    t.equal(r.statusCode, 400);
    t.assert(/not both/.test(r.body.error));
  });

  await t.test('an admin marks the packet, then a change flags it again', async () => {
    const m = await call(route, { as: RYAN, method: 'POST', body: { action: 'packet', employee_id: 'EMP-1', returned: true } });
    t.equal(m.statusCode, 200);
    t.equal(stored('EMP-1').ira.packet_returned, true);
    const c = await call(route, { as: SASHA, method: 'POST', body: { status: 'declined' } });
    t.equal(c.statusCode, 200);
    t.equal(stored('EMP-1').ira.changed_after_packet, true);
    const sheet = await call(route, { as: RYAN, query: { sheet: '1' } });
    const row = sheet.body.rows.find((x) => x.id === 'EMP-1');
    t.equal(row.packet_outstanding, true);
  });

  await t.test('an admin can set anybody\'s choice and read their history', async () => {
    const r = await call(route, { as: RYAN, method: 'POST', body: { status: 'enrolled', percent: 5, employee_id: 'EMP-5', start_date: '2026-11-01' } });
    t.equal(r.statusCode, 200);
    t.equal(stored('EMP-5').ira.start_date, '2026-11-01');
    const g = await call(route, { as: RYAN, query: { employee_id: 'EMP-5' } });
    t.equal(g.body.ira.history.length, 1);
    t.equal(g.body.ira.elected_by, 'ryan');
  });

  /* ---- no ira through the generic endpoints --------------------------- */

  await t.test('a non-admin gets no ira field back from the employee endpoint', async () => {
    const r = await call(employees, { as: SASHA });
    t.equal(r.statusCode, 200);
    t.assert(r.body.employee && r.body.employee.id === 'EMP-1', 'their own record');
    t.equal('ira' in r.body.employee, false, 'but not the ira object on it');
    t.equal(r.body.employees, undefined, 'and no roster');
    const b = await call(employees, { as: BOSS, query: { id: 'EMP-1' } });
    t.equal('ira' in (b.body.employee || {}), false, 'a supervisor asking by id gets their own record, no ira');
    t.equal(b.body.employee.id, 'EMP-5');
  });

  await t.test('time off hands a supervisor names only, never ira', async () => {
    const r = await call(timeoff, { as: BOSS });
    t.equal(r.statusCode, 200);
    t.equal(JSON.stringify(r.body).includes('"ira"'), false);
    t.equal(JSON.stringify(r.body).includes('packet'), false);
  });

  await t.test('settings: admins change the packet link, others cannot', async () => {
    const no = await call(settings, { as: SASHA, method: 'PATCH', body: { ira_packet_url: 'https://evil.test/x.pdf' } });
    t.equal(no.statusCode, 403);
    const bad = await call(settings, { as: RYAN, method: 'PATCH', body: { ira_packet_url: 'javascript:alert(1)' } });
    t.equal(bad.statusCode, 400);
    const ok = await call(settings, { as: RYAN, method: 'PATCH', body: { ira_packet_url: 'https://drive.google.com/new', ira_match_percent: 4 } });
    t.equal(ok.statusCode, 200);
    const r = await call(route, { as: SASHA });
    t.equal(r.body.plan.packet_url, 'https://drive.google.com/new');
    t.assert(r.body.plan.info.some((l) => l.includes('up to 4%')));
  });

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run crewcore-ira tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
