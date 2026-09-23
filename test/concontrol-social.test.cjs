// PUT IN: test/concontrol-social.test.cjs
/**
 * ConControl, Social screen (Sep 2026).
 *
 * The FOC27 social plan arrives as a JSON file and becomes posts, decisions
 * and a calendar. Real function calls against a fake Upstash, and the route
 * CALLED with real signed sessions, never read for the shape of its checks.
 *
 * The rules worth breaking a build over:
 *   - reloading the plan never undoes a person's work: posted stays posted,
 *     rewritten copy stays rewritten, a made decision stays made
 *   - a post dropped from a newer file is left alone, not deleted
 *   - a wrong file is refused, not half imported
 *   - every open decision reaches Home, soonest first; so do late posts and
 *     posts going out within a week with no copy or still waiting
 *   - loading the plan and deleting a post are admin only; editing is can_edit
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const kv = new Map();
const P = 'alliteration:';

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => cmds.map(([verb, key, val]) => {
        if (verb === 'SET') { kv.set(key, val); return { result: 'OK' }; }
        if (verb === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
        if (verb === 'DEL') { const had = kv.has(key); kv.delete(key); return { result: had ? 1 : 0 }; }
        if (verb === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
        return { result: null };
      }),
    };
  }
  const setM = u.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-concontrol-social';

function seedUsers() {
  kv.set(P + 'users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan', superuser: true },
    jo: { username: 'jo', name: 'Jo', access: { apps: ['concontrol'], can_edit: true } },
    viewer: { username: 'viewer', name: 'Viewer', access: { apps: ['concontrol'], can_edit: false } },
  }));
}

async function cookieFor(session) {
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

function shift(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A small plan in the real file's shape, dated around `today`. */
function planAround(today) {
  return {
    schema_version: '1.0',
    plan: 'FOC27 Social Plan',
    generated: today,
    event: { name: 'Flyover Con 2027' },
    goals: [{ id: 'notify_list', metric: 'notify list signups', target: 300, deadline: 'presale open' }],
    rules: ['No em dashes in any copy.'],
    triggers: [{ when: 'registration sells out', do: 'Same-day Sold Out post.' }],
    decisions: [
      { id: 'price', question: 'Ticket price', needed_by: shift(today, 20), status: 'open' },
      { id: 'registration_date', question: 'Registration open date', placeholder: 'presale Dec 1', needed_by: shift(today, -2), status: 'open' },
    ],
    posts: [
      { id: 'FOC27-SOC-001', date: shift(today, -3), title: 'Late one', type: 'task', channels: ['email'], status: 'drafted', depends_on: null, copy: 'Hey Russ', cta: null },
      { id: 'FOC27-SOC-002', date: shift(today, 2), title: 'SanMar announcement', type: 'sponsor', channels: ['facebook', 'instagram', 'linkedin'], status: 'drafted', depends_on: null, copy: { facebook_instagram: 'Big news', linkedin: 'Big news, longer' }, cta: 'notify_list' },
      { id: 'FOC27-SOC-003', date: shift(today, 4), title: 'No copy yet', type: 'content', channels: ['facebook', 'instagram'], status: 'planned', depends_on: null, copy: null, cta: 'survey' },
      { id: 'FOC27-SOC-004', date: shift(today, 5), title: 'Registration opens', type: 'registration', channels: ['facebook'], status: 'conditional', depends_on: ['decision:registration_date', 'decision:price'], copy: 'Seats open', cta: 'registration' },
      { id: 'FOC27-SOC-005', date: shift(today, 6), title: 'Gold sponsor 1', type: 'sponsor', channels: ['facebook'], status: 'conditional', depends_on: ['gold_sponsor_1_signed'], copy: 'Welcome', cta: 'notify_list' },
      { id: 'FOC27-SOC-006', date: shift(today, 30), title: 'Far off', type: 'content', channels: ['facebook'], status: 'planned', depends_on: null, copy: null, cta: 'notify_list' },
    ],
  };
}

const RYAN = { username: 'ryan', name: 'Ryan' };
const JO = { username: 'jo', name: 'Jo' };
const VIEWER = { username: 'viewer', name: 'Viewer' };

(async () => {
  const L = await import(path.join(ROOT, 'lib/concontrol/social.js'));
  const store = await import(path.join(ROOT, 'lib/concontrol/store.js'));
  const { default: route } = await import(path.join(ROOT, 'api/concontrol/social.js'));

  const TODAY = '2026-09-23';

  /* ---------------- reading the file ---------------- */

  t.test('a file that is not the plan is refused, not half imported', () => {
    t.equal(L.readPlan('{not json').ok, false, 'broken JSON refused');
    t.equal(L.readPlan({ name: 'package.json' }).ok, false, 'a file with no posts refused');
    t.equal(L.readPlan({ posts: [{ title: 'no id or date' }] }).ok, false, 'posts with no id or date refused');
  });

  t.test('the plan reads into posts, decisions and the rest', () => {
    const r = L.readPlan(JSON.stringify(planAround(TODAY)));
    t.equal(r.ok, true, 'read');
    t.equal(r.posts.length, 6, 'every post');
    t.equal(r.decisions.length, 2, 'every decision');
    t.equal(r.meta.rules.length, 1, 'rules kept');
    t.equal(typeof r.posts[1].copy, 'object', 'per-channel copy stays per channel');
    t.equal(r.posts[3].depends_on.length, 2, 'depends_on kept');
  });

  t.test('decisions and real-world conditions are told apart', () => {
    const s = L.splitDepends(['decision:price', 'gold_sponsor_1_signed']);
    t.equal(s.decisions.join(), 'price', 'decision key');
    t.equal(s.conditions.join(), 'gold_sponsor_1_signed', 'condition');
  });

  /* ---------------- state of a post ---------------- */

  t.test('a post waits until every decision is made and every condition happened', () => {
    const post = { depends_on: ['decision:price', 'gold_sponsor_1_signed'] };
    const open = [{ key: 'price', status: 'open', question: 'Price' }];
    const decided = [{ key: 'price', status: 'decided', question: 'Price' }];
    t.equal(L.postWaitingOn(post, open, {}).ready, false, 'open decision waits');
    t.equal(L.postWaitingOn(post, decided, {}).ready, false, 'unmet condition still waits');
    t.equal(L.postWaitingOn(post, decided, { gold_sponsor_1_signed: true }).ready, true, 'both in place is ready');
    t.equal(L.postWaitingOn({ depends_on: ['decision:missing'] }, [], {}).ready, false,
      'a decision the plan forgot to list still counts as waiting');
  });

  t.test('late means the date passed and it was not posted or skipped', () => {
    const late = L.postState({ date: '2026-09-20', status: 'planned', copy: 'x' }, [], {}, TODAY);
    t.equal(late.overdue, true, 'past and planned is late');
    t.equal(L.postState({ date: '2026-09-20', status: 'posted', copy: 'x' }, [], {}, TODAY).overdue, false, 'posted is not late');
    t.equal(L.postState({ date: '2026-09-20', status: 'skipped' }, [], {}, TODAY).overdue, false, 'skipped is not late');
    t.equal(L.postState({ date: TODAY, status: 'planned', copy: 'x' }, [], {}, TODAY).overdue, false, 'today is not late yet');
  });

  t.test('copy that breaks the plan rules is flagged', () => {
    t.equal(L.copyWarnings('We are back \u2014 again').length, 1, 'em dash flagged');
    t.equal(L.copyWarnings({ linkedin: 'fine', facebook: 'also \u2014 not' }).length, 1, 'in any version');
    t.equal(L.copyWarnings('We are back, again').length, 0, 'clean copy clean');
  });

  t.test('an empty version of the copy is not copy', () => {
    t.equal(L.hasCopy(null), false, 'null');
    t.equal(L.hasCopy('   '), false, 'blank');
    t.equal(L.hasCopy({ facebook: '', linkedin: '' }), false, 'all blank versions');
    t.equal(L.hasCopy({ facebook: '', linkedin: 'hi' }), true, 'one real version');
  });

  /* ---------------- what reaches Home ---------------- */

  t.test('Home gets every open decision soonest first, and the posts that are stuck', () => {
    const r = L.readPlan(planAround(TODAY));
    const merged = L.mergePlan([], [], null, r, 'FOC27', 'ryan');
    const rows = L.socialBlockers(merged.posts, merged.decisions, {}, TODAY);
    const decisions = rows.filter((x) => x.kind === 'decision');
    t.equal(decisions.length, 2, 'both open decisions');
    t.equal(decisions[0].key, 'registration_date', 'the late one first');
    t.equal(decisions[0].late, true, 'and it is marked late');
    t.assert(rows.some((x) => x.kind === 'post-overdue' && x.id === 'FOC27-SOC-001'), 'the late post');
    t.assert(rows.some((x) => x.kind === 'post-no-copy' && x.id === 'FOC27-SOC-003'), 'a post this week with no copy');
    t.assert(rows.some((x) => x.kind === 'post-waiting' && x.id === 'FOC27-SOC-004'), 'a post this week still waiting on decisions');
    t.assert(rows.some((x) => x.kind === 'post-waiting' && x.id === 'FOC27-SOC-005'), 'and one waiting on a sponsor signing');
    t.assert(!rows.some((x) => x.id === 'FOC27-SOC-006'), 'a post a month out is not nagging anybody yet');
    t.assert(!rows.some((x) => x.id === 'FOC27-SOC-002'), 'a ready post with copy is not stuck');

    const decided = merged.decisions.map((d) => ({ ...d, status: 'decided' }));
    const after = L.socialBlockers(merged.posts, decided, { gold_sponsor_1_signed: true }, TODAY);
    t.equal(after.filter((x) => x.kind === 'decision').length, 0, 'decided decisions leave Home');
    t.assert(!after.some((x) => x.id === 'FOC27-SOC-005'), 'a met condition clears the post');
  });

  /* ---------------- reloading never undoes work ---------------- */

  t.test('a reload keeps what people did and takes what the file changed', () => {
    const first = L.mergePlan([], [], null, L.readPlan(planAround(TODAY)), 'FOC27', 'ryan');
    t.equal(first.counts.added, 6, 'six added on first load');

    const posts = first.posts.map((p) => {
      if (p.id === 'FOC27-SOC-001') return { ...p, status: 'posted', edited: ['status'] };
      if (p.id === 'FOC27-SOC-002') return { ...p, copy: 'Rewritten by Ryan', edited: ['copy'] };
      if (p.id === 'FOC27-SOC-003') return { ...p, status: 'scheduled' };
      return p;
    }).filter((p) => p.id !== 'FOC27-SOC-006')
      .concat([{ id: 'FOC27-SOC-099', date: TODAY, title: 'Only in storage', status: 'planned', event: 'FOC27' }]);
    const decisions = first.decisions.map((d) => d.key === 'price' ? { ...d, status: 'decided', answer: '$349' } : d);
    const meta = { ...first.meta, conditions: { gold_sponsor_1_signed: true } };

    const next = planAround(TODAY);
    next.posts[0].status = 'planned';
    next.posts[1].copy = 'The file rewrote it too';
    next.posts[1].title = 'SanMar announcement v2';
    next.posts[2].status = 'drafted';
    next.posts[2].copy = 'Now written';
    next.decisions[0].needed_by = shift(TODAY, 25);

    const second = L.mergePlan(posts, decisions, meta, L.readPlan(next), 'FOC27', 'ryan');
    const byId = new Map(second.posts.map((p) => [p.id, p]));

    t.equal(byId.has('FOC27-SOC-001'), false, 'a posted post the file calls planned is not touched');
    t.equal(byId.get('FOC27-SOC-002').copy, 'Rewritten by Ryan', 'rewritten copy survives');
    t.equal(byId.get('FOC27-SOC-002').title, 'SanMar announcement v2', 'but an unedited title follows the file');
    t.equal(byId.get('FOC27-SOC-003').status, 'scheduled', 'scheduled is not pushed back to drafted');
    t.equal(byId.get('FOC27-SOC-003').copy, 'Now written', 'unedited copy follows the file');
    t.equal(byId.get('FOC27-SOC-006').status, 'planned', 'a post missing from storage comes back');
    t.equal(second.counts.notInFile, 1, 'a stored post missing from the file is counted');
    t.assert(!second.posts.some((p) => p.id === 'FOC27-SOC-099'), 'and left alone, not rewritten or deleted');

    const price = second.decisions.find((d) => d.key === 'price');
    t.equal(price.status, 'decided', 'a made decision is not reopened by a file that says open');
    t.equal(price.answer, '$349', 'and keeps its answer');
    t.equal(price.needed_by, shift(TODAY, 25), 'an unedited date still follows the file');
    t.equal(second.meta.conditions.gold_sponsor_1_signed, true, 'ticked conditions survive a reload');
  });

  t.test('editing a field marks it so a reload leaves it', () => {
    t.equal(L.markEdited({ edited: ['copy'] }, { status: 'posted' }).sort().join(), 'copy,status', 'adds to the list');
    t.equal(L.markEdited({}, { kind: 'post' }).length, 0, 'non-fields are not marked');
  });

  /* ---------------- validation ---------------- */

  t.test('a post patch only carries what was sent, and refuses junk', () => {
    const v = L.validatePostPatch({ status: 'posted' });
    t.equal(Object.keys(v.patch).join(), 'status', 'status only');
    t.equal(L.validatePostPatch({ status: 'viral' }).ok, false, 'unknown status refused');
    t.equal(L.validatePostPatch({ date: 'next Tuesday' }).ok, false, 'a date that is not a date refused');
    t.equal(L.validatePostPatch({ title: '' }).ok, false, 'a blank title refused');
    t.equal(L.validatePostPatch({ channels: ['facebook', 'myspace', 'facebook'] }).patch.channels.join(), 'facebook', 'unknown and repeated channels dropped');
    t.equal(L.validatePostPatch({ copy: { linkedin: 'x' } }).patch.copy.linkedin, 'x', 'per-channel copy accepted');
    t.equal(L.validatePostPatch({ copy: 'x'.repeat(6000) }).ok, false, 'runaway copy refused');
  });

  t.test('deciding means saying what was decided', () => {
    t.equal(L.validateDecisionPatch({ status: 'decided', answer: '' }).ok, false, 'decided with a blank answer refused');
    t.equal(L.validateDecisionPatch({ status: 'decided', answer: '$349' }).ok, true, 'with an answer fine');
    t.equal(L.validateDecisionPatch({ status: 'maybe' }).ok, false, 'unknown status refused');
  });

  /* ---------------- dates ---------------- */

  t.test('weeks start on Monday and today is Polk City today', () => {
    t.equal(L.weekOf('2026-09-29'), '2026-09-28', 'a Tuesday files under its Monday');
    t.equal(L.weekOf('2026-09-27'), '2026-09-21', 'a Sunday belongs to the week before');
    t.equal(L.todayCentral(new Date('2026-09-24T03:00:00Z')), '2026-09-23',
      '10 PM Central on the 23rd is still the 23rd, whatever UTC says');
    const g = L.groupByWeek([{ id: 'b', date: '2026-10-01' }, { id: 'a', date: '2026-09-29' }, { id: 'c', date: '2026-10-06' }]);
    t.equal(g.length, 2, 'two weeks');
    t.equal(g[0].posts[0].id, 'a', 'in date order');
  });

  /* ---------------- the route ---------------- */

  seedUsers();
  const RYANC = await cookieFor(RYAN);
  const JOC = await cookieFor(JO);
  const VIEWC = await cookieFor(VIEWER);
  const call = async (cookie, method, body, query) => {
    const res = fakeRes();
    await route({ method, headers: { cookie }, body, query: query || {} }, res);
    return res;
  };
  const today = L.todayCentral();

  await t.test('loading the plan is admin only', async () => {
    const res = await call(JOC, 'POST', { what: 'import', plan: planAround(today) });
    t.equal(res.statusCode, 403, 'an editor cannot load it');
    t.equal((await store.listPosts('FOC27')).length, 0, 'and nothing was written');
  });

  await t.test('a plan for another event is refused as the wrong file', async () => {
    const other = planAround(today);
    other.posts = other.posts.map((p) => ({ ...p, id: p.id.replace('FOC27', 'FOC28') }));
    const res = await call(RYANC, 'POST', { what: 'import', plan: other });
    t.equal(res.statusCode, 400, 'refused');
    t.equal((await store.listPosts('FOC27')).length, 0, 'nothing written');
  });

  await t.test('an admin loads the plan and everybody with the app can read it', async () => {
    const res = await call(RYANC, 'POST', { what: 'import', plan: planAround(today) });
    t.equal(res.statusCode, 200, 'loaded');
    t.equal(res.body.counts.added, 6, 'six posts');
    const get = await call(VIEWC, 'GET');
    t.equal(get.statusCode, 200, 'a read-only account can see the calendar');
    t.equal(get.body.posts.length, 6, 'every post');
    t.equal(get.body.decisions.length, 2, 'every decision');
    t.assert(get.body.blockers.some((b) => b.kind === 'decision'), 'decisions reach Home');
    t.equal(get.body.canEdit, false, 'and is told it cannot edit');
  });

  await t.test('a read-only account cannot change anything', async () => {
    const res = await call(VIEWC, 'PATCH', { kind: 'post', id: 'FOC27-SOC-002', status: 'posted' });
    t.equal(res.statusCode, 403, 'refused');
  });

  await t.test('marking posted records who and when, and a reload keeps it', async () => {
    const res = await call(JOC, 'PATCH', { kind: 'post', id: 'FOC27-SOC-002', status: 'posted' });
    t.equal(res.statusCode, 200, 'saved');
    t.equal(res.body.post.postedBy, 'jo', 'who');
    t.assert(res.body.post.postedAt, 'when');
    t.assert(res.body.post.edited.includes('status'), 'status marked edited');
    t.assert(res.body.post.history.some((h) => /Posted/.test(h.what)), 'and it is on the trail');

    await call(RYANC, 'POST', { what: 'import', plan: planAround(today) });
    t.equal((await store.getPost('FOC27-SOC-002')).status, 'posted', 'still posted after a reload');
  });

  await t.test('moving a post back off posted clears who posted it', async () => {
    const res = await call(JOC, 'PATCH', { kind: 'post', id: 'FOC27-SOC-002', status: 'drafted' });
    t.equal(res.body.post.postedAt, null, 'no posted date on a post that has not gone out');
  });

  await t.test('a decision answered leaves Home', async () => {
    const res = await call(RYANC, 'PATCH', { kind: 'decision', id: 'FOC27-price', status: 'decided', answer: '$349 early bird' });
    t.equal(res.statusCode, 200, 'saved');
    t.equal(res.body.decision.decidedBy, 'ryan', 'who decided');
    const get = await call(RYANC, 'GET');
    t.assert(!get.body.blockers.some((b) => b.id === 'FOC27-price'), 'gone from the blocked list');
    t.assert(get.body.blockers.some((b) => b.id === 'FOC27-registration_date'), 'the other one is still there');
  });

  await t.test('ticking a condition clears the post waiting on it', async () => {
    const res = await call(JOC, 'PATCH', { kind: 'condition', key: 'gold_sponsor_1_signed', met: true });
    t.equal(res.statusCode, 200, 'saved');
    const get = await call(RYANC, 'GET');
    t.assert(!get.body.blockers.some((b) => b.id === 'FOC27-SOC-005'), 'the Gold post is no longer waiting');
    await call(JOC, 'PATCH', { kind: 'condition', key: 'gold_sponsor_1_signed', met: false });
    const again = await call(RYANC, 'GET');
    t.assert(again.body.blockers.some((b) => b.id === 'FOC27-SOC-005'), 'and un-ticking puts it back');
  });

  await t.test('deleting a post is admin only', async () => {
    t.equal((await call(JOC, 'DELETE', null, { id: 'FOC27-SOC-006' })).statusCode, 403, 'an editor cannot');
    t.equal((await call(RYANC, 'DELETE', null, { id: 'FOC27-SOC-006' })).statusCode, 200, 'an admin can');
    t.equal(await store.getPost('FOC27-SOC-006'), null, 'gone');
  });

  await t.test('no session, no plan', async () => {
    const res = fakeRes();
    await route({ method: 'GET', headers: {}, query: {} }, res);
    t.equal(res.statusCode, 401, 'refused');
  });

  process.exit(t.report());
})();
