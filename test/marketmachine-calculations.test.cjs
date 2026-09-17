// PUT IN: test/marketmachine-calculations.test.cjs
/**
 * MarketMachine calculations (Sept 2026, phase 3).
 *
 * The five formulas from Jacob's handoff, section 7. What is worth breaking a
 * build over:
 *   - each formula computes exactly what the handoff writes
 *   - missing data, a zero denominator, or an app that did not answer reads as
 *     words, never as a number
 *   - a typed zero is a real zero; a blank is unknown, and never becomes zero
 *   - connected leads replace the typed estimate, and say so
 *   - TravelTrack receipts flow into actual expense without being typed again
 *   - still Admin only
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
  const k = await import('../lib/marketmachine/calculations.js');
  const tt = await import('../lib/traveltrack/store.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  const NOW = '2026-09-17T15:00:00.000Z';
  const typed = (inputs) => ({ calc: { inputs: Object.fromEntries(Object.entries(inputs).map(([key, value], i) =>
    [key, { value, source: 'Apparelytics', by: 'Ryan Toney', at: `2026-09-1${i}T12:00:00.000Z` }])) } });
  const calc = (campaign, conn, strategic) => Object.fromEntries(
    k.computeCalculations(campaign, conn || { leads: { count: 0 }, travel: { total: 0, trips: [] } }, { now: NOW, strategic })
      .map((r) => [r.key, r]));

  const full = {
    ...typed({ qualifiedContactsEstimate: 40, conversionRate: 12.5, averageOrderValue: 1200, averageGrossProfit: 450,
      otherExpense: 1087.5, influencedGrossProfit: 3000, strategicPlanned: 10, strategicCompleted: 7 }),
    budget: 1500,
  };
  const trips = { leads: { count: 0 }, travel: { total: 412.5, trips: [{ ref: 'TR-1' }] } };

  /* ================= the formulas ================= */

  t.test('each formula computes exactly what the handoff writes', () => {
    const r = calc(full, trips, true);
    t.equal(r.expectedOrders.value, 5, '40 qualified contacts x 12.5%');
    t.equal(r.expectedRevenue.value, 6000, '5 orders x $1,200');
    t.equal(r.expectedGrossProfit.value, 2250, '5 orders x $450');
    t.equal(r.eventRoiEstimate.value, 50, '($2,250 - $1,500 budget) / $1,500 x 100');
    t.equal(r.eventRoiActual.value, 100, '($3,000 - ($412.50 travel + $1,087.50 other)) / $1,500 x 100');
    t.equal(r.strategicCompletion.value, 70, '7 of 10');
  });

  t.test('every result carries its formula, inputs, basis and last update', () => {
    const r = calc(full, trips, true);
    t.equal(r.expectedOrders.formula, 'Qualified contacts × Historical conversion rate', 'the handoff wording');
    t.equal(r.eventRoiEstimate.basis, 'estimate', 'estimated ROI is labelled an estimate');
    t.equal(r.eventRoiActual.basis, 'actual', 'actual ROI is labelled actual');
    t.equal(r.expectedOrders.inputs.length, 2, 'both inputs are shown');
    t.assert(/Typed: Apparelytics/.test(r.expectedOrders.inputs[1].source), 'with where the number came from');
    t.equal(r.expectedOrders.updatedAt, '2026-09-11T12:00:00.000Z', 'last updated is the newest input');
    const travel = r.eventRoiActual.inputs.find((i) => i.label === 'Travel expense');
    t.assert(/TravelTrack/.test(travel.source) && travel.value === 412.5, 'travel is read from TravelTrack, not typed');
  });

  t.test('connected leads replace the estimate, and say so', () => {
    const r = calc(full, { leads: { count: 24 }, travel: { total: 0, trips: [] } });
    t.equal(r.expectedOrders.value, 3, '24 connected leads x 12.5%');
    t.assert(/24 leads connected in BackBone/.test(r.expectedOrders.inputs[0].source), 'the source names BackBone');
    t.equal(r.expectedOrders.inputs[0].basis, 'actual', 'and it is an actual count');
  });

  t.test('strategic completion only on an event', () => {
    t.assert(!calc(full, trips, false).strategicCompletion, 'not on an ordinary campaign');
    t.assert(calc(full, trips, true).strategicCompletion, 'on a trade show');
  });

  /* ================= words, not bad numbers ================= */

  t.test('missing inputs read as what is needed', () => {
    const r = calc({ ...typed({ qualifiedContactsEstimate: 40 }) });
    t.equal(r.expectedOrders.value, null, 'no number without a conversion rate');
    t.equal(r.expectedOrders.status, 'Needs historical conversion rate', 'and it says which input');
    t.equal(r.expectedRevenue.status, 'Needs expected orders first', 'dependent results say what they wait on');
    t.equal(r.eventRoiEstimate.status, 'Needs expected gross profit first', 'all the way down');
  });

  t.test('a zero denominator is a sentence, never a number', () => {
    const zeroBudget = calc({ ...full, budget: 0 }, trips);
    t.equal(zeroBudget.eventRoiEstimate.value, null, 'no ROI on a zero budget');
    t.assert(/budget is zero/.test(zeroBudget.eventRoiEstimate.status), 'said plainly');
    const noBudget = calc({ ...full, budget: null }, trips);
    t.assert(/Needs an approved budget/.test(noBudget.eventRoiEstimate.status), 'a missing budget is different from zero');
    const noSpend = calc({ ...typed({ influencedGrossProfit: 3000 }) }, { leads: { count: 0 }, travel: { total: 0, trips: [] } });
    t.assert(/No expense recorded yet/.test(noSpend.eventRoiActual.status), 'no expense is not infinite ROI');
    const nothingPlanned = calc({ ...typed({ strategicPlanned: 0, strategicCompleted: 2 }) }, trips, true);
    t.assert(/Nothing was planned/.test(nothingPlanned.strategicCompletion.status), 'nothing planned is not infinite completion');
  });

  t.test('an app that did not answer is named, not counted as zero', () => {
    const down = calc(full, { leads: { unavailable: true }, travel: { unavailable: true } });
    t.assert(/TravelTrack did not answer/.test(down.eventRoiActual.status), 'actual ROI names TravelTrack');
    t.equal(down.expectedOrders.value, 5, 'the typed estimate still covers contacts while BackBone is down');
    const noEstimate = calc({ ...typed({ conversionRate: 10 }) }, { leads: { unavailable: true }, travel: { total: 0 } });
    t.equal(noEstimate.expectedOrders.status, 'BackBone did not answer', 'and without one it says why');
  });

  t.test('a typed zero is a real zero and a loss is shown as a loss', () => {
    const zero = calc({ ...typed({ qualifiedContactsEstimate: 0, conversionRate: 10 }) });
    t.equal(zero.expectedOrders.value, 0, 'zero contacts is zero orders, a number');
    const loss = calc({ ...typed({ influencedGrossProfit: 500, otherExpense: 1000 }) }, { leads: { count: 0 }, travel: { total: 0, trips: [] } });
    t.equal(loss.eventRoiActual.value, -50, 'spending $1,000 to make $500 is -50%');
  });

  /* ================= typing the numbers ================= */

  const S = { username: 'ryan', name: 'Ryan Toney' };

  t.test('typed inputs are checked, and blank clears rather than zeroes', () => {
    const c = { id: 'CP-1', history: [] };
    t.assert(!k.applyCalcInput(c, { key: 'conversionRate', value: '-5', source: 'x' }, S).ok, 'negative refused');
    t.assert(!k.applyCalcInput(c, { key: 'conversionRate', value: '140', source: 'x' }, S).ok, 'a percent over 100 refused');
    t.assert(!k.applyCalcInput(c, { key: 'strategicPlanned', value: '2.5' }, S).ok, 'a fractional count refused');
    t.assert(!k.applyCalcInput(c, { key: 'averageOrderValue', value: '1200' }, S).ok, 'a money figure needs a source');
    t.assert(k.applyCalcInput(c, { key: 'otherExpense', value: '$1,087.50' }, S).ok, 'other expense needs no source, and $ and commas are fine');
    t.assert(!k.applyCalcInput(c, { key: 'magic', value: '1' }, S).ok, 'unknown input refused');

    const set = k.applyCalcInput(c, { key: 'conversionRate', value: '12.5%', source: 'Apparelytics 2025' }, S);
    t.equal(set.campaign.calc.inputs.conversionRate.value, 12.5, 'stored as a number');
    t.equal(set.campaign.calc.inputs.conversionRate.by, 'Ryan Toney', 'with who set it');
    t.assert(!c.calc, 'the input record was not mutated');
    const cleared = k.applyCalcInput(set.campaign, { key: 'conversionRate', value: '' }, S);
    t.assert(!('conversionRate' in cleared.campaign.calc.inputs), 'blank removes it');
    t.equal(calc(cleared.campaign).expectedOrders.value, null, 'and a cleared rate is unknown, not 0%');
    t.assert(/Cleared historical conversion rate/.test(cleared.campaign.history.pop().what), 'the clearing is in the history');
  });

  t.test('no em dash reaches the team in calculation text', () => {
    const texts = [];
    Object.values(k.CALC_INPUTS).forEach((s) => texts.push(s.label, s.hint));
    k.computeCalculations({}, { leads: { unavailable: true }, travel: { unavailable: true } }, { strategic: true })
      .forEach((r) => { texts.push(r.title, r.formula, r.status); r.inputs.forEach((i) => texts.push(i.label, i.source)); });
    texts.forEach((x) => t.assert(!/\u2014/.test(x || ''), 'em dash in: ' + x));
  });

  /* ================= through the route ================= */

  kv.clear();
  seedUsers();
  const trip = await tt.saveTrip({ title: 'Show', destination: 'Long Beach', start_date: '2027-01-14', status: 'confirmed' });
  await tt.saveExpense({ trip_id: trip.id, amount: 600, status: 'approved', category: 'Lodging', date: '2027-01-14' });

  const ev = await call({ as: RYAN, method: 'POST', body: { type: 'trade_show', name: 'Show', budget: '2000' } });
  const EV = ev.body.campaign.id;
  const po = await call({ as: RYAN, method: 'POST', body: { type: 'postal', name: 'Mailer' } });

  await t.test('an Admin types numbers and the event computes from them and TravelTrack', async () => {
    await call({ as: RYAN, method: 'PATCH', query: { id: EV, connect: 1 }, body: { kind: 'trips', ref: trip.id } });
    const bad = await call({ as: RYAN, method: 'PATCH', query: { id: EV, calc: 1 }, body: { key: 'averageOrderValue', value: '900' } });
    t.equal(bad.statusCode, 400, 'a money figure with no source is refused');
    for (const [key, value, source] of [['influencedGrossProfit', '1800', 'AM confirmed'], ['otherExpense', '600', '']]) {
      const r = await call({ as: RYAN, method: 'PATCH', query: { id: EV, calc: 1 }, body: { key, value, source } });
      t.equal(r.statusCode, 200, key + ' saved: ' + JSON.stringify(r.body));
    }
    const d = await call({ as: RYAN, query: { id: EV } });
    const actual = d.body.calculations.find((x) => x.key === 'eventRoiActual');
    t.equal(actual.value, 50, '($1,800 - ($600 travel + $600 other)) / $1,200 x 100');
    t.assert(d.body.calculations.some((x) => x.key === 'strategicCompletion'), 'the trade show gets strategic completion');
    const p = await call({ as: RYAN, query: { id: po.body.campaign.id } });
    t.assert(!p.body.calculations.some((x) => x.key === 'strategicCompletion'), 'the Postal campaign does not');
  });

  await t.test('typing numbers is Admin only', async () => {
    const r = await call({ as: HANNAH, method: 'PATCH', query: { id: EV, calc: 1 }, body: { key: 'otherExpense', value: '1' } });
    t.equal(r.statusCode, 403, 'refused');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
