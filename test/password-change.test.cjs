// PUT IN: test/password-change.test.cjs
/**
 * Temporary passwords and changing your own (Oct 2026).
 *
 * Ryan: "Can I set a temporary password and then prompt them to change it
 * when they log in?" Before this, an Admin could set anyone's password and
 * nothing ever asked them to replace it, and nobody could change their own.
 *
 * Everything here is a real call: the real routes (api/auth.js, api/users.js,
 * api/crewcore/employees.js, api/intake.js) over a fake store, real cookies,
 * and real sign-ins with the passwords involved.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const CC = 'crewcore_data';

/* ---- fake Upstash: get, set, and the pipeline the rate limiter uses ----- */

const kv = new Map();
const counters = new Map();

global.fetch = async (url, opts) => {
  const raw = String(url);
  if (raw.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    const out = cmds.map(([cmd, key]) => {
      if (cmd === 'INCR') { const n = (counters.get(key) || 0) + 1; counters.set(key, n); return { result: n }; }
      if (cmd === 'DEL') { counters.delete(key); return { result: 1 }; }
      return { result: 1 };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const delM = raw.match(/\/del\/(.+)$/);
  if (delM) {
    const k = decodeURIComponent(delM[1]);
    kv.delete(k); counters.delete(k);
    return { ok: true, status: 200, json: async () => ({ result: 1 }) };
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-password-change';

/* ---- request plumbing ---------------------------------------------------- */

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

/** The name=value part of whatever cookie a response set, or null. */
function cookieFrom(res) {
  const h = res.headers['Set-Cookie'];
  if (!h) return null;
  const first = Array.isArray(h) ? h[0] : String(h).split('; ')[0];
  return String(first).split('; ')[0];
}

async function call(handler, { cookie = '', method = 'GET', query = {}, body = null }) {
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie, 'x-forwarded-for': '10.0.0.1' }, socket: {} }, res);
  return res;
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const users = await import(path.join(ROOT, 'lib/users.js'));
  const session = await import(path.join(ROOT, 'lib/session.js'));
  const auth = (await import(path.join(ROOT, 'api/auth.js'))).default;
  const usersRoute = (await import(path.join(ROOT, 'api/users.js'))).default;
  const employees = (await import(path.join(ROOT, 'api/crewcore/employees.js'))).default;
  const intake = (await import(path.join(ROOT, 'api/intake.js'))).default;

  async function seed() {
    kv.clear(); counters.clear();
    // Ryan made directly so his password is known and not temporary.
    await users.createUser({ username: 'ryan', password: 'ryan-real-pass', name: 'Ryan', superuser: true });
  }

  async function login(username, password) {
    return call(auth, { method: 'POST', body: { action: 'login', username, password } });
  }

  async function ryanCookie() {
    const r = await login('ryan', 'ryan-real-pass');
    t.equal(r.statusCode, 200, 'Ryan signs in');
    return cookieFrom(r);
  }

  /* ---- the flag gets set ------------------------------------------------- */

  await check('an account an Admin creates starts on a temporary password', async () => {
    await seed();
    const c = await ryanCookie();
    const r = await call(usersRoute, { cookie: c, method: 'POST', body: { username: 'amanda', name: 'Amanda', password: 'Shirt-Hoodie-1234' } });
    t.equal(r.statusCode, 201);
    t.equal(r.body.user.must_change_password, true);
    t.assert(!JSON.stringify(r.body).includes('Shirt-Hoodie-1234'), 'the password is never echoed back');
  });

  await check('an Admin resetting somebody else flags it; resetting their own does not', async () => {
    await seed();
    await users.createUser({ username: 'hannah', password: 'hannah-own-pass', name: 'Hannah' });
    const c = await ryanCookie();
    let r = await call(usersRoute, { cookie: c, method: 'PATCH', query: { username: 'hannah' }, body: { password: 'Temp-Reset-77' } });
    t.equal(r.statusCode, 200);
    t.equal(r.body.user.must_change_password, true, 'a reset is temporary');
    r = await call(usersRoute, { cookie: c, method: 'PATCH', query: { username: 'ryan' }, body: { password: 'ryan-newer-pass' } });
    t.equal(r.body.user.must_change_password, false, 'your own reset is yours');
  });

  await check('a CrewCore roster login starts on a temporary password', async () => {
    await seed();
    kv.set(CC + ':employee_index', JSON.stringify(['EMP-00002']));
    kv.set(CC + ':employee:EMP-00002', JSON.stringify({ id: 'EMP-00002', name: 'Dana Jones', username: null, email: '', status: 'active', start_date: '2018-06-01' }));
    const c = await ryanCookie();
    const r = await call(employees, { cookie: c, method: 'POST', body: { action: 'create_login', id: 'EMP-00002' } });
    const temp = r.body && r.body.login && r.body.login.temp_password;
    t.assert(temp, 'the roster handed back a temporary password');
    const rec = await users.getUserRecord(r.body.login.username);
    t.equal(rec.must_change_password, true);
  });

  await check('editing name or access leaves the flag alone', async () => {
    await seed();
    await users.createUser({ username: 'jacob', password: 'Temp-Jacob-11', name: 'Jacob', mustChange: true });
    const c = await ryanCookie();
    const r = await call(usersRoute, { cookie: c, method: 'PATCH', query: { username: 'jacob' }, body: { name: 'Jacob Whitman' } });
    t.equal(r.body.user.must_change_password, true);
  });

  /* ---- the lock ---------------------------------------------------------- */

  await check('signing in on a temporary password says so and locks the cookie', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', access: { apps: ['backbone'] }, mustChange: true });
    const r = await login('amanda', 'Temp-Amanda-22');
    t.equal(r.statusCode, 200);
    t.equal(r.body.mustChangePassword, true);
    const fake = { headers: { cookie: cookieFrom(r) } };
    t.equal(session.getSession(fake), null, 'reads as signed out to every ordinary route');
    t.equal(session.getSession(fake, { allowPending: true }).username, 'amanda', 'but auth can still see who it is');
  });

  await check('every route refuses a locked session, with a reason', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', superuser: true, mustChange: true });
    const c = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    // requireAuth route, even for an Admin
    let r = await call(usersRoute, { cookie: c });
    t.equal(r.statusCode, 403);
    t.equal(r.body.mustChangePassword, true);
    // a route that calls getSession() itself
    r = await call(intake, { cookie: c });
    t.equal(r.statusCode, 401);
  });

  await check('the session check still says who is signed in, and that they must change', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', mustChange: true });
    const c = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    const r = await call(auth, { cookie: c, query: { action: 'session' } });
    t.equal(r.body.authenticated, true);
    t.equal(r.body.mustChangePassword, true);
    t.equal(r.body.user.username, 'amanda');
  });

  await check('a reset reaches somebody already signed in on their next page load', async () => {
    await seed();
    await users.createUser({ username: 'hannah', password: 'hannah-own-pass', name: 'Hannah' });
    const hc = cookieFrom(await login('hannah', 'hannah-own-pass'));
    t.assert(session.getSession({ headers: { cookie: hc } }), 'ordinary session to start');
    const rc = await ryanCookie();
    await call(usersRoute, { cookie: rc, method: 'PATCH', query: { username: 'hannah' }, body: { password: 'Temp-Reset-77' } });
    const r = await call(auth, { cookie: hc, query: { action: 'session' } });
    t.equal(r.body.mustChangePassword, true);
    const locked = cookieFrom(r);
    t.assert(locked, 'a locked cookie is issued');
    t.equal(session.getSession({ headers: { cookie: locked } }), null);
  });

  await check('the session check never REMOVES a lock; only proving the password does', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', mustChange: true });
    // Somebody else got to the sticky note first.
    const intruder = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    // The real Amanda changes it on her own device.
    const mine = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    t.equal((await call(auth, { cookie: mine, method: 'POST', body: { action: 'change', current: 'Temp-Amanda-22', password: 'amandas own phrase' } })).statusCode, 200);
    // The intruder's next page load must not hand them an unlocked session.
    const r = await call(auth, { cookie: intruder, query: { action: 'session' } });
    t.equal(cookieFrom(r), null, 'no cookie re-issued');
    t.equal(session.getSession({ headers: { cookie: intruder } }), null, 'still locked out of every route');
    // And the dead temp password cannot unlock it either.
    const c = await call(auth, { cookie: intruder, method: 'POST', body: { action: 'change', current: 'Temp-Amanda-22', password: 'intruder-choice' } });
    t.equal(c.statusCode, 400);
  });

  await check('junk in the change request is a 400, not a crash', async () => {
    await seed();
    const c = await ryanCookie();
    const r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'ryan-real-pass', password: 123456789 } });
    t.equal(r.statusCode, 400);
    await users.createUser({ username: 'gone', password: 'Temp-Gone-123', name: 'Gone', mustChange: true });
    const g = cookieFrom(await login('gone', 'Temp-Gone-123'));
    await call(usersRoute, { cookie: c, method: 'DELETE', query: { username: 'gone' } });
    t.equal((await call(auth, { cookie: g, method: 'POST', body: { action: 'change', current: 'Temp-Gone-123', password: 'whatever-long' } })).statusCode, 400);
  });

  await check('an ordinary sign-in is exactly as before: no flag, no lock', async () => {
    await seed();
    const r = await login('ryan', 'ryan-real-pass');
    t.equal(r.body.mustChangePassword, false);
    const sess = session.getSession({ headers: { cookie: cookieFrom(r) } });
    t.assert(sess && !('mc' in sess), 'no mc field on an ordinary cookie');
  });

  /* ---- changing it ------------------------------------------------------- */

  await check('the current password has to be right', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', mustChange: true });
    const c = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    const r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'wrong-guess', password: 'amanda-picks-this' } });
    t.equal(r.statusCode, 400);
    t.equal(r.body.field, 'current');
    t.equal((await users.getUserRecord('amanda')).must_change_password, true, 'still locked');
  });

  await check('the new password must be new, long enough, and not the username', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', mustChange: true });
    const c = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    for (const bad of ['Temp-Amanda-22', 'short', 'AMANDA  ']) {
      const r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'Temp-Amanda-22', password: bad } });
      t.equal(r.statusCode, 400, 'refused: ' + bad);
      t.equal(r.body.field, 'password');
    }
    t.equal(users.newPasswordProblem('a fine long phrase', { current: 'x', username: 'amanda' }), null);
  });

  await check('a good change unlocks, keeps them signed in, and the old password stops working', async () => {
    await seed();
    await users.createUser({ username: 'amanda', password: 'Temp-Amanda-22', name: 'Amanda', mustChange: true });
    const c = cookieFrom(await login('amanda', 'Temp-Amanda-22'));
    const r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'Temp-Amanda-22', password: 'blue ink on black tees' } });
    t.equal(r.statusCode, 200);
    const fresh = cookieFrom(r);
    const sess = session.getSession({ headers: { cookie: fresh } });
    t.assert(sess && sess.username === 'amanda' && !sess.mc, 'unlocked, same person');
    t.equal((await users.getUserRecord('amanda')).must_change_password, false);
    t.equal((await login('amanda', 'Temp-Amanda-22')).statusCode, 401, 'temp password is dead');
    const again = await login('amanda', 'blue ink on black tees');
    t.equal(again.statusCode, 200);
    t.equal(again.body.mustChangePassword, false);
    kv.forEach((v) => t.assert(!String(v).includes('blue ink on black tees'), 'new password is not in storage'));
  });

  await check('anyone can change their own password any time, not just after a reset', async () => {
    await seed();
    const c = await ryanCookie();
    const r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'ryan-real-pass', password: 'ryan-picked-another' } });
    t.equal(r.statusCode, 200);
    t.equal((await login('ryan', 'ryan-picked-another')).statusCode, 200);
  });

  await check('changing needs a session, and is rate limited like sign-in', async () => {
    await seed();
    let r = await call(auth, { method: 'POST', body: { action: 'change', current: 'x', password: 'whatever-long' } });
    t.equal(r.statusCode, 401);
    const c = await ryanCookie();
    for (let i = 0; i < 5; i++) {
      r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'guess' + i, password: 'whatever-long' } });
      t.equal(r.statusCode, 400);
    }
    r = await call(auth, { cookie: c, method: 'POST', body: { action: 'change', current: 'ryan-real-pass', password: 'whatever-long' } });
    t.equal(r.statusCode, 429, 'sixth try in the window is refused, even with the right password');
  });

  /* ---- the pages --------------------------------------------------------- */

  await check('password.html talks to /api/auth only and stores nothing', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'password.html'), 'utf8');
    const urls = [...html.matchAll(/fetch\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
    t.assert(urls.length >= 2, 'it does talk to the server');
    urls.forEach((u) => t.assert(u.startsWith('/api/auth'), 'unexpected endpoint: ' + u));
    t.assert(!/localStorage|sessionStorage|indexedDB/i.test(html), 'no browser storage on a password page');
    t.assert(!/#[0-9a-f]{3,8}\b/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')), 'colors come from tokens');
  });

  await check('sign-in and the shell both send a locked session to password.html', async () => {
    const login = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
    const shell = fs.readFileSync(path.join(ROOT, 'js/shell.js'), 'utf8');
    t.assert(/mustChangePassword[\s\S]{0,80}password\.html/.test(login), 'login.html routes a temp password');
    t.assert(/mustChangePassword[\s\S]{0,200}password\.html/.test(shell), 'shell routes a temp password');
    t.assert(/href="password\.html"/.test(shell), 'the avatar menu offers Change password');
  });

  process.exit(t.report());
})();
