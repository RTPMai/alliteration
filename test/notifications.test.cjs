// PUT IN: test/notifications.test.cjs (new)
// (this banner line is for verification only, delete it after checking the path)

// PUT IN: test/notifications.test.cjs
/**
 * Notifications tests (v2 — header panel, multi-select apps/types, no notes).
 *
 * Covers schema validation (lib/notifications/schema.js) directly — pure
 * functions, no KV needed — plus structural checks: the API's hand-maintained
 * APP_IDS allowlist against the real registry, the header panel wiring, and
 * that notifications has NO routed screen (moved out of SHELL_APPS/apps/ when
 * it became a header-only dropdown).
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
  const { APPS, SHELL_APPS } = reg;

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

  /* ---- validateNew: multi-select ---------------------------------------- */

  t.test('a valid new notification with ONE app and ONE type passes', () => {
    const { ok, errors, record } = validateNew(
      { title: 'Reprint approval', types: ['need'], appIds: ['errorengine'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid: ' + (errors || []).join(', '));
    t.equal(record.types.length, 1, 'expected one type');
    t.equal(record.appIds.length, 1, 'expected one app');
  });

  t.test('a notification can carry MULTIPLE types and MULTIPLE apps', () => {
    const { ok, errors, record } = validateNew(
      { title: 'Cross-app issue', types: ['need', 'handoff'], appIds: ['backbone', 'errorengine'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid: ' + (errors || []).join(', '));
    t.equal(record.types.length, 2, 'expected two types to be kept');
    t.equal(record.appIds.length, 2, 'expected two apps to be kept');
    t.assert(record.types.includes('need') && record.types.includes('handoff'), 'both types should survive');
    t.assert(record.appIds.includes('backbone') && record.appIds.includes('errorengine'), 'both apps should survive');
  });

  t.test('duplicate selections are de-duplicated', () => {
    const { record } = validateNew(
      { title: 'x', types: ['need', 'need', 'task'], appIds: ['general', 'general'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(record.types.length, 2, 'duplicate types should collapse');
    t.equal(record.appIds.length, 1, 'duplicate apps should collapse');
  });

  t.test('at least one type is required', () => {
    const { ok } = validateNew(
      { title: 'x', types: [], appIds: ['general'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'empty types array should not validate');
  });

  t.test('at least one app is required', () => {
    const { ok } = validateNew(
      { title: 'x', types: ['task'], appIds: [], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'empty appIds array should not validate');
  });

  t.test('an unknown type in the array is dropped, not fatal on its own', () => {
    const { ok, record } = validateNew(
      { title: 'x', types: ['task', 'urgent'], appIds: ['general'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'a mix of valid and invalid should keep the valid ones');
    t.equal(record.types.length, 1, 'the made-up type should be dropped, not kept');
  });

  t.test('a blank title is rejected', () => {
    const { ok } = validateNew(
      { title: '  ', types: ['task'], appIds: ['general'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'blank title should not validate');
  });

  t.test('notes is not part of the validated record even if supplied', () => {
    const { record } = validateNew(
      { title: 'x', types: ['task'], appIds: ['general'], assignedTo: 'ryan', notes: 'should be ignored' },
      APP_IDS, USERS
    );
    t.equal(record.notes, undefined, 'notes field should not be carried through — it was removed');
  });

  t.test('assignedTo must be a known account', () => {
    const { ok } = validateNew(
      { title: 'x', types: ['task'], appIds: ['general'], assignedTo: 'someone-who-does-not-exist' },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'unknown assignee should not validate');
  });

  /* ---- validatePatch ----------------------------------------------------- */

  t.test('marking done is a valid patch', () => {
    const { ok, patch } = validatePatch({ status: 'done' }, APP_IDS, USERS);
    t.equal(ok, true, 'status:done should validate');
    t.equal(patch.status, 'done', 'patch should carry status through');
  });

  t.test('patching types/appIds accepts arrays with multiple entries', () => {
    const { ok, patch } = validatePatch({ types: ['task', 'need'], appIds: ['shopstock', 'general'] }, APP_IDS, USERS);
    t.equal(ok, true, 'multi-value patch should validate');
    t.equal(patch.types.length, 2, 'expected two types in the patch');
    t.equal(patch.appIds.length, 2, 'expected two apps in the patch');
  });

  t.test('patching types to an empty array is rejected', () => {
    const { ok } = validatePatch({ types: [] }, APP_IDS, USERS);
    t.equal(ok, false, 'an explicit empty types array should not validate');
  });

  /* ---- store key layout --------------------------------------------------- */

  t.test('KV keys live under the notifications_data prefix', () => {
    t.assert(keys.record('N-00001').startsWith('notifications_data:'), 'record key missing prefix');
    t.assert(keys.index().startsWith('notifications_data:'), 'index key missing prefix');
  });

  /* ---- no routed screen --------------------------------------------------- */

  t.test('notifications has NO entry in SHELL_APPS — header panel only', () => {
    const hit = SHELL_APPS.find((a) => a.id === 'notifications');
    t.equal(hit, undefined, 'notifications should not be a routed shell screen anymore');
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

t.test('api/notifications.js filters by array membership, not equality', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('n.appIds') && src.includes('.includes(q.appId)'),
    'appId filter should check array membership (n.appIds.includes(...))');
  t.assert(src.includes('n.types') && src.includes('.includes(q.type)'),
    'type filter should check array membership (n.types.includes(...))');
});

t.test('api/notifications.js exposes a people picker open to any signed-in user', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('people'), 'no people-picker branch found');
  t.assert(!/requireAuth\(req,\s*res,\s*["']admin["']\)/.test(src),
    'notifications route must not be admin-gated');
});

t.test('there is no apps/notifications.js — the panel replaced the routed screen', () => {
  t.assert(!exists('apps/notifications.js'),
    'apps/notifications.js should have been removed when notifications moved into the header panel');
});

t.test('js/api.js wires the notifications endpoint as live', () => {
  const src = read('js/api.js');
  t.assert(/notifications:\s*'\/api\/notifications'/.test(src), 'ENDPOINTS.notifications is missing or renamed');
  t.assert(/LIVE_PREFIXES\s*=\s*\[[\s\S]*'\/api\/notifications'/.test(src),
    'notifications endpoint should be listed live, not left on mock data');
});

t.test('css/tokens.css defines a fixed --notif accent for the panel', () => {
  const src = read('css/tokens.css');
  t.assert(src.includes('--notif:'), 'no fixed --notif token — the panel is not tied to any one app\'s accent');
  t.assert(!src.includes('data-app="notifications"'),
    'notifications should not have a data-app theming block anymore — it has no routed screen');
});

t.test('js/notifications-panel.js exists and exports initBellPanel', () => {
  t.assert(exists('js/notifications-panel.js'), 'js/notifications-panel.js is missing');
  const src = read('js/notifications-panel.js');
  t.assert(src.includes('export function initBellPanel'), 'initBellPanel is not exported');
  t.assert(src.includes('bp-toggle'), 'multi-select toggle-pill pattern is missing from the panel');
});

t.test('the header bell + panel are wired into index.html and js/shell.js', () => {
  const html = read('index.html');
  t.assert(html.includes('id="bellBtn"'), 'index.html is missing the bell button');
  t.assert(html.includes('id="bellPanel"'), 'index.html is missing the bell dropdown panel container');
  const shell = read('js/shell.js');
  t.assert(shell.includes('initBellPanel'), 'shell.js does not wire up the notifications panel module');
});
