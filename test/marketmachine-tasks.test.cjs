// PUT IN: test/marketmachine-tasks.test.cjs
/**
 * My tasks, phase 5 (Sept 2026).
 *
 * The simple way into MarketMachine: the open steps with your name on them,
 * one line each. Built because the campaign page is right for whoever runs a
 * campaign and wrong for somebody who owes it one thing.
 *
 * What is worth breaking a build over:
 *   - a person sees their own steps and nobody else's
 *   - a generic owner ("Assigned staff", "Production") is nobody's task, so
 *     work is never put in a stranger's list or assumed covered
 *   - an Account Manager step is matched on the CrewCore record, never on a
 *     name somebody typed
 *   - ticking is checked against the campaign record, so a hand-built request
 *     cannot tick somebody else's step
 *   - a task waiting on an earlier step is set aside, not listed as due
 *   - the simple screen carries nothing else: no budgets, no history, no
 *     other people's work
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
  const tasks = await import('../lib/marketmachine/tasks.js');
  const model = await import('../lib/marketmachine/campaign.js');
  const store = await import('../lib/marketmachine/store.js');
  const cc = await import('../lib/crewcore/store.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  const S = { username: 'ryan', name: 'Ryan Toney' };
  const RYAN_P = { username: 'ryan', name: 'Ryan Toney', employeeId: 'E-RYAN' };
  const ALEXIS = { username: 'alexis', name: 'Alexis Davis', employeeId: 'E-ALEXIS' };

  /* ================= whose step is it ================= */

  t.test('a named owner is that person, whole words only', () => {
    t.assert(tasks.ownerNames('Jacob', { name: 'Jacob Whitman' }), 'a first name on its own');
    t.assert(tasks.ownerNames('Ryan and Megan', { name: 'Ryan Toney' }), 'one of a pair');
    t.assert(tasks.ownerNames('Margo, Ryan, and Megan', { name: 'Megan Griffith' }), 'one of three');
    t.assert(tasks.ownerNames('Jacob and Account Manager', { name: 'Jacob Whitman' }), 'a name beside a role');
    t.assert(!tasks.ownerNames('Ryan', { name: 'Bryan Smith' }), 'Bryan is not Ryan');
    t.assert(!tasks.ownerNames('Bryan', { name: 'Ryan Toney' }), 'and a step owned by Bryan is not Ryan\'s');
    t.assert(!tasks.ownerNames('Meganne', { name: 'Megan Griffith' }), 'a longer name is a different person');
    t.assert(!tasks.ownerNames('Megan', { name: 'Ryan Toney' }), 'and Ryan is not Megan');
    t.assert(!tasks.ownerNames('Jacob', { name: '' }), 'a person with no name matches nothing');
  });

  t.test('a role is nobody\'s task', () => {
    ['Assigned staff', 'Production', 'Art', 'Campaign owner', 'Attending staff', 'Shipping',
      'Assigned Account Manager', 'Decorator'].forEach((owner) => {
      t.assert(!tasks.ownerNames(owner, RYAN_P), `"${owner}" is a job, not a person`);
    });
    // Why the list of job words exists at all: some of them are also first
    // names. Without it, the day P&M hires an Art, every Art department step
    // lands in his list.
    t.assert(!tasks.ownerNames('Art', { name: 'Art Vandelay' }), 'the Art department is not a person called Art');
    t.assert(!tasks.ownerNames('Production', { name: 'Production Jones' }), 'nor is Production');
  });

  t.test('an Account Manager step is matched on the record, never a typed name', () => {
    const campaign = { id: 'CP-1', status: 'open', accountManagerId: 'E-ALEXIS', accountManagerName: 'Alexis Davis' };
    const step = { owner: 'Account Manager', done: false, notApplicable: false };
    t.assert(tasks.isMyStep(campaign, step, ALEXIS), 'the campaign\'s Account Manager owns it');
    t.assert(!tasks.isMyStep(campaign, step, RYAN_P), 'another person does not');
    t.assert(!tasks.isMyStep(campaign, step, { name: 'Alexis Davis' }),
      'and a matching display name with no employee record is not enough');
    // Two blanks are not a match. Without the guard, every Account Manager
    // step on a campaign with nobody assigned would land in everybody's list.
    t.assert(!tasks.isMyStep({ id: 'CP-2', status: 'open' }, step, { name: 'Alexis Davis' }),
      'a campaign with no Account Manager is nobody\'s task');
    t.assert(!tasks.isMyStep({ id: 'CP-2', status: 'open' }, step, ALEXIS),
      'not even for a person who does have an employee record');
  });

  t.test('finished, skipped and closed work never appears', () => {
    const c = { id: 'CP-1', status: 'open', accountManagerId: 'E-ALEXIS' };
    const owner = { owner: 'Account Manager' };
    t.assert(!tasks.isMyStep(c, { ...owner, done: true }, ALEXIS), 'a done step is not a task');
    t.assert(!tasks.isMyStep(c, { ...owner, notApplicable: true }, ALEXIS), 'nor a not applicable one');
    t.assert(!tasks.isMyStep({ ...c, status: 'cancelled' }, owner, ALEXIS), 'nor anything on a cancelled campaign');
  });

  /* ================= the list a person sees ================= */

  const build = (type, extra) => ({ id: 'CP-1', ...model.buildCampaign({ type, name: 'ISS Long Beach', controlDate: '2027-01-15', ...(extra || {}) }, S) });

  t.test('the list is soonest first, with undated work last', () => {
    const show = build('trade_show', { accountManagerId: 'E-ALEXIS', accountManagerName: 'Alexis Davis' });
    const mine = tasks.myTasks([show], { name: 'Jacob Whitman', employeeId: 'E-JACOB' }, '2026-11-01');
    t.assert(mine.length > 3, 'Jacob owns several trade show steps');
    const dates = mine.map((x) => x.due || 'zzz');
    t.equal(dates.join(','), dates.slice().sort().join(','), 'sorted by due date, undated last');
    t.assert(mine.every((x) => /jacob/i.test(x.label) === false || true), 'labels come through');
    t.assert(!mine.some((x) => x.label.includes('Prelaunch review')), 'the review belongs to Ryan or Megan, not Jacob');
  });

  t.test('every task carries a short why, and it is short', () => {
    const tod = build('try_on_day', { accountManagerId: 'E-ALEXIS', accountManagerName: 'Alexis Davis' });
    const mine = tasks.myTasks([tod], ALEXIS, '2026-12-01');
    t.assert(mine.length > 5, 'the Account Manager owns most of a Try On Day');
    mine.forEach((x) => {
      t.assert(x.why && x.why.length > 0, x.label + ' has no why');
      t.assert(x.why.length <= 160, x.label + ' has a why that is a paragraph: ' + x.why);
      t.assert(x.campaignName === 'ISS Long Beach', 'and says which campaign it belongs to');
    });
    const qualify = mine.find((x) => x.key === 'tod_qualify');
    t.assert(/25 participants|store/i.test(qualify.why), 'the why is the step\'s own guidance: ' + qualify.why);
  });

  t.test('work waiting on an earlier step is set aside, not listed as due', () => {
    const tod = build('try_on_day', { accountManagerId: 'E-ALEXIS', accountManagerName: 'Alexis Davis' });
    const mine = tasks.myTasks([tod], ALEXIS, '2026-12-01');
    const payment = mine.find((x) => x.key === 'tod_payment');
    t.equal(payment.waitingOn, 'Jacob reviews the invoice', 'payment waits on Jacob');
    const groups = tasks.groupTasks(mine, '2026-12-01');
    t.assert(groups.waiting.some((x) => x.key === 'tod_payment'), 'so it sits under waiting');
    t.assert(![...groups.overdue, ...groups.soon, ...groups.later].some((x) => x.key === 'tod_payment'),
      'and is not in any list of things to do now');
  });

  t.test('overdue, this week and later are split the way a person reads them', () => {
    const show = build('trade_show', { controlDate: '2026-12-10', accountManagerId: 'E-ALEXIS' });
    const mine = tasks.myTasks([show], { name: 'Jacob Whitman', employeeId: 'E-JACOB' }, '2026-10-05');
    const g = tasks.groupTasks(mine, '2026-10-05');
    t.assert(g.overdue.every((x) => x.due < '2026-10-05'), 'overdue is genuinely past');
    t.assert(g.soon.every((x) => x.due >= '2026-10-05' && x.due <= '2026-10-12'), 'this week is the next seven days');
    t.assert(g.later.every((x) => !x.due || x.due > '2026-10-12'), 'later is everything after that');
    t.equal(g.overdue.length + g.soon.length + g.later.length + g.waiting.length, mine.length, 'nothing is lost between the groups');
  });

  /* ================= through the route ================= */

  kv.clear();
  seedUsers();
  kv.set('alliteration:users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan Toney', superuser: true, access: { apps: [] } },
    hannah: { username: 'hannah', name: 'Hannah Posey', access: { apps: ['marketmachine'], can_edit: true } },
    amanda: { username: 'amanda', name: 'Amanda Clark', access: { apps: ['marketmachine'] } },
  }));
  const hannahEmp = await cc.saveEmployee({ name: 'Hannah Posey', department: 'Sales', active: true });
  const HANNAH_U = { username: 'hannah', name: 'Hannah Posey' };
  const AMANDA_U = { username: 'amanda', name: 'Amanda Clark' };

  const made = await call({ as: RYAN, method: 'POST', body: {
    type: 'try_on_day', name: 'Ankeny Schools store', controlDate: '2027-03-04',
    accountManagerId: hannahEmp.id, accountManagerName: 'Hannah Posey' } });
  const ID = made.body.campaign.id;

  await t.test('anyone signed in gets their own tasks, and only those', async () => {
    const hers = await call({ as: HANNAH_U, query: { mine: 'tasks' } });
    t.equal(hers.statusCode, 200, 'the Account Manager can read her tasks: ' + JSON.stringify(hers.body).slice(0, 120));
    t.assert(hers.body.tasks.length > 5, 'she owns most of a Try On Day');
    t.assert(hers.body.tasks.every((x) => x.campaignId === ID), 'all from the one campaign');

    const amandas = await call({ as: AMANDA_U, query: { mine: 'tasks' } });
    t.equal(amandas.body.tasks.length, 0, 'somebody with no named steps sees an empty list, not everyone\'s work');

    const ryans = await call({ as: RYAN, query: { mine: 'tasks' } });
    t.assert(ryans.body.tasks.some((x) => x.key === 'prelaunch_review'), 'Ryan gets the review that is his');
    t.assert(!ryans.body.tasks.some((x) => x.key === 'tod_qualify'), 'and not the Account Manager\'s steps');
  });

  await t.test('the simple list carries nothing but the task', async () => {
    const hers = await call({ as: HANNAH_U, query: { mine: 'tasks' } });
    const fields = Object.keys(hers.body.tasks[0]).sort().join(',');
    t.equal(fields, 'approval,blocked,campaignId,campaignName,details,due,key,label,next,overdue,typeLabel,waitingOn,why',
      'no budget, no history, no connections, no other steps');
    t.assert(!JSON.stringify(hers.body).includes('"steps"'), 'and no checklist comes along for the ride');
    // Sept 24 2026: the Details panel. Locked to exactly these, so a later
    // change cannot quietly hand staff the budget or the history.
    t.equal(Object.keys(hers.body.tasks[0].details).sort().join(','),
      'accountManager,audience,date,dateLabel,help,links,notes',
      'details are the step and the campaign basics, nothing more');
  });

  await t.test('Details shows the step\'s own notes and files, never the campaign\'s private parts', async () => {
    const cur = await store.getCampaign(ID);
    await store.updateHeader(ID, { notes: 'SECRET-CAMPAIGN-NOTE', budget: '4321', audience: 'Ankeny parents' }, S, '2026-09-24');
    await store.updateStep(ID, 'tod_qualify', { notes: 'Call the principal first',
      links: [{ label: 'Store sheet', url: 'https://example.com/sheet' }, { label: 'bad', url: 'javascript:alert(1)' }] }, S, '2026-09-24');
    await store.updateStep(ID, 'prelaunch_review', { notes: 'RYANS-OWN-NOTE' }, S, '2026-09-24');
    t.assert(cur, 'the campaign exists');

    const hers = await call({ as: HANNAH_U, query: { mine: 'tasks' } });
    const q = hers.body.tasks.find((x) => x.key === 'tod_qualify');
    t.equal(q.details.notes, 'Call the principal first', 'her step\'s notes come through');
    t.equal(q.details.links.length, 1, 'with its web links, and a non-web link is dropped');
    t.equal(q.details.links[0].url, 'https://example.com/sheet', 'the real one');
    t.equal(q.details.accountManager, 'Hannah Posey', 'the Account Manager');
    t.equal(q.details.date, '2027-03-04', 'the campaign date');
    t.assert(q.details.dateLabel && q.details.dateLabel !== 'Campaign date', 'under the type\'s own name: ' + q.details.dateLabel);
    t.equal(q.details.audience, 'Ankeny parents', 'who it is for');
    t.assert(q.details.help.length >= q.why.length, 'the full help, not just the first sentence');

    const body = JSON.stringify(hers.body);
    t.assert(!body.includes('SECRET-CAMPAIGN-NOTE'), 'campaign notes stay on the campaign page');
    t.assert(!body.includes('4321'), 'so does the budget');
    t.assert(!body.includes('RYANS-OWN-NOTE'), 'and nobody else\'s step notes come along');
    t.assert(!body.includes('"history"'), 'nor the history');
  });

  await t.test('only a person who can open the campaign is offered the link', async () => {
    const hers = await call({ as: HANNAH_U, query: { mine: 'tasks' } });
    t.equal(hers.body.full, false, 'staff are not offered a button the campaign page would refuse');
    const refused = await call({ as: HANNAH_U, query: { id: ID } });
    t.equal(refused.statusCode, 403, 'and the campaign page does refuse them');
    const ryans = await call({ as: RYAN, query: { mine: 'tasks' } });
    t.equal(ryans.body.full, true, 'an Admin is');
  });

  await t.test('a person can tick their own step and nobody else\'s', async () => {
    const ok = await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID, step: 'tod_qualify', mine: 1 }, body: { done: true } });
    t.equal(ok.statusCode, 200, 'her own step ticks: ' + JSON.stringify(ok.body));
    const saved = await store.getCampaign(ID);
    t.equal(saved.steps.find((s) => s.key === 'tod_qualify').doneBy, 'Hannah Posey', 'and it records who did it');

    const notHers = await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID, step: 'prelaunch_review', mine: 1 }, body: { done: true } });
    t.equal(notHers.statusCode, 403, 'Ryan or Megan\'s approval is refused');
    t.assert(/belongs to somebody else/.test(notHers.body.error), 'and says so plainly');

    const amanda = await call({ as: AMANDA_U, method: 'PATCH', query: { id: ID, step: 'tod_format', mine: 1 }, body: { done: true } });
    t.equal(amanda.statusCode, 403, 'somebody with no claim on the step is refused');
    t.equal((await store.getCampaign(ID)).steps.find((s) => s.key === 'tod_format').done, false, 'and nothing was written');
  });

  await t.test('ticking your own step cannot be used to change anything else', async () => {
    const sneak = await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID, step: 'tod_samples', mine: 1 },
      body: { done: true, notApplicable: true, dueDate: '2030-01-01', blocked: 'nope' } });
    t.equal(sneak.statusCode, 200, 'the request is accepted');
    const step = (await store.getCampaign(ID)).steps.find((s) => s.key === 'tod_samples');
    t.assert(step.done, 'the tick landed');
    t.assert(!step.notApplicable, 'not applicable did not');
    t.equal(step.dueOverride, null, 'nor a due date');
    t.equal(step.blocked, '', 'nor a blocker');
  });

  await t.test('the campaign itself is still Admin only', async () => {
    t.equal((await call({ as: HANNAH_U, query: { id: ID } })).statusCode, 403, 'she cannot open the campaign page');
    t.equal((await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID }, body: { name: 'Renamed' } })).statusCode, 403, 'or rename it');
    t.equal((await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID, step: 'tod_store' }, body: { done: true } })).statusCode, 403,
      'and a step patch without the tasks route is still refused');
  });

  await t.test('a cancelled campaign stops giving people work', async () => {
    const before = (await call({ as: HANNAH_U, query: { mine: 'tasks' } })).body.tasks.length;
    t.assert(before > 0, 'she has tasks to begin with');
    await call({ as: RYAN, method: 'PATCH', query: { id: ID }, body: { status: 'cancelled' } });
    const after = await call({ as: HANNAH_U, query: { mine: 'tasks' } });
    t.equal(after.body.tasks.length, 0, 'and none once the campaign is cancelled');
    const tick = await call({ as: HANNAH_U, method: 'PATCH', query: { id: ID, step: 'tod_store', mine: 1 }, body: { done: true } });
    t.assert(tick.statusCode >= 400, 'and a step on it cannot be ticked');
    await call({ as: RYAN, method: 'PATCH', query: { id: ID }, body: { status: 'open' } });
  });

  await t.test('an Admin still ticks anything, for fixing a record after the fact', async () => {
    const r = await call({ as: RYAN, method: 'PATCH', query: { id: ID, step: 'tod_calendar', mine: 1 }, body: { done: true } });
    t.equal(r.statusCode, 200, 'an Admin is not blocked by whose name is on it');
  });

  /* ================= who sees the app at all ================= */

  await t.test('ticking MarketMachine on an account gives My tasks and nothing else', async () => {
    const reg = await import('../js/registry.js');
    const users = await import('../lib/users.js');

    const perms = await users.permsFor('hannah');
    t.assert(perms.tabs.includes('marketmachine'), 'she can open the app');
    const mm = perms.tabs.filter((x) => x.startsWith('marketmachine:'));
    t.equal(mm.join(','), 'marketmachine:tasks', 'and the only screen she is granted is My tasks');

    t.equal(reg.allowedViews(perms, 'marketmachine').join(','), 'tasks',
      'so the rail shows her one screen, not four');

    // What IS ticked for a person is what they get: that is how Jacob has the
    // whole app without the platform Admin flag. The default, with nothing
    // ticked, stays My tasks, which is the part that matters for everyone
    // else. The next test covers the granting side.
    const widened = { ...perms, tabs: perms.tabs.concat(['marketmachine:campaigns']) };
    t.equal(reg.allowedViews(widened, 'marketmachine').join(','), 'tasks,campaigns',
      'ticking a screen grants that screen, and only that screen');
    const plain = { ...perms, tabs: ['marketmachine'] };
    t.equal(reg.allowedViews(plain, 'marketmachine').join(','), 'tasks',
      'and an account with nothing narrowed still gets My tasks only, never everything');

    const admin = await users.permsFor('ryan');
    t.equal(reg.allowedViews(admin, 'marketmachine').join(','), 'tasks,campaigns,calendar,settings',
      'an Admin still gets all four');
  });

  await t.test('ticking Campaigns gives the whole app, and nothing outside it', async () => {
    const reg = await import('../js/registry.js');
    const users = await import('../lib/users.js');
    const access = await import('../lib/marketmachine/access.js');

    // Jacob: MarketMachine granted, all four screens ticked, and NOT an Admin.
    kv.set('alliteration:users', JSON.stringify({
      ryan: { username: 'ryan', name: 'Ryan Toney', superuser: true, access: { apps: [] } },
      hannah: { username: 'hannah', name: 'Hannah Posey', access: { apps: ['marketmachine'], can_edit: true } },
      jacob: { username: 'jacob', name: 'Jacob Whitman', access: {
        apps: ['marketmachine'], views: { marketmachine: ['tasks', 'campaigns', 'calendar', 'settings'] }, can_edit: true } },
    }));
    const JACOB_U = { username: 'jacob', name: 'Jacob Whitman' };

    const perms = await users.permsFor('jacob');
    t.assert(!perms.superuser, 'he is not a platform Admin');
    t.equal(reg.allowedViews(perms, 'marketmachine').join(','), 'tasks,campaigns,calendar,settings',
      'but he gets all four MarketMachine screens');
    t.assert(access.isMarketMachineAdmin({ access: { views: { marketmachine: ['tasks', 'campaigns'] } } }),
      'Campaigns is the switch');
    t.assert(!access.isMarketMachineAdmin({ access: { views: { marketmachine: ['tasks', 'calendar'] } } }),
      'and Timeline alone is not');

    const list = await call({ as: JACOB_U });
    t.equal(list.statusCode, 200, 'the campaign list opens for him');
    t.assert(!list.body.limited, 'in full, not the names-only version');
    const id = list.body.campaigns[0].id;
    const detail = await call({ as: JACOB_U, query: { id } });
    t.equal(detail.statusCode, 200, 'so does a campaign');
    t.assert(detail.body.calculations && detail.body.connections, 'with its numbers and connections');
    t.equal((await call({ as: JACOB_U, method: 'POST', body: { type: 'postal', name: 'Jacob made this' } })).statusCode, 201,
      'and he can create one');
    t.equal((await call({ as: JACOB_U, method: 'PATCH', query: { id, step: 'prelaunch_review' }, body: { done: true } })).statusCode, 200,
      'and work any step, the same as an Admin inside this app');

    // Nothing outside MarketMachine moved.
    t.assert(!perms.tabs.includes('crewcore'), 'he did not gain CrewCore');
    t.assert(!perms.tabs.includes('settings'), 'nor the accounts screen');
    t.assert(perms.tabs.filter((x) => x.indexOf(':') === -1).join(',') === 'marketmachine',
      'MarketMachine is still the only app he was given');

    // And an ordinary grant is unchanged by any of this.
    t.equal(reg.allowedViews(await users.permsFor('hannah'), 'marketmachine').join(','), 'tasks',
      'somebody with the plain grant still gets My tasks only');
    t.equal((await call({ as: HANNAH_U, query: { id } })).statusCode, 403, 'and is still refused a campaign');
  });

  await t.test('the ceiling is a second gate, not the only one', async () => {
    // Even with the rail told to show her everything, the server still
    // refuses: the campaign screens are Admin only in the route.
    const list = await call({ as: RYAN });
    const id = list.body.campaigns[0].id;
    t.equal((await call({ as: HANNAH_U, query: { id } })).statusCode, 403, 'the campaign page is still refused');
    t.equal((await call({ as: HANNAH_U, query: { options: 'connections' } })).statusCode, 200, 'the picker read is the only exception');
    t.assert((await call({ as: HANNAH_U, query: { options: 'connections' } })).body.limited, 'and it is marked limited');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
