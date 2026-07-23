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

t.test('the last administrator cannot be removed or demoted', () => {
  const src = read('lib/users.js');
  t.assert(src.includes('Cannot delete the last administrator'), 'delete guard missing');
  t.assert(src.includes('Cannot demote the last administrator'), 'demote guard missing');
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

t.test('user management requires an admin session', () => {
  const src = read('api/users.js');
  t.assert(/requireAuth\(req, res, "admin"\)/.test(src),
    'api/users.js must require the admin role');
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

t.test('roles can be saved and deleted through the API', () => {
  const src = read('api/users.js');
  t.assert(src.includes('scope === "roles"'), 'the roles branch is missing');
  t.assert(src.includes('saveRoles'), 'saving roles is not wired up');
  t.assert(src.includes('deleteRole'), 'deleting roles is not wired up');
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

t.test('role edits are batched, not saved per click', () => {
  const src = read('apps/settings.js');
  // Roles have invariants that only hold across the WHOLE set (every role needs
  // at least one app), so a per-click save would post states the server must
  // reject. The Save button is what makes the batch valid.
  t.assert(src.includes("$('#saveRolesBtn')"), 'the save button is missing');
  t.assert(src.includes('markDirty'), 'unsaved changes should be tracked');
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
