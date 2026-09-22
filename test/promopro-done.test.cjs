// PUT IN: test/promopro-done.test.cjs
// test/promopro-done.test.cjs
/**
 * PromoPro: a checked-in order has to land somewhere.
 *
 * THE BUG THIS PINS DOWN. Booking in a delivery moved an order to Received.
 * The pipeline filtered Received out, the Purchase Orders list filtered
 * Received out of Open, and there was no other view, so the order vanished
 * from every screen except All. It looked like receiving deleted it.
 *
 * Closing did not save it either: closedPatch() only closes an order once
 * every manual step has a date, payment included, and payment is entered in
 * QuickBooks rather than here. So orders sit at Received rather than passing
 * through it.
 *
 * The rule now lives in two functions rather than in a list of stage names
 * copied into four places, which is how the four had already drifted apart.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const s = await import('../lib/promopro/schema.js');

  const base = {
    id: 'po1', poNumber: '26-66608-9', vendorId: 'v1',
    lines: [{ description: 'Navy hoodies', qty: 144 }],
  };
  const at = (fields) => ({ ...base, ...fields });

  const draft = at({});
  const submitted = at({ submittedAt: '2026-09-07' });
  const shipped = at({ submittedAt: '2026-09-07', confirmedAt: '2026-09-08', shippedAt: '2026-09-15' });
  const received = at({ submittedAt: '2026-09-07', confirmedAt: '2026-09-08', shippedAt: '2026-09-15', receivedAt: '2026-09-18' });
  const closed = at({ submittedAt: '2026-09-07', confirmedAt: '2026-09-08', artApprovedAt: '2026-09-09', paymentSentAt: '2026-09-10', shippedAt: '2026-09-15', receivedAt: '2026-09-18', closedAt: '2026-09-18' });
  const cancelled = at({ submittedAt: '2026-09-07', cancelledAt: '2026-09-09' });

  t.test('a checked-in order is finished even though nothing closed it', () => {
    t.equal(s.currentStage(received), 'received');
    t.assert(s.isFinished(received), 'this is the case that was disappearing');
    t.assert(!s.isOpenPo(received));
  });

  t.test('receiving does not close an order by itself, which is why Done matters', () => {
    // Payment and art approval are not ticked here, and often never are.
    t.equal(Object.keys(s.closedPatch(received)).length, 0, 'nothing closes it');
    t.assert(s.isFinished(received), 'and it still has to be findable');
  });

  t.test('a closed order is finished too', () => {
    t.equal(s.currentStage(closed), 'closed');
    t.assert(s.isFinished(closed));
    t.assert(!s.isOpenPo(closed));
  });

  t.test('everything still in flight is open', () => {
    [draft, submitted, shipped].forEach((p) => {
      t.assert(s.isOpenPo(p), s.currentStage(p) + ' should be open');
      t.assert(!s.isFinished(p), s.currentStage(p) + ' is not finished');
    });
  });

  t.test('cancelled is neither open nor done', () => {
    t.assert(!s.isOpenPo(cancelled), 'it is not being waited on');
    t.assert(!s.isFinished(cancelled), 'an order somebody called off did not land');
  });

  t.test('a cancelled order that had been received reads as cancelled', () => {
    const both = at({ submittedAt: '2026-09-07', receivedAt: '2026-09-18', cancelledAt: '2026-09-19' });
    t.assert(!s.isFinished(both), 'cancelled wins, the same way currentStage has it');
  });

  t.test('junk does not throw', () => {
    t.assert(!s.isFinished(null));
    t.assert(s.isOpenPo(null), 'an empty record reads as a draft, which is open');
  });

  /* ---- the screens ----------------------------------------------------- */

  t.test('the orders list has a Done pill and it uses the shared rule', () => {
    const app = read('apps/promopro.js');
    t.assert(/'done', 'Done'/.test(app), 'there has to be somewhere to click');
    t.assert(/st\.filter === 'done'/.test(app), 'and it has to filter something');
    t.assert(/rows\.filter\(isFinished\)/.test(app), 'the shared rule, not a fourth copy of a stage list');
  });

  t.test('no screen keeps its own list of what counts as not open', () => {
    const app = read('apps/promopro.js');
    t.assert(
      !/\['closed', 'cancelled', 'received'\]/.test(app),
      'four copies of this list had already drifted apart once'
    );
  });

  t.test('the pipeline has no lane that can never fill', () => {
    const app = read('apps/promopro.js');
    t.assert(
      /s\.key !== 'closed' && s\.key !== 'received'/.test(app),
      'the board is open orders only, so a Received column would always read None'
    );
  });

  process.exit(t.report());
})();
