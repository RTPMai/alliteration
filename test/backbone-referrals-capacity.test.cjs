// PUT IN: test/backbone-referrals-capacity.test.cjs
/**
 * BackBone, Sep 30 2026: social links on client records, referral tracking,
 * and the Capacity card.
 *
 * Real function calls into lib/backbone/{social,referrals,capacity}.js, and
 * the two new routes (api/referrals.js, api/capacity.js) CALLED with real
 * signed sessions over a fake Upstash, the same way crewcore-ira does. The
 * markup check at the end is the one place text is read, because the
 * failure it guards (main.js reading an id template.js never had) has
 * crashed BackBone's mount before.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';

global.fetch = async (url, opts) => {
  const raw = String(url);
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-backbone-referrals';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  superuser: true },
    megan: { username: 'megan', name: 'Megan', access: { apps: ['backbone', 'crewcore'] } },
    alexis:{ username: 'alexis', name: 'Alexis', access: { apps: ['backbone'] } },
    viewer:{ username: 'viewer', name: 'Viewer', access: { apps: ['backbone'], can_edit: false } },
    shop:  { username: 'shop',  name: 'Shop',  access: { apps: ['shopstock'] } },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({ id: 'EMP-1', name: 'Alexis Davis', username: 'alexis', status: 'active', hourly_rate: 30 }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({ id: 'EMP-2', name: 'Hannah M. Posey', status: 'active' }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({ id: 'EMP-3', name: 'Old Timer', status: 'terminated' }));
  kv.set(CC + ':pto_policy', JSON.stringify({ start_year: 2026, approvers: ['ryan', 'megan'], versions: {} }));
  kv.set(CC + ':pto_request_index', JSON.stringify(['R1', 'R2', 'R3']));
  kv.set(CC + ':pto_request:R1', JSON.stringify({ id: 'R1', employee_id: 'EMP-1', status: 'approved', type: 'all_days',
    start_date: '2020-01-01', end_date: '2099-12-31', hours: 8, note: 'private reason' }));
  kv.set(CC + ':pto_request:R2', JSON.stringify({ id: 'R2', employee_id: 'EMP-2', status: 'denied', type: 'all_days',
    start_date: '2020-01-01', end_date: '2099-12-31' }));
  kv.set(CC + ':pto_request:R3', JSON.stringify({ id: 'R3', employee_id: 'EMP-2', status: 'pending', type: 'appointment',
    start_date: '2020-01-01', end_date: '2020-01-01' }));
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

async function call(handler, { as, method = 'GET', query = {}, body = null }) {
  const cookie = await makeCookie({ username: as, name: as });
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie } }, res);
  return res;
}

Promise.all([
  import(path.join(ROOT, 'lib/backbone/social.js')),
  import(path.join(ROOT, 'lib/backbone/referrals.js')),
  import(path.join(ROOT, 'lib/backbone/capacity.js')),
  import(path.join(ROOT, 'api/referrals.js')),
  import(path.join(ROOT, 'api/capacity.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(async ([social, R, C, refRoute, capRoute, reg]) => {

  /* ---- social links ---------------------------------------------------- */

  t.test('a bare handle becomes the platform link', () => {
    t.equal(social.socialUrl('instagram_url', '@pmapparel'), 'https://www.instagram.com/pmapparel');
    t.equal(social.socialUrl('tiktok_url', 'pmapparel'), 'https://www.tiktok.com/@pmapparel');
    t.equal(social.socialUrl('facebook_url', 'pmapparel'), 'https://www.facebook.com/pmapparel');
  });

  t.test('a dotted handle is a handle, and a platform box only takes that platform', () => {
    t.equal(social.socialUrl('instagram_url', '@pm.apparel'), 'https://www.instagram.com/pm.apparel');
    t.equal(social.socialUrl('instagram_url', 'pm.apparel'), 'https://www.instagram.com/pm.apparel');
    t.equal(social.socialUrl('instagram_url', 'instagram.com/pm'), 'https://instagram.com/pm');
    t.equal(social.socialUrl('facebook_url', 'https://evil.example/pm'), null);
    t.equal(social.socialUrl('facebook_url', 'https://m.facebook.com/pm'), 'https://m.facebook.com/pm');
    t.equal(social.socialUrl('facebook_url', 'https://notfacebook.com/pm'), null);
  });

  t.test('an address with no scheme gets https, a full one is kept', () => {
    t.equal(social.socialUrl('facebook_url', 'facebook.com/pmapparel'), 'https://facebook.com/pmapparel');
    t.equal(social.socialUrl('linkedin_company_page', 'www.linkedin.com/company/pm'), 'https://www.linkedin.com/company/pm');
    t.equal(social.socialUrl('website_url', 'https://pmapparel.com/'), 'https://pmapparel.com/');
  });

  t.test('anything that is not a web address is refused, never drawn as a link', () => {
    ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'mailto:a@b.com', 'not found', 'N/A', '', '   ', 'x" onmouseover="y']
      .forEach((bad) => t.equal(social.socialUrl('facebook_url', bad), null, 'accepted: ' + bad));
    t.equal(social.socialUrl('website_url', 'pmapparel'), null, 'a website with no dot is not an address');
    t.equal(social.socialUrl('nope', 'https://x.com'), null, 'unknown field');
  });

  t.test('clientLinks lists only usable links, in display order', () => {
    const links = social.clientLinks({ website_url: 'pmapparel.com', instagram_url: '@pm', tiktok_url: 'javascript:x', facebook_url: '' });
    t.equal(links.map((l) => l.label).join(','), 'Website,Instagram');
    t.equal(links[1].text, '@pm');
  });

  /* ---- referral rules --------------------------------------------------- */

  t.test('the fiscal year ends November 30', () => {
    t.equal(R.fiscalYear('2025-11-30'), 2025);
    t.equal(R.fiscalYear('2025-12-01'), 2026);
    t.equal(R.fiscalYear('2026-01-15'), 2026);
    t.equal(R.fiscalYear('2026-02-30'), null, 'not a real date');
  });

  t.test('a referral cannot be confirmed without a referrer', () => {
    const rec = R.newReferral({ referred_name: 'Acme' }, { id: 'REF-0001', by: 'alexis' });
    t.equal(rec.status, 'to_confirm');
    t.equal(R.confirmReferral(rec, { by: 'alexis' }).ok, false);
    const ok = R.confirmReferral({ ...rec, referrer_name: 'YMCA' }, { by: 'alexis' });
    t.equal(ok.ok, true);
    t.equal(ok.record.status, 'confirmed');
  });

  t.test('changing who referred whom sends a confirmed referral back to be confirmed', () => {
    const rec = { ...R.newReferral({ referred_name: 'Acme', referrer_name: 'YMCA' }, { id: 'REF-1' }), status: 'confirmed', confirmed_by: 'x' };
    t.equal(R.editReferral(rec, { note: 'hi' }, {}).status, 'confirmed', 'a note edit keeps it confirmed');
    t.equal(R.editReferral(rec, { referrer_name: 'Rotary' }, {}).status, 'to_confirm');
  });

  t.test('the thank-you needs a known method and a real date', () => {
    const rec = R.newReferral({ referred_name: 'Acme' }, { id: 'REF-1' });
    t.equal(R.thankReferral(rec, { how: 'Carrier pigeon' }).ok, false);
    t.equal(R.thankReferral(rec, { how: 'Card', on: '2026-13-01' }).ok, false);
    const ok = R.thankReferral(rec, { how: 'Card', on: '2026-09-30' });
    t.equal(ok.record.thanked_how, 'Card');
    t.equal(R.thankReferral(ok.record, { how: '' }).record.thanked_at, null, 'clearing works');
  });

  t.test('the same referred person counts once, and "not a referral" does not block', () => {
    const list = [{ id: 'REF-1', referred_customer_id: '9', referred_name: 'Acme', status: 'to_confirm' }];
    t.assert(R.findDuplicate(list, { referred_customer_id: '9', referred_name: 'Other name' }), 'same client id');
    t.assert(R.findDuplicate([{ id: 'REF-2', referred_name: 'Acme, Inc.', status: 'confirmed' }], { referred_name: 'acme' }), 'same name after cleanup');
    t.equal(R.findDuplicate([{ ...list[0], status: 'not_referral' }], { referred_customer_id: '9' }), null);
  });

  const roster = [
    { customer_id: '1', company_name: 'YMCA of Ankeny', invoice_count: 10, total_revenue: 5000 },
    { customer_id: '2', company_name: 'Rotary Club', invoice_count: 2, total_revenue: 900 },
    { customer_id: '9', company_name: 'Acme', invoice_count: 3, total_revenue: 100000 },
    { customer_id: '10', company_name: 'Beta', invoice_count: 0, total_revenue: 0 },
  ];
  const conf = (id, referrer, referred, extra) => ({
    id, status: 'confirmed', referred_at: '2026-03-01', referrer_customer_id: referrer, referred_customer_id: referred, referred_name: 'x' + id, ...extra,
  });

  t.test('ranking counts distinct confirmed people, not entries or dollars', () => {
    const list = [
      conf('A', '1', '9'), conf('B', '1', '10'),
      conf('A2', '1', '9'), // logged twice: must not count twice
      conf('C', '2', '9', { thanked_at: '2026-03-02' }),
      { id: 'D', status: 'to_confirm', referred_at: '2026-03-01', referrer_customer_id: '2', referred_name: 'Gamma' },
      { id: 'E', status: 'not_referral', referred_at: '2026-03-01', referrer_customer_id: '2', referred_name: 'Delta' },
      conf('F', '2', '10', { referred_at: '2025-11-30' }), // last fiscal year
    ];
    const r = R.rankReferrers(list, 2026, roster);
    t.equal(r.rows[0].referrer_name, 'YMCA of Ankeny');
    t.equal(r.rows[0].count, 2);
    t.equal(r.rows[0].ordered, 1, 'Beta has not ordered');
    t.equal(r.rows[0].revenue, 100000, 'a double-logged client adds its revenue once');
    t.equal(r.rows[1].count, 1);
    t.equal(r.toConfirm, 1);
    t.equal(r.unthanked, 3, 'counted per logged referral');
    t.equal(r.tie, false);
    t.equal(r.leader.referrer_customer_id, '1');
  });

  t.test('a tie is a tie, and revenue never breaks it', () => {
    const list = [conf('A', '1', '10'), conf('B', '2', '9')]; // Rotary's referral is worth $100k
    const r = R.rankReferrers(list, 2026, roster);
    t.equal(r.tie, true);
    t.equal(r.leader, null);
    t.equal(r.rows[0].rank, 1);
    t.equal(r.rows[1].rank, 1);
  });

  t.test('an inquiry that heard about us by word of mouth is offered as a referral', () => {
    const h = R.referralHintFromLead({ inquiry_notes: 'Project: shirts\nHeard about us: Word of mouth, Jen at the YMCA' });
    t.equal(h.who, 'Jen at the YMCA');
    t.equal(R.referralHintFromLead({ inquiry_notes: 'Heard about us: Search engine, google' }), null);
    t.assert(R.referralHintFromLead({ source_type: 'Referral' }), 'a hand-set Referral source counts');
  });

  t.test('suggested referrers come from the roster by name', () => {
    const s = R.suggestReferrers('Jen at the YMCA of Ankeny told us', roster, 3);
    t.equal(s[0] && s[0].customer_id, '1');
  });

  /* ---- referrals route -------------------------------------------------- */

  await t.test('an account without BackBone cannot read referrals', async () => {
    seed();
    const res = await call(refRoute.default, { as: 'shop' });
    t.equal(res.statusCode, 403);
  });

  await t.test('an AM logs, the duplicate is refused, and ids come from the server', async () => {
    seed();
    const a = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Acme', referred_customer_id: '9', id: 'REF-9999' } });
    t.equal(a.statusCode, 200);
    t.equal(a.body.referral.id, 'REF-0001', 'a browser-sent id is ignored');
    const b = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Acme again', referred_customer_id: '9' } });
    t.equal(b.statusCode, 409);
    const c = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Beta' } });
    t.equal(c.body.referral.id, 'REF-0002');
  });

  await t.test('confirming needs a referrer, then counts', async () => {
    seed();
    const a = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Acme' } });
    const id = a.body.referral.id;
    const no = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'confirm', id } });
    t.equal(no.statusCode, 400);
    await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'update', id, referrer_customer_id: '1', referrer_name: 'YMCA' } });
    const yes = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'confirm', id } });
    t.equal(yes.statusCode, 200);
    t.equal(yes.body.referral.confirmed_by, 'alexis');
  });

  await t.test('a read-only account can read but not write, and only the Admin flag deletes', async () => {
    seed();
    const a = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Acme' } });
    const id = a.body.referral.id;
    const g = await call(refRoute.default, { as: 'viewer' });
    t.equal(g.statusCode, 200);
    t.equal(g.body.canEdit, false);
    const w = await call(refRoute.default, { as: 'viewer', method: 'POST', body: { action: 'create', referred_name: 'Zed' } });
    t.equal(w.statusCode, 403);
    const d1 = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'delete', id } });
    t.equal(d1.statusCode, 403, 'an AM cannot delete');
    const d2 = await call(refRoute.default, { as: 'ryan', method: 'POST', body: { action: 'delete', id } });
    t.equal(d2.statusCode, 200);
    const after = await call(refRoute.default, { as: 'ryan' });
    t.equal(after.body.referrals.length, 0);
  });

  t.test('a lead-logged referral and a client-logged one for the same person are the same person', () => {
    const list = [{ id: 'REF-1', referred_lead_id: 'lead_1', referred_name: "Bob's Tees LLC", status: 'confirmed' }];
    t.assert(R.findDuplicate(list, { referred_customer_id: '44', referred_name: 'Bobs Tees' }), 'matched on the cleaned-up name');
    t.assert(R.findDuplicate(list, { referred_lead_id: 'lead_1', referred_name: 'Anything' }), 'matched on the lead');
  });

  t.test('an own-accounts user sees referrals touching their clients, or ones they logged', () => {
    const list = [
      { id: 'A', referred_customer_id: '1', created_by: 'x' },
      { id: 'B', referrer_customer_id: '2', created_by: 'x' },
      { id: 'C', referred_customer_id: '9', created_by: 'alexis' },
      { id: 'D', referred_customer_id: '9', created_by: 'x' },
    ];
    const v = R.visibleReferrals(list, { ownIds: new Set(['1', '2']), me: 'Alexis' });
    t.equal(v.map((r) => r.id).join(','), 'A,B,C');
    t.equal(R.visibleReferrals(list, { ownIds: null }).length, 4);
  });

  await t.test('the route applies own-accounts scope to reads and writes', async () => {
    seed();
    const users = JSON.parse(kv.get(P + 'users'));
    users.hannah = { username: 'hannah', name: 'Hannah Posey', access: { apps: ['backbone'], data_scope: 'own' } };
    kv.set(P + 'users', JSON.stringify(users));
    kv.set('backbone_data', JSON.stringify({ synced: [], enrichment: { '1': { account_manager: 'Hannah Posey' }, '9': { account_manager: 'Alexis Davis' } } }));
    const a = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Acme', referred_customer_id: '9' } });
    const b = await call(refRoute.default, { as: 'alexis', method: 'POST', body: { action: 'create', referred_name: 'Ymca', referred_customer_id: '1' } });
    const g = await call(refRoute.default, { as: 'hannah' });
    t.equal(g.body.referrals.map((r) => r.id).join(','), b.body.referral.id, 'only the one naming her client');
    const w = await call(refRoute.default, { as: 'hannah', method: 'POST', body: { action: 'confirm', id: a.body.referral.id } });
    t.equal(w.statusCode, 404, 'cannot act on one she cannot see');
    const dup = await call(refRoute.default, { as: 'hannah', method: 'POST', body: { action: 'create', referred_name: 'Acme', referred_customer_id: '9' } });
    t.equal(dup.statusCode, 409);
    t.equal(dup.body.existing, null, 'the hidden record is not handed back');
  });

  /* ---- capacity rules --------------------------------------------------- */

  t.test('the work week is Monday to Friday, Central, and a weekend looks ahead', () => {
    const thu = C.workWeeks(new Date('2026-10-01T17:00:00Z')); // Thu Oct 1
    t.equal(thu.thisWeek.join(','), '2026-09-28,2026-09-29,2026-09-30,2026-10-01,2026-10-02');
    t.equal(thu.nextWeek[0], '2026-10-05');
    const sat = C.workWeeks(new Date('2026-10-03T17:00:00Z'));
    t.equal(sat.thisWeek[0], '2026-10-05');
    const lateSunUtc = C.workWeeks(new Date('2026-10-05T03:00:00Z')); // still Sunday night in Iowa
    t.equal(lateSunUtc.thisWeek[0], '2026-10-05');
  });

  t.test('days out: full days per weekday, part days count half, denied never counts', () => {
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
    const m = C.daysOut([
      { status: 'approved', type: 'all_days', start_date: '2026-09-26', end_date: '2026-09-29' },
      { status: 'pending', type: 'appointment', start_date: '2026-10-01', end_date: '2026-10-01' },
      { status: 'denied', type: 'all_days', start_date: '2026-10-02', end_date: '2026-10-02' },
    ], days);
    t.equal(Object.keys(m).sort().join(','), '2026-09-28,2026-09-29,2026-10-01');
    t.equal(m['2026-10-01'].amount, 0.5);
    t.equal(m['2026-10-01'].pending, true);
  });

  t.test('names match across apps on full name or first and last, never first alone', () => {
    t.assert(C.samePerson('Hannah Posey', 'Hannah M. Posey'));
    t.assert(C.samePerson('alexis davis', 'Alexis Davis'));
    t.assert(!C.samePerson('Jacob', 'Jacob Whitman'));
  });

  const ams = ['Alexis Davis', 'Hannah Posey'];
  const capRoster = [{ customer_id: '1', am: 'Alexis Davis' }, { customer_id: '2', am: 'Hannah Posey' }, { customer_id: '3', am: '' }];
  const wl = [
    { customer_id: '1', quotes: 2, inProgress: 6, onHold: 2, quotesValue: 1000, inProgressValue: 6000, onHoldValue: 500 },
    { customer_id: '2', quotes: 1, inProgress: 8, onHold: 0, quotesValue: 200, inProgressValue: 9000, onHoldValue: 0 },
    { customer_id: '3', quotes: 4, inProgress: 1, onHold: 0 },
  ];
  const monday = new Date('2026-09-28T15:00:00Z');

  t.test('capacity sums quotes, jobs and values per AM; unassigned clients are kept apart', () => {
    const c = C.computeCapacity({ ams, roster: capRoster, workload: wl, now: monday });
    const a = c.rows.find((r) => r.am === 'Alexis Davis');
    t.equal(a.jobs, 8);
    t.equal(a.jobsValue, 6500);
    t.equal(a.quotesValue, 1000);
    t.equal(c.unassigned.quotes, 4);
    t.equal(c.outKnown, false);
    t.equal(a.load, null, 'no time off means no per-day load');
    t.equal(c.rows[0].am, 'Hannah Posey', 'equal jobs, so fewer open quotes goes first');
  });

  t.test('time off changes who has room: fewer jobs but out three days ranks below', () => {
    const out = {
      'Alexis Davis': [{ status: 'approved', type: 'all_days', start_date: '2026-09-30', end_date: '2026-10-02' }],
      'Hannah Posey': [],
    };
    const c = C.computeCapacity({ ams, roster: capRoster, workload: wl, out, now: monday });
    t.equal(c.rows[0].am, 'Hannah Posey', '8 jobs over 5 days beats 8 jobs over 2');
    const a = c.rows.find((r) => r.am === 'Alexis Davis');
    t.equal(a.outThisWeek, 3);
    t.equal(a.daysInLeft, 2);
    t.equal(a.load, 4);
  });

  t.test('a snapshot from before the values existed shows no dollars rather than $0', () => {
    const old = wl.map((w) => ({ customer_id: w.customer_id, quotes: w.quotes, inProgress: w.inProgress, onHold: w.onHold }));
    const c = C.computeCapacity({ ams, roster: capRoster, workload: old, now: monday });
    t.equal(c.hasValues, false);
    t.equal(c.rows[0].jobsValue, null);
  });

  /* ---- capacity route --------------------------------------------------- */

  await t.test('an AM gets no days out; the calendar is for admins and approvers', async () => {
    seed();
    const res = await call(capRoute.default, { as: 'alexis', query: { names: 'Alexis Davis|Hannah Posey' } });
    t.equal(res.statusCode, 200);
    t.equal(res.body.canSeeOut, false);
    t.equal(JSON.stringify(res.body.out), '{}');
  });

  await t.test('an approver without the Admin flag sees days out', async () => {
    seed();
    const res = await call(capRoute.default, { as: 'megan', query: { names: 'Alexis Davis' } });
    t.equal(res.body.canSeeOut, true);
    t.equal(res.body.out['Alexis Davis'].length, 1);
  });

  await t.test('the route sends dates only, for the names asked, and says who it could not match', async () => {
    seed();
    const res = await call(capRoute.default, { as: 'ryan', query: { names: 'Alexis Davis|Hannah Posey|Old Timer|Nobody Here' } });
    const a = res.body.out['Alexis Davis'][0];
    t.equal(Object.keys(a).sort().join(','), 'end_date,start_date,status,type', 'no hours, notes or ids');
    t.equal(res.body.out['Hannah Posey'].length, 0, 'denied is dropped, and an old appointment is outside the window');
    t.equal(res.body.unmatched.join(','), 'Old Timer,Nobody Here', 'terminated people do not match');
    t.equal(JSON.stringify(res.body).indexOf('private reason'), -1);
  });

  await t.test('an account without BackBone is refused', async () => {
    seed();
    const res = await call(capRoute.default, { as: 'shop' });
    t.equal(res.statusCode, 403);
  });

  /* ---- wiring ----------------------------------------------------------- */

  t.test('BackBone registers a Referrals view', () => {
    const bb = reg.APPS.find((a) => a.id === 'backbone');
    t.assert(bb.views.some(([k, label]) => k === 'referrals' && label === 'Referrals'));
  });

  t.test('every element the new BackBone code reads exists in the markup', () => {
    const template = read('apps/backbone/template.js');
    const main = read('apps/backbone/main.js');
    const ids = [
      'detailLinks', 'detailReferrals', 'clientReferralBtn', 'leadReferralBtn',
      'page-referrals', 'refKpiGrid', 'refYearSelect', 'refNewBtn', 'refYearHelp', 'refRankWrap',
      'refSearch', 'refStatusFilter', 'refListWrap', 'referralOverlay', 'refModalTitle',
      'refModalClose', 'refModalStatus', 'refReferredInput', 'refSaidInput', 'refReferrerInput',
      'refSuggest', 'refDateInput', 'refNoteInput', 'refThankBox', 'refThankHow', 'refThankOn',
      'refThankBtn', 'refHistory', 'refClientList', 'refModalErr', 'refSaveBtn', 'refConfirmBtn',
      'refRejectBtn', 'refReopenBtn', 'refDeleteBtn', 'dashCapacityWrap', 'dashCapacityStamp',
    ];
    ids.forEach((id) => {
      t.assert(template.indexOf('id="' + id + '"') !== -1, 'template.js has no #' + id);
      t.assert(main.indexOf('"' + id + '"') !== -1, 'main.js never reads #' + id + ' (stale list?)');
    });
    t.equal(template.indexOf('dashCapacitySoon'), -1, 'the coming-soon card is gone');
  });
});
