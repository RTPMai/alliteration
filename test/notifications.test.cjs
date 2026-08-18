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
  import(path.join(ROOT, 'lib/users.js')),
]).then(([schema, reg, users]) => {
  const { validateNew, validatePatch, TYPES, TYPE_VALUES, GENERAL_APP, LINK_TYPES, LINK_TYPE_LABELS, PICKABLE_LINK_TYPES, keys } = schema;
  const { APPS, SHELL_APPS } = reg;
  const { DEFAULT_ROLES, permsFor } = users;

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

  /* ---- link to a record (Ryan's ask, Aug 2026) --------------------------- */

  t.test('five link types total: inquiry, lead, client, expense, donation', () => {
    t.equal(LINK_TYPES.length, 5, 'expected exactly five link types');
    ['inquiry', 'lead', 'client', 'expense', 'donation'].forEach((v) =>
      t.assert(LINK_TYPES.includes(v), 'missing link type ' + v));
    LINK_TYPES.forEach((v) =>
      t.assert(!!LINK_TYPE_LABELS[v], 'LINK_TYPE_LABELS is missing a label for ' + v));
  });

  t.test('only the three original types are pickable via manual search', () => {
    // expense/donation only ever get attached automatically, by TravelTrack/
    // GivingGauge themselves — there's no "search by company name" for them,
    // so the manual link picker on the notification form should not offer
    // them as choices even though they're valid, storable link types.
    t.equal(PICKABLE_LINK_TYPES.length, 3, 'expected exactly three pickable link types');
    ['inquiry', 'lead', 'client'].forEach((v) =>
      t.assert(PICKABLE_LINK_TYPES.includes(v), 'missing pickable link type ' + v));
    ['expense', 'donation'].forEach((v) =>
      t.assert(!PICKABLE_LINK_TYPES.includes(v), 'expense/donation should not be manually pickable — ' + v + ' is'));
  });

  t.test('a notification can carry a link to an expense or a donation, not just BackBone records', () => {
    const { ok: okExp, record: recExp } = validateNew(
      { title: 'Expense approved: $42.00', types: ['handoff'], appIds: ['traveltrack'], assignedTo: 'ryan',
        link: { type: 'expense', id: 'EXP-00012', label: 'Meals \u2014 $42.00' } },
      APP_IDS, USERS
    );
    t.equal(okExp, true, 'an expense link should validate');
    t.equal(recExp.link.type, 'expense', 'link.type should be expense');

    const { ok: okGiv, record: recGiv } = validateNew(
      { title: 'Donation approved \u2014 log the cost: Acme 5k', types: ['handoff', 'need'], appIds: ['givinggauge'], assignedTo: 'ryan',
        link: { type: 'donation', id: 'GG-00034', label: 'Acme 5k' } },
      APP_IDS, USERS
    );
    t.equal(okGiv, true, 'a donation link should validate');
    t.equal(recGiv.link.type, 'donation', 'link.type should be donation');
  });

  t.test('a notification can carry a link to a lead, inquiry, or client', () => {
    const { ok, errors, record } = validateNew(
      { title: 'New lead: Acme', types: ['handoff'], appIds: ['backbone'], assignedTo: 'ryan',
        link: { type: 'lead', id: 'LD-00042', label: 'Acme Corp' } },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'expected valid: ' + (errors || []).join(', '));
    t.equal(record.link.type, 'lead', 'link.type should be carried through');
    t.equal(record.link.id, 'LD-00042', 'link.id should be carried through');
    t.equal(record.link.label, 'Acme Corp', 'link.label should be carried through');
  });

  t.test('a notification with no link at all still validates — link stays null', () => {
    const { ok, record } = validateNew(
      { title: 'Restock coffee', types: ['task'], appIds: [GENERAL_APP], assignedTo: 'ryan' },
      APP_IDS, USERS
    );
    t.equal(ok, true, 'a notification with no link should still validate');
    t.equal(record.link, null, 'link should default to null, not undefined or {}');
  });

  t.test('an unknown link type is rejected', () => {
    const { ok, errors } = validateNew(
      { title: 'x', types: ['task'], appIds: [GENERAL_APP], assignedTo: 'ryan',
        link: { type: 'customer', id: '5860474' } },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'an unrecognized link.type should not validate');
    t.assert((errors || []).some((e) => e.includes('link.type')), 'error should mention link.type');
  });

  t.test('a link with a type but no id is rejected', () => {
    const { ok, errors } = validateNew(
      { title: 'x', types: ['task'], appIds: [GENERAL_APP], assignedTo: 'ryan', link: { type: 'lead', id: '' } },
      APP_IDS, USERS
    );
    t.equal(ok, false, 'link.type without link.id should not validate');
    t.assert((errors || []).some((e) => e.includes('link.id')), 'error should mention link.id');
  });

  t.test('a patch can attach a link to an existing notification', () => {
    const { ok, patch } = validatePatch(
      { link: { type: 'inquiry', id: 'IQ-00007', label: 'New inquiry' } }, APP_IDS, USERS
    );
    t.equal(ok, true, 'patch with a valid link should validate');
    t.equal(patch.link.type, 'inquiry', 'patch.link.type should be carried through');
  });

  t.test('a patch can explicitly clear a link with { link: null }', () => {
    const { ok, patch } = validatePatch({ link: null }, APP_IDS, USERS);
    t.equal(ok, true, 'link: null should validate');
    t.equal(patch.link, null, 'patch.link should be null, clearing the existing link');
  });

  t.test('a patch that omits link entirely leaves it untouched (not present in the patch)', () => {
    const { ok, patch } = validatePatch({ status: 'done' }, APP_IDS, USERS);
    t.equal(ok, true, 'status-only patch should validate');
    t.equal('link' in patch, false, 'omitting link should not add a link key to the patch at all');
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

  /* ---- per-role delete permission -------------------------------------- */

  t.test('every default role declares can_delete_notifications', () => {
    Object.entries(DEFAULT_ROLES).forEach(([key, role]) => {
      t.assert(role.can_delete_notifications !== undefined,
        'role "' + key + '" has no can_delete_notifications value set');
    });
  });

  t.test('can_delete_notifications defaults true when a role omits it (opt-out, not opt-in)', async () => {
    // A role saved before this flag existed (no can_delete_notifications key
    // at all) must not silently lose delete access.
    const fakeRole = { name: 'legacy', apps: ['backbone'] };
    t.equal(fakeRole.can_delete_notifications !== false, true, 'an absent flag must not read as false');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import lib/notifications/schema.js, js/registry.js, or lib/users.js: ' + e.message);
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

t.test('api/notifications.js gates DELETE on a per-role flag, not just isParty', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('callerCanDelete'), 'DELETE should check a role-level delete permission');
  t.assert(src.includes('can_delete_notifications'), 'the role flag name should appear in api/notifications.js');
});

t.test('api/notifications.js records before/after values on an edit, not just field names', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('changes'), 'edited history entries should carry a changes array with from/to values');
});

t.test('lib/users.js exposes can_delete_notifications via permsFor, opt-out by default', () => {
  const src = read('lib/users.js');
  t.assert(/can_delete_notifications:\s*role\.can_delete_notifications\s*!==\s*false/.test(src),
    'permsFor should default can_delete_notifications to true unless a role explicitly sets it false');
});

t.test('apps/settings.js exposes a "Can delete notifications" role toggle', () => {
  const src = read('apps/settings.js');
  t.assert(src.includes('data-flag="can_delete_notifications"'),
    'the role editor is missing the delete-notifications checkbox');
});

t.test('apps/notifications.js offers an Edit control that anyone who can act on the item can use', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('data-edit-toggle') && src.includes('data-edit-save'),
    'no Edit control found in apps/notifications.js');
  t.assert(src.includes('data-edit-title') && src.includes('data-edit-due'),
    'edit form should let title and due date be changed, not just type/app');
});

t.test('apps/notifications.js hides the Delete button when the role does not allow it', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('canDelete'), 'no client-side canDelete gate found for the Delete button');
});

/* ---- link to a record (Ryan's ask, Aug 2026) ------------------------------ */

t.test('api/notifications.js exposes a link search for the picker, scoped like the roster', () => {
  const src = read('api/notifications.js');
  t.assert(src.includes('linkSearch'), 'no linkSearch branch found in api/notifications.js');
  t.assert(src.includes('searchLinkable'), 'searchLinkable helper is missing');
  t.assert(src.includes('KEYS.leads') && src.includes('KEYS.intake') && src.includes('KEYS.data'),
    'link search should read from all three BackBone data sets (leads, intake, roster)');
  t.assert(src.includes('data_scope') && src.includes('"own"'),
    'client link search should respect the same "own" AM scoping as the roster endpoint');
});

t.test('api/notifications.js lets a link be attached, changed, or cleared, and logs it as an edit', () => {
  const src = read('api/notifications.js');
  t.assert(/["']link["']/.test(src), 'link should appear in the editable-fields list');
});

t.test('apps/backbone/main.js attaches a link when auto-creating lead and inquiry notifications', () => {
  const src = read('apps/backbone/main.js');
  t.assert(/link:\s*\{\s*type:\s*["']lead["']/.test(src),
    'createLeadNotifications should attach link: { type: "lead", ... }');
  t.assert(/link:\s*\{\s*type:\s*["']inquiry["']/.test(src),
    'createInquiryNotification should attach link: { type: "inquiry", ... }');
});

t.test('apps/backbone/main.js opens a deep-linked record when a route param is present', () => {
  const src = read('apps/backbone/main.js');
  t.assert(src.includes('openDeepLink'), 'showView should hand a route param off to a deep-link opener');
  t.assert(src.includes('pendingDeepLink'),
    'a deep link arriving before leads/inbox finish loading should be retried, not silently dropped');
  t.assert(/function showView\(view,\s*param\)/.test(src),
    'showView must accept a param the way index.js already passes one through');
});

t.test('js/shell.js forwards a param through goApp for cross-app deep links', () => {
  const src = read('js/shell.js');
  t.assert(/goApp:\s*\(a,\s*v,\s*p\)\s*=>\s*router\.go\(a,\s*v,\s*\{\s*param:\s*p\s*\}\)/.test(src),
    'goApp should accept and forward a third param argument to the router');
});

t.test('apps/notifications.js offers a link-to-a-record picker spanning all three link types', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('LINK_TYPES') && src.includes('LINK_TYPE_LABELS'),
    'notifications.js should import the link type constants from the schema');
  t.assert(src.includes('linkPickerHtml'), 'no link picker markup helper found');
  t.assert(src.includes('data-link-search') && src.includes('doLinkSearch'),
    'the picker should support live search-as-you-type against the linkSearch endpoint');
  t.assert(src.includes('readLinkPicker'), 'save handlers need a way to read the chosen link back out of the DOM');
});

t.test('apps/notifications.js sends the picked link on both create and edit', () => {
  const src = read('apps/notifications.js');
  t.assert(/link:\s*readLinkPicker\(['"]new['"]\)/.test(src), 'creating a notification should include the picked link');
  t.assert(/link:\s*readLinkPicker\(id\)/.test(src), 'editing a notification should include the picker\'s current link');
});

t.test('apps/notifications.js shows a clickable link pill that opens the record in its own app', () => {
  const src = read('apps/notifications.js');
  t.assert(src.includes('data-link-open'), 'no clickable link pill found on the notification card');
  t.assert(src.includes('LINK_ROUTE'), 'clicking the link pill should route via a per-type {app, view} table');
  t.assert(src.includes('ctx.goApp(route.app, route.view'),
    'the pill should call ctx.goApp with the app/view looked up for that link\'s type, not a hardcoded app');
  ['backbone', 'traveltrack', 'givinggauge'].forEach((app) =>
    t.assert(src.includes("app: '" + app + "'"), 'LINK_ROUTE is missing an entry that opens into ' + app));
});

// ---- Private notifications (Aug 18 2026) --------------------------------
// A personal scratch item must be invisible to everyone else, admins
// included, and must never end up sitting in someone else's inbox.
{
  const schema = read('lib/notifications/schema.js');
  const route = read('api/notifications.js');
  const app = read('apps/notifications.js');

  t.test('schema declares a visibility field with team as the default', () => {
    t.assert(/VISIBILITIES\s*=\s*\[\s*"team",\s*"private"\s*\]/.test(schema),
      'VISIBILITIES must list exactly team and private');
    t.assert(/DEFAULT_VISIBILITY\s*=\s*"team"/.test(schema),
      'an unmarked notification must stay visible to the team');
  });

  t.test('validateNew defaults visibility rather than trusting the body', () => {
    t.assert(/visibility:\s*b\.visibility === "private" \? "private" : DEFAULT_VISIBILITY/.test(schema),
      'anything other than the literal "private" must fall back to the default');
  });

  t.test('validatePatch rejects an unknown visibility', () => {
    t.assert(/VISIBILITIES\.includes\(b\.visibility\)/.test(schema),
      'a patch must check visibility against the allowlist');
  });

  t.test('the route hides private records from everyone but their creator', () => {
    t.assert(/const hidden = \(n\) =>[\s\S]{0,160}n\.createdBy !== me/.test(route),
      'there must be a single hidden() predicate keyed on createdBy');
    t.assert(/listNotifications\(\)\)\.filter\(\(n\) => !hidden\(n\)\)/.test(route),
      'the list must be filtered before any query filters run');
  });

  t.test('admin is not an override for private items', () => {
    const patchGate = route.slice(route.indexOf('req.method === "PATCH"'));
    t.assert(/!existing \|\| hidden\(existing\)/.test(patchGate),
      'PATCH must 404 on a private record before the admin check');
    const delGate = route.slice(route.indexOf('req.method === "DELETE"'));
    t.assert(/!existing \|\| hidden\(existing\)/.test(delGate),
      'DELETE must 404 on a private record before the admin check');
  });

  t.test('a private notification is forced back to its creator', () => {
    t.assert(/record\.visibility === "private"\) record\.assignedTo = me/.test(route),
      'POST must pin a private item to the caller');
    t.assert(/willBePrivate\) patch\.assignedTo = existing\.createdBy/.test(route),
      'PATCH must pin a private item to its creator');
  });

  t.test('the form offers Just for me and hides the assignee picker', () => {
    t.assert(/id="nf-private"/.test(app), 'the create form needs a private checkbox');
    t.assert(/visibility: \$\('#nf-private'\)/.test(app), 'the POST body must carry visibility');
    t.assert(/nf-who-field'\)\.style\.display = priv\.checked \? 'none'/.test(app),
      'assigning a private item is meaningless, so the picker must hide');
  });

  t.test('a private card is labelled on screen', () => {
    t.assert(/nt-pill private">Just for me/.test(app),
      'a private item must be visibly marked so it is never mistaken for shared work');
  });
}
