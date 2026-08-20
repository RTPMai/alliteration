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

/* THE MEMBERS PANEL IS GONE, and that is the point of the Aug 2026
   restructure. Lists stopped being a separate screen with their own table:
   they are a filter over the ONE contacts table on Audience. So these tests
   assert the merged behaviour rather than a panel that no longer exists.
   Everything below about HOW membership is edited is unchanged, because that
   logic was correct and moved across intact. */

t.test('a list is a filter over the one contacts table, not a separate panel', () => {
  t.assert(!/id="mmListMembers"/.test(src),
    'the old inline members container should be gone');
  t.assert(!/function renderListMembersPanel/.test(src),
    'the separate members panel renderer should be gone: one table renders both');
  t.assert(/function renderContactsTable/.test(src),
    'the shared table renderer is missing');
  const fn = src.slice(src.indexOf('function renderContactsTable'));
  const body = fn.slice(0, fn.indexOf('function wireListTools'));
  t.assert(/state\.activeListId/.test(body) && /state\.activeListMembers/.test(body),
    'the table must render list members when a list is selected');
});

t.test('selecting a list fetches its resolved members from the server, not a client-side rule match', () => {
  t.assert(/async function selectList/.test(src), 'selectList() is missing');
  const fn = src.slice(src.indexOf('async function selectList'));
  const body = fn.slice(0, fn.indexOf('\n    /* ----------------'));
  t.assert(/api\.get\(ENDPOINTS\.mmLists,\s*\{\s*id:\s*listId\s*\}\)/.test(body),
    'selectList must call GET ENDPOINTS.mmLists with ?id= to get resolved membership');
  t.assert(!/matchesRule/.test(body), 'the front end must not re-implement list-rule matching itself');
});

t.test('every list is reachable from one searchable picker', () => {
  // Chips became a dropdown once the list count grew: a dozen of them wrapped
  // onto three rows and pushed the table below the fold, and the only way to
  // find one was to read all of them.
  t.assert(/function renderPickers/.test(src), 'renderPickers() is missing');
  const fn = src.slice(src.indexOf('function pickerOptions'));
  const body = fn.slice(0, fn.indexOf('function renderPickers'));
  t.assert(/state\.lists\.map/.test(body), 'every saved list must appear in the picker');
  t.assert(/Everyone/.test(body),
    'there must be a way back to the unfiltered roster, or a selected list is a trap');
  t.assert(/SEARCH_THRESHOLD/.test(src),
    'the picker must offer a filter box once there are enough options to need one');
});

t.test('the table shows email, source and status per row, list or not', () => {
  // Tags and Reorder left this table on Aug 19. Reorder is BackBone's now, so
  // MailMe was showing a column it could not change; tags were a workaround
  // for having no multi-select, which the checkboxes replaced.
  const fn = src.slice(src.indexOf('function renderContactsTable'));
  const body = fn.slice(0, fn.indexOf('/* ---------------- bulk selection'));
  ['ct.email', 'ct.source', 'ct.status'].forEach((field) => {
    t.assert(body.includes(field), `renderContactsTable is missing ${field}`);
  });
  t.assert(!/reorderCell/.test(src), 'the reorder column should be gone');
  t.assert(!/data-tags=/.test(src), 'the per-row Tags button should be gone');
  t.assert(/STATUS_META/.test(body) && /SOURCE_META/.test(body),
    'the table should reuse the shared STATUS_META/SOURCE_META labels, not invent new ones');
});

t.test('leaving a list is always possible and filtering by source does it explicitly', () => {
  // Two filters at once (a list AND a source) is a state nothing else in the
  // app can express, so picking a source drops the list rather than showing
  // a silent intersection.
  const fn = src.slice(src.indexOf('async function choosePicker'));
  const body = fn.slice(0, fn.indexOf('async function selectList'));
  t.assert(/state\.activeListId = null/.test(body),
    'choosing a source filter must leave the selected list rather than intersecting');
  t.assert(/clearSelection\(\)/.test(body),
    'changing the filter must drop the selection, or a bulk action hits rows nobody can see');
});

/* ---- editing membership: add/remove ---- */

t.test('EVERY list allows adding and removing members by hand', () => {
  // A dynamic list built on source or free-text search once offered no add
  // box at all, because there was no per-contact field to toggle. The
  // exception is stored on the list instead, so no list kind is read-only.
  // Post-restructure there is no listIsMemberEditable() gate to check: the
  // add row and the Remove button render for any selected list, which is a
  // stronger guarantee than a function that returned true.
  const fn = src.slice(src.indexOf('function renderContactsTable'));
  const body = fn.slice(0, fn.indexOf('function wireListTools'));
  t.assert(/mmAddMemberEmail/.test(body),
    'a selected list must offer an add-by-email row, whatever kind it is');
  t.assert(/data-removemember/.test(body),
    'a selected list must offer Remove on every row, whatever kind it is');
  t.assert(!/listIsMemberEditable/.test(body),
    'no list kind should be gated out of hand-editing');
});

t.test('a non-tag dynamic list records the change on the list, not on the contact', () => {
  // Setting a tag the rule does not use would not add anyone to the list,
  // and would quietly edit the contact for no reason.
  const add = src.slice(src.indexOf('async function addListMemberByEmail'));
  const addBody = add.slice(0, add.indexOf('\n    /* ----------------'));
  t.assert(/extraMembers/.test(addBody), 'adding must write extraMembers for a non-tag rule');
  t.assert(/excludedMembers.*filter/.test(addBody),
    'adding someone must also clear any prior exclusion, or the two cancel out');

  const rem = src.slice(src.indexOf('async function removeListMember'));
  const remBody = rem.slice(0, rem.indexOf('\n    async function addListMemberByEmail'));
  t.assert(/excludedMembers/.test(remBody),
    'removing must write excludedMembers, or the rule re-adds them immediately');
});

t.test('a tag-based dynamic list still uses tags, not the override', () => {
  // Tags keep the contact and the rule telling the same story, so the
  // override is only for rules that have no tag to set.
  t.assert(/function usesTagMechanism/.test(src), 'usesTagMechanism() is missing');
  const add = src.slice(src.indexOf('async function addListMemberByEmail'));
  t.assert(/usesTagMechanism\(list\)/.test(add.slice(0, 2600)),
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

t.test('adding a member reuses an existing contact before creating anything', () => {
  // An address already in MailMe must keep whatever it already is (client,
  // lead, giving, prospect). Only a genuinely unknown address creates a
  // prospect, and the server decides that, not this screen.
  t.assert(/async function addListMemberByEmail/.test(src), 'addListMemberByEmail() is missing');
  const fn = src.slice(src.indexOf('async function addListMemberByEmail'));
  const body = fn.slice(0, fn.indexOf('\n    function renderListMembersPanel'));
  t.assert(/state\.contacts\.find/.test(body),
    'the already-loaded contacts should be checked first, to avoid a needless round trip');
  t.assert(/api\.post\(ENDPOINTS\.mmContacts/.test(body),
    'an unknown address must go to the find-or-create endpoint');
  t.assert(/createdNew/.test(body),
    'the result must distinguish a new prospect from an existing contact');
});

t.test('the result tells you whether it created someone or reused them', () => {
  // "Added as a new prospect" versus "Added (existing client)". Silently
  // creating a person is the kind of thing you want to see happen.
  const fn = src.slice(src.indexOf('async function addListMemberByEmail'));
  const body = fn.slice(0, fn.indexOf('\n    function renderListMembersPanel'));
  t.assert(/as a new prospect/.test(body) && /existing/.test(body),
    'both outcomes need distinct wording');
});

t.test('the member row actions refresh contacts, lists, and the selected list after a change', () => {
  // One shared reload path rather than each action remembering three calls.
  // That is what stops a change made from a list row and the same change made
  // from the roster leaving the screen in two different states.
  const removeFn = src.slice(src.indexOf('async function removeListMember'));
  const removeBody = removeFn.slice(0, removeFn.indexOf('\n    async function addListMemberByEmail'));
  t.assert(/refreshAudience\(\)/.test(removeBody),
    'removeListMember should go through the shared audience reload');

  const rf = src.slice(src.indexOf('async function refreshAudience'));
  const rbody = rf.slice(0, rf.indexOf('\n    /* ----------------'));
  t.assert(/loadContacts\(\)/.test(rbody) && /loadLists\(\)/.test(rbody),
    'the shared reload must refetch both contacts and lists');
  t.assert(/selectList\(state\.activeListId\)/.test(rbody),
    'and re-resolve the selected list, so a removal is visible without reopening it');
});

t.test('EVERY view has a message target, so a failed refresh is visible instead of silently showing zeros', () => {
  // refreshView() only announces an error when opts.announce is set, and that
  // comes from MSG_TARGET[view]. A view missing an entry fails silently: it
  // shows stale numbers or zeros with nothing on screen saying why. The
  // Dashboard used to be the gap; asserting on the whole set means a view
  // added later cannot reintroduce it.
  const block = src.slice(src.indexOf('const MSG_TARGET'), src.indexOf('const SOURCE_META'));
  ['campaigns', 'audience', 'reports', 'settings'].forEach((v) => {
    t.assert(new RegExp(v + "\\s*:\\s*['\"]#mm\\w+['\"]").test(block),
      'MSG_TARGET is missing a "' + v + '" entry, so a failed refresh there is invisible');
  });
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
