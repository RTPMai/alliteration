// PUT IN: test/mailme-import-list.test.cjs
/**
 * MailMe import: people already in MailMe go on the named list (Sep 29 2026).
 *
 * Ryan imported the 75-row Holiday Store Prospect list into "Holiday Store
 * Prospects". 67 rows were already BackBone clients, so import skipped them
 * and the list ended up holding 7 people. These checks call listAdditions()
 * directly, the function the route uses to decide who else goes on the list.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const load = () => import(path.join(ROOT, 'lib/mailme/import.js'));
const rowsFor = (emails) => emails.map((e, i) => ({ email: e, lineNumber: i + 2, company_name: 'Co ' + i }));

(async () => {

await t.test('existing clients go on the list as the contacts they already are', async () => {
  const { classifyRows, listAdditions } = await load();
  const cls = classifyRows(rowsFor(['client@a.com', 'new@b.com']), { clientEmails: ['client@a.com'] });
  const add = listAdditions(cls, [{ id: 'client:1', email: 'Client@A.com' }, { id: 'prospect:9', email: 'other@x.com' }]);
  t.equal(add.ids.join(','), 'client:1');
  t.equal(cls.new.length, 1, 'the new row is still imported');
});

await t.test('prospects from an earlier import go on too; a repeat inside the file does not double up', async () => {
  const { classifyRows, listAdditions } = await load();
  const cls = classifyRows(rowsFor(['old@p.com', 'fresh@q.com', 'fresh@q.com']), { prospectEmails: ['old@p.com'] });
  const add = listAdditions(cls, [{ id: 'prospect:1', email: 'old@p.com' }, { id: 'prospect:2', email: 'fresh@q.com' }]);
  t.equal(add.ids.join(','), 'prospect:1');
});

await t.test('an opted-out address never goes on a list, even if it is a client', async () => {
  const { classifyRows, listAdditions } = await load();
  const cls = classifyRows(rowsFor(['gone@x.com']), { suppressedEmails: ['gone@x.com'], clientEmails: ['gone@x.com'] });
  t.equal(listAdditions(cls, [{ id: 'client:5', email: 'gone@x.com' }]).ids.length, 0);
});

await t.test('invalid rows never go on a list', async () => {
  const { classifyRows, listAdditions } = await load();
  const cls = classifyRows([{ email: 'noreply@x.com', lineNumber: 2 }], { clientEmails: ['noreply@x.com'] });
  t.equal(listAdditions(cls, [{ id: 'client:5', email: 'noreply@x.com' }]).ids.length, 0);
});

await t.test('one person under two companies: both records go on, the address counts once', async () => {
  const { classifyRows, listAdditions } = await load();
  const cls = classifyRows(rowsFor(['sam@x.com']), { clientEmails: ['sam@x.com'] });
  const add = listAdditions(cls, [{ id: 'client:1', email: 'sam@x.com' }, { id: 'client:2', email: 'sam@x.com' }]);
  t.equal(add.ids.length, 2);
  t.equal(add.emails.length, 1, 'the count shown to the person should be people, not records');
});

await t.test('the Holiday Store shape: 7 new, 67 clients, 1 invalid all accounted for', async () => {
  const { classifyRows, listAdditions } = await load();
  const clients = Array.from({ length: 67 }, (_, i) => `c${i}@client.com`);
  const fresh = Array.from({ length: 7 }, (_, i) => `n${i}@new.com`);
  const rows = rowsFor(clients.concat(fresh)).concat([{ email: '', lineNumber: 99, problem: 'No email address' }]);
  const cls = classifyRows(rows, { clientEmails: clients });
  const add = listAdditions(cls, clients.map((e, i) => ({ id: 'client:' + i, email: e })));
  t.equal(cls.new.length, 7);
  t.equal(add.ids.length, 67);
  t.equal(cls.invalid.length, 1);
  t.equal(cls.new.length + add.ids.length + cls.invalid.length, 75, 'a row went missing');
});

/* ---- Oct 1 2026: the list is written by the server, in the same request ---- */

await t.test('a list name finds the existing list whatever the case or spacing', async () => {
  const { findListByName } = await load();
  const lists = [{ id: 'LS-1', name: 'Holiday Store Prospects' }, { id: 'LS-2', name: 'Other' }];
  t.equal(findListByName(lists, '  holiday store prospects ').id, 'LS-1');
  t.equal(findListByName(lists, 'nope'), null);
  t.equal(findListByName(lists, ''), null);
});

await t.test('the Holiday Store case: 7 on a static list, 67 clients added, list ends at 74', async () => {
  const { planListAdd } = await load();
  const seven = Array.from({ length: 7 }, (_, i) => 'prospect:' + i);
  const clients = Array.from({ length: 67 }, (_, i) => 'client:' + i);
  const list = { id: 'LS-1', name: 'Holiday Store Prospects', kind: 'static', members: seven };
  const plan = planListAdd(list, clients.concat(seven), seven);
  t.equal(plan.action, 'static');
  t.equal(plan.addingIds.length, 67);
  t.equal(plan.alreadyIds.length, 7, 'the 7 already there are reported, not re-added');
  t.equal(plan.patch.members.length, 74);
});

await t.test('no list yet: one is created holding everyone', async () => {
  const { planListAdd } = await load();
  const plan = planListAdd(null, ['client:1', 'prospect:2', 'client:1'], [], ' Spring schools ');
  t.equal(plan.action, 'create');
  t.equal(plan.patch.kind, 'static');
  t.equal(plan.patch.name, 'Spring schools');
  t.equal(plan.patch.members.join(','), 'client:1,prospect:2');
});

await t.test('a rule-based list gets exceptions, and anyone removed by hand is let back in', async () => {
  const { planListAdd } = await load();
  const list = { kind: 'dynamic', rule: {}, extraMembers: ['client:9'], excludedMembers: ['client:2', 'client:5'] };
  const plan = planListAdd(list, ['client:1', 'client:2', 'client:3'], ['client:3', 'client:9']);
  t.equal(plan.action, 'dynamic');
  t.equal(plan.patch.extraMembers.sort().join(','), 'client:1,client:2,client:9');
  t.equal(plan.patch.excludedMembers.join(','), 'client:5', 'an excluded person named in the upload comes back');
  t.equal(plan.alreadyIds.join(','), 'client:3');
});

await t.test('a static list keeps the members it already had', async () => {
  const { planListAdd } = await load();
  const plan = planListAdd({ kind: 'static', members: ['a', 'b'] }, ['c'], ['a', 'b']);
  t.equal(plan.patch.members.join(','), 'a,b,c');
});

await t.test('counts are people, not records', async () => {
  const { peopleCount } = await load();
  const contacts = [{ id: 'client:1', email: 'sam@x.com' }, { id: 'client:2', email: 'SAM@x.com' }, { id: 'client:3', email: 'jo@x.com' }];
  t.equal(peopleCount(['client:1', 'client:2', 'client:3'], contacts), 2);
  t.equal(peopleCount(['prospect:new'], contacts), 1, 'an id not yet resolvable still counts');
});

await t.test('the route writes the list itself, in the commit, and reports a list failure separately', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'api/mailme/import.js'), 'utf8');
  const commit = src.slice(src.indexOf('// ---- commit ----'));
  t.assert(/planListAdd\(target, additions\.ids\.concat\(newIds\)/.test(commit),
    'the newly imported people must go on the list with everyone else');
  t.assert(/createList\(/.test(commit) && /updateList\(/.test(commit), 'the server must write the list');
  t.assert(/listError/.test(commit), 'a list failure must not be reported as an import failure');
  t.assert(commit.indexOf('addProspects(') < commit.indexOf('planListAdd(target, additions.ids.concat'),
    'import first, then list, so a list failure never loses the import');
});

process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
