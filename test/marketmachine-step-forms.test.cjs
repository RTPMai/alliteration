// PUT IN: test/marketmachine-step-forms.test.cjs
/**
 * Steps that are a small form (Oct 1 2026): results, approvals, audience,
 * picks, spend.
 *
 * What is worth breaking a build over:
 *   - each step keeps only the fields it asks for, as numbers, and blank is
 *     "not known", never zero
 *   - results add up from the latest step that has each number, not summed
 *     twice
 *   - an approval is decided by Approve or Send back, never by a posted form;
 *     a send-back needs a reason and shows as the blocker
 *   - approving spend records the proposed amount; Account Managers never
 *     see it
 *   - Picks cannot be ticked with fewer than five complete picks
 *   - the audience step points the campaign's email at its list
 *   - all of it through the real route, as Ryan and as an Account Manager
 */
const path = require('path');
const fs = require('fs');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

const kv = new Map();
global.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  const get = u.match(/\/get\/(.+)$/);
  if (get) { const key = decodeURIComponent(get[1]); return ok(kv.has(key) ? kv.get(key) : null); }
  const set = u.match(/\/set\/(.+)$/);
  if (set) { kv.set(decodeURIComponent(set[1]), opts && opts.body); return ok('OK'); }
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse((opts && opts.body) || '[]');
    const out = cmds.map(([op, key, val]) => {
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
process.env.SESSION_SECRET = 'test-secret-for-marketmachine-step-forms';

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

const PICK = (n) => ({ name: 'Tee ' + n, style: 'PC5' + n, msrp: '$9.98', url: 'https://www.ssactivewear.com/p/' + n, reason: 'Soft', colors: ['Navy', 'Black'] });

(async () => {
  const F = await import('../lib/marketmachine/forms.js');
  const model = await import('../lib/marketmachine/campaign.js');
  const store = await import('../lib/marketmachine/store.js');
  const cc = await import('../lib/crewcore/store.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;
  const S = { username: 'ryan', name: 'Ryan Toney' };

  /* ================= which step gets which form ================= */

  await t.test('every step a form names is a real step in the catalogue', async () => {
    const cat = await import('../lib/marketmachine/catalog.js');
    const all = new Map();
    (cat.CAMPAIGN_TYPES || cat.TYPES || cat.default || []).forEach((ty) => (ty.steps || []).forEach((s) => all.set(s.key, s)));
    t.assert(all.size > 50, 'the catalogue loaded: ' + all.size);
    let named = 0;
    all.forEach((s) => { if (F.formFor(s)) named++; });
    t.assert(named >= 25, 'most results, audience, spend and approval steps have a form: ' + named);
    t.equal(F.formFor(all.get('dp_platform_results')), 'results');
    t.equal(F.formFor(all.get('dp_paid_proposal')), 'spend');
    t.equal(F.formFor(all.get('dp_paid_approval')), 'approval');
    t.equal(F.formFor(all.get('picks_select')), 'picks');
    t.equal(F.formFor(all.get('picks_trigger')), 'picksInfo');
    t.equal(F.formFor(all.get('dp_audience')), 'audience');
    t.equal(F.formFor(all.get('dp_launch')), '', 'an ordinary step stays a checkbox');
  });

  /* ================= cleaning ================= */

  await t.test('results keep only their own numbers; blank is unknown, not zero', () => {
    const s = { key: 'dp_platform_results' };
    const r = F.cleanForm(s, { reach: '1,200', views: '', clicks: '45', revenue: '9999', engagement: '0' });
    t.equal(r.ok, true);
    t.equal(r.form.reach, 1200); t.equal(r.form.views, null, 'blank stays blank');
    t.equal(r.form.engagement, 0, 'a real zero is kept');
    t.equal(r.form.revenue, undefined, 'a field this step does not ask for is dropped');
    t.equal(F.cleanForm(s, { reach: 'lots' }).ok, false, 'words are refused');
    t.equal(F.cleanForm(s, { reach: '-3' }).ok, false, 'and negatives');
    t.equal(F.cleanForm({ key: 'dp_sales_results' }, { revenue: '$1,234.567' }).form.revenue, 1234.57, 'money to the cent');
  });

  await t.test('spend needs an amount; picks need https links', () => {
    t.equal(F.cleanForm({ key: 'dp_paid_proposal' }, { what: 'ads' }).ok, false);
    t.equal(F.cleanForm({ key: 'dp_paid_proposal' }, { amount: '$500', what: 'ads' }).form.amount, 500);
    const bad = F.cleanForm({ key: 'picks_select' }, { picks: [{ ...PICK(1), url: 'javascript:alert(1)' }] });
    t.equal(bad.ok, false, 'a link that is not https is refused: ' + bad.errors.join(';'));
    const ok = F.cleanForm({ key: 'picks_select' }, { picks: [PICK(1), {}, { name: '' }] });
    t.equal(ok.form.picks.length, 1, 'empty rows are dropped');
    t.equal(F.cleanForm({ key: 'picks_trigger' }, { season: 'winter', vendor: 'ss', year: '2027' }).ok, false, 'only spring or fall');
  });

  await t.test('an approval cannot be decided by posting a form', () => {
    t.equal(F.cleanForm({ key: 'dp_paid_approval', approval: true }, { decision: 'approved' }).ok, false);
  });

  /* ================= the model ================= */

  const base = model.buildCampaign({ type: 'digital_platform', name: 'Fall ads', controlDate: '2027-03-04' }, S, null);
  base.id = 'CP-T1';
  const step = (c, k) => c.steps.find((s) => s.key === k);
  const patch = (c, k, body) => model.applyStepPatch(c, k, body, S, '2026-10-01');

  await t.test('the audience step points the campaign at its list', () => {
    const r = patch(base, 'dp_audience', { form: { listId: 'L-9', listName: 'Top 25 clients', count: 25 } });
    t.equal(r.ok, true, r.errors.join(';'));
    t.equal(r.campaign.audienceListId, 'L-9');
    t.equal(r.campaign.audience, 'Top 25 clients');
    t.equal(F.emailPrefill(r.campaign).listId, 'L-9', 'and a new email starts on it');
    t.assert(/form saved/.test(JSON.stringify(r.campaign.history || r.campaign.log || '')), 'the history says so');
  });

  await t.test('send back needs a reason and becomes the blocker; approve records the spend', () => {
    let c = patch(base, 'dp_paid_proposal', { form: { amount: '750', what: 'Facebook, two weeks' }, done: true }).campaign;
    t.equal(step(c, 'dp_paid_proposal').done, true);
    t.equal(patch(c, 'dp_paid_approval', { sendBack: '  ' }).ok, false, 'no reason, no send-back');
    t.equal(patch(c, 'dp_launch', { sendBack: 'no' }).ok, false, 'only an approval can be sent back');
    c = patch(c, 'dp_paid_approval', { sendBack: 'Make it $500' }).campaign;
    const a = step(c, 'dp_paid_approval');
    t.equal(a.form.decision, 'sent_back');
    t.assert(/Make it \$500/.test(a.blocked), 'it shows as the blocker: ' + a.blocked);
    t.equal(F.proposalsFor(c, a).length, 1, 'the approval knows what it is deciding');
    c = patch(c, 'dp_paid_approval', { done: true }).campaign;
    const b = step(c, 'dp_paid_approval');
    t.equal(b.form.decision, 'approved'); t.equal(b.form.approvedAmount, 750);
    t.equal(b.blocked, '', 'approving clears the blocker');
    t.equal(F.approvedSpend(c), 750);
    const back = patch(c, 'dp_paid_approval', { done: false }).campaign;
    t.equal(F.approvedSpend(back), 0, 'reopening takes the approval back');
  });

  await t.test('results add up from the latest step, not twice', () => {
    let c = patch(base, 'dp_platform_results', { form: { reach: 1000, clicks: 40 } }).campaign;
    c = patch(c, 'dp_final_results', { form: { reach: 1500, clicks: '', orders: 3, revenue: 900 } }).campaign;
    const tot = F.resultsTotals(c);
    t.equal(tot.reach.value, 1500, 'final reach wins over the earlier count');
    t.equal(tot.clicks.value, 40, 'a blank later does not wipe an earlier number');
    t.equal(tot.revenue.value, 900);
  });

  await t.test('Picks cannot be ticked with fewer than five complete picks', () => {
    const p = model.buildCampaign({ type: 'picks', name: 'Fall picks', controlDate: '2027-03-04' }, S, null);
    p.id = 'CP-T2';
    let c = model.applyStepPatch(p, 'picks_select', { form: { picks: [PICK(1), PICK(2), PICK(3), { name: 'half' }] } }, S, '2026-10-01').campaign;
    const r = model.applyStepPatch(c, 'picks_select', { done: true }, S, '2026-10-01');
    t.equal(r.ok, false, 'three complete is not enough');
    t.assert(/five/i.test(r.errors.join(' ')), r.errors.join(';'));
    c = model.applyStepPatch(c, 'picks_select', { form: { picks: [1, 2, 3, 4, 5].map(PICK) }, done: true }, S, '2026-10-01');
    t.equal(c.ok, true, c.errors.join(';'));
    c = model.applyStepPatch(c.campaign, 'picks_trigger', { form: { season: 'fall', year: '2027', vendor: 'sanmar', teamMember: 'Hannah' } }, S, '2026-10-01');
    const pre = F.emailPrefill(c.campaign);
    t.equal(pre.pwp.vendor, 'sanmar'); t.equal(pre.pwp.picks.length, 5);
    t.equal(pre.pwp.picks[0].colors[0].name, 'Navy', 'colors arrive in the email design\'s shape');
  });

  /* ================= through the route ================= */

  kv.clear();
  kv.set('alliteration:users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan Toney', superuser: true, access: { apps: [] } },
    hannah: { username: 'hannah', name: 'Hannah Posey', access: { apps: ['marketmachine'], can_edit: true } },
  }));
  const hannahEmp = await cc.saveEmployee({ name: 'Hannah Posey', department: 'Sales', active: true });
  const RYAN = { username: 'ryan', name: 'Ryan Toney' };
  const HANNAH = { username: 'hannah', name: 'Hannah Posey' };
  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }
  const made = await call({ as: RYAN, method: 'POST', body: {
    type: 'digital_platform', name: 'Spring ads', controlDate: '2027-03-04',
    accountManagerId: hannahEmp.id, accountManagerName: 'Hannah Posey' } });
  const ID = made.body.campaign.id;

  await t.test('an Account Manager fills in her own campaign\'s forms', async () => {
    const r = await call({ as: HANNAH, method: 'PATCH', query: { id: ID, step: 'dp_paid_proposal' }, body: { form: { amount: '400', what: 'Instagram' }, done: true } });
    t.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
    const res = await call({ as: HANNAH, method: 'PATCH', query: { id: ID, step: 'dp_sales_results' }, body: { form: { leads: '4', revenue: '1200' } } });
    t.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 200));
    t.equal(model.applyStepPatch ? (await store.getCampaign(ID)).steps.find((s) => s.key === 'dp_sales_results').form.leads : 4, 4);
  });

  await t.test('she cannot approve or send back; Ryan can', async () => {
    t.equal((await call({ as: HANNAH, method: 'PATCH', query: { id: ID, step: 'dp_paid_approval' }, body: { sendBack: 'x' } })).statusCode, 403);
    const sb = await call({ as: RYAN, method: 'PATCH', query: { id: ID, step: 'dp_paid_approval' }, body: { sendBack: 'Too much' } });
    t.equal(sb.statusCode, 200, JSON.stringify(sb.body).slice(0, 200));
    const ok = await call({ as: RYAN, method: 'PATCH', query: { id: ID, step: 'dp_paid_approval' }, body: { done: true } });
    t.equal(ok.statusCode, 200, JSON.stringify(ok.body).slice(0, 200));
    t.equal(ok.body.campaign.steps.find((s) => s.key === 'dp_paid_approval').form.approvedAmount, 400, 'Ryan sees the approved amount');
  });

  await t.test('the approved amount never reaches an Account Manager', async () => {
    const page = await call({ as: HANNAH, query: { id: ID } });
    t.equal(page.statusCode, 200);
    const a = page.body.campaign.steps.find((s) => s.key === 'dp_paid_approval');
    t.equal(a.form.decision, 'approved', 'she sees it was approved');
    t.equal(a.form.approvedAmount, undefined, 'but not for how much');
  });

  await t.test('the screens are wired', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'apps/marketmachine/index.js'), 'utf8');
    t.assert(/makeStepForms\(app\)/.test(idx) && /ui\.onFormClick\(t\)/.test(idx) && /ui\.onFormChange\(t\)/.test(idx));
    t.assert(/prefill: \(\) =>/.test(idx), 'the email section is handed the campaign\'s answers');
    const mm = fs.readFileSync(path.join(ROOT, 'apps/mailme.js'), 'utf8');
    t.assert(/if \(pre\.listId\) d\.listId = pre\.listId/.test(mm), 'a new email starts on the audience list');
    t.assert(/fillPwpFromCampaign\(d\.templateData\)/.test(mm), 'and the Picks design starts with the picks');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
