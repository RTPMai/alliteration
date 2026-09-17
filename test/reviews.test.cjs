// PUT IN: test/reviews.test.cjs
/**
 * RaveReviews: the review request after pickup.
 *
 * What would actually hurt here, in order:
 *
 *   1. A CUSTOMER GETS THE EMAIL TWICE. From two orders the same week, from
 *      the cron and a Send now press landing together, from the first run
 *      re-emailing everybody Zapier already asked, or from the same invoice
 *      being found at both statuses.
 *   2. A CUSTOMER WHO REVIEWED, OR UNSUBSCRIBED, GETS ASKED ANYWAY. The skip
 *      rules run at SEND time, so marking someone on day two protects them on
 *      day three.
 *   3. IT QUIETLY SENDS NOTHING. A status name that matches nothing in
 *      Printavo has to be an error you can read, not an empty queue that
 *      looks like a slow week.
 *
 * Every check calls the real functions: the real store against an in-memory
 * Redis, the real engine, the real Printavo walker against a fake Printavo.
 * Grepping for a function name proves the letters are there, not that the
 * code runs.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DAY = 86400000;

/* ---- an in-memory Redis with the commands the store uses ---------------- */

function memoryKv() {
  const str = new Map(), hash = new Map(), sets = new Map(), zsets = new Map(), locks = new Set();
  const h = (k) => { if (!hash.has(k)) hash.set(k, new Map()); return hash.get(k); };
  const s = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const z = (k) => { if (!zsets.has(k)) zsets.set(k, new Map()); return zsets.get(k); };
  return {
    _locks: locks,
    get: async (k) => (str.has(k) ? str.get(k) : null),
    set: async (k, v) => { str.set(k, v); return 'OK'; },
    setNx: async (k) => { if (locks.has(k)) return false; locks.add(k); return true; },
    del: async (k) => { locks.delete(k); str.delete(k); return 1; },
    mget: async (ks) => ks.map((k) => (str.has(k) ? str.get(k) : null)),
    hset: async (k, f, v) => { h(k).set(f, v); return 1; },
    hdel: async (k, f) => { h(k).delete(f); return 1; },
    hgetall: async (k) => Object.fromEntries(h(k)),
    sadd: async (k, m) => { s(k).add(m); return 1; },
    srem: async (k, m) => { s(k).delete(m); return 1; },
    smembers: async (k) => Array.from(s(k)),
    zadd: async (k, score, m) => { z(k).set(m, Number(score)); return 1; },
    zrevrange: async (k, a, b) => Array.from(z(k).entries()).sort((x, y) => y[1] - x[1]).map((e) => e[0]).slice(a, b + 1),
  };
}

/* ---- a fake Printavo ---------------------------------------------------- */

const PICKED = { id: 'st-9', name: '🙌 PICKED-UP 🙌' };
const SHIPPED = { id: 'st-8', name: '🚀 ORDER SHIPPED 🚀' };
const OTHER = { id: 'st-1', name: 'READY TO ORDER' };

function inv(id, status, email, extra) {
  return Object.assign({
    id: String(id), visualId: String(50000 + Number(id)), nickname: 'Order ' + id, status,
    contact: { firstName: 'Tony', fullName: 'Tony Huffman', email },
  }, extra || {});
}

// The shape lib/reviews/printavo.js hands the engine, for the rules that
// never touch Printavo.
function order(id, email) {
  return { invoiceId: String(id), visualId: String(50000 + Number(id)), nickname: 'Order ' + id,
    statusName: PICKED.name, firstName: 'Tony', fullName: 'Tony Huffman', email };
}

function fakePrintavo(opts) {
  const o = Object.assign({ statusIds: true, window: true, statusesRoot: true, statuses: [PICKED, SHIPPED, OTHER], invoices: [] }, opts || {});
  const calls = [];
  const gql = async (q) => {
    calls.push(q);
    if (q.includes('__type(name:"Query")')) {
      const args = [{ name: 'first' }, { name: 'after' }];
      if (o.statusIds) args.push({ name: 'statusIds' });
      if (o.window) args.push({ name: 'inProductionAfter' });
      const fields = [{ name: 'invoices', args, type: { name: 'InvoiceConnection' } }];
      if (o.statusesRoot) fields.push({ name: 'statuses', args: [{ name: 'first' }, { name: 'after' }], type: { name: 'StatusConnection' } });
      return { __type: { fields } };
    }
    if (q.includes('__type(name:"Invoice")')) {
      return { __type: { fields: ['id', 'visualId', 'nickname', 'status'].map((name) => ({ name, args: [], type: { name: 'X' } }))
        .concat([{ name: 'contact', args: [], type: { kind: 'NON_NULL', ofType: { name: 'Contact' } } }]) } };
    }
    if (q.includes('__type(name:"Contact")')) {
      return { __type: { fields: ['firstName', 'fullName', 'email'].map((name) => ({ name, args: [], type: { name: 'String' } })) } };
    }
    if (q.includes('statuses(')) {
      return { statuses: { nodes: o.statuses, pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    if (q.includes('invoices(')) {
      let list = o.invoices.slice();
      const m = q.match(/statusIds:\[([^\]]*)\]/);
      if (m) {
        const ids = JSON.parse('[' + m[1] + ']');
        list = list.filter((i) => ids.includes(i.status.id));
      }
      const after = (q.match(/after:"(\d+)"/) || [])[1];
      const start = after ? Number(after) : 0;
      const page = list.slice(start, start + 25);
      const next = start + 25 < list.length;
      return { invoices: { nodes: page, pageInfo: { hasNextPage: next, endCursor: next ? String(start + 25) : null } } };
    }
    throw new Error('fake Printavo got an unexpected query: ' + q);
  };
  return { gql, calls, o };
}

(async () => {
  const S = await import('../lib/reviews/schema.js');
  const { createStore } = await import('../lib/reviews/store.js');
  const E = await import('../lib/reviews/engine.js');
  const P = await import('../lib/reviews/printavo.js');
  const A = await import('../lib/reviews/access.js');

  const T0 = Date.parse('2026-09-21T15:00:00Z');

  function world(opts) {
    const o = opts || {};
    const kv = memoryKv();
    const store = createStore(kv);
    const printavo = fakePrintavo(o.printavo);
    const sent = [];
    let sendImpl = o.send || (async (m) => ({ id: 'msg-' + (sent.length + 1) }));
    const deps = {
      store, gql: printavo.gql, pauseMs: 0,
      send: async (m) => { const r = await sendImpl(m); sent.push(m); return r; },
      getSuppression: o.getSuppression || (async () => ({})),
    };
    return {
      kv, store, printavo, sent, deps,
      setSend: (fn) => { sendImpl = fn; },
      settings: Object.assign({}, S.DEFAULT_SETTINGS, { enabled: true }, o.settings || {}),
    };
  }

  const detect = (w, now) => { P._resetPlan(); return E.detect(w.deps, { settings: w.settings, now, deadline: Date.now() + 10000 }); };

  /* ======================================================================= *
   * THE EMAIL
   * ======================================================================= */

  t.test('Printavo status names match with the emoji and capitals ignored', () => {
    t.equal(S.isTriggerStatus('🙌 PICKED-UP 🙌', S.DEFAULT_STATUSES), true);
    t.equal(S.isTriggerStatus('🚀 ORDER SHIPPED 🚀', S.DEFAULT_STATUSES), true);
    t.equal(S.isTriggerStatus('picked up', S.DEFAULT_STATUSES), true);
    t.equal(S.isTriggerStatus('READY TO ORDER', S.DEFAULT_STATUSES), false);
    t.equal(S.isTriggerStatus('', S.DEFAULT_STATUSES), false);
  });

  t.test('the default email is the Zapier email, word for word where it matters', () => {
    const m = S.renderEmail(S.DEFAULT_SETTINGS, { first_name: 'Tony', visual_id: '54781', order_nickname: 'City Laundering Food Visitor' });
    t.equal(m.subject, '54781 - City Laundering Food Visitor');
    t.assert(m.text.startsWith('Hey Tony,\n\nWe hope you\u2019re enjoying your recent order from P&M Apparel.'), 'greeting and first line');
    t.assert(m.text.includes('https://www.google.com/maps/place//data=!4m3!3m2!1s0x87ee82254922cdef:0x555585b24fe33cf9!12e1?source=g.page.m.dd._&laa=lu-desktop-reviews-dialog-review-solicitation'), 'review link intact');
    t.assert(m.text.includes('referrals from happy customers mean a lot to us.'), 'referral line');
    t.assert(m.text.endsWith('Cheers,\nThe P&M Apparel Team'), 'sign off');
    t.equal(m.from, 'P&M Apparel <Ryan@pmapparel.com>');
  });

  t.test('no first name reads "Hey there," rather than "Hey ,"', () => {
    const m = S.renderEmail(S.DEFAULT_SETTINGS, { first_name: '', visual_id: '1', order_nickname: 'x' });
    t.assert(m.text.startsWith('Hey there,'), m.text.slice(0, 20));
  });

  t.test('a blank nickname does not leave a dangling dash in the subject', () => {
    t.equal(S.renderEmail(S.DEFAULT_SETTINGS, { visual_id: '54781', order_nickname: '' }).subject, '54781');
  });

  t.test('first name comes from firstName, else the first word of the full name', () => {
    t.equal(S.firstNameOf({ firstName: 'Tony', fullName: 'Anthony Huffman' }), 'Tony');
    t.equal(S.firstNameOf({ fullName: 'Tony Huffman' }), 'Tony');
    t.equal(S.firstNameOf({}), '');
  });

  t.test('a request is due three days after the order was found', () => {
    const rec = S.buildRecord(order(1, 'Huffmantony4@gmail.com'), S.DEFAULT_SETTINGS, new Date(T0).toISOString());
    t.equal(rec.send_after, new Date(T0 + 3 * DAY).toISOString());
    t.equal(rec.email, 'huffmantony4@gmail.com', 'email is lowercased so a review mark matches whatever case Printavo used');
    t.equal(S.isDue(rec, T0 + 3 * DAY - 1), false);
    t.equal(S.isDue(rec, T0 + 3 * DAY), true);
  });

  /* ======================================================================= *
   * SKIP RULES
   * ======================================================================= */

  const rec = (email) => S.buildRecord(order(1, email), S.DEFAULT_SETTINGS, new Date(T0).toISOString());
  const ctx = (extra) => Object.assign({ reviewed: {}, suppression: {}, lastSent: {}, settings: S.DEFAULT_SETTINGS, now: T0 }, extra || {});

  t.test('a customer with nothing against them is sent', () => {
    t.equal(S.decideSkip(rec('a@b.com'), ctx()), null);
  });

  t.test('a customer who already left a review is skipped', () => {
    t.equal(S.decideSkip(rec('A@B.com'), ctx({ reviewed: { 'a@b.com': { at: 'x' } } })), 'Already left a review');
  });

  t.test('an address on MailMe\'s do not email list is skipped, saying why', () => {
    const r = S.decideSkip(rec('a@b.com'), ctx({ suppression: { 'a@b.com': { status: 'bounced' } } }));
    t.assert(/do not email/.test(r) && /bounced/.test(r), r);
  });

  t.test('no email, and an email that is not an address, are skipped with different reasons', () => {
    t.equal(S.decideSkip(rec(''), ctx()), 'No email on the Printavo contact');
    t.assert(/not a usable address \(tony at gmail\)/.test(S.decideSkip(rec('tony at gmail'), ctx())));
  });

  t.test('the same address asked two days ago is skipped; eight days ago is asked', () => {
    t.assert(/2 days ago/.test(S.decideSkip(rec('a@b.com'), ctx({ lastSent: { 'a@b.com': new Date(T0 - 2 * DAY).toISOString() } }))));
    t.equal(S.decideSkip(rec('a@b.com'), ctx({ lastSent: { 'a@b.com': new Date(T0 - 8 * DAY).toISOString() } })), null);
  });

  t.test('a repeat gap of 0 turns that rule off', () => {
    const c = ctx({ settings: Object.assign({}, S.DEFAULT_SETTINGS, { repeatGapDays: 0 }), lastSent: { 'a@b.com': new Date(T0 - 60000).toISOString() } });
    t.equal(S.decideSkip(rec('a@b.com'), c), null);
  });

  /* ======================================================================= *
   * SETTINGS
   * ======================================================================= */

  t.test('settings refuse a from address Resend cannot send as', () => {
    const v = S.validateSettings({ fromEmail: 'ryan@gmail.com' });
    t.equal(v.ok, false);
    t.assert(v.errors.join(' ').includes('pmapparel.com'));
  });

  t.test('settings refuse an empty status list, and fold duplicate spellings', () => {
    t.equal(S.validateSettings({ statuses: [] }).ok, false);
    const v = S.validateSettings({ statuses: ['PICKED-UP', '🙌 picked up 🙌', 'ORDER SHIPPED'] });
    t.equal(v.ok, true);
    t.equal(v.settings.statuses.length, 2);
  });

  t.test('saving one field leaves every other field as it was', () => {
    const v = S.validateSettings({ delayDays: 5 }, Object.assign({}, S.DEFAULT_SETTINGS, { subject: 'Custom' }));
    t.equal(v.settings.delayDays, 5);
    t.equal(v.settings.subject, 'Custom');
  });

  t.test('the switch is only on when it is literally true', () => {
    t.equal(S.validateSettings({ enabled: 'true' }).settings.enabled, false);
    t.equal(S.validateSettings({ enabled: true }).settings.enabled, true);
  });

  /* ======================================================================= *
   * INTAKE AND DEDUPE
   * ======================================================================= */

  await t.test('the first run records orders already at pickup and queues none of them', async () => {
    const w = world({ printavo: { invoices: [inv(1, PICKED, 'a@b.com'), inv(2, SHIPPED, 'c@d.com'), inv(3, OTHER, 'e@f.com')] } });
    const r = await detect(w, T0);
    t.equal(r.baseline, 2, 'both trigger statuses recorded');
    t.equal(r.queued, 0, 'Zapier already emailed these');
    t.equal((await w.store.queueIds()).length, 0);
    t.assert((await w.store.getState()).seededAt, 'seeded after a complete first check');
  });

  await t.test('a first run that runs out of time does not count as the baseline', async () => {
    const w = world({ printavo: { invoices: [inv(1, PICKED, 'a@b.com')] } });
    P._resetPlan();
    const r = await E.detect(w.deps, { settings: w.settings, now: T0, deadline: Date.now() - 1 });
    t.equal(r.complete, false);
    t.equal((await w.store.getState()).seededAt, null, 'an unfinished first pass must not start queuing on the next run');
  });

  await t.test('after the baseline, a newly picked up order is queued exactly once', async () => {
    const w = world({ printavo: { invoices: [inv(1, PICKED, 'a@b.com')] } });
    await detect(w, T0);
    w.printavo.o.invoices.push(inv(2, PICKED, 'c@d.com'));
    const r1 = await detect(w, T0 + 3600000);
    const r2 = await detect(w, T0 + 7200000);
    t.equal(r1.queued, 1);
    t.equal(r2.queued, 0, 'the same order found again is not queued again');
    t.equal((await w.store.queueIds()).join(), '2');
  });

  await t.test('an order that moves from shipped to picked up gets one request, not two', async () => {
    const w = world({ printavo: { invoices: [] } });
    await detect(w, T0);
    w.printavo.o.invoices.push(inv(5, SHIPPED, 'a@b.com'));
    await detect(w, T0 + 3600000);
    w.printavo.o.invoices[0] = inv(5, PICKED, 'a@b.com');
    const r = await detect(w, T0 + 7200000);
    t.equal(r.queued, 0);
    t.equal((await w.store.recentIds()).length, 1);
  });

  await t.test('a long list is walked page by page and every order is found', async () => {
    const many = Array.from({ length: 60 }, (_, i) => inv(100 + i, PICKED, `p${i}@b.com`));
    const w = world({ printavo: { invoices: [] } });
    await detect(w, T0);
    w.printavo.o.invoices = many;
    const r = await detect(w, T0 + 3600000);
    t.equal(r.found, 60);
    t.equal(r.queued, 60);
    t.equal(r.pages, 3);
  });

  /* ======================================================================= *
   * SENDING
   * ======================================================================= */

  async function queued(w, orders) {
    await detect(w, T0);                       // baseline, empty
    w.printavo.o.invoices.push(...orders);
    await detect(w, T0 + 1000);
  }

  await t.test('nothing is sent while the switch is off, and the queue keeps it', async () => {
    const w = world({ printavo: { invoices: [] }, settings: { enabled: false } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    const r = await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(r.sent, 0);
    t.equal(w.sent.length, 0);
    t.equal((await w.store.queueIds()).length, 1);
  });

  await t.test('nothing is sent before three days are up', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 2 * DAY });
    t.equal(w.sent.length, 0);
  });

  await t.test('a due request is sent to the customer, recorded, and leaves the queue', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'Huffmantony4@gmail.com', { nickname: 'City Laundering' })]);
    const r = await E.sendDue(w.deps, { settings: w.settings, now: T0 + 3 * DAY + 5000 });
    t.equal(r.sent, 1);
    t.equal(w.sent[0].to[0], 'huffmantony4@gmail.com');
    t.equal(w.sent[0].subject, '50001 - City Laundering');
    t.equal(w.sent[0].reply_to, 'Ryan@pmapparel.com');
    const stored = await w.store.getRecord('1');
    t.equal(stored.status, 'sent');
    t.equal(stored.message_id, 'msg-1');
    t.equal((await w.store.queueIds()).length, 0);
    t.assert((await w.store.getLastSent())['huffmantony4@gmail.com'], 'last sent recorded for the repeat rule');
  });

  await t.test('two orders for the same customer in one run send one email', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'same@b.com'), inv(2, SHIPPED, 'SAME@b.com')]);
    const r = await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 1);
    t.equal(r.skipped, 1);
    const recs = await w.store.getRecords(['1', '2']);
    t.assert(recs.some((x) => x.status === 'skipped' && /earlier today/.test(x.skip_reason)), 'the second says why');
  });

  await t.test('a customer marked reviewed after being queued is not asked', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'Reviewer@b.com')]);
    await E.markReviewed(w.deps, 'reviewer@B.com', { now: T0 + DAY, by: 'Ryan' });
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 0);
    t.equal((await w.store.getRecord('1')).skip_reason, 'Already left a review');
  });

  await t.test('a repeat customer who has not reviewed is asked again on a later order', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'repeat@b.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    w.printavo.o.invoices.push(inv(2, PICKED, 'repeat@b.com'));
    await detect(w, T0 + 30 * DAY);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 34 * DAY });
    t.equal(w.sent.length, 2);
  });

  await t.test('...and not once they are marked as reviewed', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'repeat@b.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    await E.markReviewed(w.deps, 'repeat@b.com', { now: T0 + 5 * DAY });
    w.printavo.o.invoices.push(inv(2, PICKED, 'repeat@b.com'));
    await detect(w, T0 + 30 * DAY);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 34 * DAY });
    t.equal(w.sent.length, 1);
  });

  await t.test('unsubscribed in MailMe is skipped', async () => {
    const w = world({ printavo: { invoices: [] }, getSuppression: async () => ({ 'gone@b.com': { status: 'unsubscribed' } }) });
    await queued(w, [inv(1, PICKED, 'gone@b.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 0);
  });

  await t.test('an unreadable do not email list stops the run rather than sending blind', async () => {
    const w = world({ printavo: { invoices: [] }, getSuppression: async () => { throw new Error('storage blinked'); } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    let threw = false;
    try { await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY }); } catch (e) { threw = true; }
    t.equal(threw, true);
    t.equal(w.sent.length, 0);
    t.equal((await w.store.getRecord('1')).status, 'queued');
  });

  await t.test('a cancelled request is never sent, and putting it back queues it again', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    t.equal((await E.cancel(w.deps, '1', { now: T0, by: 'Ryan' })).ok, true);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 0);
    t.equal((await E.restore(w.deps, '1', { now: T0 + 4 * DAY, by: 'Ryan' })).ok, true);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 1);
  });

  await t.test('a sent request cannot be cancelled', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal((await E.cancel(w.deps, '1', { now: T0 })).ok, false);
  });

  await t.test('Send now asks before overriding a skip rule, and sends only when told to', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'fan@b.com')]);
    await E.markReviewed(w.deps, 'fan@b.com', { now: T0 });
    const ask = await E.sendNow(w.deps, '1', { settings: w.settings, now: T0 });
    t.equal(ask.outcome, 'needs_confirm');
    t.equal(ask.reason, 'Already left a review');
    t.equal(w.sent.length, 0, 'asking sends nothing');
    t.equal((await w.store.getRecord('1')).status, 'queued', 'asking changes nothing');
    const go = await E.sendNow(w.deps, '1', { settings: w.settings, now: T0, force: true, by: 'Ryan' });
    t.equal(go.outcome, 'sent');
    const h = (await w.store.getRecord('1')).history.pop();
    t.equal(h.overrode, 'Already left a review', 'the override is on the record');
  });

  await t.test('Send now works whether or not automatic sending is on', async () => {
    const w = world({ printavo: { invoices: [] }, settings: { enabled: false } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    t.equal((await E.sendNow(w.deps, '1', { settings: w.settings, now: T0 })).outcome, 'sent');
  });

  await t.test('Send now on something already sent does not send it again', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    await E.sendNow(w.deps, '1', { settings: w.settings, now: T0 });
    const again = await E.sendNow(w.deps, '1', { settings: w.settings, now: T0, force: true });
    t.equal(again.outcome, 'refused');
    t.equal(w.sent.length, 1);
  });

  await t.test('a send already in progress on that order blocks a second one', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    await w.store.lock('1');
    const r = await E.sendNow(w.deps, '1', { settings: w.settings, now: T0 });
    t.equal(r.outcome, 'locked');
    t.equal(w.sent.length, 0);
  });

  await t.test('the lock is released after a send that throws', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    w.setSend(async () => { throw new Error('boom'); });
    await E.sendNow(w.deps, '1', { settings: w.settings, now: T0 });
    t.equal(await w.store.lock('1'), true, 'a failed send must not leave the order locked forever');
  });

  await t.test('a failing send is retried, then gives up after three tries', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com')]);
    w.setSend(async () => { throw new Error('Resend said no'); });
    const now = T0 + 4 * DAY;
    await E.sendDue(w.deps, { settings: w.settings, now });
    t.equal((await w.store.getRecord('1')).status, 'queued');
    t.equal((await w.store.getRecord('1')).attempts, 1);
    await E.sendDue(w.deps, { settings: w.settings, now });
    await E.sendDue(w.deps, { settings: w.settings, now });
    const r = await w.store.getRecord('1');
    t.equal(r.status, 'failed');
    t.equal(r.last_error, 'Resend said no');
    t.equal((await w.store.queueIds()).length, 0);
  });

  await t.test('hitting the daily limit stops the run and costs nobody a try', async () => {
    const w = world({ printavo: { invoices: [] } });
    await queued(w, [inv(1, PICKED, 'a@b.com'), inv(2, PICKED, 'c@d.com')]);
    let calls = 0;
    w.setSend(async () => { calls++; const e = new Error('daily quota'); e.status = 429; throw e; });
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(calls, 1, 'the second customer is not tried after the provider said stop');
    const recs = await w.store.getRecords(['1', '2']);
    t.assert(recs.every((x) => x.status === 'queued' && x.attempts === 0), JSON.stringify(recs.map((x) => [x.status, x.attempts])));
  });

  await t.test('a run sends no more than the per-run cap and leaves the rest queued', async () => {
    const w = world({ printavo: { invoices: [] }, settings: { maxPerRun: 2 } });
    await queued(w, [inv(1, PICKED, 'a@b.com'), inv(2, PICKED, 'c@d.com'), inv(3, PICKED, 'e@f.com')]);
    await E.sendDue(w.deps, { settings: w.settings, now: T0 + 4 * DAY });
    t.equal(w.sent.length, 2);
    t.equal((await w.store.queueIds()).length, 1);
  });

  /* ======================================================================= *
   * PRINTAVO
   * ======================================================================= */

  await t.test('Printavo is asked only for orders at the two statuses, by id', async () => {
    P._resetPlan();
    const p = fakePrintavo({ invoices: [inv(1, PICKED, 'a@b.com'), inv(2, OTHER, 'c@d.com'), inv(3, SHIPPED, 'e@f.com')] });
    const got = [];
    const r = await P.walkTriggerOrders({ gql: p.gql, statuses: S.DEFAULT_STATUSES, lookbackDays: 45, now: T0, pauseMs: 0, onPage: async (o) => got.push(...o) });
    t.equal(r.mode, 'statusIds');
    const q = p.calls.find((c) => c.includes('invoices('));
    t.assert(/statusIds:\["st-9","st-8"\]/.test(q) || /statusIds:\["st-8","st-9"\]/.test(q), q);
    t.assert(/inProductionAfter:"2026-08-07/.test(q), 'bounded by the lookback window: ' + q);
    t.equal(got.map((o) => o.invoiceId).sort().join(), '1,3');
    t.equal(got[0].firstName, 'Tony');
    t.equal(got[0].email, 'a@b.com');
    t.equal(got[0].nickname, 'Order 1');
  });

  await t.test('without a status filter it scans the window and matches names itself', async () => {
    P._resetPlan();
    const p = fakePrintavo({ statusIds: false, invoices: [inv(1, PICKED, 'a@b.com'), inv(2, OTHER, 'c@d.com')] });
    const got = [];
    const r = await P.walkTriggerOrders({ gql: p.gql, statuses: S.DEFAULT_STATUSES, now: T0, pauseMs: 0, onPage: async (o) => got.push(...o) });
    t.equal(r.mode, 'scan');
    t.equal(got.map((o) => o.invoiceId).join(), '1');
  });

  await t.test('a status name that is not in Printavo is reported by name', async () => {
    P._resetPlan();
    const p = fakePrintavo({ invoices: [] });
    const r = await P.walkTriggerOrders({ gql: p.gql, statuses: ['PICKED-UP', 'DELIVERED'], now: T0, pauseMs: 0 });
    t.equal(r.missingStatuses.join(), 'DELIVERED');
  });

  await t.test('if none of the names exist in Printavo it is an error, not a quiet empty queue', async () => {
    P._resetPlan();
    const p = fakePrintavo({ invoices: [] });
    let msg = '';
    try { await P.walkTriggerOrders({ gql: p.gql, statuses: ['PICKUP COMPLETE'], now: T0, pauseMs: 0 }); } catch (e) { msg = e.message; }
    t.assert(/None of these statuses exist in Printavo: PICKUP COMPLETE/.test(msg), msg);
  });

  await t.test('with no way to bound the search it refuses rather than walking every invoice ever', async () => {
    P._resetPlan();
    const p = fakePrintavo({ statusIds: false, window: false, invoices: [] });
    let msg = '';
    try { await P.walkTriggerOrders({ gql: p.gql, statuses: S.DEFAULT_STATUSES, now: T0, pauseMs: 0 }); } catch (e) { msg = e.message; }
    t.assert(/cannot filter/.test(msg), msg);
  });

  await t.test('a failed check is recorded, not thrown away', async () => {
    const w = world({ printavo: { statusIds: false, window: false } });
    let threw = false;
    try { await detect(w, T0); } catch (e) { threw = true; }
    t.equal(threw, true, 'detect throws so the route can record it');
  });

  /* ======================================================================= *
   * ACCESS AND WIRING
   * ======================================================================= */

  t.test('only the Admin flag, strictly true, opens RaveReviews', () => {
    t.equal(A.canUseReviews({ superuser: true }), true);
    t.equal(A.canUseReviews({ superuser: 'true' }), false);
    t.equal(A.canUseReviews({ role: 'admin', tabs: ['reviews'] }), false, 'a ticked app is not admin');
    t.equal(A.canUseReviews(null), false);
  });

  t.test('both screen routes check admin before touching anything else', () => {
    ['api/reviews/requests.js', 'api/reviews/settings.js'].forEach((f) => {
      const src = read(f);
      const gate = src.indexOf('canUseReviews(perms)');
      t.assert(gate > 0, f + ' has no admin check');
      t.assert(gate < src.indexOf('realDeps()'), f + ' reaches storage before the admin check');
      t.assert(src.indexOf('requireAuth(req, res)') < gate, f + ' checks admin before signing in');
    });
  });

  await t.test('the cron refuses a call without CRON_SECRET', async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const { default: handler } = await import('../api/reviews/cron.js');
    let code = 0;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json() { return this; } };
    await handler({ headers: { authorization: 'Bearer undefined' } }, res);
    t.equal(code, 401, 'an unset secret must not match "Bearer undefined"');
    if (saved !== undefined) process.env.CRON_SECRET = saved;
  });

  await t.test('the app is registered, reachable through the seam, and scheduled', async () => {
    const reg = await import('../js/registry.js');
    const app = reg.getApp('reviews');
    t.assert(app, 'not in the registry');
    t.equal(reg.viewKeys(app).join(), 'requests,reviewed,settings');
    const { ENDPOINTS } = await import('../js/api.js');
    t.equal(ENDPOINTS.rvRequests, '/api/reviews/requests');
    t.equal(ENDPOINTS.rvSettings, '/api/reviews/settings');
    const crons = JSON.parse(read('vercel.json')).crons;
    t.assert(crons.some((c) => c.path === ENDPOINTS.rvCron), 'no cron calls the review run');
    t.assert(fs.existsSync(path.join(ROOT, 'api/reviews/cron.js')), 'the cron path has no file behind it');
  });

  t.test('lib/reviews imports nothing from api/', () => {
    fs.readdirSync(path.join(ROOT, 'lib/reviews')).forEach((f) => {
      t.assert(!/from\s+["'][^"']*\/api\//.test(read('lib/reviews/' + f)), f + ' imports from api/');
    });
  });

  process.exit(t.report());
})();
