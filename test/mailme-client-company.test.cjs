// PUT IN: test/mailme-client-company.test.cjs
/**
 * MailMe: prospects at client companies count as clients (Oct 1 2026).
 *
 * The Holiday Store send held back 7 people at Foth & VanDyke, MH Equipment,
 * Iowa Donor Network and others as "Prospects", because their address was not
 * the primary contact BackBone keeps. They are client contacts, not cold leads.
 * Real calls to the audience rules and the send path's helpers.
 */
const path = require('path');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

(async () => {
  const s = await import(path.join(ROOT, 'lib/mailme/schema.js'));

  const client = { id: 'client:1', source: 'client', customer_id: '1', company_name: 'Foth & VanDyke LLC', email: 'jane@foth.com', accountManager: 'Hannah Posey', status: 'subscribed' };
  const gmailClient = { id: 'client:2', source: 'client', customer_id: '2', company_name: 'Bob', email: 'bob@gmail.com', status: 'subscribed' };
  const idx = s.clientDomainIndex([client, gmailClient]);

  await t.test('a client company domain is indexed, a free mailbox never is', () => {
    t.equal(idx.get('foth.com').company_name, 'Foth & VanDyke LLC');
    t.equal(idx.has('gmail.com'), false);
  });

  const atFoth = { id: 'prospect:9', source: 'prospect', email: 'tom@foth.com', status: 'subscribed', atClient: 'Foth & VanDyke LLC' };
  const cold = { id: 'prospect:8', source: 'prospect', email: 'x@stranger.com', status: 'subscribed' };

  await t.test('a Clients send includes prospects at client companies, not strangers', () => {
    const ids = s.selectRecipients([client, atFoth, cold], { source: 'client' }).map((c) => c.id);
    t.equal(ids.join(','), 'client:1,prospect:9');
  });

  await t.test('they are not cold, so no cold cap and no mixed-send refusal', () => {
    t.equal(s.isColdContact(atFoth), false);
    t.equal(s.isColdContact(cold), true);
    t.equal(s.campaignSourceConflict([client, atFoth], { label: 'PM', domain: 'pmapparel.com' }), null);
    t.assert(s.campaignSourceConflict([client, cold], { label: 'PM', domain: 'pmapparel.com' }), 'a real cold prospect still trips it');
    t.equal(s.identityAudienceWarning([client, atFoth], { label: 'PM', domain: 'pmapparel.com' }), null);
  });

  await t.test('a Prospects send still reaches them too', () => {
    t.equal(s.selectRecipients([atFoth, cold], { source: 'prospect' }).length, 2);
  });

  await t.test('opted-out still wins', () => {
    t.equal(s.selectRecipients([{ ...atFoth, status: 'unsubscribed' }], { source: 'client' }).length, 0);
  });

  await t.test('the contact list ties them to the client and its account manager', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/mailme/store.js'), 'utf8');
    t.assert(/clientDomains\.get\(emailDomain\(p\.email\)\)/.test(src), 'prospects are matched by email domain');
    t.assert(/accountManager: hit\.accountManager, atClient: hit\.company_name/.test(src), 'and inherit the account manager');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
