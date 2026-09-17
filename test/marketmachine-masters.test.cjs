// PUT IN: test/marketmachine-masters.test.cjs
/**
 * The campaign masters, phase 4 (Sept 2026).
 *
 * Jacob's fourteen master documents define each campaign's own steps,
 * formulas, scorecard and, for Try On Day, a minimum. What is worth breaking
 * a build over:
 *
 *   - every formula computes what its master writes, including the ones whose
 *     wording is easy to get backwards (net expense counts support once, a
 *     December referral runs to the FOLLOWING November 30, in-order gifting is
 *     two months not one)
 *   - a zero denominator or a missing value is words, never a number
 *   - Try On Day's 25-participant minimum WARNS and never blocks (Ryan's call)
 *   - a type's own input cannot be typed onto another type's campaign
 *   - the three campaigns whose masters have not arrived carry no invented
 *     formulas
 *   - a scorecard row keeps its source and limitation, and clearing a row
 *     removes it rather than leaving blanks that look filled in
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
  const cat = await import('../lib/marketmachine/catalog.js');
  const tn = await import('../lib/marketmachine/type-numbers.js');
  const k = await import('../lib/marketmachine/calculations.js');
  const m = await import('../lib/marketmachine/campaign.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  const S = { username: 'ryan', name: 'Ryan Toney' };
  const withInputs = (type, inputs) => ({
    id: 'CP-T', type, history: [],
    calc: { inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, { value, source: 'test', by: 'Ryan Toney', at: '2026-09-17T12:00:00.000Z' }])) },
  });
  const calcs = (type, inputs) => Object.fromEntries(
    k.computeCalculations(withInputs(type, inputs), { leads: { count: 0 }, travel: { total: 0, trips: [] } }, {})
      .map((r) => [r.key, r]));

  /* ================= each master's own formulas ================= */

  t.test('Parade Day: order gap, distributed, net expense, cost per interaction', () => {
    const r = calcs('parade', { par_planned: 2000, par_stock: 1400, par_starting: 2000, par_remaining: 150,
      par_damaged: 50, par_costs: 4200, par_support: 1200, par_cta: 300 });
    t.equal(r.par_order_gap.value, 600, '2,000 planned less 1,400 in stock');
    t.equal(r.par_distributed.value, 1800, '2,000 out, 150 back, 50 damaged');
    t.equal(r.par_net_expense.value, 3000, '$4,200 of cost less $1,200 of support, subtracted once');
    t.equal(r.par_cost_per_cta.value, 10, '$3,000 over 300 interactions');
    const plenty = calcs('parade', { par_planned: 500, par_stock: 900 });
    t.equal(plenty.par_order_gap.value, 0, 'more stock than needed is a gap of zero, never negative');
  });

  t.test('This One Is On Us: gift cost and delivery completion', () => {
    const r = calcs('on_us', { onus_item: 18.5, onus_decoration: 6.25, onus_packaging: 2, onus_freight: 11.4,
      onus_released: 8, onus_delivered: 6 });
    t.equal(r.onus_gift_cost.value, 38.15, 'the four costs add to the penny');
    t.equal(r.onus_delivery.value, 75, '6 of 8 delivered');
    t.assert(/Held for the Account Manager is not delivered/.test(r.onus_delivery.note), 'and the master\'s caveat is shown');
  });

  t.test('Sampling: response, conversion and cost per conversion', () => {
    const r = calcs('sampling', { samp_delivered: 40, samp_responding: 12, samp_ordered: 5, samp_cost: 1250 });
    t.equal(r.samp_response.value, 30, '12 of 40');
    t.equal(r.samp_conversion.value, 12.5, '5 of 40');
    t.equal(r.samp_cost_per.value, 250, '$1,250 over 5 orders');
    const none = calcs('sampling', { samp_delivered: 40, samp_ordered: 0, samp_cost: 1250 });
    t.equal(none.samp_cost_per.value, null, 'no conversions is not a divide by zero');
    t.assert(/Nobody has ordered yet/.test(none.samp_cost_per.status), 'it says so plainly');
  });

  t.test('Referral: conversion, and the fiscal-year rule that is easy to get wrong', () => {
    const r = calcs('referral', { ref_distinct: 8, ref_ordered: 3, ref_revenue: 14250.75 });
    t.equal(r.ref_conversion.value, 37.5, '3 of 8 referred people ordered');
    t.equal(r.ref_fiscal_revenue.value, 14250.75, 'revenue carries through');
    t.assert(/FOLLOWING November 30/.test(r.ref_fiscal_revenue.note), 'a December first order runs to the following November 30');
    t.assert(/never the tie-breaker/i.test(r.ref_fiscal_revenue.note), 'and revenue never breaks a tie');
  });

  t.test('Poll Sending: opt-in, response and completion rates', () => {
    const r = calcs('poll', { poll_pre_delivered: 50, poll_yes: 20, poll_invites: 20, poll_responded: 14, poll_completed: 11 });
    t.equal(r.poll_optin.value, 40, '20 yes of 50 pre-poll emails');
    t.equal(r.poll_response.value, 70, '14 of 20 invites');
    t.equal(r.poll_completion.value, 55, '11 completed of 20 invites');
    const nobody = calcs('poll', { poll_pre_delivered: 50, poll_yes: 0, poll_invites: 0, poll_responded: 0 });
    t.equal(nobody.poll_response.value, null, 'nobody opted in, so there is no response rate');
    t.assert(/is zero/.test(nobody.poll_response.status), 'said as a sentence');
  });

  t.test('In-Order Gifting: two months before the client needs them, not one', () => {
    const r = calcs('in_order_gifting', { iog_need_date: '2027-05-31', iog_recipients: 40, iog_later_order: 9, iog_influenced: 6100 });
    t.equal(r.iog_distribution.value, '2027-03-31', 'May 31 back two months is March 31, not a day April does not have');
    t.equal(r.iog_repeat.value, 22.5, '9 of 40 ordered again');
    t.equal(r.iog_influenced_revenue.value, 6100, 'influenced revenue carries through');
    t.equal(tn.monthsBefore('2027-01-15', 2), '2026-11-15', 'and it crosses a year end');
    t.equal(tn.monthsBefore('2027-04-30', 2), '2027-02-28', 'two months before April 30 is the last day of February, not a February 30');
  });

  t.test('Picks with Personality: delivered, unique click rate, attributed conversion', () => {
    const r = calcs('picks', { picks_sent: 420, picks_bounces: 20, picks_clickers: 52, picks_audience: 400, picks_orders: 6 });
    t.equal(r.picks_delivered.value, 400, 'sent less bounces');
    t.equal(r.picks_click_rate.value, 13, '52 unique clickers of 400 delivered');
    t.assert(/Opens are directional/.test(r.picks_click_rate.note), 'unique clicks are the primary measure');
    t.equal(r.picks_attributed.value, 1.5, '6 orders against the named audience');
  });

  t.test('Digital Platform: engagement rate, CTR, cost per result', () => {
    const r = calcs('digital_platform', { dp_engagements: 240, dp_reach: 6000, dp_clicks: 90, dp_impressions: 9000,
      dp_spend: 300, dp_results: 24 });
    t.equal(r.dp_engagement_rate.value, 4, '240 of 6,000');
    t.equal(r.dp_ctr.value, 1, '90 clicks of 9,000 impressions');
    t.equal(r.dp_cost_per_result.value, 12.5, '$300 over 24 results');
    t.assert(/Reach and impressions are not the same/.test(r.dp_engagement_rate.note), 'the denominator has to be named');
  });

  t.test('Live Customization: finished price and completed units', () => {
    const r = calcs('live_customization', { lc_blank: 9.75, lc_decoration: 6.5, lc_taken: 180, lc_not_customized: 12, lc_damaged: 3 });
    t.equal(r.lc_price.value, 16.25, 'blank plus decoration');
    t.equal(r.lc_completed.value, 165, 'taken less NOT CUSTOMIZED less DAMAGED DURING APPLICATION');
  });

  t.test('Try On Day: participation, conversion, ROI and the count check', () => {
    const r = calcs('try_on_day', { tod_invited: 120, tod_participants: 78, tod_buyers: 41, tod_profit: 2600,
      tod_expense: 1300, tod_outgoing: 24, tod_usable: 21, tod_damaged: 2, tod_missing: 1 });
    t.equal(r.tod_participation.value, 65, '78 of 120 invited');
    t.equal(r.tod_conversion.value, 52.6, '41 buyers of 78 participants');
    t.equal(r.tod_roi.value, 100, '($2,600 - $1,300) over $1,300');
    t.equal(r.tod_count_check.value, 0, '24 out, 21 usable, 2 damaged, 1 missing reconciles');
    t.assert(!r.tod_count_check.flag, 'and nothing is flagged');
    const off = calcs('try_on_day', { tod_outgoing: 24, tod_usable: 20, tod_damaged: 2, tod_missing: 1 });
    t.equal(off.tod_count_check.value, 1, 'one garment unaccounted for');
    t.assert(/dated explanation/.test(off.tod_count_check.flag), 'is flagged for an explanation');
  });

  /* ================= the 25-participant minimum ================= */

  t.test('Try On Day warns under 25 participants and never blocks', () => {
    const small = withInputs('try_on_day', { tod_expected: 18 });
    const warnings = k.advisories(small);
    t.equal(warnings.length, 1, 'one warning');
    t.assert(/25-participant minimum/.test(warnings[0].text), 'it names the minimum');
    t.assert(/Jacob/.test(warnings[0].text), 'and whose approval the exception needs');
    // Nothing about the warning stops the work: every step is still workable.
    const campaign = { ...m.buildCampaign({ type: 'try_on_day', name: 'Small group' }, S), ...small, type: 'try_on_day' };
    const ticked = m.applyStepPatch(campaign, 'tod_qualify', { done: true }, S, '2026-09-17');
    t.assert(ticked.ok, 'the qualify step can still be completed');
    t.equal(k.advisories(withInputs('try_on_day', { tod_expected: 25 })).length, 0, 'exactly 25 is fine');
    t.equal(k.advisories(withInputs('try_on_day', {})).length, 0, 'and nothing is warned about before a number is entered');
  });

  t.test('Try On Day carries its master\'s hard rules where the team reads them', () => {
    const type = cat.typeMeta('try_on_day');
    const all = type.steps.map((s) => s.label + ' ' + s.help).join(' ');
    t.assert(/25 participants is a firm minimum|firm minimum/.test(all), 'the minimum');
    t.assert(/EVERY sample is bought upfront/.test(all), 'samples are paid for upfront');
    t.assert(/never Printavo's invoice date/i.test(all), 'the return date is not the invoice date');
    t.assert(/saving again must never add stock twice/.test(all), 'the usable count posts once');
    const jacob = type.steps.find((s) => s.key === 'tod_jacob');
    t.equal(jacob.owner, 'Jacob', 'Jacob second-reviews');
    const payment = type.steps.find((s) => s.key === 'tod_payment');
    t.assert(payment.after.includes('tod_jacob'), 'and nothing is purchased before that review');
    const kit = type.steps.find((s) => s.key === 'tod_kit');
    t.assert(kit.after.includes('tod_payment'), 'or before payment');
  });

  /* ================= guards ================= */

  t.test('a campaign type cannot be given another type\'s numbers', () => {
    const parade = { id: 'CP-1', type: 'parade', history: [] };
    t.assert(!k.applyCalcInput(parade, { key: 'poll_yes', value: '4' }, S).ok, 'a Poll input is refused on a Parade campaign');
    t.assert(k.applyCalcInput(parade, { key: 'par_planned', value: '2000' }, S).ok, 'its own input is accepted');
    t.assert(k.applyCalcInput(parade, { key: 'conversionRate', value: '10', source: 'Apparelytics' }, S).ok, 'and so are the shared ones');
  });

  t.test('the three campaigns with no master carry no invented formulas', () => {
    tn.TYPES_WITHOUT_A_MASTER.forEach((key) => {
      t.equal(tn.typeNumbers(key).calcs.length, 0, key + ' has no formulas of its own');
      t.equal(tn.typeNumbers(key).scorecard.length, 0, key + ' has no scorecard');
      t.assert(cat.typeMeta(key), key + ' is still a campaign type with its steps');
    });
    t.assert(calcs('postal', {}).expectedOrders, 'and it still gets the five shared calculations');
  });

  t.test('every formula names its inputs, and every input exists', () => {
    Object.entries(tn.TYPE_NUMBERS).forEach(([type, numbers]) => {
      const keys = numbers.inputs.map((i) => i.key);
      numbers.calcs.forEach((c) => {
        t.assert(c.formula && c.title, `${type}: ${c.key} needs a title and formula`);
        c.needs.forEach((n) => t.assert(keys.includes(n), `${type}: ${c.key} needs ${n}, which is not an input`));
      });
      (numbers.advisories || []).forEach((a) => a.needs.forEach((n) =>
        t.assert(keys.includes(n), `${type}: advisory needs ${n}, which is not an input`)));
      const dup = keys.filter((x, i) => keys.indexOf(x) !== i);
      t.equal(dup.length, 0, type + ' has duplicate input keys');
      t.assert(numbers.scorecard.length > 0, type + ' has a scorecard');
    });
  });

  t.test('no em dash reaches the team in any master text', () => {
    Object.values(tn.TYPE_NUMBERS).forEach((n) => {
      n.inputs.forEach((i) => { t.assert(!/\u2014/.test(i.label + (i.hint || '')), 'em dash: ' + i.label); });
      n.calcs.forEach((c) => t.assert(!/\u2014/.test(c.title + c.formula + (c.note || '')), 'em dash: ' + c.title));
      n.scorecard.forEach((x) => t.assert(!/\u2014/.test(x), 'em dash: ' + x));
    });
    cat.typeMeta('try_on_day').steps.forEach((s) =>
      t.assert(!/\u2014/.test(s.label + s.help + s.owner), 'em dash: ' + s.label));
  });

  /* ================= the scorecard ================= */

  t.test('a scorecard row keeps its source and limitation, and clearing removes it', () => {
    const c = { id: 'CP-1', type: 'sampling', history: [] };
    const rows = k.scorecardRows(c);
    t.assert(rows.length >= 8, 'Sampling has its master\'s metric rows');
    t.assert(rows.every((r) => !r.filled), 'nothing filled in yet');
    const saved = k.applyScorecardPatch(c, { key: rows[0].key, target: '40', actual: '38',
      range: 'Sept 2026', source: 'Shipping log', notes: 'Two undeliverable' }, S);
    t.assert(saved.ok, 'saved');
    const back = k.scorecardRows(saved.campaign)[0];
    t.equal(back.source, 'Shipping log', 'the source is kept');
    t.equal(back.notes, 'Two undeliverable', 'so is the limitation');
    t.equal(back.by, 'Ryan Toney', 'and who filled it in');
    t.assert(back.filled, 'the row counts as filled');
    const cleared = k.applyScorecardPatch(saved.campaign, { key: rows[0].key }, S);
    t.assert(!k.scorecardRows(cleared.campaign)[0].filled, 'clearing empties the row rather than leaving blanks');
    t.assert(!(rows[0].key in (cleared.campaign.scorecard || {})), 'and the row is removed, not stored as blanks');
    t.assert(/Cleared scorecard row/.test(cleared.campaign.history.pop().what), 'the clearing is in the history');
    t.assert(!k.applyScorecardPatch(c, { key: 'not_a_metric', actual: '1' }, S).ok, 'an unknown metric is refused');
  });

  /* ================= through the route ================= */

  kv.clear();
  seedUsers();

  await t.test('a Try On Day campaign works end to end through the route', async () => {
    const made = await call({ as: RYAN, method: 'POST', body: { type: 'try_on_day', name: 'Ankeny Schools store', controlDate: '2027-03-04' } });
    t.equal(made.statusCode, 201, 'created: ' + JSON.stringify(made.body));
    const id = made.body.campaign.id;

    const small = await call({ as: RYAN, method: 'PATCH', query: { id, calc: 1 }, body: { key: 'tod_expected', value: '18' } });
    t.equal(small.statusCode, 200, 'an under-25 group is accepted, not refused');

    const d = await call({ as: RYAN, query: { id } });
    t.equal(d.body.advisories.length, 1, 'and it comes back as a warning');
    t.assert(/Jacob/.test(d.body.advisories[0].text), 'naming the approval needed');
    t.assert(d.body.scorecard.length > 0, 'the scorecard rows are there');
    t.assert(d.body.calculations.some((c) => c.key === 'tod_participation'), 'so are its own calculations');

    const row = d.body.scorecard[0];
    const sc = await call({ as: RYAN, method: 'PATCH', query: { id, scorecard: 1 }, body: { key: row.key, actual: '78', source: 'Client headcount' } });
    t.equal(sc.statusCode, 200, 'a scorecard row saves');
    const after = await call({ as: RYAN, query: { id } });
    t.equal(after.body.scorecard[0].actual, '78', 'and comes back');

    const dated = await call({ as: RYAN, method: 'PATCH', query: { id, calc: 1 }, body: { key: 'iog_need_date', value: '2027-05-31' } });
    t.equal(dated.statusCode, 400, 'another campaign type\'s input is refused here too');
  });

  await t.test('scorecard rows are Admin only', async () => {
    const list = await call({ as: RYAN });
    const id = list.body.campaigns[0].id;
    t.equal((await call({ as: HANNAH, method: 'PATCH', query: { id, scorecard: 1 }, body: { key: 'x', actual: '1' } })).statusCode, 403, 'refused');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
