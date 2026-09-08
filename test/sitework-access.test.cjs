// PUT IN: test/sitework-access.test.cjs
/**
 * Site Work access: the Admin flag, or a role with the box ticked.
 *
 * Sep 2026. Site Work used to gate on the per-account Admin flag alone. Ryan
 * asked for a role checkbox so somebody can see the build list without being
 * handed the whole platform.
 *
 * That makes this a security change, so these are REAL requests through the
 * real route with a mocked store, not regular expressions over the source. The
 * question "can this person reach the board" is answered by running the code
 * that answers it in production.
 *
 * The thing being guarded against is the CrewCore trap from August: a rule that
 * looks opt-in but has a fallback somewhere that opens it to roles nobody
 * ticked. Half the checks below are about who must still be REFUSED.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const SW = 'sitework:';

/* ---- the store --------------------------------------------------------- */

const kv = new Map();

global.fetch = async (url, opts) => {
  const u = String(url);
  const get = u.match(/\/get\/(.+)$/);
  if (get) {
    const key = decodeURIComponent(get[1]);
    return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
  }
  // The store writes through /pipeline, so the mock has to speak it or a POST
  // throws and comes back 500. A 403 test that passes because the route
  // exploded is not testing the gate.
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse((opts && opts.body) || '[]');
    const out = cmds.map(([op, key, val]) => {
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
      if (op === 'INCR') {
        const n = Number(kv.get(key) || 0) + 1;
        kv.set(key, String(n));
        return { result: n };
      }
      if (op === 'GET' || op === 'MGET') {
        return { result: kv.has(key) ? kv.get(key) : null };
      }
      return { result: null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-sitework-access';

/**
 * roles: builder has the box ticked, watcher has it ticked but cannot edit,
 * office is an ordinary role somebody made for an unrelated reason, and legacy
 * is a role stored before app ids existed. That last one is the CrewCore trap.
 */
function seed() {
  kv.clear();
  kv.set(P + 'roles', JSON.stringify({
    builder: { name: 'builder', label: 'Builder', apps: ['backbone', 'stickies'], can_edit: true },
    watcher: { name: 'watcher', label: 'Watcher', apps: ['backbone', 'stickies'], can_edit: false },
    office:  { name: 'office',  label: 'Office',  apps: ['backbone', 'crewcore', 'mailme'], can_edit: true },
    legacy:  { name: 'legacy',  label: 'Legacy',  apps: [], tabs: ['leads', 'roster'], can_edit: true },
  }));
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   role: 'admin', superuser: true },
    jacob:  { username: 'jacob',  name: 'Jacob',  role: 'builder' },
    margo:  { username: 'margo',  name: 'Margo',  role: 'watcher' },
    amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
    olddog: { username: 'olddog', name: 'Old Dog', role: 'legacy' },
  }));
  kv.set(SW + 'index', JSON.stringify(['SN-00001']));
  kv.set(SW + 'note:SN-00001', JSON.stringify({
    id: 'SN-00001', title: 'Fix the rail on mobile', status: 'open', color: 'yellow',
  }));
}

/* ---- a real request ---------------------------------------------------- */

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
  const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const RYAN   = { username: 'ryan',   name: 'Ryan',   role: 'admin' };
const JACOB  = { username: 'jacob',  name: 'Jacob',  role: 'builder' };
const MARGO  = { username: 'margo',  name: 'Margo',  role: 'watcher' };
const AMANDA = { username: 'amanda', name: 'Amanda', role: 'office' };
const OLDDOG = { username: 'olddog', name: 'Old Dog', role: 'legacy' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const route = (await import(path.join(ROOT, 'api/sitework.js'))).default;
  const { permsFor, DEFAULT_ROLES } = await import(path.join(ROOT, 'lib/users.js'));
  const { canAccess } = await import(path.join(ROOT, 'js/registry.js'));

  seed();

  /* ---- who gets in ----------------------------------------------------- */

  await check('the Admin flag still reaches the board', async () => {
    const res = await call(route, { as: RYAN });
    t.equal(res.statusCode, 200, 'an admin was refused: ' + JSON.stringify(res.body));
  });

  await check('a role with the box ticked reaches the board', async () => {
    const res = await call(route, { as: JACOB });
    t.equal(res.statusCode, 200,
      'the whole point of the change: ' + JSON.stringify(res.body));
  });

  await check('an ordinary role is still refused', async () => {
    const res = await call(route, { as: AMANDA });
    t.equal(res.statusCode, 403,
      'a role created for an unrelated reason must not pick up the build list');
  });

  await check('signed out is refused', async () => {
    const res = fakeRes();
    await route({ method: 'GET', query: {}, headers: {} }, res);
    t.assert(res.statusCode === 401 || res.statusCode === 403,
      'no session must not reach the board, got ' + res.statusCode);
  });

  /* ---- nobody gains it on deploy: THE CREWCORE TRAP -------------------- */

  await check('a role stored before app ids existed is refused', async () => {
    // A tabs list stored before app ids existed. canAccess has a fallback for
    // that shape which grants BackBone and nothing else, so this would be
    // refused either way; the check exists so that stays true if anybody ever
    // widens the fallback.
    const res = await call(route, { as: OLDDOG });
    t.equal(res.statusCode, 403,
      'the legacy-shape fallback leaked Site Work to a role that never asked for it');
    const perms = await permsFor('olddog');
    t.equal(canAccess(perms, 'stickies'), false,
      'and the rail must agree with the route, or one of them is lying');
  });

  await check('no shipped role carries the grant', async () => {
    // A rule that is opt-in does not help if a default opts you in.
    Object.keys(DEFAULT_ROLES).forEach((key) => {
      const apps = DEFAULT_ROLES[key].apps || [];
      t.assert(!apps.includes('stickies'),
        'the default role "' + key + '" ships with Site Work granted');
    });
  });

  await check('the rail and the route answer the same question', async () => {
    // Two gates that disagree is worse than one: either somebody sees a tab
    // that 403s, or somebody can reach a board with no way to find it.
    for (const [name, expected] of [['jacob', true], ['margo', true], ['amanda', false], ['olddog', false]]) {
      const perms = await permsFor(name);
      t.equal(canAccess(perms, 'stickies'), expected, name + ': rail disagrees with the route');
      const res = await call(route, { as: { username: name, name, role: 'x' } });
      t.equal(res.statusCode === 200, expected, name + ': route disagrees with the rail');
    }
  });

  /* ---- reading is not writing ------------------------------------------ */

  await check('a granted role without can_edit can read the board', async () => {
    const res = await call(route, { as: MARGO });
    t.equal(res.statusCode, 200, 'view access must not depend on can_edit');
  });

  await check('a granted role without can_edit cannot change the board', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await call(route, { as: MARGO, method, body: { title: 'sneak' }, query: { id: 'SN-00001' } });
      t.equal(res.statusCode, 403, method + ' got through without can_edit');
    }
  });

  await check('a granted role with can_edit can change the board', async () => {
    const res = await call(route, { as: JACOB, method: 'POST', body: { title: 'A real note' } });
    t.equal(res.statusCode, 201,
      'can_edit was ticked and the write did not succeed: ' + JSON.stringify(res.body));
    t.assert(res.body && res.body.note && res.body.note.title === 'A real note',
      'the note must actually come back, not just a non-403');
  });

  await check('the Admin flag is not subject to can_edit at all', async () => {
    // can_edit lives on a ROLE, and an admin's access does not come from one.
    // Reading it for them would let a role edit take the board away from the
    // people who build the platform.
    kv.set(P + 'roles', JSON.stringify({
      admin: { name: 'admin', label: 'Full access', apps: ['backbone'], can_edit: false, protected: true },
    }));
    const res = await call(route, { as: RYAN, method: 'POST', body: { title: 'Admin note' } });
    t.equal(res.statusCode, 201,
      'an admin lost write access because a role somewhere had can_edit off');
    seed();
  });

  /* ---- the write gate cannot be forgotten ------------------------------ */

  await check('every non-GET method is gated, not just the ones in use today', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(route, { as: AMANDA, method, body: {} });
      t.equal(res.statusCode, 403, method + ' reached a route it should never have');
    }
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL sitework-access could not run: ' + ((e && e.stack) || e));
  process.exit(1);
});
