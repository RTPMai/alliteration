/**
 * SanMar sample drops: pick resolution, the stipend entry, and the sheet.
 *
 * A pick puts a figure on somebody's apparel stipend and a line on a document
 * that goes to a vendor, so the rules that decide those two things are
 * covered here as real calls rather than trusted once.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* A catalog entry as sanmar.js builds it: colours, each with a size run, each
 * size carrying its own price and its own ordering keys. */
const STYLE = {
  style: 'PC61',
  tier: 50,
  brand: 'Port & Co',
  title: 'Port & Co Essential Tee. PC61',
  image: 'https://cdnm.sanmar.com/catalog/images/PC61.jpg',
  colors: [
    {
      name: 'White', code: 'White', swatch: 'sw-white.gif', image: 'img-white.jpg',
      sizes: [
        { size: 'S', raw_size: 'S', size_index: '2', inventory_key: '11803', unique_key: '118032', case_price: 3.12, price: 1.56 },
        { size: '2XL', raw_size: 'XXL', size_index: '1', inventory_key: '11807', unique_key: '118071', case_price: 4.67, price: 2.33 },
      ],
    },
    {
      name: 'Navy', code: 'Navy', swatch: 'sw-navy.gif', image: 'img-navy.jpg',
      sizes: [
        { size: 'S', raw_size: 'S', size_index: '1', inventory_key: '266777', unique_key: '2667771', case_price: 3.45, price: 1.72 },
        // A row SanMar returned with no usable price.
        { size: 'M', raw_size: 'M', size_index: '2', inventory_key: '266778', unique_key: '2667782', case_price: null, price: null },
      ],
    },
  ],
};

(async () => {
  const m = await import('file://' + path.join(ROOT, 'lib/crewcore/samples.js'));

  /* ---- drops ------------------------------------------------------------ */

  t.test('a drop needs a name', () => {
    t.equal(m.validateDrop({}).ok, false);
    t.equal(m.validateDrop({ name: '   ' }).ok, false, 'whitespace is not a name');
    t.equal(m.validateDrop({ name: 'Fall 2026' }).ok, true);
  });

  t.test('a new drop opens for picks and carries no due date silently', () => {
    const v = m.validateDrop({ name: 'Fall 2026' });
    t.equal(v.record.status, 'open');
    t.equal(v.record.due_date, '');
  });

  t.test('a due date has to be a date', () => {
    t.equal(m.validateDrop({ name: 'F', due_date: 'next friday' }).ok, false);
    t.equal(m.validateDrop({ name: 'F', due_date: '2026-10-15' }).ok, true);
  });

  t.test('a closed drop refuses picks, and says why', () => {
    t.equal(m.pickingClosed({ name: 'Fall 2026', status: 'open' }), null);
    const why = m.pickingClosed({ name: 'Fall 2026', status: 'closed' });
    t.assert(why && why.includes('Fall 2026'), 'the reason names the drop');
    t.assert(m.pickingClosed(null), 'a drop that vanished is also a refusal');
  });

  /* ---- resolving a pick -------------------------------------------------- */

  t.test('a pick takes its price from the catalog, never from the request', () => {
    // The browser asking for a shirt at four cents must not get one.
    const r = m.resolvePick({ style: 'PC61', color: 'White', size: 'S', price: 0.04 }, STYLE);
    t.equal(r.ok, true);
    t.equal(r.record.price, 1.56);
  });

  t.test('each colour and size gets its own price', () => {
    t.equal(m.resolvePick({ color: 'Navy', size: 'S' }, STYLE).record.price, 1.72);
    t.equal(m.resolvePick({ color: 'White', size: '2XL' }, STYLE).record.price, 2.33);
  });

  t.test('the two spellings of a size both find the garment', () => {
    // The catalog holds 2XL; somebody picking XXL means the same thing.
    const r = m.resolvePick({ color: 'White', size: 'XXL' }, STYLE);
    t.equal(r.ok, true);
    t.equal(r.record.size, '2XL');
    t.equal(r.record.raw_size, 'XXL', 'and the sheet goes back in SanMar\'s spelling');
  });

  t.test('the ordering keys travel with the pick, verbatim', () => {
    const white = m.resolvePick({ color: 'White', size: 'S' }, STYLE).record;
    const navy = m.resolvePick({ color: 'Navy', size: 'S' }, STYLE).record;
    t.equal(white.size_index, '2');
    t.equal(navy.size_index, '1', 'same size, different index: the feed does this');
    t.equal(white.inventory_key, '11803');
    t.equal(white.color_code, 'White', 'the code a purchase order carries');
  });

  t.test('a colour or size the style does not come in is refused by name', () => {
    const c = m.resolvePick({ color: 'Chartreuse', size: 'S' }, STYLE);
    t.equal(c.ok, false);
    t.assert(c.errors[0].includes('Chartreuse'));
    const z = m.resolvePick({ color: 'White', size: '6XL' }, STYLE);
    t.equal(z.ok, false);
    t.assert(z.errors[0].includes('6XL'));
  });

  t.test('a row SanMar did not price is refused, not charged at zero', () => {
    // Otherwise it lands on a stipend as a free shirt and on the vendor sheet
    // as a $0.00 line.
    const r = m.resolvePick({ color: 'Navy', size: 'M' }, STYLE);
    t.equal(r.ok, false);
    t.assert(r.errors[0].includes('price'));
  });

  t.test('a style missing from the catalog is refused', () => {
    t.equal(m.resolvePick({ color: 'White', size: 'S' }, null).ok, false);
  });

  /* ---- the stipend entry ------------------------------------------------- */

  t.test('a pick makes an apparel stipend entry for its own price', () => {
    const pick = { employee_id: 'E-1', style: 'PC61', color: 'White', size: 'S', price: 1.56 };
    const spend = m.spendForPick(pick, { name: 'Fall 2026' }, new Date('2026-09-01T12:00:00Z'));
    t.equal(spend.employee_id, 'E-1');
    t.equal(spend.amount, 1.56);
    t.equal(spend.category, 'apparel');
    t.equal(spend.date, '2026-09-01');
  });

  t.test('the stipend line names the garment, not just the drop', () => {
    // Three lines all reading "Fall 2026" tell nobody which shirt was which.
    const spend = m.spendForPick(
      { employee_id: 'E-1', style: 'PC61', color: 'White', size: 'S', price: 1.56 },
      { name: 'Fall 2026' });
    t.assert(spend.description.includes('PC61'));
    t.assert(spend.description.includes('White'));
    t.assert(spend.description.includes('Fall 2026'));
  });

  /* ---- the sheet --------------------------------------------------------- */

  const NAMES = { 'E-1': 'Abby Penton', 'E-2': 'Margo Niemeyer' };
  const nameFor = (id) => NAMES[id];
  const PICKS = [
    { employee_id: 'E-2', style: 'PC61', title: 'Essential Tee', color: 'Navy', size: 'S', raw_size: 'S', price: 1.72 },
    { employee_id: 'E-1', style: 'PC61', title: 'Essential Tee', color: 'White', size: '2XL', raw_size: 'XXL', price: 2.33 },
    { employee_id: 'E-1', style: 'DT6105', title: 'V.I.T. Fleece', color: 'Black', size: 'M', raw_size: 'M', price: 5.68 },
  ];

  t.test('the sheet has one line per pick and a header', () => {
    const out = m.buildExport(PICKS, nameFor);
    const lines = out.csv.trim().split('\r\n');
    t.equal(lines.length, 4, 'header plus three');
    t.equal(lines[0], m.EXPORT_COLUMNS.join(','));
    t.equal(out.rowCount, 3);
  });

  t.test('the sheet totals what the picks cost', () => {
    t.equal(m.buildExport(PICKS, nameFor).total, 9.73);
  });

  t.test('lines group by person, then style, the way the order gets filled', () => {
    const lines = m.buildExport(PICKS, nameFor).csv.trim().split('\r\n').slice(1);
    t.assert(lines[0].startsWith('Abby Penton'), 'Abby before Margo');
    t.assert(lines[0].includes('DT6105'), 'and her styles in order');
    t.assert(lines[2].startsWith('Margo Niemeyer'));
  });

  t.test('each line is a quantity of one, never a rolled-up count', () => {
    // The same style in two colours is two garments, not a quantity of two.
    const two = [
      { employee_id: 'E-1', style: 'BP45', color: 'Red', size: 'L', price: 4 },
      { employee_id: 'E-1', style: 'BP45', color: 'Blue', size: 'L', price: 4 },
    ];
    const out = m.buildExport(two, nameFor);
    t.equal(out.rowCount, 2);
    t.assert(out.csv.split('\r\n').filter((l) => l.includes('BP45')).length === 2);
  });

  t.test('the size goes back in SanMar\'s spelling, not ours', () => {
    const csv = m.buildExport(PICKS, nameFor).csv;
    t.assert(csv.includes(',XXL,'), 'we store 2XL, the sheet says XXL');
  });

  t.test('a vendor-supplied title cannot smuggle a formula into the sheet', () => {
    // Product titles are vendor-controlled text landing in a file Ryan opens
    // in Excel, where a leading = is executed.
    const out = m.buildExport(
      [{ employee_id: 'E-1', style: 'X', title: '=HYPERLINK("http://bad","hi")', color: 'Red', size: 'L', price: 1 }],
      nameFor);
    t.assert(out.csv.includes("'=HYPERLINK"), 'a leading = must be prefixed');
    t.assert(!/(^|,)"?=HYPERLINK/.test(out.csv), 'and must not survive quoted either');
  });

  t.test('a comma or a quote in a name does not break the columns', () => {
    const out = m.buildExport(
      [{ employee_id: 'E-3', style: 'X', title: 'Tee, "classic"', color: 'Red', size: 'L', price: 1 }],
      () => 'Smith, John');
    const lines = out.csv.trim().split('\r\n');
    t.equal(lines.length, 2);
    t.assert(lines[1].startsWith('"Smith, John"'), 'quoted, not split into two columns');
  });

  t.test('a pick whose person is gone still exports, marked', () => {
    // Losing the line entirely would mean a garment nobody ordered arriving.
    const out = m.buildExport([{ employee_id: 'GONE', style: 'X', color: 'Red', size: 'L', price: 1 }], () => '');
    t.assert(out.csv.includes('(unassigned)'));
    t.equal(out.rowCount, 1);
  });

  t.test('per-person totals agree with the sheet', () => {
    const totals = m.totalsByEmployee(PICKS);
    t.equal(totals.get('E-1').count, 2);
    t.equal(totals.get('E-1').total, 8.01);
    t.equal(totals.get('E-2').total, 1.72);
    const sum = [...totals.values()].reduce((a, v) => a + v.total, 0);
    t.equal(Math.round(sum * 100) / 100, m.buildExport(PICKS, nameFor).total);
  });
})();
