// PUT IN: test/marketmachine-email-pass2.test.cjs
/**
 * Email inside MarketMachine, pass 2 (Oct 1 2026): the Quick Email campaign
 * type, building a list from filters in step 1, and MailMe's New button
 * handing off to MarketMachine. Real calls where the logic is plain code.
 */
const path = require('path');
const fs = require('fs');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  const cat = await import(path.join(ROOT, 'lib/marketmachine/catalog.js'));
  const camp = await import(path.join(ROOT, 'lib/marketmachine/campaign.js'));
  const mm = await import(path.join(ROOT, 'lib/mailme/schema.js'));

  /* ---- Quick Email ---- */

  await t.test('Quick Email is a real campaign type with a short, all-AM checklist', () => {
    const q = cat.typeMeta('quick_email');
    t.assert(q, 'missing');
    t.equal(q.label, 'Quick Email');
    t.equal(q.steps.length, 5);
    t.assert(q.steps.every((s) => s.owner === 'Account Manager'), 'every step is the AM\'s');
    t.equal(q.steps[0].key, 'qe_audience', 'who gets it comes first');
  });

  await t.test('a Quick Email campaign is created the way MailMe asks for one', () => {
    const body = { type: 'quick_email', name: 'Quick email, Oct 1', audienceKind: 'list', platforms: ['email'] };
    t.equal(camp.validateNew(body).ok, true, JSON.stringify(camp.validateNew(body).errors));
    const rec = camp.buildCampaign(body, { username: 'ryan' });
    t.equal(rec.type, 'quick_email');
    t.equal(rec.steps.length, 5);
    t.equal(rec.status, 'open');
  });

  await t.test('its steps go in order, and sending waits on the test', () => {
    const q = cat.typeMeta('quick_email');
    const send = q.steps.find((s) => s.key === 'qe_send');
    t.equal(send.after.join(','), 'qe_test');
  });

  /* ---- top clients ---- */

  const P = [
    { id: 'c1', lifetimeRevenue: 50000, ytdRevenue: 100 },
    { id: 'c2', lifetimeRevenue: 90000, ytdRevenue: 30000 },
    { id: 'c3', lifetimeRevenue: 9000, ytdRevenue: 9000 },
    { id: 'p1', lifetimeRevenue: 0, ytdRevenue: 0 },
    { id: 'l1' },
  ];
  const ids = (r) => r.map((c) => c.id).join(',');

  await t.test('top N by all-time spend, biggest first, as numbers', () => {
    t.equal(ids(mm.topContacts(P, 2, 'lifetimeRevenue')), 'c2,c1');
  });

  await t.test('top N this year ranks by this year', () => {
    t.equal(ids(mm.topContacts(P, 2, 'ytdRevenue')), 'c2,c3');
  });

  await t.test('nobody at $0 pads a top list out', () => {
    t.equal(ids(mm.topContacts(P, 50, 'lifetimeRevenue')), 'c2,c1,c3');
  });

  await t.test('no N means no cut, and silly N is capped', () => {
    t.equal(mm.topContacts(P, 0).length, P.length);
    t.equal(mm.topContacts(P, '9999', 'lifetimeRevenue').length, 3);
    t.equal(mm.topContacts(P, 'abc').length, P.length);
  });

  /* ---- the screens ---- */
  const app = read('apps/mailme.js');

  await t.test('a top-N list is saved fixed, a plain filter is saved as a rule', () => {
    const fn = app.slice(app.indexOf('async function saveFilterList'), app.indexOf('/* ---------------- modal machinery'));
    t.assert(/f\.top\s*\?\s*\{ name: nm, kind: 'static'/.test(fn), 'top N is a fixed list');
    t.assert(/kind: 'dynamic', rule:/.test(fn) && /industries:/.test(fn) && /tiers:/.test(fn), 'filters are a rule');
    t.assert(/sendToList\(id, [\s\S]*?, f\.source\);/.test(fn), 'the email is pointed at it, with who the list holds');
  });

  await t.test('the count comes from the server, mailable people only', () => {
    const fn = app.slice(app.indexOf('async function countFilter'), app.indexOf('async function saveFilterList'));
    t.assert(/status: 'mailable'/.test(fn) && /q\.top = f\.top/.test(fn));
    const route = read('api/mailme/contacts.js');
    t.assert(/if \(q\.top\) contacts = topContacts\(contacts, q\.top, q\.by\)/.test(route));
  });

  await t.test('MailMe\'s New button starts a Quick Email campaign, only for people who can open one', () => {
    const fn = app.slice(app.indexOf("$('#mmNewCampaign').addEventListener"), app.indexOf("$('#mmNewList')"));
    t.assert(/state\.marketingFull && !state\.marketingDown/.test(fn), 'gated on campaign access');
    t.assert(/type: 'quick_email'/.test(fn) && /ctx\.goApp\('marketmachine', 'campaigns', id\)/.test(fn));
    t.assert(/written here instead/.test(fn), 'falls back to MailMe if MarketMachine says no');
    t.assert(/state\.marketingFull = !\(d && d\.limited\)/.test(app), 'access read from MarketMachine\'s own answer');
  });

  await t.test('a Quick Email campaign always shows the Email section', () => {
    t.assert(/c\.type === 'quick_email' \|\|/.test(read('apps/marketmachine/detail.js')));
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
