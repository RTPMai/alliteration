// PUT IN: test/shopstock-access.test.cjs
/**
 * ShopStock: who may write, and what a refusal looks like.
 *
 * WHY THIS EXISTS. ShopStock came over from a standalone app that had no
 * accounts, and its three routes kept deciding writes by reading the role
 * NAME: role === "admin" || role === "manager". The rest of the shell had long
 * since moved to the real permissions (the per-account Admin flag and the
 * role's can_edit). Two people were refused by that gap:
 *
 *   - anyone on a role created in Settings, whatever its can_edit says,
 *   - anyone carrying the Admin flag, because the session cookie holds only
 *     { username, name, role } and has never carried that flag.
 *
 * The refusal came back 401, and js/api.js treated 401 and 403 alike as a dead
 * session, so the shell painted "Session expired" over the page. A permissions
 * problem was reported, truthfully, as being logged out, and the search went
 * to cookies and SESSION_SECRET, which were fine. Production staff hit it
 * every time they pressed a button in the ordering queue.
 *
 * Real function calls through dynamic import, not source-text matching. The
 * three routes and the screen all read shopstockCan(), so a role that gains or
 * loses write access here turns this file red rather than surprising somebody
 * in the shop.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

Promise.all([
  import(path.join(ROOT, 'lib/shopstock/access.js')),
  import(path.join(ROOT, 'lib/users.js')),
]).then(([access, users]) => {
  const { shopstockCan, denyWrite } = access;
  const { DEFAULT_ROLES } = users;

  /* ---- the rule itself ------------------------------------------------ */

  t.test('the per-account Admin flag grants write, whatever the role', () => {
    t.equal(shopstockCan({ superuser: true, role: 'employee', can_edit: false }).write, true,
      'the flag every other app honours must work here too');
  });

  t.test('the admin role grants write', () => {
    t.equal(shopstockCan({ superuser: false, role: 'admin', can_edit: true }).write, true,
      'admin writes');
  });

  t.test('can_edit grants write on a role created in Settings', () => {
    // This is the case that was refused. A production role with editing ticked
    // is not called "admin" or "manager", and the old check read the name.
    t.equal(shopstockCan({ superuser: false, role: 'production', can_edit: true }).write, true,
      'a custom role with can_edit must be able to write');
  });

  t.test('a role name is never read on its own', () => {
    // The old bug, stated as a test: "manager" with editing switched off must
    // not write just because of what the role is called.
    t.equal(shopstockCan({ superuser: false, role: 'manager', can_edit: false }).write, false,
      'the name is not the permission');
  });

  t.test('read-only roles cannot write', () => {
    ['viewer', 'employee'].forEach((r) => {
      t.equal(shopstockCan({ superuser: false, role: r, can_edit: false }).write, false,
        r + ' must stay read only');
    });
  });

  t.test('an empty or missing perms object never grants write', () => {
    [null, undefined, {}, { role: 'admin ' }, { can_edit: 'yes' }].forEach((p) => {
      t.equal(shopstockCan(p).write, false,
        'omission and near-misses must not promote anyone: ' + JSON.stringify(p));
    });
  });

  /* ---- deleting is narrower than writing ------------------------------ */

  t.test('deleting stays with admin, manager and the Admin flag', () => {
    t.equal(shopstockCan({ superuser: false, role: 'admin', can_edit: true }).remove, true, 'admin');
    t.equal(shopstockCan({ superuser: false, role: 'manager', can_edit: true }).remove, true, 'manager');
    t.equal(shopstockCan({ superuser: true, role: 'am', can_edit: true }).remove, true, 'Admin flag');
  });

  t.test('can_edit alone does not grant delete', () => {
    // Deliberately narrower than write: DELETE ?all=true wipes every item and
    // there is no undo. Widening this is a decision, not a tidy-up.
    const can = shopstockCan({ superuser: false, role: 'production', can_edit: true });
    t.equal(can.write, true, 'can write');
    t.equal(can.remove, false, 'cannot delete');
  });

  /* ---- run it against the roles that actually ship -------------------- */

  t.test('every shipped role gets a decision, and it matches its can_edit', () => {
    Object.keys(DEFAULT_ROLES).forEach((name) => {
      const role = DEFAULT_ROLES[name];
      const can = shopstockCan({ superuser: false, role: name, can_edit: role.can_edit === true });
      const expected = name === 'admin' || role.can_edit === true;
      t.equal(can.write, expected,
        'shipped role ' + name + ' write access must follow its can_edit flag');
    });
  });

  t.test('the self-serve employee role cannot write inventory', () => {
    // Production staff flag an item from its detail page instead. That path is
    // action:"flag" in api/items.js and is open to anyone signed in.
    t.equal(DEFAULT_ROLES.employee.can_edit, false, 'employee is read only by role');
    t.equal(shopstockCan({ superuser: false, role: 'employee', can_edit: false }).write, false,
      'and read only in ShopStock');
  });

  /* ---- 401 versus 403 -------------------------------------------------- */

  function fakeRes() {
    const out = { code: null, body: null };
    return {
      out,
      status(c) { out.code = c; return this; },
      json(b) { out.body = b; return this; },
    };
  }

  t.test('a caller we cannot identify gets 401', () => {
    const res = fakeRes();
    denyWrite(res, { signedIn: false, write: false, remove: false }, 'edit inventory items');
    t.equal(res.out.code, 401, 'no session is the one thing worth a sign-out');
  });

  t.test('a signed-in caller without permission gets 403, not 401', () => {
    // This is the whole point. A 401 wipes the screen with "Session expired".
    const res = fakeRes();
    denyWrite(res, { signedIn: true, write: false, remove: false }, 'edit inventory items');
    t.equal(res.out.code, 403, 'a refusal is not an expired session');
  });

  t.test('the refusal says what was refused and what to do', () => {
    const res = fakeRes();
    denyWrite(res, { signedIn: true, write: false, remove: false }, 'delete inventory items');
    const msg = String(res.out.body && res.out.body.error);
    t.assert(msg.includes('delete inventory items'), 'names the action: ' + msg);
    t.assert(msg.toLowerCase().includes('settings'), 'names where the fix lives: ' + msg);
  });

  /* ---- the seam no longer calls a 403 a dead session ------------------- */

  t.test('js/api.js treats 401 as auth failure and 403 as a refusal', () => {
    // ApiError is a browser-side class in an ES module the harness cannot
    // import without a DOM, so this reads the two accessors out of the source
    // and evaluates them. Not a grep for a name: the bodies are run.
    const src = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
    const auth = src.match(/get isAuth\(\)\s*\{([^}]*)\}/);
    const forbidden = src.match(/get isForbidden\(\)\s*\{([^}]*)\}/);
    t.assert(auth, 'isAuth accessor still exists');
    t.assert(forbidden, 'isForbidden accessor exists');

    const isAuth = (status) => new Function('return function(){' + auth[1] + '}')().call({ status });
    const isForbidden = (status) => new Function('return function(){' + forbidden[1] + '}')().call({ status });

    t.equal(isAuth(401), true, '401 is an auth failure');
    t.equal(isAuth(403), false, '403 must NOT bounce anyone to the session screen');
    t.equal(isAuth(404), false, '404 is not auth');
    t.equal(isForbidden(403), true, '403 is a refusal');
    t.equal(isForbidden(401), false, '401 is not a refusal');
  });

  t.test('only isAuth announces a session failure', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
    t.assert(/if \(err\.isAuth\) announceAuthFailure\(err\)/.test(src),
      'the announce is still gated on isAuth alone');
    t.assert(!/isForbidden.*announceAuthFailure/.test(src),
      'a refusal must not announce a session failure');
  });

  /* ---- the routes all read the shared rule ---------------------------- */

  t.test('all three ShopStock routes use the shared rule, none reads a role name', () => {
    ['api/items.js', 'api/settings.js', 'api/scrape.js'].forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      t.assert(src.includes('lib/shopstock/access.js'),
        f + ' must import the shared rule');
      t.assert(!/sess\.role === "(admin|manager)"/.test(src),
        f + ' must not decide access by role name');
    });
  });

  t.test('the screen and the server agree on who can write', () => {
    // Two copies of one rule drift. The screen cannot import from lib/, so it
    // spells the same three conditions inline; this checks it still spells all
    // three, and that it is not back to reading the role name alone.
    const src = fs.readFileSync(path.join(ROOT, 'apps/shopstock.js'), 'utf8');
    const block = src.match(/const canWrite =([\s\S]{0,200}?);/);
    t.assert(block, 'the screen still computes canWrite');
    const body = block[1];
    t.assert(body.includes('superuser'), 'screen honours the Admin flag');
    t.assert(body.includes('can_edit'), 'screen honours can_edit');
    t.assert(!body.includes('"manager"'), 'screen no longer keys off the manager role name');
  });

  process.exit(t.report());
}).catch((err) => {
  console.log('  FAIL  could not load the ShopStock access rule');
  console.log('       ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
