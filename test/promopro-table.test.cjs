// PUT IN: test/promopro-table.test.cjs
/**
 * Sorting and per-column filtering on the Purchase Orders table.
 *
 * Every rule here can be wrong on screen and look completely normal, which is
 * why they are pure functions in lib/ and tested by calling them:
 *
 *   - A row sorted to the bottom is indistinguishable from a row that is not
 *     there. Nothing throws. Nobody notices.
 *   - Sorting Stage alphabetically puts Confirmed above Submitted, so the
 *     pipeline appears to run backwards.
 *   - Filtering Status on its text would offer "no word for 6 days" and "no
 *     word for 8 days" as two separate choices and narrow nothing.
 *   - An empty tick list that matches NOTHING empties the table the moment
 *     somebody unticks their last box, which reads as a fault, not a choice.
 */

const t = require('./harness.cjs');

// Rows as the screen builds them: display values, not ids.
const R = (o) => Object.assign({
  poNumber: '', customer: '', product: '', vendor: '', am: '',
  stage: '', stageKey: 'submitted', neededBy: '', total: 0,
  status: '', healthLevel: 'ok',
}, o);

const names = (rows) => rows.map((r) => r.poNumber).join(',');

(async () => {
  const tb = await import('../lib/promopro/table.js');

  /* ---- the columns themselves ---------------------------------------- */

  t.test('every column the table draws is declared once', () => {
    t.equal(tb.ORDER_COLUMNS.length, 9);
    t.equal(new Set(tb.COLUMN_KEYS).size, 9);
  });

  t.test('only columns whose values repeat offer a filter', () => {
    // A menu of PO numbers, due dates or totals would be as long as the table
    // and would never narrow anything.
    const filterable = tb.ORDER_COLUMNS.filter((c) => c.filter).map((c) => c.key);
    t.equal(filterable.join(','), 'customer,product,vendor,am,stage,status');
  });

  /* ---- sorting ------------------------------------------------------- */

  t.test('text sorts ignore case, so Acme and acme are not two groups', () => {
    const rows = [R({ poNumber: '1', customer: 'zeta' }), R({ poNumber: '2', customer: 'Alpha' })];
    t.equal(names(tb.sortRows(rows, 'customer', 'asc')), '2,1');
  });

  t.test('totals sort as numbers, not as strings', () => {
    const rows = [R({ poNumber: '1', total: 9 }), R({ poNumber: '2', total: 100 })];
    // As text, "100" sorts before "9". As money it does not.
    t.equal(names(tb.sortRows(rows, 'total', 'asc')), '1,2');
    t.equal(names(tb.sortRows(rows, 'total', 'desc')), '2,1');
  });

  t.test('stage sorts down the pipeline, not down the alphabet', () => {
    const rows = [
      R({ poNumber: 'ship', stageKey: 'shipped' }),
      R({ poNumber: 'sub', stageKey: 'submitted' }),
      R({ poNumber: 'conf', stageKey: 'confirmed' }),
    ];
    const out = names(tb.sortRows(rows, 'stage', 'asc'));
    // Alphabetically this would be confirmed, shipped, submitted.
    t.equal(out, 'sub,conf,ship');
  });

  t.test('cancelled sits past the end rather than among the real stages', () => {
    const rows = [
      R({ poNumber: 'x', stageKey: 'cancelled' }),
      R({ poNumber: 'y', stageKey: 'draft' }),
    ];
    t.equal(names(tb.sortRows(rows, 'stage', 'asc')), 'y,x');
  });

  t.test('status sorts worst first, the same order the pipeline ranks cards', () => {
    const rows = [
      R({ poNumber: 'ok', healthLevel: 'ok' }),
      R({ poNumber: 'red', healthLevel: 'red' }),
      R({ poNumber: 'done', healthLevel: 'done' }),
      R({ poNumber: 'amber', healthLevel: 'amber' }),
    ];
    t.equal(names(tb.sortRows(rows, 'status', 'asc')), 'red,amber,ok,done');
  });

  /* ---- THE ONE THAT MATTERS ------------------------------------------ */

  t.test('rows with no value sink in BOTH directions', () => {
    const rows = [
      R({ poNumber: 'none', neededBy: '' }),
      R({ poNumber: 'late', neededBy: '2026-12-01' }),
      R({ poNumber: 'soon', neededBy: '2026-09-15' }),
    ];
    // An order with no due date has not got the earliest one, and it has not
    // got the latest one either. Letting blanks ride the reverse to the top
    // fills the first screen with the rows that cannot answer the question.
    t.equal(names(tb.sortRows(rows, 'neededBy', 'asc')), 'soon,late,none');
    t.equal(names(tb.sortRows(rows, 'neededBy', 'desc')), 'late,soon,none');
  });

  t.test('a zero total is a real value and does not sink', () => {
    const rows = [R({ poNumber: 'zero', total: 0 }), R({ poNumber: 'ten', total: 10 })];
    t.equal(names(tb.sortRows(rows, 'total', 'asc')), 'zero,ten');
  });

  t.test('ties break on PO number, so the list never shuffles on redraw', () => {
    const rows = [
      R({ poNumber: '26-3', customer: 'Same' }),
      R({ poNumber: '26-1', customer: 'Same' }),
      R({ poNumber: '26-2', customer: 'Same' }),
    ];
    const once = names(tb.sortRows(rows, 'customer', 'asc'));
    const twice = names(tb.sortRows(tb.sortRows(rows, 'customer', 'asc'), 'customer', 'asc'));
    t.equal(once, '26-1,26-2,26-3');
    t.equal(once, twice);
  });

  t.test('sorting never loses or invents a row', () => {
    const rows = [R({ poNumber: 'a' }), R({ poNumber: 'b' }), R({ poNumber: 'c' })];
    t.equal(tb.sortRows(rows, 'customer', 'asc').length, 3);
    t.equal(tb.sortRows(rows, 'nonsense-column', 'asc').length, 3);
  });

  t.test('the original array is not reordered under the caller', () => {
    const rows = [R({ poNumber: 'b' }), R({ poNumber: 'a' })];
    tb.sortRows(rows, 'poNumber', 'asc');
    t.equal(names(rows), 'b,a');
  });

  /* ---- which way a header click goes --------------------------------- */

  t.test('clicking the sorted column again reverses it', () => {
    t.equal(tb.nextDir('customer', 'asc', 'customer'), 'desc');
    t.equal(tb.nextDir('customer', 'desc', 'customer'), 'asc');
  });

  t.test('a new column opens the way that column is useful first', () => {
    // Money is interesting at the top end; names are not.
    t.equal(tb.nextDir('customer', 'asc', 'total'), 'desc');
    t.equal(tb.nextDir('total', 'desc', 'customer'), 'asc');
  });

  /* ---- what a filter menu offers -------------------------------------- */

  t.test('values come with counts, most common first', () => {
    const rows = [
      R({ vendor: 'SanMar' }), R({ vendor: 'SanMar' }), R({ vendor: 'Ballpro' }),
    ];
    const vals = tb.filterValues(rows, 'vendor');
    t.equal(vals[0].value, 'SanMar');
    t.equal(vals[0].count, 2);
    t.equal(vals[1].value, 'Ballpro');
  });

  t.test('an empty value is offered explicitly, at the bottom', () => {
    // "Which orders have no account manager" is a real question and is
    // unanswerable if blanks are simply not listed.
    const rows = [R({ am: 'Hannah Posey' }), R({ am: '' }), R({ am: '' }), R({ am: '' })];
    const vals = tb.filterValues(rows, 'am');
    t.equal(vals[vals.length - 1].value, tb.BLANK_LABEL);
    t.equal(vals[vals.length - 1].count, 3);
  });

  t.test('status offers levels, not the sentences', () => {
    const rows = [
      R({ status: 'no word for 6 days', healthLevel: 'red' }),
      R({ status: 'no word for 8 days', healthLevel: 'red' }),
      R({ status: 'On track', healthLevel: 'ok' }),
    ];
    const vals = tb.filterValues(rows, 'status');
    t.equal(vals.length, 2);                 // not three near-unique strings
    t.equal(vals[0].value, tb.HEALTH_LABELS.red);
    t.equal(vals[0].count, 2);
  });

  t.test('a column with no menu offers nothing', () => {
    t.equal(tb.filterValues([R({ poNumber: '26-1' })], 'poNumber').length, 0);
  });

  /* ---- applying the filters ------------------------------------------ */

  const mixed = [
    R({ poNumber: '1', vendor: 'SanMar', am: 'Hannah', healthLevel: 'red' }),
    R({ poNumber: '2', vendor: 'SanMar', am: 'Alexis', healthLevel: 'ok' }),
    R({ poNumber: '3', vendor: 'Ballpro', am: 'Hannah', healthLevel: 'red' }),
  ];

  t.test('no filters means every row, not no rows', () => {
    t.equal(tb.applyColumnFilters(mixed, {}).length, 3);
    t.equal(tb.applyColumnFilters(mixed, null).length, 3);
  });

  t.test('an empty tick list on a column is NOT a filter', () => {
    // Unticking the last box has to give the table back, not empty it.
    t.equal(tb.applyColumnFilters(mixed, { vendor: [] }).length, 3);
  });

  t.test('within one column the choices are OR', () => {
    const out = tb.applyColumnFilters(mixed, { vendor: ['SanMar', 'Ballpro'] });
    t.equal(out.length, 3);
  });

  t.test('across columns the filters are AND', () => {
    const out = tb.applyColumnFilters(mixed, { vendor: ['SanMar'], am: ['Hannah'] });
    t.equal(names(out), '1');
  });

  t.test('status filters on the level behind the sentence', () => {
    const out = tb.applyColumnFilters(mixed, { status: [tb.HEALTH_LABELS.red] });
    t.equal(names(out), '1,3');
  });

  t.test('an unknown column key is ignored rather than emptying the table', () => {
    t.equal(tb.applyColumnFilters(mixed, { nonsense: ['x'] }).length, 3);
  });

  t.test('filtering does not mutate what it was given', () => {
    tb.applyColumnFilters(mixed, { vendor: ['SanMar'] });
    t.equal(mixed.length, 3);
  });

  /* ---- saying what is hidden ------------------------------------------ */

  t.test('nothing active reports nothing active', () => {
    t.equal(tb.anyFilterActive({}), false);
    t.equal(tb.anyFilterActive({ vendor: [] }), false);
    t.equal(tb.activeFilterList({}).length, 0);
  });

  t.test('an active filter is listed so the screen can say so out loud', () => {
    const list = tb.activeFilterList({ vendor: ['SanMar'], am: ['Hannah'] });
    t.equal(list.length, 2);
    t.equal(tb.anyFilterActive({ vendor: ['SanMar'] }), true);
    // Labelled, because "Vendor: SanMar" is readable and "vendor" is a key.
    t.equal(list[0].label, 'Vendor');
  });

  t.test('the chip list follows column order, not the order they were ticked', () => {
    const list = tb.activeFilterList({ status: ['Late'], customer: ['MH Equipment'] });
    t.equal(list.map((x) => x.key).join(','), 'customer,status');
  });

  process.exit(t.report());
})();
