// PUT IN: test/marketmachine-demo.test.cjs
/**
 * Example campaigns (Sept 2026), for showing MarketMachine to somebody before
 * real work goes in it.
 *
 * What is worth breaking a build over:
 *   - removing the examples deletes the examples and NOTHING else, matched on
 *     the flag rather than the name
 *   - an example never shares an id with a real campaign
 *   - the examples obey the real rules: real checklists, real locks, real
 *     dates, so nobody is shown behaviour the app does not have
 *   - they touch no other app: no invented trips, leads, emails or invoices
 *   - loading and removing are Admin only
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
  const demo = await import('../lib/marketmachine/demo.js');
  const store = await import('../lib/marketmachine/store.js');
  const cat = await import('../lib/marketmachine/catalog.js');
  const model = await import('../lib/marketmachine/campaign.js');
  const tasks = await import('../lib/marketmachine/tasks.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }
  const S = { username: 'ryan', name: 'Ryan Toney' };

  t.test('the examples are built by the real rules, not drawn by hand', () => {
    const made = demo.demoCampaigns(S, '2026-09-17');
    t.equal(made.length, 5, 'five examples');
    made.forEach((c) => {
      t.assert(c.demo === true, c.name + ' is flagged as an example');
      t.assert(c.name.startsWith('EXAMPLE'), c.name + ' says so in its name');
      const meta = cat.typeMeta(c.type);
      t.assert(meta, c.name + ' has a real campaign type');
      t.equal(c.steps.length, meta.steps.length, c.name + ' carries that type\'s whole checklist');
      t.equal(c.catalogVersion, cat.CATALOG_VERSION, c.name + ' records the checklist version');
    });
  });

  t.test('no example shows the app doing something it cannot do', () => {
    demo.demoCampaigns(S, '2026-09-17').forEach((c) => {
      // Nothing is ticked that the real rules would refuse, and nothing is
      // marked not applicable that the master says is required.
      c.steps.filter((s) => s.done).forEach((s) => {
        (s.after || []).forEach((dep) => {
          const before = c.steps.find((x) => x.key === dep);
          t.assert(before && (before.done || before.notApplicable),
            `${c.name}: "${s.label}" is ticked while "${dep}" is not`);
        });
      });
      c.steps.filter((s) => s.notApplicable).forEach((s) =>
        t.assert(s.na, `${c.name}: "${s.label}" is required and cannot be skipped`));
      t.assert(!c.links, c.name + ' invents no trip, lead or invoice in another app');
    });
  });

  t.test('the examples show the parts worth showing', () => {
    const made = demo.demoCampaigns(S, '2026-09-17');
    const show = made.find((c) => c.type === 'trade_show');
    t.assert(show, 'an event');
    t.equal(made.filter((c) => c.parentId === show.name).length, 2, 'with two campaigns connected under it');
    t.assert(made.some((c) => c.steps.some((s) => s.blocked)), 'one carries a blocker');
    t.assert(made.some((c) => c.steps.every((s) => s.done)), 'one is finished');
    t.assert(made.some((c) => c.scorecard && Object.keys(c.scorecard).length), 'one has its scorecard filled in');
    const tryOn = made.find((c) => c.type === 'try_on_day');
    t.assert(tryOn && tryOn.calc.inputs.tod_expected.value < 25, 'and one carries the under-25 warning');
  });

  kv.clear();
  seedUsers();

  await t.test('loading gives them real ids, and the connected ones really connect', async () => {
    const real = await call({ as: RYAN, method: 'POST', body: { type: 'postal', name: 'A real mailer' } });
    t.equal(real.body.campaign.id, 'CP-00001', 'a real campaign exists first');

    const loaded = await call({ as: RYAN, method: 'POST', query: { demo: 'load' } });
    t.equal(loaded.statusCode, 201, 'loaded: ' + JSON.stringify(loaded.body));
    t.equal(loaded.body.created, 5, 'five examples');

    const list = await call({ as: RYAN });
    t.equal(list.body.campaigns.length, 6, 'six campaigns in total');
    t.equal(list.body.demoCount, 5, 'and Settings knows five of them are examples');
    const ids = list.body.campaigns.map((c) => c.id);
    t.equal(new Set(ids).size, ids.length, 'no id is shared with the real campaign');

    const show = list.body.campaigns.find((c) => c.type === 'trade_show');
    t.equal(show.childCount, 2, 'the event holds its two connected campaigns');
    const child = list.body.campaigns.find((c) => c.type === 'digital_platform');
    t.equal(child.parentId, show.id, 'and a child points at a real id, not a name');
    t.assert(child.progress.done > 0, 'with some work already done on it');
  });

  await t.test('an id that exists but is not listed is never written over', async () => {
    // The store checks the record as well as the index, because a campaign
    // whose index write failed still exists and is still somebody's work.
    const orphanId = 'CP-00042';
    kv.set(`marketmachine:v2:campaign:${orphanId}`, JSON.stringify({ id: orphanId, name: 'Orphan, not in the index', type: 'postal', status: 'open', steps: [] }));
    kv.set('marketmachine:v2:index', JSON.stringify(['CP-00041']));
    kv.set('marketmachine:v2:campaign:CP-00041', JSON.stringify({ id: 'CP-00041', name: 'Listed', type: 'postal', status: 'open', steps: [] }));
    await call({ as: RYAN, method: 'POST', query: { demo: 'load' } });
    const orphan = await store.getCampaign(orphanId);
    t.equal(orphan.name, 'Orphan, not in the index', 'the unlisted campaign is untouched');
    await call({ as: RYAN, method: 'DELETE', query: { demo: 'all' } });
    kv.clear();
    seedUsers();
    await call({ as: RYAN, method: 'POST', body: { type: 'postal', name: 'A real mailer' } });
    await call({ as: RYAN, method: 'POST', query: { demo: 'load' } });
  });

  await t.test('an example behaves like a campaign when you open it', async () => {
    const list = await call({ as: RYAN });
    const tryOn = list.body.campaigns.find((c) => c.type === 'try_on_day');
    const d = await call({ as: RYAN, query: { id: tryOn.id } });
    t.equal(d.statusCode, 200, 'it opens');
    t.equal(d.body.advisories.length, 1, 'the under-25 warning shows');
    t.assert(d.body.calculations.length > 5, 'its calculations are there');
    t.assert(d.body.scorecard.length > 0, 'and its scorecard rows');
    const picks = list.body.campaigns.find((c) => c.type === 'picks');
    const p = await call({ as: RYAN, query: { id: picks.id } });
    const rate = p.body.calculations.find((c) => c.key === 'picks_click_rate');
    t.equal(rate.value, 13.1, 'the finished example really computes: 61 clickers of 466 delivered');
  });

  await t.test('examples appear as tasks, and say EXAMPLE where a person will read it', async () => {
    const mine = await call({ as: RYAN, query: { mine: 'tasks' } });
    const fromExamples = mine.body.tasks.filter((x) => x.campaignId !== 'CP-00001');
    t.assert(fromExamples.length > 0, 'Ryan has example steps, since some name him');
    t.assert(fromExamples.every((x) => x.campaignName.startsWith('EXAMPLE')),
      'and every one says EXAMPLE in the line he reads, so nobody mistakes it for real work');
    t.assert(mine.body.tasks.some((x) => x.campaignId === 'CP-00001'),
      'while his real campaign is still in the same list, unchanged');
  });

  await t.test('removing takes the examples and leaves everything else alone', async () => {
    const before = await call({ as: RYAN });
    const realId = before.body.campaigns.find((c) => !c.name.startsWith('EXAMPLE')).id;

    const out = await call({ as: RYAN, method: 'DELETE', query: { demo: 'all' } });
    t.equal(out.body.removed, 5, 'five removed');
    const after = await call({ as: RYAN });
    t.equal(after.body.campaigns.length, 1, 'one campaign left');
    t.equal(after.body.campaigns[0].id, realId, 'and it is the real one');
    t.equal(after.body.demoCount, 0, 'no examples remain');
    t.equal((await call({ as: RYAN, query: { mine: 'tasks' } })).body.tasks.filter((x) => x.campaignName.startsWith('EXAMPLE')).length, 0,
      'and they are out of everybody\'s task list');
  });

  await t.test('a real campaign named like an example is never deleted', async () => {
    const decoy = await call({ as: RYAN, method: 'POST', body: { type: 'postal', name: 'EXAMPLE of what not to do' } });
    t.equal(decoy.statusCode, 201, 'somebody names a real campaign EXAMPLE');
    await call({ as: RYAN, method: 'POST', query: { demo: 'load' } });
    await call({ as: RYAN, method: 'DELETE', query: { demo: 'all' } });
    const left = await call({ as: RYAN });
    t.assert(left.body.campaigns.some((c) => c.id === decoy.body.campaign.id),
      'their campaign survives, because removal matches the flag and not the name');
  });

  await t.test('loading and removing examples are Admin only', async () => {
    t.equal((await call({ as: HANNAH, method: 'POST', query: { demo: 'load' } })).statusCode, 403, 'cannot load');
    t.equal((await call({ as: HANNAH, method: 'DELETE', query: { demo: 'all' } })).statusCode, 403, 'cannot remove');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
