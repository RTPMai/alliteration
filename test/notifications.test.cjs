// PUT IN: test/notifications.test.cjs (new)
// (this banner line is for verification only, delete it after checking the path)

// PUT IN: test/notifications.test.cjs
/**
 * Notifications tests (v3 — back to a routed screen, plus reassignment and
 * a per-item history log).
 *
 * Timeline: v1 was a routed screen. v2 (same day) moved everything into a
 * header dropdown, which turned out to have an event-bubbling bug (the
 * panel closed itself the instant any inner button re-rendered it) and
 * Ryan preferred the full page anyway. v3 reverts to routed, fixes nothing
 * dropdown-related since the dropdown is gone, and adds: reassignment with
 * an optional message, and an append-only history log so "who clicked the
 * notification off" and every reassignment is traceable — the Printavo
 * Tasks pattern Ryan described.
 *
 * Covers schema validation (lib/notifications/schema.js) directly — pure
 * functions, no KV needed — plus structural checks against the real
 * registry and the restored routed screen.
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
  });

  /* ---- validateNew: multi-select ---------------------------------------- */

  t.test('a notification can carry MULTIPLE types and MULTIPLE apps', () => {
    const { ok, errors, record } = validateNew(
      { title: 'Cross-app issue', types: ['need', 'handoff'], appIds: ['backbone', 'errorengine'], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid: ' + (errors || []).join(', '));
    t.equal(record.types.length, 2, 'expected two types to be kept');
    t.equal(record.appIds.length, 2, 'expected two apps to be kept');
  });

  t.test('at least one type is required', () => {
    const { ok } = validateNew(
      { title: 'x', types: [], appIds: ['general'], assignedTo: 'ryan' }, APP_IDS, USERS
    );
    t.equal(ok, false, 'empty types array should not validate');
  });

  t.test('at least one app is required', () => {
    const { ok } = validateNew(
      { title: 'x', types: ['task'], appIds: [], assignedTo: 'ryan' }, APP_IDS, USERS
    );
    t.equal(ok, false, 'empty appIds array should not validate');
  });

  t.test('a blank title is rejected', () => {
    const { ok } = validateNew(
      { title: '  ', types: ['task'], appIds: ['general'], assignedTo: 'ryan' }, APP_IDS, USERS
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

  /* ---- validatePatch: reassignment + message ----------------------------- */

  t.test('marking done is a valid patch', () => {
    const { ok, patch } = validatePatch({ status: 'done' }, APP_IDS, USERS);
    t.equal(ok, true, 'status:done should validate');
    t.equal(patch.status, 'done', 'patch should carry status through');
  });

  t.test('reassigning to a known user is a valid patch', () => {
    const { ok, patch } = validatePatch({ assignedTo: 'HANNAH' }, APP_IDS, USERS);
    t.equal(ok, true, 'reassignment should validate');
    t.equal(patch.assignedTo, 'hannah', 'assignedTo should be lowercased');
  });

  t.test('a reassignment message is accepted and trimmed, but is a separate field from the record fields', () => {
    const { ok, patch } = validatePatch({ assignedTo: 'margo', message: '  can you confirm this?  ' }, APP_IDS, USERS);
    t.equal(ok, true, 'message alongside reassignment should validate');
    t.equal(patch.message, 'can you confirm this?', 'message should be trimmed');
  });

  t.test('a patch with only a message (no other field) still validates — a plain comment', () => {
    const { ok, patch } = validatePatch({ message: 'just checking in' }, APP_IDS, USERS);
    t.equal(ok, true, 'message-only patch should validate');
    t.equal(patch.message, 'just checking in', 'message should be carried through');
    t.equal(Object.keys(patch).length, 1, 'a message-only patch should produce no other fields');
  });

  /* ---- store key layout --------------------------------------------------- */

  t.test('KV keys live under the notifications_data prefix', () => {
    t.assert(keys.record('N-00001').startsWith('notifications_data:'), 'record key missing prefix');
  });

  /* ---- routed screen is back ------------------------------------------------ */

  t.test('notifications HAS an entry in SHELL_APPS again — routed screen restored', () => {
    const hit = SHELL_APPS.find((a) => a.id === 'notifications');
    t.assert(hit, 'notifications should be a routed shell screen');
    t.equal(hit.adminOnly, false, 'notifications must stay open to every employee, not admin-only');
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

t.test('api/notifications.js logs history on create, reassignment, and completion', () => {
  const src = read('api/notifications.js');
  ['historyEntry', '"created"', '"reassigned"', '"completed"', '"reopened"'].forEach((k) =>
    t.assert(src.includes(k), 'api/notifications.js is missing history handling for ' + k));
});

t.test('api/notifications.js records who completed a notification (doneBy)', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('doneBy') && src.includes('doneByName'),
    'completing a notification should record who did it, not just when');
});

t.test('api/notifications.js exposes a people picker open to any signed-in user', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('people'), 'no people-picker branch found');
  t.assert(!/requireAuth\(req,\s*res,\s*["']admin["']\)/.test(src),
    'notifications route must not be admin-gated');
});

t.test('there is no js/notifications-panel.js — the header dropdown was reverted', () => {
  t.assert(!exists('js/notifications-panel.js'),
    'js/notifications-panel.js should have been removed when notifications reverted to a routed screen');
});

t.test('apps/notifications.js exists and follows the app contract', () => {
  t.assert(exists('apps/notifications.js'), 'apps/notifications.js is missing');
  const src = read('apps/notifications.js');
  ['export default', "id: 'notifications'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'notifications.js is missing ' + k));
});

t.test('apps/notifications.js offers a reassign control and a history view', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('reassign'), 'no reassign UI found in apps/notifications.js');
  t.assert(src.includes('history') || src.includes('History'), 'no history UI found in apps/notifications.js');
});

t.test('apps/notifications.js uses the toggle-pill multi-select for type/app, not a <select>', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('nt-toggle'), 'multi-select toggle-pill pattern is missing');
});

t.test('js/api.js wires the notifications endpoint as live', () => {
  const src = read('js/api.js');
  t.assert(/notifications:\s*'\/api\/notifications'/.test(src), 'ENDPOINTS.notifications is missing or renamed');
  t.assert(/LIVE_PREFIXES\s*=\s*\[[\s\S]*'\/api\/notifications'/.test(src),
    'notifications endpoint should be listed live, not left on mock data');
});

t.test('css/tokens.css themes the routed notifications screen again', () => {
  t.assert(read('css/tokens.css').includes('body[data-app="notifications"]'),
    'no theming block for notifications — expected now that it is a routed screen again');
});

t.test('the header bell navigates to notifications rather than opening its own panel', () => {
  const shell = read('js/shell.js');
  t.assert(shell.includes("router.go('notifications'"), 'bell click should route to the notifications screen');
  t.assert(!shell.includes('initBellPanel'), 'shell.js should no longer reference the removed dropdown panel module');
});
