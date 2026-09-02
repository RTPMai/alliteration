// PUT IN: test/promopro-quotes.test.cjs
/**
 * PromoPro: a quote is not an invoice.
 *
 * Reported Sep 2, 2026. Typing 66290 into "Find the Printavo quote or
 * invoice" answered "Nothing matched" while quote 66290 sat open in Printavo
 * with line items on it. The lookup only ever asked Printavo's `invoices`
 * root, so a job that had not been invoiced yet could not be found at all,
 * and the same search would start working by itself the day it was invoiced.
 *
 * Every check here CALLS the code. Grepping for the word "quotes" in a query
 * string would prove the letters are there, not that a quote comes back.
 */

'use strict';

const t = require('./harness.cjs');

(async () => {
  const pl = await import('../lib/promopro/printavo-lookup.js');
  const schema = await import('../lib/promopro/schema.js');

  process.env.PRINTAVO_API_TOKEN = 'x';
  process.env.PRINTAVO_EMAIL = 'x@y.com';

  /* ------------------------------------------------------------------ *
   * A fake Printavo account.
   *
   * It answers introspection the way a real one does, then serves quotes and
   * invoices from separate roots, so asking the wrong root returns nothing
   * rather than politely helping.
   * ------------------------------------------------------------------ */

  const QUOTE_66290 = {
    id: 'q_66290', __typename: 'Quote', visualId: 66290, total: 1840,
    customerDueAt: '2026-09-18T00:00:00Z', status: { id: 's1', name: 'Quote Sent' },
    contact: { fullName: 'Dana Reeves', customer: { id: 'c1', companyName: 'DSM Fencing Club' } },
    lineItemGroups: { nodes: [{ id: 'g1', position: 1, lineItems: { nodes: [
      { id: 'l1', description: 'Knee High Socks', itemNumber: 'LTM7209', items: 60, color: 'Navy', price: 14 },
    ] } }] },
  };

  const INVOICE_66601 = {
    id: 'inv_66601', __typename: 'Invoice', visualId: 66601, total: 900,
    customerDueAt: '2026-09-30T00:00:00Z', status: { id: 's2', name: 'In Production' },
    contact: { fullName: 'Ray Olson', customer: { id: 'c2', companyName: 'Hy-Vee' } },
    lineItemGroups: { nodes: [{ id: 'g2', position: 1, lineItems: { nodes: [
      { id: 'l2', description: 'Gildan Tee', itemNumber: 'G500', items: 50 },
    ] } }] },
  };

  const ROOTS = {
    root: { fields: [
      { name: 'invoices', args: [{ name: 'query' }, { name: 'first' }] },
      { name: 'quotes', args: [{ name: 'query' }, { name: 'first' }] },
      { name: 'invoice', args: [{ name: 'id' }] },
      { name: 'quote', args: [{ name: 'id' }] },
    ] },
    quote: { fields: [
      { name: 'id' }, { name: 'visualId' }, { name: 'total' }, { name: 'customerDueAt' },
      { name: 'status' }, { name: 'contact' }, { name: 'lineItemGroups' },
    ] },
    invoice: { fields: [
      { name: 'id' }, { name: 'visualId' }, { name: 'total' }, { name: 'customerDueAt' },
      { name: 'status' }, { name: 'contact' }, { name: 'lineItemGroups' },
    ] },
  };

  /**
   * @param over  per-root overrides: a function returning data, or an Error
   *              to make that root fail.
   */
  function fakeAccount(over) {
    const o = over || {};
    const calls = [];
    pl._resetSchemaCache();
    global.fetch = async (url, opts) => {
      const q = JSON.parse(opts.body).query;
      calls.push(q);
      const answer = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
      const fail = (msg) => answer({ errors: [{ message: msg }] });

      if (/PromoProRoots/.test(q)) {
        if (o.introspection === 'fail') return fail('Introspection is disabled');
        return answer({ data: o.roots === null ? {} : (o.roots || ROOTS) });
      }
      if (/PromoProImprints/.test(q)) return answer({ data: {} });

      const root = (q.match(/\n\s+(invoices|quotes|invoice|quote)\(/) || [])[1];
      if (o[root] instanceof Error) return fail(o[root].message);

      if (root === 'invoices') return answer({ data: { invoices: { nodes: o.invoices || [] } } });
      if (root === 'quotes') return answer({ data: { quotes: { nodes: o.quotes || [] } } });
      if (root === 'invoice') return answer({ data: { invoice: o.invoice || null } });
      if (root === 'quote') return answer({ data: { quote: o.quote || null } });
      return answer({ data: {} });
    };
    return calls;
  }

  /* ---- the bug itself ---------------------------------------------- */

  await t.test('a quote number is found, which is the whole bug', async () => {
    fakeAccount({ invoices: [], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results.length, 1, 'quote 66290 exists in Printavo and must come back');
    t.equal(found.results[0].invoiceNumber, '66290');
    t.equal(found.results[0].kind, 'quote');
  });

  await t.test('the company is what the row is named after, not the buyer', async () => {
    fakeAccount({ invoices: [], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results[0].customerName, 'DSM Fencing Club');
    t.equal(found.results[0].contactName, 'Dana Reeves');
  });

  await t.test('both roots are searched, not one or the other', async () => {
    fakeAccount({ invoices: [INVOICE_66601], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66');
    t.equal(found.results.length, 2);
    t.equal(found.searched.length, 2);
  });

  await t.test('the number typed leads the list whichever root it came from', async () => {
    // The exact match is nearly always the one wanted, and a quote arriving
    // second in the code must not arrive second on screen.
    fakeAccount({ invoices: [INVOICE_66601], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results[0].invoiceNumber, '66290');
  });

  await t.test('the same job on both roots is listed once', async () => {
    const both = { ...QUOTE_66290 };
    fakeAccount({ invoices: [both], quotes: [both] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results.length, 1);
  });

  /* ---- half an answer is not no answer ------------------------------ */

  await t.test('one root failing still returns the other root results', async () => {
    // Answering "nothing matched" because the quote search was down tells
    // somebody their job does not exist when it does.
    fakeAccount({ invoices: [INVOICE_66601], quotes: new Error('Printavo HTTP 503') });
    const found = await pl.searchOrders('66');
    t.equal(found.results.length, 1);
    t.equal(found.searched.length, 1);
    t.equal(found.unavailable.length, 1);
    t.equal(found.unavailable[0].root, 'quotes');
  });

  await t.test('a root that failed is named, so the gap can be read', async () => {
    fakeAccount({ invoices: [INVOICE_66601], quotes: new Error('Printavo HTTP 503') });
    const found = await pl.searchOrders('66');
    t.assert(/503/.test(found.unavailable[0].reason), 'the real reason has to reach the screen');
  });

  await t.test('both roots failing is an error, never an empty list', async () => {
    // An empty list means "Printavo has no such job". A failure means "ask
    // again". Showing them the same way is how a wrong answer gets trusted.
    fakeAccount({ invoices: new Error('Not authorized'), quotes: new Error('Not authorized') });
    let threw = null;
    try { await pl.searchOrders('66290'); } catch (e) { threw = e; }
    t.assert(threw, 'nothing answered at all is a failure');
    t.assert(/Not authorized/.test(threw.message), 'and it carries the reason');
  });

  /* ---- opening the order -------------------------------------------- */

  await t.test('clicking a quote result loads it with its lines', async () => {
    const calls = fakeAccount({ quote: QUOTE_66290 });
    const r = await pl.getOrder('q_66290', 'quote');
    t.assert(r.invoice, 'a quote must open the same way an invoice does');
    t.equal(calls.filter((c) => /PromoProOrder/.test(c)).length, 1,
      'the hint off the search result should put the quote root first, not spend a request learning it');
    t.equal(r.invoice.invoiceNumber, '66290');
    t.equal(r.invoice.kind, 'quote');
    t.equal(r.invoice.lines.length, 1);
    t.equal(r.invoice.lines[0].qty, 60);
  });

  await t.test('the quote price is never copied into our cost', async () => {
    // Printavo holds what we CHARGE. A PO holds what the vendor charges US.
    // The rule does not change because the document is a quote.
    fakeAccount({ quote: QUOTE_66290 });
    const r = await pl.getOrder('q_66290', 'quote');
    t.equal(r.invoice.lines[0].unitCost, 0);
  });

  await t.test('a quote id with no hint still resolves, one request later', async () => {
    // The hint saves a round trip. Getting it wrong, or not having one, must
    // not be the difference between working and not.
    const calls = fakeAccount({ quote: QUOTE_66290 });
    const r = await pl.getOrder('q_66290');
    t.assert(r.invoice, 'the invoice root answering empty means try the quote root');
    t.equal(r.invoice.kind, 'quote');
    t.assert(calls.length >= 3, 'schema, the empty invoice attempt, then the quote');
  });

  await t.test('an invoice is still asked for first, and answers in one', async () => {
    const calls = fakeAccount({ invoice: INVOICE_66601 });
    const r = await pl.getOrder('inv_66601', 'invoice');
    t.equal(r.invoice.kind, 'invoice');
    t.equal(calls.filter((c) => /PromoProOrder/.test(c)).length, 1,
      'the common case must not have got slower');
  });

  await t.test('an id in neither root reports why, rather than nothing', async () => {
    fakeAccount({ invoice: null, quote: null });
    const r = await pl.getOrder('nope');
    t.equal(r.invoice, null);
    t.assert(r.tried.length >= 2, 'both roots should be in the trail');
    t.assert(r.tried.every((x) => x.error), 'every rung has to carry a reason');
  });

  await t.test('a real failure stops instead of trying the other root', async () => {
    // An auth error is the same auth error on the second root. Retrying it
    // spends requests against the rate limiter to learn what the first said.
    const calls = fakeAccount({ invoice: new Error('Not authorized') });
    const r = await pl.getOrder('inv_66601');
    t.equal(r.invoice, null);
    t.equal(calls.filter((c) => /PromoProOrder/.test(c)).length, 1);
  });

  /* ---- when the account will not say what it has --------------------- */

  await t.test('introspection failing does not stop the search', async () => {
    // Unknown must mean "attempt it", not "skip it". Skipping is how a whole
    // class of job went missing in the first place.
    fakeAccount({ introspection: 'fail', invoices: [], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results.length, 1);
  });

  await t.test('an empty introspection answer is unknown, not "no roots"', async () => {
    // A well-formed reply carrying nothing tells us nothing. Reading it as
    // "this account has no root queries" would refuse to search anything.
    fakeAccount({ roots: null, invoices: [], quotes: [QUOTE_66290] });
    const found = await pl.searchOrders('66290');
    t.equal(found.results.length, 1);
  });

  await t.test('a root the account really lacks is reported, not attempted', async () => {
    fakeAccount({
      roots: { root: { fields: [{ name: 'invoices', args: [{ name: 'query' }] }, { name: 'invoice', args: [{ name: 'id' }] }] } },
      invoices: [INVOICE_66601],
    });
    const found = await pl.searchOrders('66');
    t.equal(found.results.length, 1);
    t.equal(found.unavailable.length, 1);
    t.equal(found.unavailable[0].root, 'quotes');
  });

  await t.test('the schema is asked once, not on every keystroke', async () => {
    const calls = fakeAccount({ invoices: [], quotes: [QUOTE_66290] });
    await pl.searchOrders('662');
    await pl.searchOrders('6629');
    await pl.searchOrders('66290');
    t.equal(calls.filter((c) => /PromoProRoots/.test(c)).length, 1,
      'a typeahead would otherwise spend a request per letter on the same question');
  });

  /* ---- what ends up on the purchase order ---------------------------- */

  t.test('a PO remembers it was raised off a quote', () => {
    const r = schema.validateNew({
      vendorId: 'v1', accountManager: 'EMP-1',
      lines: [{ description: 'Socks', qty: 60, unitCost: 4 }],
      printavo: { invoiceNumber: '66290', id: 'q_66290', kind: 'quote', customerName: 'DSM Fencing Club' },
    }, ['v1'], ['EMP-1']);
    t.assert(r.ok, (r.errors || []).join('; '));
    t.equal(r.record.printavo.kind, 'quote');
  });

  t.test('a PO with no kind stored reads as an invoice', () => {
    // Everything saved before Sep 2026 came off an invoice, because a quote
    // could not be found at all.
    const r = schema.validateNew({
      vendorId: 'v1', accountManager: 'EMP-1',
      lines: [{ description: 'Tee', qty: 50, unitCost: 4 }],
      printavo: { invoiceNumber: '66601', id: 'inv_66601', customerName: 'Hy-Vee' },
    }, ['v1'], ['EMP-1']);
    t.equal(r.record.printavo.kind, 'invoice');
  });

  t.test('junk in the kind field is not stored as a third kind', () => {
    const r = schema.validateNew({
      vendorId: 'v1', accountManager: 'EMP-1',
      lines: [{ description: 'Tee', qty: 50, unitCost: 4 }],
      printavo: { invoiceNumber: '66601', kind: 'estimate', customerName: 'Hy-Vee' },
    }, ['v1'], ['EMP-1']);
    t.equal(r.record.printavo.kind, 'invoice');
  });

  /* ---- the screen ---------------------------------------------------- */

  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');

  t.test('the picker says which rows are quotes', () => {
    t.assert(/Quote /.test(app), 'a quote and an invoice must be tellable apart in the list');
    t.assert(/data-kind=/.test(app), 'and the choice has to reach the server');
  });

  t.test('a half-answered search is not shown as no match', () => {
    t.assert(/did not answer for/.test(app),
      'saying "nothing matched" when a root was down reports a job as missing when it is not');
  });

  process.exit(t.report());
})();
