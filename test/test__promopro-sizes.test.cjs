// PUT IN: test/promopro-sizes.test.cjs
/**
 * PromoPro: one PO line per size when filling from Printavo.
 *
 * Printavo holds one line per style and color with the size run hanging off
 * it. A vendor ships sizes, not "100 tees", so the import splits the run into
 * one line each. All real function calls, plus one fake-Printavo run through
 * getOrder() to prove the query degrades to yesterday's if sizes are refused.
 */

const t = require('./harness.cjs');

(async () => {
  const pl = await import('../lib/promopro/printavo-lookup.js');

  const invoiceWith = (lineItems) => ({
    id: '1', visualId: 67000, contact: { fullName: 'Acme' },
    lineItemGroups: { nodes: [{ id: 'g1', position: 1, lineItems: { nodes: lineItems } }] },
  });

  const TEE = {
    id: 'l1', description: 'Gildan Softstyle Tee', itemNumber: '64000', items: 100, color: 'Navy',
    sizes: [
      { size: 'size_xl', count: 30 },
      { size: 'size_s', count: 15 },
      { size: 'size_m', count: 25 },
      { size: 'size_l', count: 30 },
      { size: 'size_2xl', count: 0 },
    ],
  };

  t.test('a line with a size run becomes one line per size, in size order', () => {
    const inv = pl.normalizeInvoice(invoiceWith([TEE]));
    t.equal(inv.lines.length, 4, 'S, M, L and XL, the zero 2XL dropped');
    t.equal(inv.lines.map((l) => l.size).join(','), 'S,M,L,XL');
    t.equal(inv.lines.map((l) => l.qty).join(','), '15,25,30,30');
  });

  t.test('the size sits beside the color in the Color / sizes column', () => {
    const inv = pl.normalizeInvoice(invoiceWith([TEE]));
    t.equal(inv.lines[0].detail, 'Navy / S');
    t.equal(inv.lines[3].detail, 'Navy / XL');
  });

  t.test('every split line keeps the style, item number and Printavo link', () => {
    const inv = pl.normalizeInvoice(invoiceWith([TEE]));
    inv.lines.forEach((l) => {
      t.equal(l.description, 'Gildan Softstyle Tee');
      t.equal(l.itemNumber, '64000');
      t.equal(l.printavoLineId, 'l1');
      t.equal(l.unitCost, 0, 'still no sell price copied onto a PO');
    });
  });

  t.test('the pieces add up to the same total as before the split', () => {
    const inv = pl.normalizeInvoice(invoiceWith([TEE]));
    t.equal(inv.lines.reduce((a, l) => a + l.qty, 0), 100);
  });

  t.test('a line with no sizes stays one line, exactly as before', () => {
    const inv = pl.normalizeInvoice(invoiceWith([
      { id: 'k', description: 'Koozie', itemNumber: 'KZ-100', items: 250, color: 'Red', sizes: [] },
      { id: 'p', description: 'Pen', items: 500 },
    ]));
    t.equal(inv.lines.length, 2);
    t.equal(inv.lines[0].qty, 250);
    t.equal(inv.lines[0].detail, 'Red', 'no size bolted on when there is none');
  });

  t.test('a size run of all zeros is treated as no size run', () => {
    const inv = pl.normalizeInvoice(invoiceWith([
      { id: 'z', description: 'Hat', items: 12, sizes: [{ size: 'size_other', count: 0 }] },
    ]));
    t.equal(inv.lines.length, 1);
    t.equal(inv.lines[0].qty, 12);
  });

  t.test('sizes that come up short leave a "size not given" line, never lost pieces', () => {
    const inv = pl.normalizeInvoice(invoiceWith([
      { id: 's', description: 'Hoodie', items: 20, color: 'Black',
        sizes: [{ size: 'size_m', count: 8 }, { size: 'size_l', count: 7 }] },
    ]));
    t.equal(inv.lines.length, 3);
    t.equal(inv.lines[2].qty, 5);
    t.equal(inv.lines[2].detail, 'Black / size not given');
    t.equal(inv.lines.reduce((a, l) => a + l.qty, 0), 20);
  });

  t.test('no color means the size stands alone in the detail', () => {
    const inv = pl.normalizeInvoice(invoiceWith([
      { id: 'n', description: 'Tee', items: 3, sizes: [{ size: 'size_ym', count: 3 }] },
    ]));
    t.equal(inv.lines[0].detail, 'YM');
  });

  t.test('size labels read the way a vendor reads them', () => {
    t.equal(pl.sizeLabel('size_2xl'), '2XL');
    t.equal(pl.sizeLabel('size_yxs'), 'YXS');
    t.equal(pl.sizeLabel('size_12m'), '12M');
    t.equal(pl.sizeLabel('size_other'), 'Other size');
    t.equal(pl.sizeLabel('SIZE_L'), 'L', 'case does not matter');
    t.equal(pl.sizeLabel(''), '');
  });

  t.test('a size run is read youth before adult, Other last', () => {
    const run = pl.sizeRun({ sizes: [
      { size: 'size_other', count: 1 }, { size: 'size_3xl', count: 1 },
      { size: 'size_xs', count: 1 }, { size: 'size_yl', count: 1 }, { size: 'size_2t', count: 1 },
    ] });
    t.equal(run.map((s) => s.label).join(','), '2T,YL,XS,3XL,Other size');
  });

  t.test('the same size twice is added together, not listed twice', () => {
    const run = pl.sizeRun({ sizes: [{ size: 'size_l', count: 4 }, { size: 'size_l', count: 6 }] });
    t.equal(run.length, 1);
    t.equal(run[0].count, 10);
  });

  t.test('the group card still counts every piece', () => {
    const inv = pl.normalizeInvoice(invoiceWith([TEE]));
    t.equal(inv.groups[0].lines.reduce((a, l) => a + l.qty, 0), 100);
    t.equal(inv.groups[0].lines.length, 4);
  });

  /* -- if Printavo refuses sizes, the lookup is exactly yesterday's -- */

  await t.test('an account that refuses sizes still fills the form, unsplit', async () => {
    process.env.PRINTAVO_API_TOKEN = 'x';
    process.env.PRINTAVO_EMAIL = 'x@y.com';
    pl._resetSchemaCache();
    global.fetch = async (url, opts) => {
      const q = JSON.parse(opts.body).query;
      const body = /sizes \{/.test(q)
        ? { errors: [{ message: "Field 'sizes' doesn't exist on type 'LineItem'" }] }
        : { data: { invoice: invoiceWith([{ id: 'l1', description: 'Tee', itemNumber: '64000', items: 100, color: 'Navy' }]) } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    };
    const r = await pl.getOrder('1');
    t.assert(r.invoice, 'the invoice should still come back');
    t.equal(r.via, 'no-sizes', 'the screen hint names the rung that answered');
    t.equal(r.invoice.lines.length, 1);
    t.equal(r.invoice.lines[0].qty, 100);
  });

  await t.test('an account that has sizes gets them on the first request', async () => {
    process.env.PRINTAVO_API_TOKEN = 'x';
    process.env.PRINTAVO_EMAIL = 'x@y.com';
    pl._resetSchemaCache();
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data: { invoice: invoiceWith([TEE]) } }),
    });
    const r = await pl.getOrder('1');
    t.equal(r.via, 'full');
    t.equal(r.invoice.lines.length, 4);
  });

  process.exit(t.report());
})();
