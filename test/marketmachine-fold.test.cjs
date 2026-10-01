// PUT IN: test/marketmachine-fold.test.cjs
/**
 * MailMe folded into MarketMachine (Oct 1 2026).
 *
 * One app for campaigns and email. Account Managers read every campaign and
 * change their own (Ryan's call); nobody but an Admin sees money; the MailMe
 * grant still decides who can send email and now brings MarketMachine with it.
 * Real calls: the access rulebook, permsFor over a fake Upstash, the registry.
 */
const path = require('path');
const fs = require('fs');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

const kv = new Map();
const ok = (result) => ({ ok: true, status: 200, json: async () => result });
global.fetch = async (url, opts) => {
  const raw = String(url);
  if (/\/pipeline$/.test(raw)) {
    return ok(JSON.parse(opts.body).map(([op, key, val]) => {
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      return { result: null };
    }));
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return ok({ result: kv.has(key) ? kv.get(key) : null });
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

(async () => {
  const m = await import(path.join(ROOT, 'lib/marketmachine/member.js'));
  const access = await import(path.join(ROOT, 'lib/marketmachine/access.js'));
  const users = await import(path.join(ROOT, 'lib/users.js'));
  const reg = await import(path.join(ROOT, 'js/registry.js'));

  /* ---- the rulebook ---- */
  const CAMP = { id: 'CP-1', budget: 900, calc: { inputs: {} }, scorecard: [{ a: 1 }], name: 'Holiday',
    steps: [{ key: 'write', approval: false }, { key: 'prelaunch_review', approval: true }] };
  const ME = { id: 'E-7', name: 'Hannah Posey' };

  await t.test('a member reads a campaign without its money', () => {
    const c = m.withoutMoney(CAMP);
    t.equal(c.budget, undefined); t.equal(c.calc, undefined); t.equal(c.scorecard, undefined);
    t.equal(c.name, 'Holiday', 'everything else is there');
    t.equal(CAMP.budget, 900, 'the stored record is untouched');
  });

  await t.test('trip spend is money too; the trips are not', () => {
    const conn = { travel: { total: 500, pending: 100, trips: [{ id: 'T1', name: 'ISS', total: 500 }] }, email: { count: 2 } };
    const out = m.connectionsWithoutMoney(conn);
    t.equal(out.travel.total, undefined); t.equal(out.travel.trips[0].total, undefined);
    t.equal(out.travel.trips[0].name, 'ISS'); t.equal(out.email.count, 2);
  });

  await t.test('their own campaign: ordinary edits pass, the budget is dropped', () => {
    const v = m.memberWrite({ method: 'PATCH', q: { id: 'CP-1' }, body: { name: 'New', budget: 5 }, campaign: CAMP, mine: true, me: ME });
    t.equal(v.ok, true); t.equal(v.body.name, 'New'); t.equal(v.body.budget, undefined);
  });

  await t.test('their own campaign: approvals, numbers and deletes are still refused', () => {
    t.equal(m.memberWrite({ method: 'PATCH', q: { step: 'prelaunch_review' }, body: {}, campaign: CAMP, mine: true, me: ME }).status, 403);
    t.equal(m.memberWrite({ method: 'PATCH', q: { step: 'write' }, body: { done: true }, campaign: CAMP, mine: true, me: ME }).ok, true, 'a normal step is fine');
    t.equal(m.memberWrite({ method: 'PATCH', q: { calc: 1 }, body: {}, campaign: CAMP, mine: true, me: ME }).status, 403);
    t.equal(m.memberWrite({ method: 'PATCH', q: { scorecard: 1 }, body: {}, campaign: CAMP, mine: true, me: ME }).status, 403);
    t.equal(m.memberWrite({ method: 'DELETE', q: {}, body: {}, campaign: CAMP, mine: true, me: ME }).status, 403);
  });

  await t.test('somebody else\'s campaign: nothing changes', () => {
    ['PATCH', 'POST'].forEach((method) => {
      const v = m.memberWrite({ method, q: method === 'POST' ? { art: 1 } : {}, body: { name: 'x' }, campaign: CAMP, mine: false, me: ME });
      t.equal(v.status, 403, method);
    });
  });

  await t.test('a new campaign always has its maker on it, and no budget', () => {
    const v = m.memberWrite({ method: 'POST', q: {}, body: { type: 'quick_email', budget: 10, accountManagers: [{ id: 'E-9', name: 'Abby' }] }, campaign: null, mine: false, me: ME });
    t.equal(v.ok, true);
    t.equal(v.body.budget, undefined);
    t.equal(v.body.accountManagers.map((a) => a.id).join(','), 'E-7,E-9', 'her first, the one she picked kept');
    t.equal(m.memberWrite({ method: 'POST', q: {}, body: {}, campaign: null, mine: false, me: null }).status, 403, 'no employee record, no campaign in her name');
    t.equal(m.memberWrite({ method: 'POST', q: { demo: 'load' }, body: {}, campaign: null, mine: false, me: ME }).status, 403, 'no demo data');
  });

  /* ---- who is an Admin ---- */

  await t.test('full access is the Settings tick on the stored account, never perms', () => {
    t.assert(access.isMarketMachineAdmin({ access: { views: { marketmachine: ['settings'] } } }));
    t.assert(!access.isMarketMachineAdmin({ access: { views: { marketmachine: ['tasks', 'campaigns', 'calendar', 'email'] } } }),
      'saving an Account Manager\'s default ticks does not make them an Admin');
    t.assert(!access.isMarketMachineAdmin({ tabs: ['marketmachine', 'marketmachine:settings', 'marketmachine:campaigns'] }));
    t.assert(access.isMarketMachineAdmin({ superuser: true }));
  });

  /* ---- the grant ---- */

  kv.set('alliteration:users', JSON.stringify({
    mailonly: { username: 'mailonly', name: 'Mail Only', access: { apps: ['mailme'], can_edit: true } },
    am: { username: 'am', name: 'Plain AM', access: { apps: ['marketmachine'] } },
    narrowed: { username: 'narrowed', name: 'Narrowed', access: { apps: ['mailme', 'marketmachine'], views: { marketmachine: ['tasks'] } } },
  }));

  await t.test('the MailMe grant brings MarketMachine and its Email screen', async () => {
    const p = await users.permsFor('mailonly');
    t.assert(p.tabs.includes('marketmachine'), 'MarketMachine came with it');
    t.assert(p.tabs.includes('mailme'), 'the email switch is still there for the email routes');
    t.equal(reg.allowedViews(p, 'marketmachine').join(','), 'tasks,campaigns,email,calendar');
  });

  await t.test('MarketMachine without the email switch has no Email screen', async () => {
    const p = await users.permsFor('am');
    t.equal(reg.allowedViews(p, 'marketmachine').join(','), 'tasks,campaigns,calendar');
  });

  await t.test('an account narrowed by hand stays narrowed, and still gets Email if it can send', async () => {
    const p = await users.permsFor('narrowed');
    t.equal(reg.allowedViews(p, 'marketmachine').join(','), 'tasks,email');
  });

  /* ---- the rail and old links ---- */

  await t.test('MailMe is off the rail and its old links land in MarketMachine', () => {
    const mm = reg.getApp('mailme');
    t.equal(mm.railHidden, true);
    t.equal(mm.foldedInto.app, 'marketmachine');
    ['campaigns', 'audience', 'reports'].forEach((v) => t.equal(mm.foldedInto.views[v], 'email', v));
    t.equal(mm.foldedInto.views.settings, 'settings');
    t.assert(reg.getApp('marketmachine').views.some(([k]) => k === 'email'), 'MarketMachine has the Email screen');
    t.assert(reg.firstAllowed({ tabs: ['mailme'] }) === null || reg.firstAllowed({ tabs: ['mailme'] }).id !== 'mailme',
      'nobody is ever sent to MailMe as their first app');
  });

  await t.test('the shell forwards a folded app before anything else', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'js/shell.js'), 'utf8');
    const fn = shell.slice(shell.indexOf('async function handleRoute'));
    t.assert(fn.indexOf('foldedInto') !== -1 && fn.indexOf('foldedInto') < fn.indexOf('canAccess(state.perms, appId)'),
      'forwarded before the access check, so a MailMe-only bookmark still works');
    t.assert(/!a\.railHidden && canAccess/.test(shell), 'and the rail skips it');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
