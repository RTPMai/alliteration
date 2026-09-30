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

await t.test('the route passes known contacts back only when a list was named', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'api/mailme/import.js'), 'utf8');
  t.assert(/listMemberIds: addExisting \? additions\.ids : \[\]/.test(src), 'route does not gate on a named list');
  t.assert(/!classified\.new\.length && !\(addExisting && additions\.ids\.length\)/.test(src),
    'a file of only existing clients is still refused even with a list named');
});

process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
