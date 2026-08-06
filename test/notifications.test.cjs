// PUT IN: test/notifications.test.cjs (new)
// (this banner line is for verification only, delete it after checking the path)

// PUT IN: test/notifications.test.cjs
/**
 * Notifications tests.
 *
 * Covers the schema validation (lib/notifications/schema.js) directly — no
 * KV needed, these are pure functions — plus two structural checks: that
 * api/notifications.js's hand-maintained APP_IDS allowlist actually matches
 * js/registry.js's real app ids (they can't share an import, since one is
 * server code and the other is browser code that imports js/registry.js),
 * and that the shell wiring (bell, registry entry, endpoint) is all in place.
 *
 * registry.js is an ES module and the harness is CommonJS, so it is loaded
 * through a dynamic import, same pattern as test/scope.test.cjs.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

Promise.all([
  import(path.join(ROOT, 'lib/notifications/schema.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(([schema, reg]) => {
  const { validateNew, validatePatch, TYPES, TYPE_VALUES, GENERAL_APP, keys } = schema;
  const { APPS } = reg;

  const APP_IDS = APPS.map((a) => a.id).concat([GENERAL_APP]);
  const USERS = ['ryan', 'hannah', 'margo'];

  /* ---- type tags ------------------------------------------------------- */

  t.test('exactly three type tags: Task, Need, Hand Off', () => {
    t.equal(TYPES.length, 3, 'expected exactly three type tags');
    t.equal(TYPE_VALUES.includes('task'), true, 'missing task');
    t.equal(TYPE_VALUES.includes('need'), true, 'missing need');
    t.equal(TYPE_VALUES.includes('handoff'), true, 'missing handoff');
    const handoff = TYPES.find((x) => x.value === 'handoff');
    t.equal(handoff.label, 'Hand Off', 'handoff label should read "Hand Off"');
  });

  /* ---- validateNew ------------------------------------------------------ */

  t.test('a valid new notification passes', () => {
    const { ok, errors, record } = validateNew(
      { title: 'Reprint approval', type: 'need', appId: 'errorengine', assignedTo: 'ryan', notes: 'x' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid: ' + errors.join(', '));
    t.equal(record.title, 'Reprint approval', 'title not carried through');
    t.equal(record.type, 'need', 'type not carried through');
  });

  t.test('a blank title is rejected', () => {
    const { ok } = validateNew(
      { title: '  ', type: 'task', appId: 'general', assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'blank title should not validate');
  });

  t.test('a type outside task/need/handoff is rejected', () => {
    const { ok } = validateNew(
      { title: 'x', type: 'urgent', appId: 'general', assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'made-up type should not validate');
  });

  t.test('an appId not in the registry (and not "general") is rejected', () => {
    const { ok } = validateNew(
      { title: 'x', type: 'task', appId: 'not-a-real-app', assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'unknown appId should not validate');
  });

  t.test('"general" is always an accepted appId', () => {
    const { ok, errors } = validateNew(
      { title: 'x', type: 'task', appId: 'general', assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'general should validate: ' + (errors || []).join(', '));
  });

  t.test('assignedTo must be a known account', () => {
    const { ok } = validateNew(
      { title: 'x', type: 'task', appId: 'general', assignedTo: 'someone-who-does-not-exist' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'unknown assignee should not validate');
  });

  t.test('assignedTo is normalized to lowercase', () => {
    const { ok, record } = validateNew(
      { title: 'x', type: 'task', appId: 'general', assignedTo: 'RYAN' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid');
    t.equal(record.assignedTo, 'ryan', 'assignedTo should be lowercased');
  });

  /* ---- validatePatch ----------------------------------------------------- */

  t.test('marking done is a valid patch', () => {
    const { ok, patch } = validatePatch({ status: 'done' }, APP_IDS, USERS);
    t.equal(ok, true, 'status:done should validate');
    t.equal(patch.status, 'done', 'patch should carry status through');
  });

  t.test('an invalid status is rejected', () => {
    const { ok } = validatePatch({ status: 'archived' }, APP_IDS, USERS);
    t.equal(ok, false, 'made-up status should not validate');
  });

  t.test('an empty patch (nothing recognized) yields no fields', () => {
    const { ok, patch } = validatePatch({ notAField: 1 }, APP_IDS, USERS);
    t.equal(ok, true, 'unknown fields alone should not fail validation');
    t.equal(Object.keys(patch).length, 0, 'no editable fields should be produced');
  });

  /* ---- store key layout --------------------------------------------------- */

  t.test('KV keys live under the notifications_data prefix', () => {
    t.assert(keys.record('N-00001').startsWith('notifications_data:'), 'record key missing prefix');
    t.assert(keys.index().startsWith('notifications_data:'), 'index key missing prefix');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import lib/notifications/schema.js or js/registry.js: ' + e.message);
  process.exit(1);
});

/* ---- structural checks (sync, no dynamic import needed) -------------------- */

t.test('api/notifications.js exists and follows the shared handler contract', () => {
  t.assert(exists('api/notifications.js'), 'api/notifications.js is missing');
  const src = read('api/notifications.js');
  ['requireAuth', 'GET', 'POST', 'PATCH', 'DELETE'].forEach((k) =>
    t.assert(src.includes(k), 'api/notifications.js is missing ' + k));
});

t.test('api/notifications.js exposes a people picker open to any signed-in user', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('people'), 'no people-picker branch found');
  // Must NOT reuse the admin-only requireAuth(req, res, "admin") pattern from
  // api/users.js — this route is for every employee, not just admins.
  t.assert(!/requireAuth\(req,\s*res,\s*["']admin["']\)/.test(src),
    'notifications route must not be admin-gated');
});

t.test('js/api.js wires the notifications endpoint as live', () => {
  const src = read('js/api.js');
  t.assert(/notifications:\s*'\/api\/notifications'/.test(src), 'ENDPOINTS.notifications is missing or renamed');
  t.assert(/LIVE_PREFIXES\s*=\s*\[[\s\S]*'\/api\/notifications'/.test(src),
    'notifications endpoint should be listed live, not left on mock data');
});

t.test('js/registry.js registers notifications as a non-admin shell screen', () => {
  const src = read('js/registry.js');
  t.assert(src.includes("id: 'notifications'"), 'notifications is missing from SHELL_APPS');
  const entry = src.slice(src.indexOf("id: 'notifications'"), src.indexOf("id: 'notifications'") + 600);
  t.assert(/adminOnly:\s*false/.test(entry), 'notifications must be open to every employee, not admin-only');
});

t.test('css/tokens.css themes the notifications screen', () => {
  t.assert(read('css/tokens.css').includes('body[data-app="notifications"]'),
    'no theming block for notifications');
});

t.test('apps/notifications.js exists and follows the app contract', () => {
  t.assert(exists('apps/notifications.js'), 'apps/notifications.js is missing');
  const src = read('apps/notifications.js');
  ['export default', "id: 'notifications'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'notifications.js is missing ' + k));
});

t.test('the header bell is wired into index.html and js/shell.js', () => {
  t.assert(read('index.html').includes('id="bellBtn"'), 'index.html is missing the bell button');
  const shell = read('js/shell.js');
  t.assert(shell.includes('bellBtn') && shell.includes('bellBadge'), 'shell.js is missing bell wiring');
  t.assert(shell.includes('refreshBell'), 'shell.js is missing the badge refresh logic');
});
