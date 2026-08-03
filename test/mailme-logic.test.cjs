/**
 * MailMe pure-logic tests.
 *
 * Everything exercised here is a real function call, not a source-text match.
 * These cover the four places where a bug is SILENT — it produces plausible
 * output that is wrong, and nobody finds out until after a send:
 *
 *   CSV parsing      a quoted comma shifts every column right by one, so
 *                    people get emailed with a phone number as their name
 *   import dedupe    a re-imported CSV resurrects someone who opted out
 *   list rules       a segment quietly includes or excludes the wrong people
 *   results maths    repeat opens inflate the open rate and a bad campaign
 *                    reads as a good one
 */

const t = require('./harness.cjs');

Promise.all([
  import('../lib/mailme/schema.js'),
  import('../lib/mailme/import.js'),
]).then(([schema, imp]) => {

  /* ---- CSV parsing ---------------------------------------------------- */

  t.test('parseCsv handles quoted commas without shifting columns', () => {
    const rows = imp.parseCsv('a,b,c\n"Smith, John",two,three');
    t.equal(rows.length, 2, 'expected two rows');
    t.equal(rows[1].length, 3, 'a quoted comma must not create a fourth column');
    t.equal(rows[1][0], 'Smith, John', 'quoted comma should stay inside the field');
  });

  t.test('parseCsv handles escaped quotes and embedded newlines', () => {
    const rows = imp.parseCsv('a\n"He said ""hi""","line1\nline2"');
    t.equal(rows[1][0], 'He said "hi"', 'doubled quotes should unescape');
    t.equal(rows[1][1], 'line1\nline2', 'newline inside quotes should stay in the field');
  });

  t.test('parseCsv survives CRLF line endings', () => {
    // Anything exported from Excel on Windows arrives this way.
    const rows = imp.parseCsv('a,b\r\n1,2\r\n');
    t.equal(rows.length, 2, 'CRLF must not produce phantom rows');
    t.equal(rows[1][1], '2', 'trailing CR must be stripped from the last field');
  });

  t.test('header mapping accepts the usual real-world column names', () => {
    const { rows } = imp.parseProspectCsv(
      'Work Email,Organization,First Name,Last Name,Job Title\n' +
      'a@b.com,Acme Co,Jane,Doe,Marketing Director');
    t.equal(rows[0].email, 'a@b.com', 'Work Email should map to email');
    t.equal(rows[0].company_name, 'Acme Co', 'Organization should map to company');
    t.equal(rows[0].contact_name, 'Jane Doe', 'first+last should combine into a name');
    t.equal(rows[0].title, 'Marketing Director', 'Job Title should map to title');
  });

  t.test('a file with no email column fails loudly rather than importing nothing', () => {
    const out = imp.parseProspectCsv('Company,Phone\nAcme,515-555-0100');
    t.assert(out.errors.length > 0, 'missing email column must produce an error');
    t.assert(/email/i.test(out.errors[0]), 'the error should say what is missing');
  });

  t.test('bad rows are reported, never silently dropped', () => {
    const { rows } = imp.parseProspectCsv('Email,Company\n,Acme\nnot-an-email,Beta\nok@x.com,Gamma');
    t.equal(rows.length, 3, 'every data row must come back, valid or not');
    t.assert(rows[0].problem, 'a blank email must carry a problem');
    t.assert(rows[1].problem, 'a malformed email must carry a problem');
    t.equal(rows[2].problem, null, 'a good row must have no problem');
  });

  /* ---- dedupe / classification ---------------------------------------- */

  const rowsFor = (emails) => emails.map((e, i) => ({
    lineNumber: i + 2, email: e, company_name: 'Co ' + i, contact_name: '', problem: null,
  }));

  t.test('a previously unsubscribed address can never be re-imported', () => {
    // THE most important test in this file. Re-importing a bought list must
    // not resurrect someone who opted out.
    const out = imp.classifyRows(rowsFor(['gone@x.com', 'new@x.com']), {
      suppressedEmails: ['gone@x.com'],
    });
    t.equal(out.new.length, 1, 'only the untouched address is importable');
    t.equal(out.suppressed.length, 1, 'the opted-out address must land in suppressed');
    t.equal(out.new[0].email, 'new@x.com', 'wrong address survived');
  });

  t.test('existing clients are not importable as cold prospects', () => {
    const out = imp.classifyRows(rowsFor(['client@x.com']), { clientEmails: ['client@x.com'] });
    t.equal(out.existing.length, 1, 'a current client must not become a cold prospect');
    t.equal(out.new.length, 0, 'nothing should be importable here');
  });

  t.test('duplicates within one file are caught', () => {
    const out = imp.classifyRows(rowsFor(['dup@x.com', 'dup@x.com']), {});
    t.equal(out.new.length, 1, 'the same address twice should import once');
    t.equal(out.duplicate.length, 1, 'the repeat should be reported');
  });

  t.test('classification is case insensitive on the address', () => {
    const out = imp.classifyRows(rowsFor(['Gone@X.com']), { suppressedEmails: ['gone@x.com'] });
    t.equal(out.suppressed.length, 1, 'case must not defeat the suppression check');
  });

  t.test('role addresses are rejected', () => {
    // abuse@ and postmaster@ are the addresses used to REPORT spam.
    const out = imp.classifyRows(rowsFor(['abuse@x.com', 'noreply@x.com', 'real@x.com']), {});
    t.equal(out.new.length, 1, 'only the real mailbox should import');
    t.equal(out.invalid.length, 2, 'role accounts must be rejected');
  });

  /* ---- list rules ------------------------------------------------------ */

  const contacts = [
    { id: 'client:1', source: 'client', company_name: 'Alpha', email: 'a@x.com', status: 'subscribed', tags: ['vip'] },
    { id: 'client:2', source: 'client', company_name: 'Beta', email: 'b@x.com', status: 'unsubscribed', tags: ['vip'] },
    { id: 'prospect:PR-1', source: 'prospect', company_name: 'Gamma', email: 'g@x.com', status: 'subscribed', tags: ['vip', 'cold'] },
    { id: 'prospect:PR-2', source: 'prospect', company_name: 'Delta', email: 'd@x.com', status: 'subscribed', tags: ['cold'] },
  ];
  const ids = (rows) => rows.map((r) => r.id).sort().join(',');

  t.test('a dynamic list filters by source', () => {
    const out = schema.resolveList({ kind: 'dynamic', rule: { source: 'prospect' } }, contacts);
    t.equal(ids(out), 'prospect:PR-1,prospect:PR-2', 'source filter is wrong');
  });

  t.test('tagMatch "all" requires every tag, "any" requires one', () => {
    const any = schema.resolveList(
      { kind: 'dynamic', rule: { tags: ['vip', 'cold'], tagMatch: 'any' } }, contacts);
    const all = schema.resolveList(
      { kind: 'dynamic', rule: { tags: ['vip', 'cold'], tagMatch: 'all' } }, contacts);
    // All four match: three carry 'vip', and Delta carries 'cold'.
    t.equal(ids(any), 'client:1,client:2,prospect:PR-1,prospect:PR-2', 'any-match is wrong');
    t.equal(ids(all), 'prospect:PR-1', 'all-match is wrong');
  });

  t.test('list membership includes suppressed contacts, but sending never does', () => {
    // A list DESCRIBES an audience; suppression is applied at send time. That
    // separation is what lets a list show its true size while a send from it
    // still cannot reach an opted-out address.
    const members = schema.resolveList({ kind: 'dynamic', rule: { tags: ['vip'] } }, contacts);
    t.assert(members.some((m) => m.status === 'unsubscribed'),
      'the list itself should show the unsubscribed member');
    const sendable = schema.selectRecipients(members, {});
    t.assert(!sendable.some((m) => m.status === 'unsubscribed'),
      'a send from that list must exclude them');
  });

  t.test('a static list is a fixed set, unaffected by tags', () => {
    const out = schema.resolveList({ kind: 'static', members: ['client:1', 'prospect:PR-2'] }, contacts);
    t.equal(ids(out), 'client:1,prospect:PR-2', 'static membership is wrong');
  });

  t.test('a campaign cannot mix clients and prospects', () => {
    // They send from different domains; one of the two would go out over the
    // wrong one.
    t.assert(schema.campaignSourceConflict(contacts), 'mixed sources must be refused');
    t.equal(schema.campaignSourceConflict(contacts.filter((c) => c.source === 'client')), null,
      'a single-source campaign must be allowed');
  });

  /* ---- sorting --------------------------------------------------------- */

  t.test('sorting is case insensitive and reverses', () => {
    const rows = [{ company_name: 'beta' }, { company_name: 'Alpha' }, { company_name: 'Gamma' }];
    const asc = schema.sortContacts(rows, 'company_name', 'asc').map((r) => r.company_name);
    const desc = schema.sortContacts(rows, 'company_name', 'desc').map((r) => r.company_name);
    t.equal(asc.join(','), 'Alpha,beta,Gamma', 'ascending sort should ignore case');
    t.equal(desc.join(','), 'Gamma,beta,Alpha', 'descending sort is wrong');
  });

  t.test('blank values sort last in BOTH directions', () => {
    // Reversing a sparse column otherwise fills the top of the screen with
    // empty rows, which reads as broken data.
    const rows = [{ company_name: '' }, { company_name: 'Alpha' }, { company_name: 'Beta' }];
    const asc = schema.sortContacts(rows, 'company_name', 'asc').map((r) => r.company_name);
    const desc = schema.sortContacts(rows, 'company_name', 'desc').map((r) => r.company_name);
    t.equal(asc[2], '', 'blank should be last ascending');
    t.equal(desc[2], '', 'blank should still be last descending');
  });

  t.test('an unknown sort key falls back rather than returning nothing', () => {
    const rows = [{ company_name: 'B' }, { company_name: 'A' }];
    const out = schema.sortContacts(rows, 'nonsense; DROP TABLE', 'asc');
    t.equal(out.length, 2, 'a bad sort key must not lose rows');
    t.equal(out[0].company_name, 'A', 'should fall back to the default column');
  });

  /* ---- results aggregation -------------------------------------------- */

  t.test('unique opens are counted per person, not per event', () => {
    // One keen reader opening four times must not read as four people.
    const events = [
      { type: 'open', contactId: 'c1' }, { type: 'open', contactId: 'c1' },
      { type: 'open', contactId: 'c1' }, { type: 'open', contactId: 'c2' },
    ];
    const { stats } = schema.aggregateEvents(events, 10);
    t.equal(stats.opens, 4, 'total opens should count every event');
    t.equal(stats.uniqueOpens, 2, 'unique opens should count people');
  });

  t.test('open rate uses unique opens over delivered', () => {
    const events = [
      { type: 'delivered', contactId: 'c1' }, { type: 'delivered', contactId: 'c2' },
      { type: 'open', contactId: 'c1' }, { type: 'open', contactId: 'c1' },
    ];
    const { stats } = schema.aggregateEvents(events, 2);
    const rates = schema.computeRates(stats);
    t.equal(rates.openRate, 50, 'one of two delivered opened, so 50%');
  });

  t.test('clicks are broken down per link', () => {
    const events = [
      { type: 'click', contactId: 'c1', linkUrl: 'https://a.com' },
      { type: 'click', contactId: 'c1', linkUrl: 'https://a.com' },
      { type: 'click', contactId: 'c2', linkUrl: 'https://b.com' },
    ];
    const { links } = schema.aggregateEvents(events, 5);
    t.equal(links.length, 2, 'two distinct links expected');
    t.equal(links[0].url, 'https://a.com', 'links should sort by total clicks');
    t.equal(links[0].clicks, 2, 'total clicks on the top link is wrong');
    t.equal(links[0].uniqueClicks, 1, 'the same person twice is one unique click');
  });

  t.test('rates never divide by zero', () => {
    const rates = schema.computeRates(schema.emptyStats());
    t.equal(rates.openRate, 0, 'no delivered mail should give 0%, not NaN');
    t.equal(rates.clickToOpenRate, 0, 'no opens should give 0%, not NaN');
  });

  t.test('deliverability warnings fire at the industry thresholds', () => {
    // 2% bounce and 0.1% complaint are where mailbox providers start acting.
    const bouncy = { ...schema.emptyStats(), recipients: 100, delivered: 98, bounces: 2 };
    t.assert(schema.deliverabilityWarnings(bouncy).length > 0, '2% bounce should warn');
    const clean = { ...schema.emptyStats(), recipients: 1000, delivered: 999, bounces: 1 };
    t.equal(schema.deliverabilityWarnings(clean).length, 0, '0.1% bounce should not warn');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import MailMe modules: ' + e.message);
  process.exit(1);
});
