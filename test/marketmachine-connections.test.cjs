// PUT IN: test/marketmachine-connections.test.cjs
/**
 * MarketMachine connections (Sept 2026, phase 2).
 *
 * A campaign points at TravelTrack trips, BackBone leads and Printavo invoice
 * numbers by id; MailMe emails point at the campaign. Everything is read live
 * and counted once. What is worth breaking a build over:
 *
 *   - the same invoice, lead, trip or expense on an event and its connected
 *     campaign is counted ONCE in the event's totals
 *   - money is read from TravelTrack, never copied, and rejected receipts are
 *     never counted as spent
 *   - a unique click rate with nothing delivered is a plain status, not 0%
 *   - a trip or lead has to exist in its own app before it can be connected
 *   - one app being down costs its own card, not the campaign page
 *   - a near-miss Printavo search result is never taken for the invoice
 *   - still Admin only
 *
 * Real function calls and real requests through the real route, against a
 * fake Upstash.
 */

const path = require('path');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

const kv = new Map();
let failApp = null; // a key prefix whose reads fail, to prove an outage stays contained
global.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  const get = u.match(/\/get\/(.+)$/);
  if (get) {
    const key = decodeURIComponent(get[1]);
    if (failApp && key.startsWith(failApp)) throw new Error('storage unreachable');
    return ok(kv.has(key) ? kv.get(key) : null);
  }
  const set = u.match(/\/set\/(.+)$/);
  if (set) { kv.set(decodeURIComponent(set[1]), opts && opts.body); return ok('OK'); }
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse((opts && opts.body) || '[]');
    const out = cmds.map(([op, key, val]) => {
      if (failApp && String(key).startsWith(failApp)) return { error: 'storage unreachable' };
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      return { result: null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return ok(null);
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-marketmachine-connections';

function seedUsers() {
  kv.set('alliteration:users', JSON.stringify({
    ryan:   { username: 'ryan', name: 'Ryan Toney', superuser: true, access: { apps: [] } },
    hannah: { username: 'hannah', name: 'Hannah Posey', access: { apps: ['mailme', 'marketmachine'], can_edit: true } },
  }));
}

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

const RYAN = { username: 'ryan', name: 'Ryan Toney' };
const HANNAH = { username: 'hannah', name: 'Hannah Posey' };
const SESSION = { username: 'ryan', name: 'Ryan Toney' };

(async () => {
  const cx = await import('../lib/marketmachine/connections.js');
  const store = await import('../lib/marketmachine/store.js');
  const tt = await import('../lib/traveltrack/store.js');
  const mailme = await import('../lib/mailme/store.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  const link = (c, kind, ref, at) => {
    const next = JSON.parse(JSON.stringify(c));
    const links = cx.linksOf(next);
    links[kind].push({ ref, at, by: 'test' });
    next.links = links;
    return next;
  };

  /* ================= linking rules ================= */

  t.test('connecting and disconnecting, with the history kept', () => {
    const c = { id: 'CP-00001', history: [] };
    const added = cx.applyLinkPatch(c, { kind: 'trips', ref: 'TR-0004' }, SESSION, true);
    t.assert(added.ok, 'a trip that exists connects');
    t.equal(cx.linksOf(added.campaign).trips[0].by, 'Ryan Toney', 'who connected it is stored');
    t.assert(/Connected trip TR-0004/.test(added.campaign.history[0].what), 'and it is in the history');
    t.equal(cx.linksOf(c).trips.length, 0, 'the input was not mutated');
    t.assert(!cx.applyLinkPatch(added.campaign, { kind: 'trips', ref: 'TR-0004' }, SESSION, true).ok, 'no duplicates');
    const removed = cx.applyLinkPatch(added.campaign, { kind: 'trips', ref: 'TR-0004', remove: true }, SESSION);
    t.equal(cx.linksOf(removed.campaign).trips.length, 0, 'disconnected');
    t.assert(!cx.applyLinkPatch(removed.campaign, { kind: 'trips', ref: 'TR-0004', remove: true }, SESSION).ok, 'removing twice is refused, not silent');
  });

  t.test('a trip or lead that does not exist is not connected', () => {
    const r = cx.applyLinkPatch({ id: 'CP-1' }, { kind: 'leads', ref: 'L-00099' }, SESSION, false);
    t.assert(!r.ok, 'refused');
    t.assert(/No lead L-00099/.test(r.errors[0]), 'and it says which: ' + r.errors[0]);
  });

  t.test('invoice numbers are cleaned and must be digits', () => {
    const ok = cx.applyLinkPatch({ id: 'CP-1' }, { kind: 'invoices', ref: ' #66608 ' }, SESSION);
    t.equal(cx.linksOf(ok.campaign).invoices[0].ref, '66608', 'a pasted "#66608" is stored as 66608');
    t.assert(!cx.applyLinkPatch({ id: 'CP-1' }, { kind: 'invoices', ref: '66608-9' }, SESSION).ok, 'an imprint number is not an invoice');
    t.assert(!cx.applyLinkPatch({ id: 'CP-1' }, { kind: 'pos', ref: '1' }, SESSION).ok, 'an unknown kind is refused');
  });

  /* ================= counted once ================= */

  const show = link(link(link({ id: 'CP-00001', name: 'ISS Long Beach' }, 'invoices', '70001', '2026-09-01'),
    'leads', 'lead-a', '2026-09-02'), 'trips', 'TR-0001', '2026-09-01');
  const postal = link(link(link({ id: 'CP-00002', name: 'Leftover mailer', parentId: 'CP-00001' }, 'invoices', '70001', '2026-09-05'),
    'leads', 'lead-a', '2026-09-01'), 'trips', 'TR-0001', '2026-09-06');
  const other = link({ id: 'CP-00009', name: 'Unrelated' }, 'invoices', '99999', '2026-09-01');
  const all = [show, postal, other];
  const scope = cx.scopeOf(show, all);

  t.test('an event covers itself and its connected campaigns, nothing else', () => {
    t.equal(scope.map((c) => c.id).join(','), 'CP-00001,CP-00002', 'the event and its child');
    t.equal(cx.scopeOf(postal, all).length, 1, 'a connected campaign covers only itself');
  });

  t.test('the same invoice on the event and its campaign counts once', () => {
    const inv = cx.invoiceTotals(scope);
    t.equal(inv.count, 1, 'one invoice, not two');
    t.assert(!inv.invoices.some((x) => x.ref === '99999'), 'an unrelated campaign is not rolled in');
  });

  t.test('a lead counts once, credited to the campaign that connected it first', () => {
    const leads = cx.leadTotals(scope, [{ lead_id: 'lead-a', lead_no: 'L-00007', company_name: 'Acme', status: 'Won' }]);
    t.equal(leads.count, 1, 'one lead');
    t.equal(leads.leads[0].primary, 'CP-00002', 'the Postal campaign connected it first');
    t.equal(leads.leads[0].assisting.join(','), 'CP-00001', 'the event assisted');
    t.equal(leads.won, 1, 'won is counted');
  });

  t.test('travel money is read from TravelTrack and counted once', () => {
    const trips = [{ id: 'TR-0001', title: 'Long Beach', start_date: '2027-01-14', status: 'confirmed' }];
    const expenses = [
      { id: 'EX-1', trip_id: 'TR-0001', amount: 0.1, status: 'approved' },
      { id: 'EX-2', trip_id: 'TR-0001', amount: 0.2, status: 'pending' },
      { id: 'EX-1', trip_id: 'TR-0001', amount: 0.1, status: 'approved' },  // the same receipt twice
      { id: 'EX-3', trip_id: 'TR-0001', amount: 500, status: 'rejected' },
      { id: 'EX-4', trip_id: 'TR-0002', amount: 900, status: 'approved' },  // another trip entirely
    ];
    const tr = cx.travelTotals(scope, trips, expenses);
    t.equal(tr.trips.length, 1, 'the trip on both campaigns is one trip');
    t.equal(tr.total, 0.3, 'pennies add exactly, the duplicate receipt counts once, rejected is not spent');
    t.equal(tr.rejected, 1, 'the rejected receipt is still counted as a receipt');
    t.equal(tr.receipts, 3, 'three distinct receipts on this trip');
    t.equal(tr.pending, 0.2, 'pending is separate');
    const gone = cx.travelTotals(scope, [], []);
    t.assert(gone.trips[0].missing, 'a trip deleted in TravelTrack is flagged, not dropped');
  });

  t.test('email results count each email once, and never say 0% of nothing', () => {
    const emails = [
      { id: 'MM-1', marketingCampaignId: 'CP-00001', status: 'sent', sentAt: 'x', stats: { delivered: 40, uniqueClicks: 3, uniqueOpens: 20, recipients: 42 } },
      { id: 'MM-2', marketingCampaignId: 'CP-00002', status: 'sent', sentAt: 'x', stats: { delivered: 40, uniqueClicks: 2 } },
      { id: 'MM-2', marketingCampaignId: 'CP-00002', status: 'sent', sentAt: 'x', stats: { delivered: 40, uniqueClicks: 2 } },
      { id: 'MM-3', marketingCampaignId: 'CP-00009', status: 'sent', stats: { delivered: 1000, uniqueClicks: 900 } },
    ];
    const em = cx.emailTotals(emails, scope);
    t.equal(em.count, 2, 'two distinct emails in scope');
    t.equal(em.delivered, 80, 'delivered counts each email once');
    t.equal(em.uniqueClickRate, 6.3, '5 unique clicks over 80 delivered');
    const drafts = cx.emailTotals([{ id: 'MM-4', marketingCampaignId: 'CP-00001', status: 'draft', stats: {} }], scope);
    t.equal(drafts.uniqueClickRate, null, 'no rate with nothing delivered');
    t.equal(drafts.rateStatus, 'Nothing delivered yet', 'a plain status instead');
    t.equal(cx.emailTotals([], scope).rateStatus, 'No emails attached', 'and a different one with no emails at all');
  });

  t.test('a near-miss Printavo result is never taken for the invoice', () => {
    const results = [
      { invoiceNumber: '66608', kind: 'invoice', status: 'Shipped' },
      { invoiceNumber: '6660', kind: 'quote', status: 'Quote' },
      { invoiceNumber: '6660', kind: 'invoice', status: 'In production' },
    ];
    t.equal(cx.matchPrintavo('6660', results).status, 'In production', 'the invoice beats the quote with the same number');
    t.equal(cx.matchPrintavo('666', results), null, 'nothing close counts');
  });

  /* ================= through the store and the route ================= */

  kv.clear();
  seedUsers();

  const trip = await tt.saveTrip({ title: 'ISS Long Beach', destination: 'Long Beach, CA', start_date: '2027-01-14', end_date: '2027-01-17', status: 'confirmed' });
  await tt.saveExpense({ trip_id: trip.id, amount: 412.5, status: 'approved', category: 'Lodging', date: '2027-01-14' });
  await tt.saveExpense({ trip_id: trip.id, amount: 88, status: 'rejected', category: 'Meals', date: '2027-01-15' });
  kv.set('backbone_leads', JSON.stringify({ leads: [
    { lead_id: 'lead-a', lead_no: 'L-00007', company_name: 'Acme Dental', status: 'Quoted', account_manager: 'Hannah' },
    { lead_id: 'lead-z', lead_no: 'L-00008', company_name: 'Closed Co', status: 'Lost', archived_at: '2026-01-01', archive_reason: 'Went elsewhere' },
  ] }));

  const ev = await call({ as: RYAN, method: 'POST', body: { type: 'trade_show', name: 'ISS Long Beach', controlDate: '2027-01-15' } });
  const child = await call({ as: RYAN, method: 'POST', body: { type: 'postal', parentId: ev.body.campaign.id } });
  const EV = ev.body.campaign.id;
  const CH = child.body.campaign.id;

  await t.test('connecting through the route checks the other app', async () => {
    const trip1 = await call({ as: RYAN, method: 'PATCH', query: { id: EV, connect: 1 }, body: { kind: 'trips', ref: trip.id } });
    t.equal(trip1.statusCode, 200, 'a real trip connects: ' + JSON.stringify(trip1.body));
    const fake = await call({ as: RYAN, method: 'PATCH', query: { id: EV, connect: 1 }, body: { kind: 'trips', ref: 'TR-9999' } });
    t.equal(fake.statusCode, 400, 'a trip TravelTrack does not have is refused');
    const lead = await call({ as: RYAN, method: 'PATCH', query: { id: CH, connect: 1 }, body: { kind: 'leads', ref: 'L-00007' } });
    t.equal(lead.statusCode, 200, 'a lead connects by its lead number too');
    await call({ as: RYAN, method: 'PATCH', query: { id: EV, connect: 1 }, body: { kind: 'invoices', ref: '70001' } });
    await call({ as: RYAN, method: 'PATCH', query: { id: CH, connect: 1 }, body: { kind: 'invoices', ref: '#70001' } });
  });

  await t.test('the options leave archived leads out', async () => {
    const res = await call({ as: RYAN, query: { options: 'connections' } });
    t.equal(res.statusCode, 200, 'answered');
    t.equal(res.body.trips.length, 1, 'the trip is offered');
    t.equal(res.body.leads.map((l) => l.leadNo).join(','), 'L-00007', 'the archived lead is not');
  });

  await t.test('the event page rolls everything up, counted once', async () => {
    const draft = await mailme.createCampaign({ marketingCampaignId: CH, marketingChannelId: 'email' }, SESSION);
    await mailme.applyCampaignPatch(draft.id, { status: 'sent', sentAt: '2027-01-20T15:00:00Z', stats: { delivered: 50, uniqueClicks: 5, uniqueOpens: 22 } });

    const res = await call({ as: RYAN, query: { id: EV } });
    const cn = res.body.connections;
    t.equal(cn.scope.length, 2, 'the event and its connected campaign');
    t.equal(cn.invoices.count, 1, 'invoice 70001 on both counts once');
    t.equal(cn.travel.total, 412.5, 'spent is TravelTrack\'s approved receipt, not the rejected one');
    t.equal(cn.leads.count, 1, 'the lead on the child shows on the event');
    t.equal(cn.email.count, 1, 'the email attached to the child shows on the event');
    t.equal(cn.email.uniqueClickRate, 10, '5 of 50');
  });

  await t.test('one app being down costs its own card, not the page', async () => {
    failApp = 'traveltrack';
    const res = await call({ as: RYAN, query: { id: EV } });
    failApp = null;
    t.equal(res.statusCode, 200, 'the campaign still opens');
    t.assert(res.body.connections.travel.unavailable, 'travel says unavailable');
    t.assert(!res.body.connections.leads.unavailable && res.body.connections.leads.count === 1, 'leads still show');
    t.equal(res.body.connections.invoices.count, 1, 'invoices still show');
  });

  await t.test('Printavo statuses are checked on demand, and an outage is not "not found"', async () => {
    const found = await store.invoiceStatuses(['70001', '70002'], async (n) => ({
      results: n === '70001' ? [{ invoiceNumber: '70001', kind: 'invoice', status: 'Shipped', total: 1234.5, customerName: 'Acme' }] : [],
    }));
    t.equal(found['70001'].status, 'Shipped', 'a match carries its status');
    t.equal(found['70002'].found, false, 'no match is not found');
    const down = await store.invoiceStatuses(['70001'], async () => { throw new Error('timeout'); });
    t.assert(down['70001'].unavailable && down['70001'].found === undefined, 'a timeout is unavailable, not missing');
    const many = await store.invoiceStatuses(Array.from({ length: 40 }, (_, i) => String(80000 + i)), async () => ({ results: [] }));
    t.equal(Object.keys(many).length, store.PRINTAVO_CHECK_LIMIT, 'a check is capped so it cannot hang the screen');
  });

  await t.test('connections are Admin only, like the rest', async () => {
    t.equal((await call({ as: HANNAH, query: { options: 'connections' } })).statusCode, 200, 'the bare list read is the only exception');
    const opts = await call({ as: HANNAH, query: { options: 'connections' } });
    t.assert(opts.body.limited && !opts.body.trips, 'and it carries no trips or leads');
    t.equal((await call({ as: HANNAH, method: 'PATCH', query: { id: EV, connect: 1 }, body: { kind: 'invoices', ref: '1' } })).statusCode, 403, 'cannot connect');
    t.equal((await call({ as: HANNAH, query: { id: EV, printavo: 1 } })).statusCode, 403, 'cannot check Printavo');
  });

  await t.test('disconnecting from the child leaves the event\'s own link', async () => {
    await call({ as: RYAN, method: 'PATCH', query: { id: CH, connect: 1 }, body: { kind: 'invoices', ref: '70001', remove: true } });
    const res = await call({ as: RYAN, query: { id: EV } });
    t.equal(res.body.connections.invoices.count, 1, 'still one: the event connected it too');
    t.equal(res.body.connections.invoices.invoices[0].primary, EV, 'now credited to the event');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
