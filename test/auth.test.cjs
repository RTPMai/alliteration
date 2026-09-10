/**
 * Auth tests.
 *
 * The consolidation these cover: BackBone and ErrorEngine each shipped their own
 * session.js (byte-identical apart from comments) AND their own user store with
 * incompatible password hashes. One cookie plus one account list is what makes
 * "one login" true rather than half-true.
 *
 * The half-true state is the dangerous one: a shared cookie with separate
 * account lists means a valid key for a building you are not on the guest list
 * for. These tests exist so nobody reintroduces that.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ---- One lock ---------------------------------------------------------- */

t.test('there is exactly one session library', () => {
  t.assert(exists('lib/session.js'), 'lib/session.js is missing');
  ['lib/session-backbone.js', 'lib/session-errorengine.js', 'lib/user-store.js']
    .forEach((p) => t.assert(!exists(p), 'leftover duplicate: ' + p));
});

t.test('one cookie name is used for every app', () => {
  const src = read('lib/session.js');
  t.assert(src.includes('alliteration_session'), 'shell cookie name is missing');
  // The old per-app names may appear ONLY in clearSessionCookie, which expires
  // stale cookies left over from the separate deployments.
  const setBlock = src.slice(src.indexOf('export function setSessionCookie'),
                            src.indexOf('export function clearSessionCookie'));
  ['backbone_session', 'errorengine_session'].forEach((old) => {
    t.assert(!setBlock.includes(old), 'setSessionCookie still writes ' + old);
  });
});

t.test('sign out clears the legacy per-app cookies too', () => {
  const src = read('lib/session.js');
  const clearBlock = src.slice(src.indexOf('export function clearSessionCookie'),
                               src.indexOf('export function getSession'));
  ['backbone_session', 'errorengine_session'].forEach((old) => {
    t.assert(clearBlock.includes(old),
      'clearSessionCookie must expire ' + old + ' or a stale cookie survives sign out');
  });
});

t.test('session verifies the signature before parsing the payload', () => {
  const src = read('lib/session.js');
  const verifyAt = src.indexOf('safeEqual(sig, sign(payload))');
  const parseAt = src.indexOf('JSON.parse(unb64url(payload)');
  t.assert(verifyAt !== -1, 'signature check is missing');
  t.assert(verifyAt < parseAt,
    'signature MUST be verified before parsing, or anyone can mint an admin cookie');
});

t.test('SESSION_SECRET is required, never defaulted', () => {
  const src = read('lib/session.js');
  t.assert(/throw new Error\(\s*\n?\s*"SESSION_SECRET is not set/.test(src) ||
           src.includes('SESSION_SECRET is not set'),
    'a missing SESSION_SECRET must throw, not fall back to a default');
});

/* ---- One guest list ---------------------------------------------------- */

t.test('there is exactly one user store', () => {
  t.assert(exists('lib/users.js'), 'lib/users.js is missing');
});

t.test('passwords use one hash format', () => {
  const src = read('lib/users.js');
  t.assert(src.includes('scrypt$'), 'expected the scrypt$N$salt$hash format');
  // BackBone's old "salt:hash" hex format must not linger; two formats in one
  // store is how you get accounts that cannot be verified.
  t.assert(!src.includes('scryptSync'),
    'the old synchronous salt:hash format must not survive the merge');
});

t.test('passwords are never returned to a client', () => {
  const src = read('lib/users.js');
  const pub = src.slice(src.indexOf('function publicUser'), src.indexOf('/* ---'));
  t.assert(!pub.includes('password_hash'),
    'publicUser must never expose password_hash');
});

t.test('authenticate burns work when the user is missing', () => {
  const src = read('lib/users.js');
  const fn = src.slice(src.indexOf('export async function authenticate'));
  t.assert(fn.includes('hashPassword("dummy")'),
    'a missing user must cost the same time as a wrong password, or usernames leak');
});

// Sep 2026: roles are gone, so there is no role to demote. The Admin FLAG is
// the only administrator and removing the last one is what would lock everyone
// out. Real behavioural coverage (an actual updateUser call that is refused) is
// in test/user-grants.test.cjs.
t.test('the last administrator cannot be removed', () => {
  const src = read('lib/users.js');
  t.assert(src.includes('Cannot delete the last administrator'), 'delete guard missing');
  t.assert(src.includes('Cannot remove the last administrator'), 'flag guard missing');
});

/* ---- Permissions ------------------------------------------------------- */

t.test('roles grant apps by registry id', () => {
  const src = read('lib/users.js');
  ['backbone', 'shopstock', 'errorengine', 'givinggauge', 'traveltrack']
    .forEach((id) => t.assert(src.includes(`"${id}"`), 'admin role is missing app ' + id));
});

t.test('permsFor returns tabs in the shape the registry expects', () => {
  const src = read('lib/users.js');
  const fn = src.slice(src.indexOf('export async function permsFor'));
  t.assert(fn.includes('tabs:'),
    'permsFor must return perms.tabs — canAccess() reads that key');
});

t.test('every role keeps at least one app', () => {
  const src = read('lib/users.js');
  t.assert(src.includes('has no apps'),
    'saveRoles must reject a role with no apps, or its users sign in to a blank screen');
});

/* ---- Routes ------------------------------------------------------------ */

t.test('there is one auth route', () => {
  t.assert(exists('api/auth.js'), 'api/auth.js is missing');
});

t.test('auth route looks permissions up fresh, not from the cookie', () => {
  const src = read('api/auth.js');
  t.assert(src.includes('permsFor(sess.username)'),
    'permissions must be read live so a role change takes effect immediately');
});

t.test('bootstrap only works while no accounts exist', () => {
  const src = read('api/auth.js');
  const block = src.slice(src.indexOf('action === "bootstrap"'));
  t.assert(block.includes('noUsersYet'),
    'bootstrap must be gated on an empty store or anyone could mint an admin');
});

// Sep 2026: the third argument to requireAuth compared a role name carried in
// the COOKIE. With roles gone, admin is the per-account flag and has to be read
// from storage, so the route asks permsFor itself.
t.test('user management requires an admin session', () => {
  const src = read('api/users.js');
  t.assert(/permsFor\(sess\.username\)/.test(src),
    'api/users.js must resolve the caller live');
  t.assert(/superuser !== true/.test(src) && /403/.test(src),
    'and refuse anyone without the Admin flag');
});

t.test('an admin cannot delete their own account', () => {
  const src = read('api/users.js');
  t.assert(src.includes('cannot delete your own account'),
    'deleting yourself leaves a valid cookie for an account that no longer exists');
});

/* ---- Failing readably -------------------------------------------------- */

t.test('a missing env var returns a readable 503, not a bare 500', () => {
  const src = read('api/auth.js');
  t.assert(src.includes('function configProblem'),
    'auth must check configuration before doing anything that could throw');
  t.assert(src.includes('503'),
    'a setup problem is a 503 (not ready), not a 500 (crash)');
  t.assert(src.includes('SESSION_SECRET is not set'),
    'the error must name the missing variable');
});

t.test('health imports nothing from this project', () => {
  t.assert(exists('api/health.js'), 'api/health.js is missing');
  const src = read('api/health.js');
  // Node BUILTINS are fine: they cannot be missing or misconfigured. What must
  // never appear is a project import (../lib/..., ./something), because health
  // is the endpoint you open WHEN the project is broken. If it imports a file
  // that failed to deploy, it dies with the same opaque 500 it exists to explain.
  const imports = [...src.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const local = imports.filter((i) => i.startsWith('.') || i.startsWith('/'));
  t.equal(local.length, 0,
    'health must not import project files, found: ' + local.join(', '));
});

t.test('health never leaks secret values', () => {
  const src = read('api/health.js');
  // Reporting whether a var is SET is fine. Printing it is not.
  t.assert(!/process\.env\.SESSION_SECRET\s*[,)}]/.test(src.replace(/!!/g, '')),
    'health must report only whether a variable is set, never its value');
  t.assert(src.includes('!!env.SESSION_SECRET') || src.includes('!!process.env.SESSION_SECRET'),
    'health should coerce to a boolean');
});

t.test('vercel.json function patterns do not overlap', () => {
  // Vercel matches these in order and a file is claimed by the FIRST pattern
  // that fits. A later, more specific pattern then matches nothing and the
  // build fails with "doesn't match any Serverless Functions". One pattern
  // covering api/*.js avoids the whole class of problem.
  const cfg = JSON.parse(read('vercel.json'));
  const patterns = Object.keys(cfg.functions || {});
  const broad = patterns.filter((p) => p.includes('**'));
  const specific = patterns.filter((p) => !p.includes('*'));
  specific.forEach((sp) => {
    broad.forEach((bp) => {
      const prefix = bp.split('**')[0];
      t.assert(!sp.startsWith(prefix),
        'pattern "' + sp + '" is already claimed by "' + bp + '" and will match nothing');
    });
  });
});

t.test('health can read the static files it reports on', () => {
  // The file-presence check is useless if those folders are not bundled with
  // the function: everything would report as absent.
  const cfg = JSON.parse(read('vercel.json'));
  const forApi = Object.entries(cfg.functions || {})
    .find(([p]) => p.startsWith('api/'));
  t.assert(forApi, 'no function config for api/');
  const inc = forApi[1].includeFiles || '';
  ['apps', 'js', 'vendor'].forEach((dir) => {
    t.assert(inc.includes(dir),
      'includeFiles must cover ' + dir + '/ or health cannot see it');
  });
});

t.test('vercel.json bundles lib/ with the api functions', () => {
  // Vercel traces imports to decide what to ship with a function. When that
  // tracing misses a sibling folder the function deploys FINE and then crashes
  // at runtime with ERR_MODULE_NOT_FOUND, which looks like a code bug and is
  // not one. Declaring it explicitly removes the guesswork.
  const cfg = JSON.parse(read('vercel.json'));
  t.assert(cfg.functions, 'vercel.json has no functions block');
  const patterns = Object.values(cfg.functions);
  t.assert(patterns.some((f) => f.includeFiles && f.includeFiles.includes('lib')),
    'api functions must includeFiles lib/** or lib/ will not be deployed');
});

t.test('every lib/ import from api/ resolves to a real file', () => {
  const fsx = require('fs');
  const apiDir = path.join(ROOT, 'api');
  fsx.readdirSync(apiDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fsx.readFileSync(path.join(apiDir, f), 'utf8');
    [...src.matchAll(/from\s+["'](\.\.\/lib\/[^"']+)["']/g)].forEach((m) => {
      const target = path.join(apiDir, m[1]);
      t.assert(fsx.existsSync(target),
        'api/' + f + ' imports ' + m[1] + ' which does not exist');
    });
  });
});

t.test('package.json pins a Node version', () => {
  const pkg = JSON.parse(read('package.json'));
  t.assert(pkg.engines && pkg.engines.node,
    'without engines.node, Vercel picks a default that may not match what the code needs');
});

t.test('login screen avoids top-level await', () => {
  const src = read('login.html');
  const script = src.slice(src.indexOf('<script type="module">'), src.indexOf('</script>'));
  // Top-level await fails to PARSE on older browsers, so the whole module dies
  // and the page renders blank with nothing useful in the console.
  const topLevel = /^  (const|let|var) .*= await /m.test(script);
  t.assert(!topLevel, 'wrap awaits in a function so the module parses everywhere');
});

/* ---- Sign-in screen ---------------------------------------------------- */

t.test('login screen exists and offers first-account setup', () => {
  t.assert(exists('login.html'), 'login.html is missing');
  const src = read('login.html');
  t.assert(src.includes('needsSetup'), 'login must detect the empty-store case');
  t.assert(src.includes('bootstrap'), 'login must be able to create the first admin');
});

t.test('login screen declares no hex colors outside brand artwork', () => {
  const src = read('login.html').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const found = src.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  t.equal(found.length, 0, 'login.html contains hex colors: ' + found.join(', '));
});

t.test('shell sends signed-out visitors to the login screen', () => {
  const src = read('js/shell.js');
  t.assert(src.includes("location.replace('login.html')"),
    'an unauthenticated visitor should land on sign-in, not a dead end');
});

t.test('the login redirect is not skipped in mock mode', () => {
  // Regression guard. Mock mode once faked the signed-in user, so skipping the
  // redirect was harmless. Auth is always real now, and skipping it stranded
  // people on a "Not signed in" screen with no way to sign in.
  const src = read('js/shell.js');
  const block = src.slice(src.indexOf('authenticated === false'),
                          src.indexOf('state.user  = session.user'));
  t.assert(!/if\s*\(\s*!api\.MOCK\s*\)/.test(block),
    'the redirect to login must not be conditional on mock mode');
});

t.test('auth is never served from mock data', () => {
  // Mock mode exists so an app can run before its endpoints are migrated. If it
  // also faked /api/auth you would be "signed in" as a fabricated admin, which
  // is a security hole, not a convenience.
  const src = read('js/api.js');
  t.assert(src.includes('LIVE_PREFIXES'), 'the live-endpoint list is missing');
  t.assert(/LIVE_PREFIXES\s*=\s*\[[^\]]*'\/api\/auth'/.test(src),
    '/api/auth must always hit the real server');
  t.assert(src.includes('MOCK && !isLive(path)'),
    'mock mode must exempt live endpoints');
});

t.test('a 404 on a live endpoint is never masked by mock data', () => {
  const src = read('js/api.js');
  t.assert(src.includes('res.status === 404 && !isLive(path)'),
    'a failed auth call must surface, not silently fall back to mock data');
});

/* ---- Role management --------------------------------------------------- */

// INVERTED, Sep 2026. Roles were removed; this now guards against them coming
// back as a second place access can be set.
t.test('the roles API is gone', () => {
  const src = read('api/users.js');
  t.assert(!src.includes('scope === "roles"'), 'the roles branch must stay gone');
  t.assert(!src.includes('saveRoles') && !src.includes('deleteRole'),
    'nothing writes a roles map any more');
  t.assert(src.includes('access'), 'access is what the route carries instead');
});

t.test('a role in use cannot be deleted', () => {
  const src = read('lib/users.js');
  const fn = src.slice(src.indexOf('export async function deleteRole'));
  // Deleting a held role does not remove access, it silently changes it: the
  // user falls through to viewer permissions and nobody notices.
  t.assert(fn.includes('still using'),
    'deleteRole must refuse while people still hold the role');
  t.assert(fn.includes('protected'),
    'deleteRole must refuse to delete a protected role');
});

t.test('the admin role cannot be stripped of apps', () => {
  const src = read('lib/users.js');
  const fn = src.slice(src.indexOf('export async function saveRoles'), src.indexOf('export async function deleteRole'));
  t.assert(fn.includes('DEFAULT_ROLES.admin.apps.slice()'),
    'saveRoles must force admin back to every app');
  t.assert(fn.includes('has no apps'),
    'saveRoles must reject a non-admin role with no apps');
});

// REPLACED, Sep 2026. The roles editor is gone. Access is edited one person at
// a time and saved with one button, which has no cross-account invariant to
// batch: one account being wrong cannot make another invalid.
t.test('access is edited per person and saved explicitly', () => {
  const src = read('apps/settings.js');
  t.assert(!src.includes("$('#saveRolesBtn')"), 'the roles editor must stay gone');
  t.assert(/data-acc="save"/.test(src), 'the access editor has its own save');
  t.assert(/body: \{ access: access \}/.test(src),
    'and it sends the whole access record for that one person');
});

t.test('accounts table opens an access editor per person', () => {
  const src = read('apps/settings.js');
  // Sep 2026: the role dropdown is gone with roles. Each row gets a Set access
  // button instead, and the table shows what that person can open so the model
  // can be read at a glance rather than only from inside an editor.
  t.assert(!src.includes('data-role-user'), 'no role dropdown survives');
  t.assert(src.includes('data-access='), 'each row needs a Set access button');
  t.assert(src.includes('accessCell('), 'and the table says what they can open');
});

t.test('taxonomy list editing is a role flag, not a hardcoded name list', () => {
  const api = read('api/taxonomy.js');
  // The old CAN_EDIT constant named roles the shell does not even have
  // ("superuser", "management"), which silently reduced it to admin-only.
  t.assert(!api.includes('CAN_EDIT ='), 'the hardcoded CAN_EDIT list must be gone');
  t.assert(api.includes('manage_lists'), 'the gate must read the manage_lists flag');
  // Sep 2026: getRole (what does this ROLE say) became getAccess (what may this
  // PERSON do). Roles no longer exist.
  t.assert(api.includes('getAccess'), 'the gate must resolve the caller\'s access live');

  const users = read('lib/users.js');
  // Opt-in: roles stored before the flag existed must NOT gain edit rights.
  // Sep 2026: the opt-in decision moved into resolveGrants() in
  // lib/user-grants.js when accounts gained their own grants, so permsFor now
  // reads `resolved.manage_lists`. The REAL behavioural check (permsFor
  // against a fake Upstash, asserting the default is off) lives in
  // test/user-grants.test.cjs. This one only confirms the value is not being
  // read straight off the role again, which would skip the override.
  t.assert(/manage_lists:\s*access\.manage_lists/.test(users),
    'permsFor must resolve manage_lists through lib/user-grants.js');
  t.assert(/roles\.admin = Object\.assign\([\s\S]*?manage_lists: true/.test(users),
    'saveRoles must force manage_lists on for admin');

  const set = read('apps/settings.js');
  // Sep 2026: the switch moved from the roles editor to the per-person access
  // editor when roles were removed. Same flag, one place to set it.
  t.assert(set.includes('data-acc-flag='),
    'the role editor must expose a Manage ErrorEngine lists checkbox');
});

t.test('app chips carry each app accent, not a shared grey', () => {
  const src = read('apps/settings.js');
  // The point of the chips is scanning: grey-on-grey means reading every word.
  t.assert(src.includes('a.accent'), 'chips must read the accent from the registry');
  t.assert(src.includes('--c:'), 'chips must set a per-app custom property');
  t.assert(!/\.app-chip\s*\{[^}]*background:\s*var\(--line-soft\)/.test(src),
    'app chips should not fall back to one shared grey');
});

process.exit(t.report());
