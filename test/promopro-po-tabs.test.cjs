// PUT IN: test/promopro-po-tabs.test.cjs
/**
 * PromoPro order screen, Sep 24 2026: two tabs and one next step.
 *
 * Ryan's ask: most of the team reads this screen in a hurry, so the order
 * itself has to be simple and easy to read, and every email, reply, call and
 * history line lives on its own tab. These checks keep the record off the
 * Order tab, because the way this screen got long in the first place was one
 * reasonable section at a time.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'apps/promopro.js'), 'utf8');

const between = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

(async () => {
  const schema = await import('../lib/promopro/schema.js');

  /* ---- next step, called for real ------------------------------------- */

  t.test('the next step is the first unticked one', () => {
    const n = schema.nextStep({ submittedAt: '2026-09-15', confirmedAt: '2026-09-17' });
    t.equal(n.stage.key, 'art_approved');
    t.equal(n.onUs, true, 'art approval is on us');
  });

  t.test('a vendor step says it is waiting on the vendor', () => {
    const n = schema.nextStep({});
    t.equal(n.stage.key, 'submitted');
    t.equal(n.onUs, false);
  });

  t.test('a gap counts: a later tick does not skip an earlier step', () => {
    const n = schema.nextStep({ submittedAt: 'x', shippedAt: 'x' });
    t.equal(n.stage.key, 'confirmed');
  });

  t.test('nothing next when done or cancelled', () => {
    const all = {};
    schema.MANUAL_STAGES.forEach((s) => { all[s.dateField] = '2026-09-24'; });
    t.equal(schema.nextStep(all), null);
    t.equal(schema.nextStep({ cancelledAt: '2026-09-24' }), null);
    t.equal(schema.nextStep(null), null);
  });

  /* ---- history reads like English ------------------------------------- */

  t.test('a stage change is written with real step names', () => {
    t.equal(schema.stageMoveText('confirmed', 'art_approved', {}), 'Confirmed to Art approved');
    t.equal(schema.stageMoveText('shipped', 'cancelled', {}), 'Shipped to Cancelled');
  });

  t.test('old raw history lines are tidied when shown', () => {
    t.equal(schema.readableHistory('confirmed to art_approved', {}), 'Confirmed to Art approved');
  });

  t.test('ordinary history lines are left alone', () => {
    t.equal(schema.readableHistory('followed up: called them', {}), 'followed up: called them');
    t.equal(schema.readableHistory('emailed to orders@x.test', {}), 'emailed to orders@x.test');
    // Two words that happen to fit the pattern but are not stages.
    t.equal(schema.readableHistory('draft to nowhere', {}), 'draft to nowhere');
    t.equal(schema.readableHistory(null, {}), '');
  });

  t.test('the route writes it and the screen reads it through the helpers', () => {
    const route = fs.readFileSync(path.join(ROOT, 'api/promopro/pos.js'), 'utf8');
    t.assert(/what: stageMoveText\(before, after, existing\)/.test(route), 'route still writes raw keys');
    t.assert(/esc\(readableHistory\(h\.what, po\)\)/.test(app), 'screen shows raw history');
  });

  /* ---- the split ------------------------------------------------------- */

  const orderPane = between('function orderPaneHtml', 'function alertsHtml');
  const activityPane = between('function activityPaneHtml', 'function renderDetail');
  const detail = app.slice(app.indexOf('function renderDetail'));
  const detailBody = detail.slice(0, detail.indexOf('\n    }\n'));

  t.test('the detail screen renders both tabs', () => {
    t.assert(/data-potab="order"/.test(detailBody) && /data-potab="activity"/.test(detailBody), 'tab buttons missing');
    t.assert(/orderPaneHtml\(po/.test(detailBody) && /activityPaneHtml\(po/.test(detailBody), 'panes missing');
  });

  t.test('replies, calls and history are not on the Order tab', () => {
    t.assert(!/repliesHtml\(/.test(orderPane), 'replies on the order tab');
    t.assert(!/activityHtml\(/.test(orderPane), 'history on the order tab');
    t.assert(!/receipts\.map/.test(orderPane), 'booking log on the order tab');
    t.assert(!/lastSentAt\)\.slice/.test(orderPane), 'send log on the order tab');
  });

  t.test('they are on the Emails & history tab', () => {
    t.assert(/repliesHtml\(po\)/.test(activityPane));
    t.assert(/activityHtml\(po\)/.test(activityPane));
    t.assert(/ppDeliveryLine/.test(activityPane), 'delivery status belongs with the send log');
  });

  t.test('the Order tab leads with what is wrong, then the next step', () => {
    const a = orderPane.indexOf('alertsHtml(');
    const n = orderPane.indexOf('nextStepHtml(');
    const p = orderPane.indexOf('progressHtml(');
    const l = orderPane.indexOf('linesHtml(');
    t.assert(a >= 0 && a < n && n < p && p < l, 'order should be alerts, next step, ticks, lines');
  });

  t.test('a bounce still shows on the Order tab', () => {
    // A bounce changes what somebody does next, so it cannot hide on the
    // history tab.
    t.assert(/id="ppDeliveryBad"/.test(between('function alertsHtml', 'function nextStepHtml')));
  });

  t.test('the next step button is gated like every other tick', () => {
    const fn = between('function nextStepHtml', 'function moreHtml');
    t.assert(/canMove\(po\)\s*\n?\s*\? '<button class="pp-btn" data-stagetick/.test(fn), 'next step not on canMove');
  });

  t.test('switching tabs does not redraw', () => {
    // A redraw would throw away a half-typed tracking number or call note.
    const handler = app.slice(app.indexOf("const tabKey = t.dataset ? t.dataset.potab : ''"));
    const branch = handler.slice(0, handler.indexOf('return;'));
    t.assert(branch.length > 0, 'tab handler missing');
    t.assert(!/renderDetail\(/.test(branch), 'tab switch should toggle, not redraw');
  });

  t.test('a different order opens on the Order tab', () => {
    t.assert(/if \(st\.tabPoId !== po\.id\)[\s\S]{0,80}st\.poTab = 'order'/.test(detailBody));
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL promopro-po-tabs could not run: ' + (e && e.stack || e));
  process.exit(1);
});
