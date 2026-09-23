// PUT IN: test/crewcore-roster-logins.test.cjs
/**
 * CrewCore roster: logins and emails (Sep 21 2026).
 *
 * Ryan: flag anyone on the roster without an email or a connected username,
 * and when somebody is added to the roster, make them a user if they are not
 * one. Also: a PTO exempt switch for Ryan and Megan.
 *
 * Making an account is the same power as Settings > Accounts, so the route is
 * CALLED here with real sessions over a fake store, and the new login is
 * checked by actually signing in with it.
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
process.env.SESSION_SECRET = 'test-secret-for-roster-logins';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  superuser: true },
    // Signed in, no Admin flag. Since roles were removed (Sep 10) the old
    // "admin" role migrates INTO the flag, so this is what non-admin means.
    margo: { username: 'margo', name: 'Margo', access: { apps: ['crewcore'] } },
    sasha: { username: 'sasha', name: 'Sasha Smith' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-00001', 'EMP-00002', 'EMP-00003']));
  kv.set(CC + ':employee:EMP-00001', JSON.stringify({ id: 'EMP-00001', name: 'Sasha Smith', username: 'sasha', email: 'sasha@example.com', status: 'active', start_date: '2015-03-01' }));
  kv.set(CC + ':employee:EMP-00002', JSON.stringify({ id: 'EMP-00002', name: 'Dana Jones', username: null, email: '', status: 'active', start_date: '2018-06-01' }));
  // Typed a username nobody made an account for.
  kv.set(CC + ':employee:EMP-00003', JSON.stringify({ id: 'EMP-00003', name: 'Old Timer', username: 'oldtimer', email: 'ot@example.com', status: 'active', start_date: '2001-01-01' }));
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
const MARGO = { username: 'margo', name: 'Margo' };
const SASHA = { username: 'sasha', name: 'Sasha Smith' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const acc = await import(path.join(ROOT, 'lib/crewcore/accounts.js'));
  const route = (await import(path.join(ROOT, 'api/crewcore/employees.js'))).default;
  const users = await import(path.join(ROOT, 'lib/users.js'));

  /* ---- the pure pieces --------------------------------------------------- */

  await check('usernames follow the shop pattern: first name, then first plus last initial', async () => {
    t.equal(acc.suggestUsername('Nicole Printy', new Set()), 'nicole');
    t.equal(acc.suggestUsername('Nicole Printy', new Set(['nicole'])), 'nicolep');
    t.equal(acc.suggestUsername('Nicole Printy', new Set(['nicole', 'nicolep'])), 'nicoleprinty');
    t.equal(acc.suggestUsername('Nicole Printy', new Set(['NICOLE'])), 'nicolep', 'taken ignores case');
    t.equal(acc.suggestUsername('José Núñez', new Set()), 'jose', 'accents dropped');
    t.equal(acc.suggestUsername('Al', new Set()), 'al0', 'padded to the 3 character minimum');
    t.equal(acc.suggestUsername('Cher', new Set(['cher'])), 'cher2', 'one name, taken: a number');
  });

  await check('a temporary password is readable, long enough, and varies', async () => {
    const seq = [0, 1, 4821];
    const p = acc.tempPassword((n) => seq.shift() % n);
    t.equal(p, 'Shirt-Hoodie-4821');
    t.assert(p.length >= 8);
    const a = acc.tempPassword(), b = acc.tempPassword(), c = acc.tempPassword();
    t.assert(a !== b || b !== c, 'not the same every time');
  });

  await check('a username with no account behind it counts as no login', async () => {
    const logins = new Set(['sasha']);
    t.equal(acc.rosterGaps({ username: 'sasha', email: 'a@b.co' }, logins).no_login, false);
    t.equal(acc.rosterGaps({ username: 'oldtimer', email: 'a@b.co' }, logins).no_login, true);
    t.equal(acc.rosterGaps({ username: null, email: '' }, logins).no_email, true);
    t.equal(acc.rosterGaps({ username: 'sasha', email: 'not an email' }, logins).no_email, true);
  });

  /* ---- the flags --------------------------------------------------------- */

  await check('the roster read flags no email and no login on every row', async () => {
    seed();
    const r = await call(route, { as: RYAN });
    const by = Object.fromEntries(r.body.employees.map((e) => [e.id, e.gaps]));
    t.equal(by['EMP-00001'].no_login, false);
    t.equal(by['EMP-00001'].no_email, false);
    t.equal(by['EMP-00002'].no_login, true);
    t.equal(by['EMP-00002'].no_email, true);
    t.equal(by['EMP-00003'].no_login, true, 'typed username, no account');
    t.equal(r.body.can_make_logins, true);
    const m = await call(route, { as: MARGO });
    t.equal(m.body.employees, undefined, 'a non-admin never sees the roster or its flags');
  });

  /* ---- adding somebody makes a login ------------------------------------ */

  await check('adding a person makes a CrewCore-only login they can sign in with', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { name: 'Nicole Printy', start_date: '2026-09-01', email: 'nicole@pmapparel.com' } });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.login.username, 'nicole');
    t.equal(r.body.employee.username, 'nicole', 'linked on the roster');
    t.equal(r.body.employee.gaps.no_login, false);
    const who = await users.authenticate('nicole', r.body.login.temp_password);
    t.assert(who, 'the temporary password signs in');
    const perms = await users.permsFor('nicole');
    t.assert(perms.tabs.includes('crewcore'), JSON.stringify(perms.tabs));
    t.assert(perms.tabs.includes('crewcore:timeoff'));
    t.assert(!perms.tabs.includes('crewcore:roster'), 'the ceiling holds: no roster');
    t.assert(!perms.tabs.some((x) => x.startsWith('backbone')), 'nothing outside CrewCore');
    t.equal((await users.getUser('nicole')).superuser, false);
  });

  await check('the temporary password is never stored in plain text', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { name: 'Nicole Printy', start_date: '2026-09-01' } });
    const pw = r.body.login.temp_password;
    kv.forEach((v) => t.assert(!String(v).includes(pw), 'found the password in storage'));
  });

  await check('a taken first name gets the last initial', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { name: 'Sasha Brown', start_date: '2026-09-01' } });
    t.equal(r.body.login.username, 'sashab');
  });

  await check('unticking "make a login" makes none, and the row is flagged', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { name: 'Seasonal Help', start_date: '2026-09-01', create_login: false } });
    t.equal(r.body.login, null);
    t.equal(r.body.employee.gaps.no_login, true);
  });

  await check('a non-admin can neither add to the roster nor get a login made that way', async () => {
    seed();
    const r = await call(route, { as: MARGO, method: 'POST', body: { name: 'Nicole Printy', start_date: '2026-09-01' } });
    t.equal(r.statusCode, 403);
    t.equal(await users.getUser('nicole'), null);
  });

  await check('an old "admin" role account was migrated to the Admin flag, so it can make logins', async () => {
    seed();
    const u = JSON.parse(kv.get(P + 'users'));
    u.kim = { username: 'kim', name: 'Kim', role: 'admin' };
    kv.set(P + 'users', JSON.stringify(u));
    const r = await call(route, { as: { username: 'kim', name: 'Kim' }, method: 'POST', body: { action: 'create_login', id: 'EMP-00002' } });
    t.equal(r.statusCode, 201, 'same person who could before roles went away');
  });

  /* ---- people already on the roster -------------------------------------- */

  await check('Make a login works for somebody already on the roster', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'create_login', id: 'EMP-00002' } });
    t.equal(r.statusCode, 201, JSON.stringify(r.body));
    t.equal(r.body.login.username, 'dana');
    t.equal(JSON.parse(kv.get(CC + ':employee:EMP-00002')).username, 'dana');
  });

  await check('a typed username with no account is used for the new login', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'create_login', id: 'EMP-00003' } });
    t.equal(r.body.login.username, 'oldtimer');
    t.assert(await users.getUser('oldtimer'));
  });

  await check('somebody with a working login is not given a second one', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'POST', body: { action: 'create_login', id: 'EMP-00001' } });
    t.equal(r.statusCode, 409);
  });

  await check('only the Admin flag can make a login; an employee certainly cannot', async () => {
    seed();
    t.equal((await call(route, { as: MARGO, method: 'POST', body: { action: 'create_login', id: 'EMP-00002' } })).statusCode, 403);
    t.equal((await call(route, { as: SASHA, method: 'POST', body: { action: 'create_login', id: 'EMP-00002' } })).statusCode, 403);
    t.equal(await users.getUser('dana'), null);
  });

  /* ---- PTO exempt -------------------------------------------------------- */

  await check('PTO exempt is saved from the roster form', async () => {
    seed();
    const r = await call(route, { as: RYAN, method: 'PATCH', query: { id: 'EMP-00001' }, body: { pto_exempt: true } });
    t.equal(r.statusCode, 200, JSON.stringify(r.body));
    t.equal(JSON.parse(kv.get(CC + ':employee:EMP-00001')).pto_exempt, true);
    const off = await call(route, { as: RYAN, method: 'PATCH', query: { id: 'EMP-00001' }, body: { pto_exempt: false } });
    t.equal(off.body.employee.pto_exempt, false);
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-roster-logins could not run: ' + (e && e.stack || e));
  process.exit(1);
});
