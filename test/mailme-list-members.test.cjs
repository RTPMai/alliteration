// test/mailme-list-members.test.cjs
/**
 * Locks the "click into a list, see who's on it" feature added to the
 * Lists view (apps/mailme.js). This reads through GET /api/mailme/lists?id=,
 * which already resolves membership server-side via lib/mailme/store.js's
 * membersOf() — the same function that produces the memberCount/mailableCount
 * numbers the list table already showed. The tests here lock that the front
 * end actually calls that endpoint and renders it, rather than re-deriving
 * membership client-side (which would be a second implementation of
 * matchesRule() to drift out of sync with schema.js).
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const src = read('apps/mailme.js');

t.test('the members panel renders into the shared modal', () => {
  // Was a #mmListMembers container inline in the Lists view. It is now the
  // same modal Results and the editors use, so the assertion is that it
  // routes through setModalContent under the 'members' kind rather than
  // writing into a container that no longer exists.
  t.assert(!/id="mmListMembers"/.test(src),
    'the old inline members container should be gone');
  const fn = src.slice(src.indexOf('async function viewListMembers'));
  t.assert(/setModalContent\([^)]*'members'\)/.test(fn.slice(0, 900)),
    'viewListMembers must open the members modal');
  t.assert(/closeModalIf\('members'\)/.test(src),
    'closing the panel must close that modal specifically, not whatever is open');
});

t.test('viewing a list fetches its resolved members from the server, not a client-side rule match', () => {
  t.assert(/async function viewListMembers/.test(src), 'viewListMembers() is missing');
  const fn = src.slice(src.indexOf('async function viewListMembers'));
  const body = fn.slice(0, fn.indexOf('\n    function renderListMembersPanel'));
  t.assert(/api\.get\(ENDPOINTS\.mmLists,\s*\{\s*id:\s*listId\s*\}\)/.test(body),
    'viewListMembers must call GET ENDPOINTS.mmLists with ?id= to get resolved membership');
  t.assert(!/matchesRule/.test(body), 'the front end must not re-implement list-rule matching itself');
});

t.test('every list row has a way to view its members', () => {
  t.assert(/data-viewlist/.test(src), 'list rows are missing a data-viewlist trigger');
  t.assert(/mm-linklike/.test(src), 'the list name should be clickable, not just a small "View" button');
});

t.test('the members panel shows email, source, status and tags per member', () => {
  const fn = src.slice(src.indexOf('function renderListMembersPanel'));
  const body = fn.slice(0, fn.indexOf('\n    function renderListTable'));
  ['m.email', 'm.source', 'm.status', 'm.tags'].forEach((field) => {
    t.assert(body.includes(field), `renderListMembersPanel is missing ${field}`);
  });
  t.assert(/STATUS_META/.test(body) && /SOURCE_META/.test(body),
    'renderListMembersPanel should reuse the shared STATUS_META/SOURCE_META labels, not invent new ones');
});

t.test('the members panel can be closed and does not linger when a different list is edited', () => {
  t.assert(/function closeListMembers/.test(src), 'closeListMembers() is missing');
  t.assert(/\[data-editlist\]'\)\.forEach\(\(b\) => \{[\s\S]{0,200}closeListMembers\(\)/.test(src),
    'opening the list editor should close any open members panel first');
});

/* ---- editing membership: add/remove ---- */

t.test('EVERY list allows adding and removing members by hand', () => {
  // Previously a dynamic list built on source or free-text search offered no
  // add box at all, because there was no per-contact field to toggle. The
  // exception is now stored on the list instead, so no list is read-only.
  t.assert(/function listIsMemberEditable/.test(src), 'listIsMemberEditable() is missing');
  const fn = src.slice(src.indexOf('function listIsMemberEditable'));
  const body = fn.slice(0, fn.indexOf('}'));
  t.assert(/return !!list/.test(body),
    'no list kind should be excluded from hand-editing');
});

t.test('a non-tag dynamic list records the change on the list, not on the contact', () => {
  // Setting a tag the rule does not use would not add anyone to the list,
  // and would quietly edit the contact for no reason.
  const add = src.slice(src.indexOf('async function addListMember'));
  const addBody = add.slice(0, add.indexOf('\n    function renderListMembersPanel'));
  t.assert(/extraMembers/.test(addBody), 'adding must write extraMembers for a non-tag rule');
  t.assert(/excludedMembers.*filter/.test(addBody),
    'adding someone must also clear any prior exclusion, or the two cancel out');

  const rem = src.slice(src.indexOf('async function removeListMember'));
  const remBody = rem.slice(0, rem.indexOf('\n    async function addListMember'));
  t.assert(/excludedMembers/.test(remBody),
    'removing must write excludedMembers, or the rule re-adds them immediately');
});

t.test('a tag-based dynamic list still uses tags, not the override', () => {
  // Tags keep the contact and the rule telling the same story, so the
  // override is only for rules that have no tag to set.
  t.assert(/function usesTagMechanism/.test(src), 'usesTagMechanism() is missing');
  const add = src.slice(src.indexOf('async function addListMember'));
  t.assert(/usesTagMechanism\(list\)/.test(add.slice(0, 1400)),
    'the add path must branch on whether the rule is tag-based');
});

t.test('removing a member from a STATIC list edits list.members, not the contact', () => {
  const fn = src.slice(src.indexOf('async function removeListMember'));
  const body = fn.slice(0, fn.indexOf('\n    async function addListMemberByEmail'));
  t.assert(/kind === ['"]static['"]/.test(body), 'removeListMember must branch on static vs dynamic');
  t.assert(/api\.patch\(ENDPOINTS\.mmLists,\s*\{\s*id:\s*list\.id,\s*members\s*\}\)/.test(body),
    'a static list must be edited via PATCH ENDPOINTS.mmLists with the updated members array');
});

t.test('removing a member from a TAG-BASED dynamic list edits the contact\'s tags, not list.members', () => {
  const fn = src.slice(src.indexOf('async function removeListMember'));
  const body = fn.slice(0, fn.indexOf('\n    async function addListMemberByEmail'));
  t.assert(/api\.patch\(ENDPOINTS\.mmContacts,\s*\{\s*id:\s*member\.id,\s*tags\s*\}\)/.test(body),
    'a dynamic list must be edited by removing the rule tag(s) from the contact via PATCH ENDPOINTS.mmContacts');
});

t.test('adding a member looks up an existing contact by email rather than creating a bare record', () => {
  t.assert(/async function addListMemberByEmail/.test(src), 'addListMemberByEmail() is missing');
  const fn = src.slice(src.indexOf('async function addListMemberByEmail'));
  const body = fn.slice(0, fn.indexOf('\n    function renderListMembersPanel'));
  t.assert(/state\.contacts\.find/.test(body),
    'adding a member must look the email up against already-loaded contacts');
  t.assert(/No contact with that email/.test(body),
    'an unknown email should get a clear error rather than silently doing nothing');
});

t.test('the member row actions refresh contacts, lists, and the open panel after a change', () => {
  const removeFn = src.slice(src.indexOf('async function removeListMember'));
  const removeBody = removeFn.slice(0, removeFn.indexOf('\n    async function addListMemberByEmail'));
  t.assert(/loadContacts\(\)/.test(removeBody) && /loadLists\(\)/.test(removeBody) && /viewListMembers\(list\.id\)/.test(removeBody),
    'removeListMember should reload contacts/lists and refresh the open panel');
});

t.test('the Dashboard view has a message target, so a failed refresh is visible instead of silently showing zeros', () => {
  t.assert(/dashboard:\s*['"]#mm\w+['"]/.test(src),
    'MSG_TARGET is missing a "dashboard" entry — a failed Dashboard refresh currently fails ' +
    'silently (shows 0s with no error), because refreshView() only announces errors when ' +
    'opts.announce is set, and that comes from MSG_TARGET[view]');
});


/* ---- resolveList overrides: real calls, not source matching ---- */

(async () => {
  const schema = await import('../lib/mailme/schema.js');
  const contacts = [
    { id: 'client:1', email: 'a@x.com', source: 'client', tags: [] },
    { id: 'client:2', email: 'b@x.com', source: 'client', tags: [] },
    { id: 'prospect:9', email: 'c@x.com', source: 'prospect', tags: [] },
  ];
  const base = { kind: 'dynamic', rule: { source: 'client' } };
  const ids = (l) => schema.resolveList(l, contacts).map((c) => c.id);

  t.test('a manual addition appears even though the rule does not match them', () => {
    t.equal(ids({ ...base, extraMembers: ['prospect:9'] }).join(','),
      'client:1,client:2,prospect:9');
  });

  t.test('a manual removal sticks even though the rule still matches them', () => {
    // Without this the rule would re-add them on the very next render.
    t.equal(ids({ ...base, excludedMembers: ['client:1'] }).join(','), 'client:2');
  });

  t.test('exclusion beats inclusion, so a contact can never be both', () => {
    t.equal(ids({ ...base, extraMembers: ['client:1'], excludedMembers: ['client:1'] }).join(','),
      'client:2');
  });

  t.test('a list with no overrides behaves exactly as before', () => {
    t.equal(ids(base).join(','), 'client:1,client:2');
    t.equal(ids({ ...base, extraMembers: [], excludedMembers: [] }).join(','), 'client:1,client:2');
  });

  t.test('overrides never leak into static lists', () => {
    const stat = { kind: 'static', members: ['client:1'], extraMembers: ['prospect:9'] };
    t.equal(ids(stat).join(','), 'client:1',
      'a static list is its members, full stop');
  });

  process.exit(t.report());
})();
