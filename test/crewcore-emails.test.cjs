// PUT IN: test/crewcore-emails.test.cjs
/**
 * CrewCore: work email and personal email (Sep 23 2026).
 *
 * Ryan: people have personal and work emails. Addresses on the roster were
 * switched to personal ones so time off emails reached people at home, and
 * work mail (PromoPro) started going there too. Two fields now: work email
 * for work, personal email for their own time off.
 *
 * Every check is a real call: the pure helpers, the store reading an old
 * record, the roster route, PromoPro's account manager list built from the
 * store, and the time off email with a fake sender.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';

global.fetch = async (url, opts) => {
  const raw = String(url);
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
process.env.SESSION_SECRET = 'test-secret-for-crewcore-emails';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({ ryan: { username: 'ryan', name: 'Ryan', superuser: true } }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-00001', 'EMP-00002', 'EMP-00003']));
  // Old one-field records, the way the live roster looks today.
  kv.set(CC + ':employee:EMP-00001', JSON.stringify({ id: 'EMP-00001', name: 'Alexis Davis', department: 'Sales', email: 'alexis.home@gmail.com', status: 'active' }));
  kv.set(CC + ':employee:EMP-00002', JSON.stringify({ id: 'EMP-00002', name: 'Jacob Whitman', department: 'Sales', email: 'jacob@pmapparel.com', status: 'active' }));
  // Already on the two-field scheme.
  kv.set(CC + ':employee:EMP-00003', JSON.stringify({ id: 'EMP-00003', name: 'Hannah Posey', department: 'Sales', email: 'hannah@pmapparel.com', personal_email: 'hannah.p@yahoo.com', status: 'active' }));
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

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const schema = await import(path.join(ROOT, 'lib/crewcore/schema.js'));
  const store = await import(path.join(ROOT, 'lib/crewcore/store.js'));
  const route = (await import(path.join(ROOT, 'api/crewcore/employees.js'))).default;
  const am = await import(path.join(ROOT, 'lib/promopro/account-managers.js'));
  const ptoEmail = await import(path.join(ROOT, 'lib/crewcore/pto-email.js'));
  const acc = await import(path.join(ROOT, 'lib/crewcore/accounts.js'));

  await check('a company domain is work, anything else is personal, any case', async () => {
    t.equal(schema.isWorkEmail('Jacob@PMApparel.com'), true);
    t.equal(schema.isWorkEmail('x@iowaondemand.com'), true);
    t.equal(schema.isWorkEmail('x@flyovercon.ink'), true);
    t.equal(schema.isWorkEmail('x@gmail.com'), false);
    t.equal(schema.isWorkEmail('x@pmapparel.com.evil.test'), false, 'the whole domain, not a prefix');
    t.equal(schema.isWorkEmail(''), false);
  });

  await check('an old record with a personal address in the one field is split on read', async () => {
    const s = schema.splitEmails({ id: 'A', email: 'me@gmail.com' });
    t.equal(s.email, '');
    t.equal(s.personal_email, 'me@gmail.com');
    const w = schema.splitEmails({ id: 'B', email: 'jacob@pmapparel.com' });
    t.equal(w.email, 'jacob@pmapparel.com');
    t.equal(w.personal_email, '');
  });

  await check('a record already on two fields is taken exactly as stored', async () => {
    const r = { id: 'C', email: '', personal_email: '' };
    t.equal(schema.splitEmails(r), r);
  });

  await check('the store never hands a personal address out as the work email', async () => {
    seed();
    const a = await store.getEmployee('EMP-00001');
    t.equal(a.email, '');
    t.equal(a.personal_email, 'alexis.home@gmail.com');
    const all = await store.listEmployees();
    t.assert(all.every((e) => !e.email || schema.isWorkEmail(e.email)), JSON.stringify(all.map((e) => e.email)));
  });

  await check('PromoPro account managers never get a personal address', async () => {
    seed();
    const c = am.candidatesFrom(await store.listEmployees());
    const by = Object.fromEntries(c.map((x) => [x.id, x]));
    t.equal(by['EMP-00001'].email, '', 'Alexis only has a personal address');
    t.equal(by['EMP-00001'].selectable, false);
    t.equal(by['EMP-00001'].reason, 'no work email in CrewCore');
    t.equal(by['EMP-00003'].email, 'hannah@pmapparel.com', 'Hannah has both: work wins');
    const resolved = am.resolveAccountManagers(['EMP-00001', 'EMP-00002', 'EMP-00003'], await store.listEmployees());
    t.assert(resolved.every((r) => schema.isWorkEmail(r.email)), JSON.stringify(resolved));
  });

  await check('the roster refuses a personal address in the work field', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'PATCH', query: { id: 'EMP-00002' }, body: { email: 'jacob@gmail.com' } });
    t.equal(r.statusCode, 400, JSON.stringify(r.body));
    t.equal(JSON.parse(kv.get(CC + ':employee:EMP-00002')).email, 'jacob@pmapparel.com', 'nothing written');
  });

  await check('the roster saves both addresses, and an edit writes the split to storage', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'PATCH', query: { id: 'EMP-00001' }, body: { email: 'alexis@pmapparel.com' } });
    t.equal(r.statusCode, 200, JSON.stringify(r.body));
    const saved = JSON.parse(kv.get(CC + ':employee:EMP-00001'));
    t.equal(saved.email, 'alexis@pmapparel.com');
    t.equal(saved.personal_email, 'alexis.home@gmail.com', 'the personal address survived the edit');
  });

  await check('a personal-only person is not flagged as having no email', async () => {
    t.equal(acc.rosterGaps({ email: '', personal_email: 'me@gmail.com' }, new Set()).no_email, false);
    t.equal(acc.rosterGaps({ email: '', personal_email: '' }, new Set()).no_email, true);
  });

  await check('time off goes to the personal address, supervisor copy to their work address', async () => {
    const sent = [];
    const send = async (m) => { sent.push(m); return { id: 'x' }; };
    const employee = { id: 'E', name: 'Hannah Posey', email: 'hannah@pmapparel.com', personal_email: 'hannah.p@yahoo.com' };
    const boss = { id: 'B', name: 'Jacob Whitman', email: 'jacob@pmapparel.com', personal_email: 'jw@gmail.com' };
    const out = await ptoEmail.sendDecisionEmail({
      employee, event: 'approved', note: '', balance: null, byName: 'Ryan',
      request: { id: 'R', employee_id: 'E', start_date: '2026-10-01', end_date: '2026-10-01', kind: 'full_day', hours: 8, status: 'approved', use_pto: true },
      cc: [schema.supervisorEmailOf(boss)], ccName: boss.name, from: 'Ryan@pmapparel.com',
    }, { send });
    t.equal(out.sent, true, JSON.stringify(out));
    t.equal(sent[0].to[0], 'hannah.p@yahoo.com');
    t.equal(sent[0].cc[0], 'jacob@pmapparel.com');
  });

  await check('time off falls back to the work address when there is no personal one', async () => {
    t.equal(schema.timeOffEmailOf({ email: 'jacob@pmapparel.com', personal_email: '' }), 'jacob@pmapparel.com');
    t.equal(schema.timeOffEmailOf({ email: 'old@gmail.com' }), 'old@gmail.com', 'an old one-field record still reaches them');
    t.equal(schema.supervisorEmailOf({ email: '', personal_email: 'm@gmail.com' }), 'm@gmail.com', 'a supervisor with only personal is still copied');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-emails could not run: ' + (e && e.stack || e));
  process.exit(1);
});
