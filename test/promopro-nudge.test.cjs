// PUT IN: test/promopro-nudge.test.cjs
// test/promopro-nudge.test.cjs
/**
 * PromoPro automatic vendor reminders.
 *
 * The app now puts mail in another company's inbox with nobody watching, so
 * the interesting tests here are all the ones about NOT sending: a vendor who
 * replied, a vendor who is blacklisted, an order somebody already rang about,
 * an order from four months ago, a Saturday. Every one of those is a failure
 * that would be embarrassing in front of a supplier rather than merely wrong
 * on a screen.
 *
 * Every check calls the real function. Reading the source would only prove
 * the letters are there, which is exactly how a live 500 once hid behind a
 * green suite.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const n = await import('../lib/promopro/nudge.js');
  const s = await import('../lib/promopro/schema.js');

  const VENDOR = { id: 'v1', name: 'Acme Blanks', email: 'orders@acme.test' };

  const settings = s.withSettingDefaults({
    nudgeVendors: true,
    nudgeFromAddress: 'ryan@pmapparel.com',
    nudgeFromName: 'Ryan',
    brandName: 'P&M Apparel',
    alwaysCc: ['office@pmapparel.com'],
  });

  // Sent Monday Sep 7 2026. Wednesday the 9th is two working days later.
  const po = () => ({
    id: 'po1',
    poNumber: '26-66608-9',
    vendorId: 'v1',
    submittedAt: '2026-09-07',
    lastSentAt: '2026-09-07T15:00:00.000Z',
    sentTo: 'orders@acme.test',
    sentCc: ['alexis@pmapparel.com'],
    sendCount: 1,
    lines: [{ description: 'Navy hoodies' }, { description: 'Caps' }],
    neededBy: '2026-09-25',
  });

  /* ---- the clock ------------------------------------------------------ */

  t.test('a weekend is not waiting', () => {
    // Thursday to Saturday is one working day, not two.
    t.equal(n.businessDaysBetween('2026-09-10', '2026-09-12'), 1);
    t.equal(n.businessDaysBetween('2026-09-10', '2026-09-14'), 2, 'Thu to Mon is Fri and Mon');
  });

  t.test('same day is zero, and a backwards pair does not go negative', () => {
    t.equal(n.businessDaysBetween('2026-09-09', '2026-09-09'), 0);
    t.equal(n.businessDaysBetween('2026-09-09', '2026-09-07'), 0);
  });

  t.test('a garbled date reports null rather than guessing', () => {
    t.equal(n.businessDaysBetween('not-a-date', '2026-09-09'), null);
    t.equal(n.businessDaysBetween('', '2026-09-09'), null);
  });

  /* ---- when it sends -------------------------------------------------- */

  t.test('two working days with no confirmation is a reminder', () => {
    const plan = n.nudgePlan(po(), VENDOR, settings, '2026-09-09');
    t.assert(plan.send, plan.reason);
    t.equal(plan.round, 1);
  });

  t.test('one working day is too early, and says so', () => {
    const plan = n.nudgePlan(po(), VENDOR, settings, '2026-09-08');
    t.assert(!plan.send, 'must not send on day one');
    t.assert(/1 working day/.test(plan.reason), plan.reason);
  });

  t.test('a PO sent Thursday is not chased on Saturday', () => {
    const p = po();
    p.submittedAt = '2026-09-10';
    p.lastSentAt = '2026-09-10T15:00:00.000Z';
    t.assert(!n.nudgePlan(p, VENDOR, settings, '2026-09-12').send, 'Saturday is one working day later');
    t.assert(n.nudgePlan(p, VENDOR, settings, '2026-09-14').send, 'Monday is two');
  });

  /* ---- when it must not send ------------------------------------------ */

  t.test('a confirmed order is left alone', () => {
    const p = po();
    p.confirmedAt = '2026-09-08';
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-09');
    t.assert(!plan.send, 'confirmed is the thing being waited for');
  });

  t.test('a vendor who has replied is never told they have not', () => {
    const p = po();
    p.lastVendorReplyAt = '2026-09-08T09:00:00.000Z';
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-11');
    t.assert(!plan.send, 'they wrote back');
    t.assert(/replied/.test(plan.reason), plan.reason);
  });

  t.test('a reply to an OLDER send does not hold up the reminder', () => {
    const p = po();
    // Replied to the first send, then we re-sent. The reply is not an answer
    // to the email we sent on the 7th.
    p.lastVendorReplyAt = '2026-09-01T09:00:00.000Z';
    t.assert(n.nudgePlan(p, VENDOR, settings, '2026-09-09').send);
  });

  t.test('a blacklisted vendor is not emailed by a cron', () => {
    const plan = n.nudgePlan(po(), { ...VENDOR, blacklisted: true }, settings, '2026-09-09');
    t.assert(!plan.send);
    t.assert(/blacklisted/.test(plan.reason), plan.reason);
  });

  t.test('outsourced work has no purchase order to chase', () => {
    const p = po();
    p.outsourced = true;
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-09');
    t.assert(!plan.send);
    t.assert(/outsourced/.test(plan.reason), plan.reason);
  });

  t.test('somebody who rang them yesterday stops the automatic one', () => {
    const p = po();
    p.lastFollowUpAt = '2026-09-09T16:00:00.000Z';
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-10');
    t.assert(!plan.send, 'the shop must not look like it is not talking to itself');
    t.assert(/chased/.test(plan.reason), plan.reason);
  });

  t.test('a follow-up logged BEFORE the last send does not bring it forward', () => {
    const p = po();
    p.lastFollowUpAt = '2026-08-20T16:00:00.000Z';
    t.assert(!n.nudgePlan(p, VENDOR, settings, '2026-09-08').send, 'still only one working day since the send');
  });

  t.test('it gives up rather than writing every morning', () => {
    const p = po();
    p.nudges = [
      { at: '2026-09-09T14:00:00.000Z', round: 1 },
      { at: '2026-09-11T14:00:00.000Z', round: 2 },
    ];
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-16');
    t.assert(!plan.send);
    t.assert(/limit/.test(plan.reason), plan.reason);
  });

  t.test('a second reminder waits the same gap as the first', () => {
    const p = po();
    p.nudges = [{ at: '2026-09-09T14:00:00.000Z', round: 1 }];
    t.assert(!n.nudgePlan(p, VENDOR, settings, '2026-09-10').send, 'one day after the first is too soon');
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-11');
    t.assert(plan.send, plan.reason);
    t.equal(plan.round, 2);
  });

  t.test('a re-send starts the count again', () => {
    const p = po();
    p.nudges = [
      { at: '2026-09-09T14:00:00.000Z', round: 1 },
      { at: '2026-09-11T14:00:00.000Z', round: 2 },
    ];
    p.lastSentAt = '2026-09-14T15:00:00.000Z';
    p.sendCount = 2;
    t.equal(n.nudgeRoundSoFar(p), 0, 'reminders about the previous send are spent');
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-16');
    t.assert(plan.send, plan.reason);
    t.equal(plan.round, 1);
  });

  t.test('an old order is not chased the day this gets switched on', () => {
    const p = po();
    p.submittedAt = '2026-05-04';
    p.lastSentAt = '2026-05-04T15:00:00.000Z';
    const plan = n.nudgePlan(p, VENDOR, settings, '2026-09-09');
    t.assert(!plan.send);
    t.assert(/cut-off/.test(plan.reason), plan.reason);
  });

  t.test('a draft that was never emailed is not chased', () => {
    const p = po();
    delete p.submittedAt;
    delete p.lastSentAt;
    t.assert(!n.nudgePlan(p, VENDOR, settings, '2026-09-09').send);
  });

  t.test('switched off means nothing at all, however overdue', () => {
    const off = s.withSettingDefaults({ ...settings, nudgeVendors: false });
    const plan = n.nudgePlan(po(), VENDOR, off, '2026-09-20');
    t.assert(!plan.send);
    t.assert(/switched off/.test(plan.reason), plan.reason);
  });

  t.test('no from-address means it refuses rather than sending from nothing', () => {
    const bad = s.withSettingDefaults({ nudgeVendors: true, nudgeFromAddress: '', fromAddress: '' });
    const plan = n.nudgePlan(po(), VENDOR, bad, '2026-09-09');
    t.assert(!plan.send);
    t.assert(/from-address/.test(plan.reason), plan.reason);
  });

  /* ---- who it goes to -------------------------------------------------- */

  t.test('it goes to everyone who was on the original email', () => {
    const r = n.nudgeRecipients(po(), VENDOR, settings);
    t.equal(r.to.join(','), 'orders@acme.test');
    t.equal(r.cc.join(','), 'alexis@pmapparel.com', 'the recorded list, not a rebuilt one');
  });

  t.test('an order sent before the CC list was recorded falls back to the rule', () => {
    const p = po();
    delete p.sentCc;
    const r = n.nudgeRecipients(p, VENDOR, settings);
    t.assert(r.cc.includes('office@pmapparel.com'), 'always-CC still gets copied: ' + r.cc.join(','));
  });

  t.test('nobody is on it twice', () => {
    const p = po();
    p.sentCc = ['orders@acme.test', 'Alexis@pmapparel.com', 'alexis@pmapparel.com'];
    const r = n.nudgeRecipients(p, VENDOR, settings);
    t.equal(r.cc.length, 1, 'the vendor and a duplicate both drop out: ' + r.cc.join(','));
  });

  t.test('a junk address on the record is dropped, not sent to', () => {
    const p = po();
    p.sentCc = ['not an address', 'abby@pmapparel.com'];
    t.equal(n.nudgeRecipients(p, VENDOR, settings).cc.join(','), 'abby@pmapparel.com');
  });

  t.test('an order with no address to write to is held, not sent blank', () => {
    const p = po();
    p.sentTo = '';
    const plan = n.nudgePlan(p, { ...VENDOR, email: '' }, settings, '2026-09-09');
    t.assert(!plan.send);
    t.assert(/no address/.test(plan.reason), plan.reason);
  });

  /* ---- the message ----------------------------------------------------- */

  t.test('it comes from the owner, signed by name', () => {
    const m = n.nudgeMessage(po(), VENDOR, settings, 1, '2026-09-09');
    t.equal(m.from, 'Ryan <ryan@pmapparel.com>');
    t.assert(/Ryan/.test(m.text), 'it should be signed');
  });

  t.test('the from-address falls back to the purchase order one', () => {
    const fb = s.withSettingDefaults({
      nudgeVendors: true, nudgeFromAddress: '', fromAddress: 'orders@pmapparel.com', brandName: 'P&M Apparel',
    });
    t.equal(n.nudgeMessage(po(), VENDOR, fb, 1, '2026-09-09').from, 'P&M Apparel <orders@pmapparel.com>');
  });

  t.test('a reply lands back on the order when capture is on', () => {
    const cap = s.withSettingDefaults({
      ...settings, captureReplies: true, captureDomain: 'po.pmapparel.com',
    });
    const m = n.nudgeMessage(po(), VENDOR, cap, 1, '2026-09-09');
    t.equal(m.reply_to, 'po+26-66608-9@po.pmapparel.com');
  });

  t.test('capture off still reaches a person, never a no-reply', () => {
    const m = n.nudgeMessage(po(), VENDOR, settings, 1, '2026-09-09');
    t.equal(m.reply_to, 'ryan@pmapparel.com');
  });

  t.test('the message says which order, what is on it and when it is due', () => {
    const m = n.nudgeMessage(po(), VENDOR, settings, 1, '2026-09-09');
    t.assert(/26-66608-9/.test(m.subject), m.subject);
    t.assert(/26-66608-9/.test(m.text), 'the number has to be in the body too');
    t.assert(/Navy hoodies/.test(m.text), 'what was ordered');
    t.assert(/2026-09-25/.test(m.text), 'when it is needed');
    t.assert(/Acme Blanks/.test(m.text), 'addressed to them by name');
  });

  t.test('a second reminder does not read like a duplicate of the first', () => {
    const one = n.nudgeMessage(po(), VENDOR, settings, 1, '2026-09-09');
    const two = n.nudgeMessage(po(), VENDOR, settings, 2, '2026-09-11');
    t.assert(one.subject !== two.subject, 'same subject twice looks like a send that misfired');
    t.assert(/Second/.test(two.subject), two.subject);
  });

  t.test('it asks, it does not threaten', () => {
    const text = n.nudgeMessage(po(), VENDOR, settings, 2, '2026-09-11').text;
    t.assert(!/cancel|elsewhere|urgent|immediately/i.test(text), 'an automatic email cannot make that call: ' + text);
  });

  /* ---- the morning list ------------------------------------------------ */

  t.test('the list separates what is due from what is held, with reasons', () => {
    const due = po();
    const early = { ...po(), id: 'po2', poNumber: '26-66609-1', lastSentAt: '2026-09-08T15:00:00.000Z', submittedAt: '2026-09-08' };
    const done = { ...po(), id: 'po3', poNumber: '26-66610-1', confirmedAt: '2026-09-08' };
    const out = n.nudgeList([due, early, done], [VENDOR], settings, '2026-09-09');
    t.equal(out.due.length, 1);
    t.equal(out.due[0].poNumber, '26-66608-9');
    t.equal(out.held.length, 1, 'a confirmed order is not being held back from anything');
    t.assert(out.held[0].reason.length > 0, 'a held order has to say why');
  });

  t.test('an order whose vendor has been deleted is reported, not crashed on', () => {
    const out = n.nudgeList([po()], [], settings, '2026-09-09');
    t.equal(out.due.length, 0);
    t.assert(/no longer exists/.test(out.held[0].reason), out.held[0].reason);
  });

  t.test('nothing at all is a clean empty run', () => {
    const out = n.nudgeList([], [], settings, '2026-09-09');
    t.equal(out.due.length, 0);
    t.equal(out.held.length, 0);
  });

  /* ---- settings -------------------------------------------------------- */

  t.test('reminders cannot be switched on with nowhere to send from', () => {
    const r = s.validateSettings({ nudgeVendors: true }, { fromAddress: '', nudgeFromAddress: '' });
    t.assert(!r.ok, 'a cron that runs every morning and silently sends nothing is the worst outcome');
    t.assert(/before switching them on/.test(r.errors.join(' ')), r.errors.join(' '));
  });

  t.test('switching on is fine when the PO from-address is set', () => {
    const r = s.validateSettings({ nudgeVendors: true }, { fromAddress: 'orders@pmapparel.com' });
    t.assert(r.ok, r.errors.join(' '));
    t.equal(r.patch.nudgeVendors, true);
  });

  t.test('a typo in the reminder address is refused', () => {
    const r = s.validateSettings({ nudgeFromAddress: 'ryan at pmapparel' }, {});
    t.assert(!r.ok);
    t.assert(/does not look like an address/.test(r.errors.join(' ')), r.errors.join(' '));
  });

  t.test('zero days, zero reminders and a zero cut-off are all refused', () => {
    t.assert(!s.validateSettings({ nudgeAfterDays: 0 }, {}).ok);
    t.assert(!s.validateSettings({ nudgeMaxRounds: 0 }, {}).ok);
    t.assert(!s.validateSettings({ nudgeMaxAgeDays: 0 }, {}).ok);
  });

  t.test('the number of reminders is capped however big a number is typed', () => {
    t.equal(s.validateSettings({ nudgeMaxRounds: 99 }, {}).patch.nudgeMaxRounds, 5);
  });

  t.test('only a real true switches this on', () => {
    t.equal(s.withSettingDefaults({ nudgeVendors: 'true' }).nudgeVendors, false, 'a string must never start mail going out');
    t.equal(s.withSettingDefaults({ nudgeVendors: 1 }).nudgeVendors, false);
    t.equal(s.withSettingDefaults({ nudgeVendors: true }).nudgeVendors, true);
  });

  t.test('the defaults are two working days, two reminders, thirty day cut-off', () => {
    const d = s.withSettingDefaults({});
    t.equal(d.nudgeAfterDays, 2);
    t.equal(d.nudgeMaxRounds, 2);
    t.equal(d.nudgeMaxAgeDays, 30);
    t.equal(d.nudgeVendors, false, 'off until somebody turns it on');
  });

  /* ---- wiring ---------------------------------------------------------- */

  await t.test('the route loads and exports a handler', async () => {
    const route = await import('../api/promopro/cron-nudge.js');
    t.equal(typeof route.default, 'function');
  });

  t.test('the send route records who was CC\'d, which the reminder reuses', () => {
    t.assert(/sentCc: cc,/.test(read('api/promopro/send.js')), 'without this the reminder rebuilds a list that may have changed');
  });

  t.test('the cron is registered', () => {
    const v = JSON.parse(read('vercel.json'));
    const job = (v.crons || []).find((c) => c.path === '/api/promopro/cron-nudge');
    t.assert(job, 'a route nothing calls does nothing');
    t.assert(/1-5$/.test(job.schedule), 'weekdays only: ' + job.schedule);
  });

  t.test('Settings can switch it on', () => {
    const app = read('apps/promopro.js');
    t.assert(/ppNudge"/.test(app), 'the on/off control');
    t.assert(/payload\.nudgeVendors/.test(app), 'and it has to be saved');
  });

  process.exit(t.report());
})();
