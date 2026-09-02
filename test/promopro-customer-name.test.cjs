// test/promopro-customer-name.test.cjs
/**
 * PromoPro: the company, not the person who placed the order.
 *
 * Printavo hangs a job off a CONTACT and that contact off a CUSTOMER. The
 * lookup only ever asked for the contact, so "Jill Stevents" appeared on a
 * pipeline card, in the orders table, and on the purchase order emailed to
 * the vendor, everywhere "Hy-Vee" belonged. Nothing was broken enough to
 * throw; it was just the wrong name, confidently.
 *
 * normalizeInvoice is called for real below. The risky part is not the
 * mapping though, it is the QUERY: GraphQL validates the whole thing before
 * running it, so one field name this account does not have returns no invoice
 * at all rather than an invoice missing a company. The ladder is what keeps
 * that from being a broken autofill, and the last rung of it is checked here
 * against the exact shape that worked before.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const lookupSrc = read('lib/promopro/printavo-lookup.js');
const app = read('apps/promopro.js');
const posRoute = read('api/promopro/pos.js');

const inv = (contact, extra) => Object.assign({
  id: 'inv_1',
  visualId: 66848,
  contact,
  lineItemGroups: { nodes: [] },
}, extra || {});

(async () => {
  const lookup = await import('../lib/promopro/printavo-lookup.js');
  const doc = await import('../lib/promopro/document.js');
  const schema = await import('../lib/promopro/schema.js');

  /* ---- reading the invoice -------------------------------------------- */

  t.test('the company comes off the contact parent, not the contact', () => {
    const r = lookup.normalizeInvoice(inv({ fullName: 'Jill Stevents', customer: { id: 'c1', companyName: 'Hy-Vee' } }));
    t.equal(r.companyName, 'Hy-Vee');
    t.equal(r.contactName, 'Jill Stevents');
  });

  t.test('the one name to show is the company', () => {
    // Every screen already reads customerName. Putting the company there is
    // what fixes the pipeline card, the table and the PO in one move.
    const r = lookup.normalizeInvoice(inv({ fullName: 'Jill Stevents', customer: { companyName: 'Hy-Vee' } }));
    t.equal(r.customerName, 'Hy-Vee');
  });

  t.test('a buyer with no company shows as themselves, not as blank', () => {
    // A real individual customer exists. A blank card is worse than a name.
    const r = lookup.normalizeInvoice(inv({ fullName: 'Macy Denbeste' }));
    t.equal(r.customerName, 'Macy Denbeste');
    t.equal(r.companyName, '');
    t.equal(r.contactName, 'Macy Denbeste');
  });

  t.test('a company object that calls its name field name still works', () => {
    const r = lookup.normalizeInvoice(inv({ fullName: 'X', customer: { name: 'Ankeny Schools' } }));
    t.equal(r.customerName, 'Ankeny Schools');
  });

  t.test('a customer hanging off the invoice itself is also read', () => {
    const r = lookup.normalizeInvoice(inv({ fullName: 'X' }, { customer: { companyName: 'Casey\'s' } }));
    t.equal(r.companyName, "Casey's");
  });

  t.test('an invoice with no contact at all does not throw', () => {
    const r = lookup.normalizeInvoice(inv(null));
    t.equal(r.customerName, '');
    t.equal(r.companyName, '');
  });

  t.test('an empty company name does not beat a real person name', () => {
    const r = lookup.normalizeInvoice(inv({ fullName: 'Jill Stevents', customer: { id: 'c1', companyName: '' } }));
    t.equal(r.customerName, 'Jill Stevents', 'a blank company must not win the fallback');
  });

  /* ---- the query ladder ------------------------------------------------ */

  t.test('the last rung is exactly the query that worked before', () => {
    // This is the whole safety property. If every company shape is rejected
    // by this account, autofill must land back where it was this morning,
    // not on a broken lookup.
    t.assert(/{ name: "contact-only", fields: "contact { fullName email }" }/.test(lookupSrc),
      'the bottom rung should be the pre-existing selection, unchanged');
  });

  t.test('the ladder is tried richest first', () => {
    const block = lookupSrc.slice(lookupSrc.indexOf('const PARTY_FIELD_SETS'), lookupSrc.indexOf('function invoiceQuery'));
    const order = ['companyName', 'customer { id name }', 'contact { fullName email }'];
    let at = -1;
    order.forEach((s) => {
      const i = block.indexOf(s);
      t.assert(i > at, 'out of order: ' + s);
      at = i;
    });
  });

  t.test('a real failure stops the ladder instead of spending six requests', () => {
    const fn = lookupSrc.slice(lookupSrc.indexOf('async function getFromRoot'));
    t.assert(/if \(!isSchemaError\(e\.message\)\) return/.test(fn.slice(0, 2500)),
      'an auth error or an outage is not something to retry with fewer fields');
  });

  t.test('which rung answered is reported back', () => {
    // The ladder is insurance, not a permanent state. partyVia is how the
    // first real lookup after deploy settles the shape so it can be trimmed.
    t.assert(/partyVia/.test(lookupSrc));
  });

  t.test('the job picker searches with the company too', () => {
    const start = lookupSrc.indexOf('const SEARCH_PARTY_SETS');
    const sets = lookupSrc.slice(start, lookupSrc.indexOf('];', start) + 2);
    t.assert(/companyName/.test(sets), 'picking a job by contact name is the same problem one step earlier');
    t.assert(/contact { fullName }/.test(sets), 'and it needs the same bottom rung');
  });

  /* ---- what gets stored ------------------------------------------------ */

  t.test('a purchase order keeps the company and the person apart', () => {
    const r = schema.validateNew({
      vendorId: 'v1',
      accountManager: 'EMP-1',
      lines: [{ description: 'Mug', qty: 10, unitCost: 2 }],
      printavo: { invoiceNumber: '66848', id: 'inv_1', customerName: 'Hy-Vee', companyName: 'Hy-Vee', contactName: 'Jill Stevents' },
    }, ['v1'], ['EMP-1']);
    t.assert(r.ok, (r.errors || []).join('; '));
    t.equal(r.record.printavo.companyName, 'Hy-Vee');
    t.equal(r.record.printavo.contactName, 'Jill Stevents');
  });

  t.test('an order raised before the split still validates', () => {
    // No companyName in the payload. It must not become a required field:
    // that would refuse every reorder and every older client.
    const r = schema.validateNew({
      vendorId: 'v1',
      accountManager: 'EMP-1',
      lines: [{ description: 'Mug', qty: 10, unitCost: 2 }],
      printavo: { invoiceNumber: '66848', customerName: 'Jill Stevents' },
    }, ['v1'], ['EMP-1']);
    t.assert(r.ok, (r.errors || []).join('; '));
    t.equal(r.record.printavo.companyName, '');
    t.equal(r.record.printavo.customerName, 'Jill Stevents');
  });

  /* ---- the printed and emailed document -------------------------------- */

  const po = {
    poNumber: '26-66848-4',
    createdAt: '2026-08-28T10:00:00Z',
    shipTo: 'Polk City',
    lines: [{ description: 'Mug', qty: 10, unitCost: 2 }],
    printavo: { id: 'inv_1', invoiceNumber: '66848', companyName: 'Hy-Vee', contactName: 'Jill Stevents', customerName: 'Hy-Vee' },
  };
  const opts = { vendor: { name: 'ALPI International', email: 'a@alpi.example' }, brand: { name: 'P&M Apparel' }, sender: { name: 'Ryan' } };

  t.test('the company prints directly under the PO number', () => {
    const html = doc.renderPoHtml(po, opts);
    const num = html.indexOf('26-66848-4');
    const company = html.indexOf('Hy-Vee');
    t.assert(num > -1 && company > num, 'the company should follow the number');
    t.assert(company - num < 200, 'and sit under it, not somewhere else on the page');
  });

  t.test('the buyer personal name is not printed at the vendor', () => {
    const html = doc.renderPoHtml(po, opts);
    t.equal(html.includes('Jill Stevents'), false,
      'the person is ours to know; the vendor needs the company');
  });

  t.test('the plain-text copy says the same thing as the page', () => {
    const txt = doc.renderEmailText(po, opts);
    t.assert(/Purchase Order # : 26-66848-4/.test(txt));
    t.assert(/For: Hy-Vee/.test(txt), 'a summary that answers different questions than the page is how the two drift');
  });

  t.test('an order raised before the split still prints a name', () => {
    const old = { ...po, printavo: { id: 'i', invoiceNumber: '66848', customerName: 'Jill Stevents' } };
    t.assert(doc.renderPoHtml(old, opts).includes('Jill Stevents'),
      'an out-of-date name beats a blank line on a document going to a vendor');
  });

  t.test('a manual order prints nothing there rather than the words Manual order', () => {
    const manual = { ...po, printavo: null };
    const html = doc.renderPoHtml(manual, opts);
    t.equal(html.includes('Manual order'), false);
    const txt = doc.renderEmailText(manual, opts);
    t.equal(/^For:/m.test(txt), false, 'no empty For line');
  });

  t.test('the new line adds no hex of its own', () => {
    // The document is TOKEN-EXEMPT because mail clients cannot read tokens,
    // but that is not a licence to add more.
    const block = read('lib/promopro/document.js');
    const added = block.slice(block.indexOf('WHOSE JOB THIS IS'), block.indexOf('const logo'));
    t.equal(/#[0-9a-fA-F]{6}/.test(added), false);
  });

  /* ---- the screens ----------------------------------------------------- */

  t.test('all three screens ask one helper, so they cannot disagree', () => {
    t.assert(/const custName = \(p\) =>/.test(app));
    t.equal((app.match(/esc\(custName\(/g) || []).length >= 3, true,
      'pipeline card, orders table and the detail header');
    t.equal(/printavo && p\.printavo\.customerName/.test(app), false,
      'no screen should still be reading the old field directly');
  });

  t.test('the detail shows the person as well, where there is room', () => {
    t.assert(/const custContact/.test(app));
    t.assert(/c !== custName\(p\)/.test(app),
      'an old record has the person in both fields and should not print it twice');
  });

  /* ---- fixing the orders already on the board -------------------------- */

  t.test('refresh re-reads Printavo rather than letting anyone type a name', () => {
    const block = posRoute.slice(posRoute.indexOf('refreshPrintavo'));
    t.assert(/getInvoice/.test(block.slice(0, 1600)), 'Printavo owns the name');
    t.assert(!/body\.companyName/.test(posRoute), 'a typed-in name is a second version that drifts');
  });

  t.test('refresh touches the names and nothing else', () => {
    const block = posRoute.slice(posRoute.indexOf('refreshPrintavo'), posRoute.indexOf('refreshPrintavo') + 2000);
    t.assert(/companyName: invoice\.companyName/.test(block));
    t.assert(/contactName: invoice\.contactName/.test(block));
    t.equal(/lines:|unitCost|neededBy:/.test(block), false,
      'a PO is a snapshot of what the vendor was told; a refresh must not rewrite it');
  });

  t.test('refresh on an unlinked order is refused with a reason', () => {
    const block = posRoute.slice(posRoute.indexOf('refreshPrintavo'));
    t.assert(/not linked to a Printavo job/.test(block.slice(0, 900)));
  });

  t.test('a Printavo outage leaves the order alone and says so', () => {
    const block = posRoute.slice(posRoute.indexOf('refreshPrintavo'), posRoute.indexOf('refreshPrintavo') + 2000);
    t.assert(/The order is unchanged|did not answer/.test(block));
    t.assert(/status\(200\)/.test(block), 'an outage should not look like a broken app');
  });

  t.test('the button only appears where it could do something', () => {
    t.assert(/canEdit && po\.printavo && po\.printavo\.id/.test(app),
      'a manual order has no job to re-read');
  });

  process.exit(t.report());
})();
