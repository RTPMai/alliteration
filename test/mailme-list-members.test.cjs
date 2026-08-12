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

t.test('the Lists view has a members panel mount point', () => {
  t.assert(/id="mmListMembers"/.test(src), 'apps/mailme.js is missing the #mmListMembers container');
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

t.test('a tag-based dynamic list, or a static list, allows adding/removing members', () => {
  t.assert(/function listIsMemberEditable/.test(src), 'listIsMemberEditable() is missing');
  const fn = src.slice(src.indexOf('function listIsMemberEditable'));
  const body = fn.slice(0, fn.indexOf('\n    async function removeListMember'));
  t.assert(/kind === ['"]static['"]/.test(body) && /listRuleTags\(list\)\.length > 0/.test(body),
    'membership editing must be allowed for static lists and tag-based dynamic lists');
});

t.test('a source- or search-only dynamic list explains why it cannot be hand-edited here', () => {
  t.assert(/isn't tag-based/.test(src),
    'the panel should tell the user why add/remove is unavailable for a non-tag rule');
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
