// PUT IN: test/promopro-outsourced.test.cjs
// test/promopro-outsourced.test.cjs
/**
 * PromoPro: work we send out that never gets a purchase order raised
 * against it.
 *
 * The whole feature is one flag, and the risk in a flag like this is not
 * that it fails to work. It is that it works everywhere except the one
 * place that matters, so these call the real functions with real records:
 * isOutsourced decides, stageLabel renames, docLabels titles the paper, and
 * the vendor scorecard is asked whether the spend actually landed.
 *
 * The source checks at the bottom are only for wiring that has no function
 * to call: a route refusing before it sends, a button that is not drawn.
 * Grepping proves the letters are there, never that the code runs, which is
 * the distinction that let api/promopro/printavo.js 500 for days behind a
 * green suite.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('apps/promopro.js');
const sendRoute = read('api/promopro/send.js');
const posRoute = read('api/promopro/pos.js');

(async () => {
  const s = await import('../lib/promopro/schema.js');
  const vs = await import('../lib/promopro/vendor-stats.js');
  const doc = await import('../lib/promopro/document.js');

  /* ---- what counts as outsourced -------------------------------------- */

  t.test('only an exact true makes a record outsourced', () => {
    t.assert(s.isOutsourced({ outsourced: true }) === true, 'true is outsourced');
    t.assert(s.isOutsourced({ outsourced: false }) === false, 'false is not');
    t.assert(s.isOutsourced({}) === false, 'a record with no flag is a purchase order');
    t.assert(s.isOutsourced(null) === false, 'nothing is not outsourced');
  });

  t.test('a truthy value that is not true still leaves it a purchase order', () => {
    // The safe answer is PO. A stored "true" string, a 1 out of an old
    // import, or a half-parsed body must never be the thing that silently
    // stops a real purchase order from reaching a vendor.
    t.assert(s.isOutsourced({ outsourced: 'true' }) === false, 'the string is not the boolean');
    t.assert(s.isOutsourced({ outsourced: 1 }) === false, 'a number is not the boolean');
  });

  /* ---- creating one ---------------------------------------------------- */

  const vendorIds = ['v1'];
  const amIds = ['alexis'];
  const base = {
    vendorId: 'v1',
    accountManager: 'alexis',
    lines: [{ itemNumber: 'CONTRACT', description: 'Contract embroidery, 48 caps', qty: 48, unitCost: 3.25 }],
  };

  t.test('the flag is carried onto a new record', () => {
    const made = s.validateNew({ ...base, outsourced: true }, vendorIds, amIds);
    t.assert(made.ok === true, 'it validates');
    t.assert(made.record.outsourced === true, 'and it comes out outsourced');
  });

  t.test('a normal purchase order is not outsourced by omission', () => {
    const made = s.validateNew(base, vendorIds, amIds);
    t.assert(made.ok === true, 'it validates');
    t.assert(made.record.outsourced === false, 'no flag means a purchase order');
  });

  t.test('an outsourced job still needs a vendor and an account manager', () => {
    // The flag removes the email, not the ownership. A job sent out with
    // nobody's name on it is the exact failure this app exists to end, and
    // it must not become reachable through a different create path.
    const noVendor = s.validateNew({ ...base, vendorId: '', outsourced: true }, vendorIds, amIds);
    t.assert(noVendor.ok === false, 'no vendor is refused');
    const noAm = s.validateNew({ ...base, accountManager: '', outsourced: true }, vendorIds, amIds);
    t.assert(noAm.ok === false, 'no account manager is refused');
  });

  t.test('the flag can be patched both ways, as a strict boolean', () => {
    const on = s.validatePatch({ outsourced: true }, vendorIds, amIds);
    t.assert(on.ok === true && on.patch.outsourced === true, 'switched on');
    const off = s.validatePatch({ outsourced: false }, vendorIds, amIds);
    t.assert(off.ok === true && off.patch.outsourced === false, 'switched off');
    const junk = s.validatePatch({ outsourced: 'yes' }, vendorIds, amIds);
    t.assert(junk.patch.outsourced === false, 'anything else lands on the purchase order side');
  });

  t.test('a patch that does not mention it leaves it alone', () => {
    // Not the same as setting it false. Every unrelated edit on the detail
    // screen goes through this, so a missing field turning a job back into a
    // purchase order would undo the flag on the next note change.
    const p = s.validatePatch({ notes: 'ready Thursday' }, vendorIds, amIds);
    t.assert(p.ok === true, 'it validates');
    t.assert(!('outsourced' in p.patch), 'and the flag is untouched');
  });

  /* ---- what it is called ----------------------------------------------- */

  const job = { outsourced: true };
  const po = { outsourced: false };

  t.test('the three misleading step names are renamed, and only those', () => {
    t.equal(s.stageLabel('submitted', job), 'Sent out', 'nothing was submitted');
    t.equal(s.stageLabel('shipped', job), 'Shipped back', 'it comes back to us');
    t.equal(s.stageLabel('received', job), 'Back in house', 'not received from a supplier');
    t.equal(s.stageLabel('confirmed', job), 'Confirmed', 'confirmed still reads right');
    t.equal(s.stageLabel('paid', job), 'Paid', 'payment is unchanged, it still gets paid');
    t.equal(s.stageLabel('art_approved', job), 'Art approved', 'art approval still reads right');
  });

  t.test('a purchase order keeps every name it had', () => {
    s.STAGES.forEach((stage) => {
      t.equal(s.stageLabel(stage.key, po), stage.label, stage.key + ' is unchanged');
    });
  });

  t.test('an unknown stage key comes back as itself rather than blank', () => {
    // A label is drawn straight into a table cell. Returning undefined for a
    // key added later would empty the Stage column instead of failing loudly.
    t.equal(s.stageLabel('something_new', job), 'something_new', 'the key is the fallback');
  });

  t.test('the paperwork calls itself what it is', () => {
    t.equal(s.docLabels(job).title, 'OUTSOURCED JOB', 'not a purchase order');
    t.equal(s.docLabels(po).title, 'PURCHASE ORDER', 'and one that is, is');
    t.assert(s.docLabels(job).numberLabel !== s.docLabels(po).numberLabel, 'the number is labelled differently too');
  });

  t.test('the printed sheet actually carries the outsourced heading', () => {
    // Rendered for real, because the title travelling from docLabels into
    // the document is the point. A vendor handed paper headed PURCHASE ORDER
    // has been given a purchase order, whatever the record says.
    const record = {
      poNumber: '26-66610',
      outsourced: true,
      createdAt: '2026-09-03T12:00:00.000Z',
      lines: [{ description: 'Contract embroidery', qty: 48, unitCost: 3.25 }],
    };
    const html = doc.renderPoHtml(record, { name: 'Contract Shop' }, { brand: { name: 'P&M Apparel' } });
    t.assert(html.includes('OUTSOURCED JOB'), 'the sheet says outsourced job');
    t.assert(!html.includes('>PURCHASE ORDER<'), 'and never says purchase order');

    const asPo = doc.renderPoHtml({ ...record, outsourced: false }, { name: 'Contract Shop' }, { brand: { name: 'P&M Apparel' } });
    t.assert(asPo.includes('PURCHASE ORDER'), 'a real purchase order is unchanged');
  });

  /* ---- it behaves like every other order ------------------------------- */

  t.test('an outsourced job counts toward what we spend with that vendor', () => {
    // Ryan's decision: money paid to a contract shop is money spent with
    // that vendor. Splitting it out would take real spend off the scorecard.
    const vendor = { id: 'v1', name: 'Contract Shop', leadDays: 7 };
    const stats = vs.vendorStats(vendor, [
      { vendorId: 'v1', outsourced: true, lines: [{ qty: 48, unitCost: 3.25 }] },
      { vendorId: 'v1', lines: [{ qty: 10, unitCost: 5 }] },
    ]);
    t.equal(stats.spend, 206, '48 at 3.25 plus 10 at 5');
    t.equal(stats.orders, 2, 'and it is counted as an order');
  });

  t.test('an outsourced job is scored on turnaround like anything else', () => {
    const vendor = { id: 'v1', name: 'Contract Shop', leadDays: 7 };
    const stats = vs.vendorStats(vendor, [
      { vendorId: 'v1', outsourced: true, submittedAt: '2026-09-01', confirmedAt: '2026-09-02', receivedAt: '2026-09-05', lines: [] },
    ]);
    t.equal(stats.avgResponseDays, 1, 'the response clock ran');
    t.equal(stats.avgDeliveryDays, 4, 'and so did the delivery clock');
  });

  t.test('payment is still one of the steps that has to be ticked to close it', () => {
    // The answer to the third question: cost is real and it gets paid, so a
    // job with everything else done but no payment date is NOT finished.
    const ticked = {};
    s.MANUAL_STAGES.forEach((stage) => { ticked[stage.dateField] = '2026-09-04'; });

    t.assert(s.MANUAL_STAGES.some((x) => x.dateField === 'paymentSentAt'), 'payment is a step somebody ticks');

    const done = s.closedPatch({ outsourced: true, ...ticked });
    t.equal(done.closedAt, '2026-09-04', 'everything ticked closes it');

    const unpaid = { outsourced: true, ...ticked, paymentSentAt: null };
    const notDone = s.closedPatch(unpaid);
    t.assert(!notDone.closedAt, 'without the payment it stays open');
  });

  t.test('the stage an outsourced job sits in is worked out the same way', () => {
    t.equal(s.currentStage({ outsourced: true }), 'draft', 'nothing done yet');
    t.equal(s.currentStage({ outsourced: true, submittedAt: '2026-09-01' }), 'submitted', 'sent out');
    t.equal(s.currentStage({ outsourced: true, cancelledAt: '2026-09-02' }), s.CANCELLED, 'cancelled leaves the pipeline');
  });

  /* ---- wiring that has no function to call ----------------------------- */

  t.test('the send route refuses an outsourced record before it renders anything', () => {
    t.assert(sendRoute.includes('isOutsourced(po) && body.cancel !== true'), 'refused unless it is a cancellation');
    const refusal = sendRoute.indexOf('isOutsourced(po) && body.cancel !== true');
    const render = sendRoute.indexOf('renderEmailHtml(');
    t.assert(refusal !== -1 && render !== -1 && refusal < render, 'the refusal comes before the document is built');
  });

  t.test('cancelling an outsourced job is still possible, and emails nobody', () => {
    t.assert(sendRoute.includes('const tellVendor = !isOutsourced(po)'), 'the send is skipped, not the cancellation');
    t.assert(
      sendRoute.includes('no vendor email because this is outsourced work'),
      'and the record says why nobody was told'
    );
  });

  t.test('the route will not turn an already emailed purchase order into one', () => {
    t.assert(
      posRoute.includes('check.patch.outsourced === true && !isOutsourced(existing) && existing.lastSentAt'),
      'a sent document cannot be un-issued from a checkbox'
    );
  });

  t.test('the screen offers no way to send one', () => {
    // Both send buttons, not one. The test send renders the same document
    // as the real one, so leaving it drawn would put a purchase order in
    // somebody's inbox for a job that never had one.
    const sendBtn = app.indexOf('id="ppSend">');
    const testBtn = app.indexOf('id="ppSendTest">');
    t.assert(sendBtn !== -1 && testBtn !== -1, 'both buttons exist to be gated');
    const gateBefore = (at) => app.slice(Math.max(0, at - 200), at).includes('!isOutsourced(po)');
    t.assert(gateBefore(sendBtn), 'the send button is gated on it');
    t.assert(gateBefore(testBtn), 'and so is the test send');
    t.assert(app.includes('id="ppOutsourced"'), 'and the create form carries the tick');
  });

  t.test('the badge asks isOutsourced rather than reading the field itself', () => {
    // A second place deciding what counts as outsourced is how a screen and
    // a server start disagreeing. Same rule as poHealth().
    const tag = app.slice(app.indexOf('function outsourcedTag(po)'), app.indexOf('function outsourcedTag(po)') + 400);
    t.assert(tag.length > 40, 'the helper exists');
    t.assert(tag.includes('isOutsourced(po)'), 'it asks the shared reader');
    t.assert(!tag.includes('po.outsourced'), 'and never reads the raw field');
  });

  t.test('the badge colour comes from tokens, not from a hex in the app file', () => {
    const css = app.slice(app.indexOf('.pp-nopo'), app.indexOf('.pp-nopo') + 300);
    t.assert(css.includes('var(--line)') && css.includes('var(--muted)'), 'tokens only');
    t.assert(!/#[0-9a-fA-F]{3,6}/.test(css), 'no hex values');
  });

  t.test('a reorder of an outsourced job stays outsourced', () => {
    t.assert(app.includes('outsourced: isOutsourced(po),'), 'the prefill carries it across');
  });

  t.test('what is typed above the lines survives a redraw', () => {
    // Added because ticking the box redraws the form. The same redraw
    // happens on Add a line, where it was quietly wiping notes already.
    t.assert(app.includes('function harvestForm()'), 'the values are harvested');
    const addLine = app.indexOf("t.id === 'ppAddLine'");
    const harvestAt = app.indexOf('harvestForm();', addLine);
    const renderAt = app.indexOf('renderForm();', addLine);
    t.assert(harvestAt !== -1 && harvestAt < renderAt, 'and harvested BEFORE the redraw, not after');
  });

  process.exit(t.report());
})();
