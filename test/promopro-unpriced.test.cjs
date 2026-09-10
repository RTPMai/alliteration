// PUT IN: test/promopro-unpriced.test.cjs
/**
 * Purchase orders that go out before a price is agreed.
 *
 * Sep 2026. Sending was refused whenever a PO totalled zero, on the reasoning
 * that the costs must have been forgotten. Sometimes they have been. But
 * raising a PO and letting the vendor come back with a price is ordinary here,
 * and the rule had no override and no way around it: a created PO could not be
 * edited either, so an order in that state was simply stuck.
 *
 * The block is gone. What makes that safe is the other half: a blank unit cost
 * is stored as zero, so the document was telling vendors in writing that we
 * were paying them $0.00. That is a worse thing to send than nothing at all,
 * and it is what these checks are really guarding.
 */

const path = require('path');
const fs = require('fs');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function po(lines, extra) {
  return Object.assign({
    id: 'po_test',
    poNumber: '26-00001-1',
    createdAt: '2026-09-10T12:00:00.000Z',
    vendorId: 'v1',
    shipTo: 'P&M Apparel, Polk City IA',
    lines,
  }, extra || {});
}

const VENDOR = { id: 'v1', name: 'SanMar', email: 'orders@sanmar.test' };

const PRICED   = { description: 'Hoodie', qty: 200, unitCost: 18.5, receivedQty: 0 };
const UNPRICED = { description: 'Hoodie', qty: 200, unitCost: 0, receivedQty: 0 };

(async () => {
  const schema = await import(path.join(ROOT, 'lib/promopro/schema.js'));
  const { linePriced, pricingState, poTotal, validateLines } = schema;
  const doc = await import(path.join(ROOT, 'lib/promopro/document.js'));

  /* ---- what counts as priced ------------------------------------------- */

  t.test('a line with a cost is priced', () => {
    t.assert(linePriced(PRICED), 'a real unit cost should count as priced');
  });

  t.test('a line with no cost is not priced', () => {
    // Zero means "nobody has typed a price yet", which is the app's existing
    // convention: the Printavo lookup fills unitCost with 0 on purpose and
    // says in a comment that the buyer types it in.
    t.assert(!linePriced(UNPRICED), 'a zero cost is an unpriced line, not a free one');
    t.assert(!linePriced({ description: 'x', qty: 1 }), 'a missing cost is unpriced');
    t.assert(!linePriced(null), 'nothing at all is unpriced, and must not throw');
  });

  t.test('a PO knows whether it is fully, partly or not priced', () => {
    t.equal(pricingState(po([PRICED, PRICED])), 'all', 'both lines priced');
    t.equal(pricingState(po([UNPRICED, UNPRICED])), 'none', 'neither line priced');
    t.equal(pricingState(po([PRICED, UNPRICED])), 'some', 'one of each');
    t.equal(pricingState(po([])), 'none', 'an empty PO should not claim to be priced');
  });

  /* ---- what the vendor is told ----------------------------------------- */

  t.test('an unpriced line does not tell the vendor we are paying $0.00', () => {
    // THE POINT OF THE WHOLE CHANGE. Everything else here supports this.
    const html = doc.renderPoHtml(po([UNPRICED]), VENDOR, {});
    t.assert(!/\$0\.00/.test(html),
      'the document still says $0.00 on a line nobody has priced');
    t.assert(/to be confirmed/.test(html),
      'an unpriced line should say so in words the vendor can act on');
  });

  t.test('a priced line still shows its price', () => {
    const html = doc.renderPoHtml(po([PRICED]), VENDOR, {});
    t.assert(/18\.50/.test(html), 'a real price should still appear on the document');
    t.assert(!/to be confirmed/.test(html), 'a fully priced PO should say nothing about confirming');
  });

  t.test('a part-priced PO does not present its subtotal as the total', () => {
    // Missing is not zero. A rollup that quietly treats an unknown as zero
    // looks authoritative and is wrong, which is the same rule MarketMachine
    // applies to a campaign with a week of numbers not entered yet.
    const html = doc.renderPoHtml(po([PRICED, UNPRICED]), VENDOR, {});
    t.assert(/so far/.test(html),
      'a total covering only some of the lines should say so rather than standing as the figure');
  });

  t.test('the plain-text part says the same thing as the page', () => {
    // Plenty of vendors read the text part. Two answers to one question is
    // how the two copies drift.
    const built = doc.renderEmailText(po([UNPRICED]), VENDOR, {});
    t.assert(!/\$0\.00/.test(built), 'the text copy still claims $0.00');
    t.assert(/to be confirmed/.test(built), 'the text copy should match the printed one');
  });

  /* ---- the send no longer refuses -------------------------------------- */

  t.test('a zero total is not a reason to refuse a send', () => {
    const sendRoute = read('api/promopro/send.js');
    t.assert(!/totals zero/.test(sendRoute),
      'the zero-total blocker is back; an unpriced PO cannot be sent and cannot be fixed either');
    // The checks that ARE about a send being deliverable must stay.
    ['no longer exists', 'no order email', 'no lines', 'no from-address'].forEach((phrase) => {
      t.assert(sendRoute.includes(phrase), 'a real pre-send check went missing: ' + phrase);
    });
  });

  /* ---- the screen agrees with the document ----------------------------- */

  t.test('the screen says to be confirmed where the document does', () => {
    const app = read('apps/promopro.js');
    t.assert(/linePriced\(l\)/.test(app),
      'the order detail table should ask whether a line is priced rather than printing a zero');
    t.assert(/pricingState\(po\)/.test(app),
      'the total row should know whether the PO is fully priced');
  });

  /* ---- and none of this changes the arithmetic ------------------------- */

  t.test('an unpriced line still contributes nothing to the total', () => {
    t.equal(poTotal(po([PRICED, UNPRICED])), 3700, 'the maths should be unchanged');
  });

  t.test('a blank cost still saves without complaint', () => {
    // Creating an unpriced PO was always allowed. It was only sending that
    // refused, which is the worst place to find out.
    const { errors, lines } = validateLines([{ description: 'Hoodie', qty: 200, unitCost: '' }]);
    t.equal(errors.length, 0, 'a blank cost should not be a validation error');
    t.equal(lines[0].unitCost, 0, 'and it should store as zero, as it always has');
  });
})();
