// PUT IN: test/promopro-chase.test.cjs
// test/promopro-chase.test.cjs
/**
 * PromoPro: chasing, the product column, and did the email land.
 *
 * Three changes with one thing in common: each of them adds something to a
 * screen that could quietly say the wrong thing, and the wrong thing would
 * look exactly as confident as the right thing.
 *
 *   1. A LOGGED FOLLOW-UP MUST NOT STOP THE CLOCK. The silence clock measures
 *      how long the VENDOR has been quiet. Us ringing them does not make them
 *      less quiet. If logging a call turned a red order green it would drop
 *      off the pipeline with nothing resolved, which is the exact failure the
 *      app exists to end. This is the single most important assertion in the
 *      file and it is checked by calling poHealth() before and after.
 *
 *   2. THE FIRST SEND IS NOT A CHASE. It is the order. Counting it as one
 *      would put "chased today" on every PO the moment it went out, and a
 *      label that is always there tells nobody anything.
 *
 *   3. A DELIVERY STATE WE HAVE NO WORDING FOR MUST NOT VANISH. Resend adding
 *      an event we have not seen should surface as a strange word on one
 *      screen, not as silence that reads like nothing happened.
 *
 * Real function calls throughout. Grepping the source for a function name
 * proves the letters are there, not that the code runs.
 */

const t = require('./harness.cjs');

(async () => {
  const s = await import('../lib/promopro/schema.js');

  /* ---- logging a follow-up ------------------------------------------- */

  t.test('a follow-up needs to say how it happened', () => {
    t.equal(s.validateFollowUp({ note: 'left a message' }).ok, false);
    t.assert(s.validateFollowUp({ note: 'x' }).errors.join(' ').includes('how you followed up'));
  });

  t.test('a made-up method is refused by name', () => {
    const r = s.validateFollowUp({ method: 'carrier-pigeon' });
    t.equal(r.ok, false);
    t.assert(r.errors.join(' ').includes('carrier-pigeon'));
  });

  t.test('the note is optional, because "called them" is a fact on its own', () => {
    const r = s.validateFollowUp({ method: 'called' });
    t.equal(r.ok, true);
    t.equal(r.followUp.note, '');
  });

  t.test('every offered method validates', () => {
    s.FOLLOW_UP_METHODS.forEach((m) => {
      t.equal(s.validateFollowUp({ method: m.key }).ok, true);
    });
  });

  t.test('the entry records who, when and what in words', () => {
    const e = s.followUpEntry({ method: 'voicemail', note: 'asked for Dana' }, 'Ryan', '2026-09-09T15:00:00.000Z');
    t.equal(e.kind, 'followup');
    t.equal(e.by, 'ryan');                 // lowercased, like every other by
    t.equal(e.at, '2026-09-09T15:00:00.000Z');
    t.assert(e.what.includes('voicemail'));
    t.assert(e.what.includes('asked for Dana'));
  });

  /* ---- THE ONE THAT MATTERS ------------------------------------------ */

  t.test('logging a follow-up does not stop the silence clock', () => {
    const vendor = { id: 'v1', name: 'SanMar', responseDays: 3 };
    const po = { vendorId: 'v1', submittedAt: '2026-09-01' };
    const before = s.poHealth(po, vendor, '2026-09-12');
    t.equal(before.level, 'red');

    const chased = { ...po, lastFollowUpAt: '2026-09-11T09:00:00.000Z' };
    const after = s.poHealth(chased, vendor, '2026-09-12');

    t.equal(after.level, 'red');
    t.equal(after.reasons.join(' '), before.reasons.join(' '));
  });

  t.test('a re-send does not stop it either', () => {
    const vendor = { id: 'v1', responseDays: 3 };
    const po = { vendorId: 'v1', submittedAt: '2026-09-01', lastSentAt: '2026-09-11T09:00:00.000Z', sendCount: 2 };
    t.equal(s.poHealth(po, vendor, '2026-09-12').level, 'red');
  });

  t.test('a vendor REPLY still stops it, which is the difference', () => {
    const vendor = { id: 'v1', responseDays: 3 };
    const po = { vendorId: 'v1', submittedAt: '2026-09-01', lastVendorReplyAt: '2026-09-11T09:00:00.000Z' };
    t.equal(s.poHealth(po, vendor, '2026-09-12').level, 'ok');
  });

  /* ---- when was it last chased --------------------------------------- */

  t.test('never chased reads as null, not as a date', () => {
    t.equal(s.lastChasedAt({}), null);
    t.equal(s.chaseNote({}, '2026-09-09'), '');
  });

  t.test('the first send is the order, not a chase', () => {
    const po = { lastSentAt: '2026-09-08T10:00:00.000Z', sendCount: 1 };
    t.equal(s.lastChasedAt(po), null);
    t.equal(s.chaseNote(po, '2026-09-09'), '');
  });

  t.test('sending again is a chase', () => {
    const po = { lastSentAt: '2026-09-08T10:00:00.000Z', sendCount: 2 };
    t.equal(s.chaseNote(po, '2026-09-09'), 'chased yesterday');
  });

  t.test('the later of a logged call and a re-send wins', () => {
    const po = {
      lastSentAt: '2026-09-05T10:00:00.000Z', sendCount: 3,
      lastFollowUpAt: '2026-09-08T10:00:00.000Z',
    };
    t.equal(s.lastChasedAt(po), '2026-09-08T10:00:00.000Z');

    const older = {
      lastSentAt: '2026-09-08T10:00:00.000Z', sendCount: 3,
      lastFollowUpAt: '2026-09-05T10:00:00.000Z',
    };
    t.equal(s.lastChasedAt(older), '2026-09-08T10:00:00.000Z');
  });

  t.test('today and yesterday are said in words, older in days', () => {
    const at = (d) => ({ lastFollowUpAt: d + 'T10:00:00.000Z' });
    t.equal(s.chaseNote(at('2026-09-09'), '2026-09-09'), 'chased today');
    t.equal(s.chaseNote(at('2026-09-08'), '2026-09-09'), 'chased yesterday');
    t.equal(s.chaseNote(at('2026-09-02'), '2026-09-09'), 'chased 7 days ago');
  });

  /* ---- what is on the order ------------------------------------------ */

  t.test('one line shows its description with no count after it', () => {
    const r = s.productSummary({ lines: [{ description: 'PC55 Core Blend Tee' }] });
    t.equal(r.first, 'PC55 Core Blend Tee');
    t.equal(r.more, 0);
    t.equal(r.text, 'PC55 Core Blend Tee');
  });

  t.test('extra lines are counted, not concatenated', () => {
    const r = s.productSummary({ lines: [
      { description: 'PC55 Core Blend Tee' },
      { description: 'ST350 Sport-Tek Tee' },
      { description: 'F259 Hooded Sweatshirt' },
    ] });
    t.equal(r.first, 'PC55 Core Blend Tee');
    t.equal(r.more, 2);
    t.equal(r.text, 'PC55 Core Blend Tee +2 more');
  });

  t.test('an order with no lines draws a blank rather than a broken label', () => {
    t.equal(s.productSummary({ lines: [] }).text, '');
    t.equal(s.productSummary({}).text, '');
    t.equal(s.productSummary(null).text, '');
  });

  t.test('the count follows the LINES, not just the named ones', () => {
    // A blank description on line two is still a line on the order. Counting
    // only named lines would report "+1 more" on a three-line PO.
    const r = s.productSummary({ lines: [
      { description: 'PC55 Core Blend Tee' }, { description: '' }, { description: 'F259' },
    ] });
    t.equal(r.more, 2);
  });

  /* ---- did the email land -------------------------------------------- */

  t.test('a bounce is bad and says so in a sentence', () => {
    const st = s.deliveryState('bounced');
    t.equal(st.level, 'bad');
    t.assert(st.detail.length > 0);
  });

  t.test('resend prefixes are stripped so email.delivered reads as delivered', () => {
    t.equal(s.deliveryState('email.delivered').key, 'delivered');
    t.equal(s.deliveryState('DELIVERED').key, 'delivered');
    t.equal(s.deliveryState('delivery-delayed').key, 'delivery_delayed');
  });

  t.test('an unknown state surfaces as itself instead of disappearing', () => {
    const st = s.deliveryState('quarantined_by_martians');
    t.assert(st !== null);
    t.equal(st.key, 'quarantined_by_martians');
    t.assert(st.label.includes('martians'));
  });

  t.test('no status at all is null, which draws nothing', () => {
    t.equal(s.deliveryState(''), null);
    t.equal(s.deliveryState(null), null);
  });

  t.test('opened is treated as an open, delivered is not', () => {
    t.equal(s.openIsTrusted(s.deliveryState('opened')), true);
    t.equal(s.openIsTrusted(s.deliveryState('clicked')), true);
    t.equal(s.openIsTrusted(s.deliveryState('delivered')), false);
  });

  /* ---- when NOT to ask Resend ---------------------------------------- */

  t.test('an unsent order is not asked about, and says nothing about it', () => {
    const a = s.deliveryAsk({});
    t.equal(a.ask, false);
    t.equal(a.why, '');
  });

  t.test('outsourced work emails nobody, so there is nothing to look up', () => {
    t.equal(s.deliveryAsk({ outsourced: true, lastSentAt: '2026-09-01T10:00:00.000Z', lastMessageId: 'x' }).ask, false);
  });

  t.test('a send from before we recorded ids explains itself', () => {
    const a = s.deliveryAsk({ lastSentAt: '2026-08-01T10:00:00.000Z' });
    t.equal(a.ask, false);
    t.assert(a.why.includes('before we started recording'));
  });

  t.test('a real send with an id is worth asking about', () => {
    t.equal(s.deliveryAsk({ lastSentAt: '2026-09-08T10:00:00.000Z', lastMessageId: 're_abc123' }).ask, true);
  });

  /* ---- the route actually loads and is wired ------------------------- */

  await t.test('the delivery route loads and exports a handler', async () => {
    const mod = await import('../api/promopro/delivery.js');
    t.equal(typeof mod.default, 'function');
  });

  await t.test('the seam knows the delivery endpoint', async () => {
    const { ENDPOINTS } = await import('../js/api.js');
    t.equal(ENDPOINTS.ppDelivery, '/api/promopro/delivery');
  });

  await t.test('the status reader never throws on a missing id', async () => {
    const { getEmailStatus } = await import('../lib/mailme/resend-client.js');
    const r = await getEmailStatus('');
    t.equal(r.ok, false);
    t.assert(r.error.length > 0);
  });
})();
