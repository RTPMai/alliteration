// PUT IN: test/marketmachine.test.cjs
/**
 * MarketMachine, rebuilt as campaign checklists (Sept 2026, phase 1).
 *
 * Real function calls and real requests through the real route, against a
 * fake Upstash. Nothing here greps source text for a rule it could run
 * instead; see test/route-imports.test.cjs for why that distinction cost a
 * live outage once.
 *
 * What is worth breaking a build over:
 *   - a launch step can never be ticked before the prelaunch review
 *   - a person's due date is never overwritten by a moved launch date
 *   - business days skip weekends, and nothing drifts across daylight saving
 *   - a connected campaign inherits once and never loses its own timing
 *   - the app is Admin only: anyone else gets names and ids, nothing more,
 *     even with MarketMachine ticked on their account (the CrewCore trap)
 *   - new ids cannot collide with the old sample campaigns MailMe points at
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

// The app is a FOLDER since Sept 2026: index.js plus one file per screen.
// Listed here so a new screen that forgets the seam or hardcodes a color
// cannot hide in it.
const MODULE_FILES = ['index', 'styles', 'template', 'format', 'shared', 'list', 'new',
  'detail', 'connect', 'calc', 'timeline', 'settings'].map((n) => `apps/marketmachine/${n}.js`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ---- a fake Upstash that speaks every shape the stores use ------------- */

const kv = new Map();
global.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  const get = u.match(/\/get\/(.+)$/);
  if (get) {
    const key = decodeURIComponent(get[1]);
    return ok(kv.has(key) ? kv.get(key) : null);
  }
  const set = u.match(/\/set\/(.+)$/);
  if (set) {
    kv.set(decodeURIComponent(set[1]), opts && opts.body);
    return ok('OK');
  }
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
process.env.SESSION_SECRET = 'test-secret-for-marketmachine';

const P = 'alliteration:';

function seedUsers() {
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan Toney', superuser: true, access: { apps: [] } },
    jacob:  { username: 'jacob',  name: 'Jacob Whitman', superuser: true, access: { apps: [] } },
    // Has MarketMachine ticked on her account and is NOT an Admin. This is
    // the account the CrewCore trap would have let in.
    hannah: { username: 'hannah', name: 'Hannah Posey', access: { apps: ['mailme', 'marketmachine'], can_edit: true } },
    // A superuser flag that is truthy but not true must not count.
    sneaky: { username: 'sneaky', name: 'Sneaky', superuser: 'yes', access: { apps: ['marketmachine'] } },
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
const JACOB = { username: 'jacob', name: 'Jacob Whitman' };
const HANNAH = { username: 'hannah', name: 'Hannah Posey' };
const SNEAKY = { username: 'sneaky', name: 'Sneaky' };

(async () => {
  const dates = await import('../lib/marketmachine/dates.js');
  const cat = await import('../lib/marketmachine/catalog.js');
  const m = await import('../lib/marketmachine/campaign.js');
  const store = await import('../lib/marketmachine/store.js');
  const route = (await import('../api/marketmachine/campaigns.js')).default;

  async function call({ as, method = 'GET', query = {}, body = null }) {
    const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  const SESSION = { username: 'ryan', name: 'Ryan Toney' };
  const make = (type, extra, parent) => ({ id: 'CP-TEST', ...m.buildCampaign({ type, name: 'Test', ...(extra || {}) }, SESSION, parent) });
  const step = (c, key) => c.steps.find((s) => s.key === key);
  const tick = (c, key, today) => m.applyStepPatch(c, key, { done: true }, SESSION, today || '2026-09-16');

  /* ================= dates ================= */

  t.test('two business days before a Monday is the Thursday before', () => {
    t.equal(dates.addBusinessDays('2026-09-21', -2), '2026-09-17', 'the weekend is skipped');
    t.equal(dates.addBusinessDays('2026-09-18', 1), '2026-09-21', 'Friday plus one is Monday');
    t.equal(dates.addBusinessDays('2026-09-21', -10), '2026-09-07', 'ten business days is two calendar weeks');
  });

  t.test('zero business days leaves a weekend date alone', () => {
    t.equal(dates.addBusinessDays('2026-06-13', 0), '2026-06-13', 'a Saturday parade stays on Saturday');
  });

  t.test('dates do not drift across daylight saving or a year end', () => {
    t.equal(dates.addDays('2026-03-07', 2), '2026-03-09', 'the spring change does not lose a day');
    t.equal(dates.addDays('2026-11-01', -1), '2026-10-31', 'the fall change does not add one');
    t.equal(dates.addDays('2026-12-31', 1), '2027-01-01', 'a year boundary rolls over');
    t.equal(dates.addBusinessDays('2027-01-01', -1), '2026-12-31', 'business days cross years too');
  });

  t.test('an impossible date is not a date', () => {
    t.assert(!dates.isIsoDate('2026-02-30'), 'February 30 is refused');
    t.assert(!dates.isIsoDate('09/16/2026'), 'another format is refused');
    t.assert(dates.isIsoDate('2028-02-29'), 'a real leap day is accepted');
    t.equal(dates.suggestDate({ bd: -2 }, null), null, 'no controlling date gives no suggestion, not a guess');
  });

  t.test('a fixed date lands in the campaign year', () => {
    t.equal(dates.suggestDate({ fixed: '10-31' }, '2027-10-31'), '2027-10-31', 'Christmas delivery is that year');
    t.equal(dates.suggestDate({ fixed: '09-30' }, '2026-10-31'), '2026-09-30', 'September selection is that year');
  });

  t.test('a person set due date beats the suggestion, even after the launch date moves', () => {
    const s = { timing: { bd: -5 }, dueOverride: null };
    t.equal(dates.dueDateFor(s, '2026-09-21'), '2026-09-14', 'suggested first');
    s.dueOverride = '2026-09-10';
    t.equal(dates.dueDateFor(s, '2026-09-21'), '2026-09-10', 'the hand set date wins');
    t.equal(dates.dueDateFor(s, '2026-12-01'), '2026-09-10', 'and moving the launch does not move it');
  });

  t.test('today is a Central calendar day, not a UTC one', () => {
    t.equal(dates.todayCentral(new Date('2026-09-17T03:00:00Z')), '2026-09-16',
      '10 PM Central on the 16th is still the 16th');
  });

  t.test('timing reads as plain words', () => {
    t.equal(dates.timingLabel({ bd: -10 }, 'Launch date'), '10 business days before launch date', 'business days');
    t.equal(dates.timingLabel({ days: -70 }, 'Event date'), '10 weeks before event date', 'whole weeks read as weeks');
    t.equal(dates.timingLabel({ fixed: '10-31' }), 'By October 31', 'fixed dates');
    t.equal(dates.timingLabel(null), 'Set by the owner', 'no suggestion');
  });

  /* ================= catalog ================= */

  t.test('every campaign type with an approved master, and nothing extra', () => {
    // Thirteen from the handoff, plus Try On Day, whose own master arrived in
    // September and which Ryan confirmed is a real campaign, not the one the
    // business decided not to pursue.
    const want = ['Digital Platform', 'Poll Sending', 'Picks with Personality', 'Referral', 'Sampling', 'Postal',
      'In-Order Gifting', 'This One Is On Us', 'Christmas Gifting', 'Parade Day', 'Live Screen Printing',
      'Live Customization', 'External Trade Show', 'Try On Day'];
    t.equal(cat.CAMPAIGN_TYPES.length, 14, 'fourteen types');
    want.forEach((l) => t.assert(cat.CAMPAIGN_TYPES.some((x) => x.label === l), l + ' is missing'));
    cat.CAMPAIGN_TYPES.forEach((x) => t.assert(cat.FAMILIES.some((f) => f.key === x.family), x.label + ' has no family'));
  });

  t.test('every checklist is internally sound', () => {
    cat.CAMPAIGN_TYPES.forEach((type) => {
      const keys = type.steps.map((s) => s.key);
      t.equal(new Set(keys).size, keys.length, type.label + ' has duplicate step keys');
      let lastStage = 0;
      type.steps.forEach((s, i) => {
        const stage = cat.STAGE_KEYS.indexOf(s.stage);
        t.assert(stage >= 0, `${type.label}: ${s.key} has an unknown stage`);
        t.assert(stage >= lastStage, `${type.label}: ${s.key} is out of stage order`);
        lastStage = stage;
        s.after.forEach((dep) => {
          const at = keys.indexOf(dep);
          t.assert(at >= 0 && at < i, `${type.label}: ${s.key} waits on ${dep}, which must come earlier`);
        });
      });
    });
  });

  t.test('nothing launches without the prelaunch review', () => {
    cat.CAMPAIGN_TYPES.filter((x) => x.steps.some((s) => s.key === 'prelaunch_review')).forEach((type) => {
      const review = type.steps.find((s) => s.key === 'prelaunch_review');
      t.equal(review.owner, 'Ryan or Megan', type.label + ': prelaunch review is Ryan or Megan');
      t.assert(review.approval, type.label + ': the review is an approval');
      t.assert(!review.na, type.label + ': the review cannot be skipped');
      const byKey = Object.fromEntries(type.steps.map((s) => [s.key, s]));
      const reaches = (key, seen = new Set()) => {
        if (key === 'prelaunch_review') return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return (byKey[key].after || []).some((d) => reaches(d, seen));
      };
      type.steps.filter((s) => s.stage === 'launch').forEach((s) => {
        t.assert(reaches(s.key), `${type.label}: "${s.label}" can be done before the prelaunch review`);
      });
    });
  });

  t.test('Referral is reactive and has no launch gate', () => {
    const ref = cat.typeMeta('referral');
    t.assert(!ref.steps.some((s) => s.key === 'prelaunch_review'), 'there is nothing to launch');
    t.assert(ref.steps.some((s) => /confirm or correct/i.test(s.label)), 'the Account Manager confirms before it counts');
  });

  t.test('the handoff exclusions are respected', () => {
    const xmas = cat.typeMeta('christmas');
    const deliver = xmas.steps.findIndex((s) => s.key === 'xmas_deliver');
    t.assert(!xmas.steps.slice(deliver + 1).some((s) => /follow.?up/i.test(s.label)),
      'Christmas Gifting creates no follow-up task after delivery');
    const ts = cat.typeMeta('trade_show');
    t.assert(!ts.steps.some((s) => /mileage/i.test(s.label + s.help)), 'TravelTrack has no mileage, permanently');
    t.assert(ts.parent, 'External Trade Show is the parent event');
    t.equal(ts.steps.filter((s) => /final (material )?count/i.test(s.label)).length, 1,
      'one final count, no daily count');
  });

  t.test('only the five connected types can sit under a trade show', () => {
    t.equal(cat.connectableTypes('trade_show').sort().join(','),
      'digital_platform,live_customization,live_screen_printing,postal,sampling', 'the diagram-4 set');
    t.equal(cat.connectableTypes('postal').length, 0, 'a Postal campaign holds nothing');
  });

  t.test('no em dash reaches the team in catalog or help text', () => {
    const texts = [];
    cat.CAMPAIGN_TYPES.forEach((x) => {
      texts.push(x.label, x.summary, x.controlLabel);
      x.steps.forEach((s) => texts.push(s.label, s.help, s.owner));
    });
    cat.STAGES.forEach((s) => texts.push(s.label, s.about, s.doing));
    texts.forEach((txt) => t.assert(!/\u2014/.test(txt || ''), 'em dash in: ' + txt));
    const help = read('lib/help/content.js');
    const doc = help.slice(help.indexOf('app: "marketmachine"'));
    t.assert(!/\u2014/.test(doc.slice(0, doc.indexOf('\n  },'))), 'em dash in the MarketMachine help text');
  });

  t.test('a new campaign copies its steps rather than sharing them', () => {
    const a = cat.starterSteps('postal');
    a[0].label = 'changed';
    a[0].after.push('x');
    t.assert(cat.starterSteps('postal')[0].label !== 'changed', 'editing a copy never edits the catalog');
    t.equal(cat.starterSteps('postal')[0].after.length, 0, 'including nested lists');
  });

  t.test('the menu lists most used first and keeps family order on ties', () => {
    const fresh = cat.typesByUse([]);
    t.equal(fresh.map((x) => x.key).join(','), cat.TYPE_KEYS.join(','), 'day one is the catalog order');
    const used = cat.typesByUse([{ type: 'postal' }, { type: 'postal' }, { type: 'trade_show' }]);
    t.equal(used[0].key, 'postal', 'the most used type is first');
    t.equal(used[1].key, 'trade_show', 'then the next');
    t.equal(used[2].key, 'digital_platform', 'then unused types in catalog order');
  });

  /* ================= campaign rules ================= */

  t.test('a campaign records the checklist version it started with', () => {
    const c = make('postal');
    t.equal(c.catalogVersion, cat.CATALOG_VERSION, 'the version is stored');
    t.equal(c.steps.length, cat.typeMeta('postal').steps.length, 'every step is copied');
    t.assert(c.steps.every((s) => s.done === false && s.notApplicable === false), 'nothing starts done');
  });

  t.test('a new campaign needs a real type and a name', () => {
    t.assert(!m.validateNew({ name: 'X', type: 'sms_blast' }).ok, 'an unknown type is refused');
    t.assert(!m.validateNew({ type: 'postal' }).ok, 'a nameless campaign is refused');
    t.assert(!m.validateNew({ type: 'postal', name: 'X', controlDate: '2026-02-30' }).ok, 'a fake date is refused');
    t.assert(m.validateNew({ type: 'postal', name: 'X' }).ok, 'a plain one is accepted');
  });

  t.test('connected campaigns follow the parent rules', () => {
    const show = { id: 'CP-00001', type: 'trade_show', name: 'ISS Long Beach' };
    const postal = { id: 'CP-00002', type: 'postal', name: 'Mailer' };
    t.assert(m.validateNew({ type: 'postal', parentId: 'CP-00001' }, show).ok, 'Postal under a trade show');
    t.assert(!m.validateNew({ type: 'christmas', parentId: 'CP-00001' }, show).ok, 'Christmas Gifting is not a connected type');
    t.assert(!m.validateNew({ type: 'postal', parentId: 'CP-00002' }, postal).ok, 'only a Marketing Event holds campaigns');
    t.assert(!m.validateNew({ type: 'trade_show', parentId: 'CP-00001' }, show).ok, 'an event cannot sit under an event');
    t.assert(!m.validateNew({ type: 'postal', parentId: 'CP-99999' }, null).ok, 'a missing parent is refused');
  });

  t.test('a connected campaign inherits once and keeps its own audience', () => {
    const show = { id: 'CP-00001', type: 'trade_show', name: 'ISS Long Beach', controlDate: '2027-01-15',
      accountManagerId: 'EMP-1', accountManagerName: 'Jacob Whitman', audience: 'Show attendees' };
    const child = m.buildCampaign({ type: 'postal' }, SESSION, show);
    t.equal(child.name, 'ISS Long Beach: Postal', 'the name starts from the event');
    t.equal(child.controlDate, '2027-01-15', 'so does the date');
    t.equal(child.accountManagerName, 'Jacob Whitman', 'and the Account Manager');
    t.equal(child.audience, '', 'the audience is never copied');
    t.equal(child.parentId, 'CP-00001', 'it points at the event');

    const own = m.buildCampaign({ type: 'postal', name: 'Leftover mailer', controlDate: '2027-02-20' }, SESSION, show);
    t.equal(own.name, 'Leftover mailer', 'a supplied name wins');
    t.equal(own.controlDate, '2027-02-20', 'a supplied date wins: the child keeps its own timing');
  });

  t.test('a launch step cannot be ticked before the prelaunch review', () => {
    const c = make('postal', { controlDate: '2026-10-01' });
    const r = tick(c, 'post_ship');
    t.assert(!r.ok, 'refused');
    t.assert(/prelaunch review/i.test(r.errors[0]), 'and it names what to finish first: ' + r.errors[0]);
    t.equal(step(r.campaign, 'post_ship').done, false, 'the record handed back is unchanged');
    t.equal(step(c, 'post_ship').done, false, 'and the input was not mutated');
  });

  t.test('approving the review unlocks launch, and records who approved', () => {
    const c = make('postal', { controlDate: '2026-10-01' });
    const approved = tick(c, 'prelaunch_review');
    t.assert(approved.ok, 'the review can be approved');
    t.equal(step(approved.campaign, 'prelaunch_review').approvedBy, 'Ryan Toney', 'the approver is recorded');
    t.equal(step(approved.campaign, 'prelaunch_review').doneAt, '2026-09-16', 'dated today by default');
    t.assert(tick(approved.campaign, 'post_ship').ok, 'the launch step is now allowed');
  });

  t.test('not applicable only where the handoff allows it, and it satisfies a wait', () => {
    const c = make('digital_platform', { controlDate: '2026-10-01' });
    const req = m.applyStepPatch(c, 'dp_art', { notApplicable: true }, SESSION, '2026-09-16');
    t.assert(!req.ok, 'a required step cannot be waved through');
    const na = m.applyStepPatch(c, 'dp_paid_proposal', { notApplicable: true }, SESSION, '2026-09-16');
    t.assert(na.ok, 'an optional step can be marked not applicable');
    t.assert(m.unmetDependencies(na.campaign, 'dp_paid_approval').length === 0,
      'and the step waiting on it is free to go');
    const both = m.applyStepPatch(na.campaign, 'dp_paid_proposal', { done: true }, SESSION, '2026-09-16');
    t.assert(!both.ok, 'a not applicable step cannot also be done');
  });

  t.test('a finished step cannot be undone out from under the step that relied on it', () => {
    let c = make('postal', { controlDate: '2026-10-01' });
    c = tick(c, 'prelaunch_review').campaign;
    c = tick(c, 'post_ship').campaign;
    const undo = m.applyStepPatch(c, 'prelaunch_review', { done: false }, SESSION, '2026-09-16');
    t.assert(!undo.ok, 'refused while the shipping step is done');
    const undoShip = m.applyStepPatch(c, 'post_ship', { done: false }, SESSION, '2026-09-16');
    t.assert(undoShip.ok, 'undoing the later step first is fine');
    t.assert(m.applyStepPatch(undoShip.campaign, 'prelaunch_review', { done: false }, SESSION, '2026-09-16').ok,
      'and then the review can be reopened');
  });

  t.test('a date completed cannot be in the future or fake', () => {
    const c = make('postal');
    t.assert(!m.applyStepPatch(c, 'post_recipients', { done: true, doneAt: '2026-09-20' }, SESSION, '2026-09-16').ok, 'future refused');
    t.assert(!m.applyStepPatch(c, 'post_recipients', { done: true, doneAt: '2026-13-01' }, SESSION, '2026-09-16').ok, 'fake refused');
    const past = m.applyStepPatch(c, 'post_recipients', { done: true, doneAt: '2026-09-10' }, SESSION, '2026-09-16');
    t.equal(step(past.campaign, 'post_recipients').doneAt, '2026-09-10', 'a real earlier day is kept');
  });

  t.test('moving a due date by hand, and back', () => {
    const c = make('postal', { controlDate: '2026-10-01' });
    const moved = m.applyStepPatch(c, 'post_art', { dueDate: '2026-09-20' }, SESSION, '2026-09-16');
    t.equal(dates.dueDateFor(step(moved.campaign, 'post_art'), '2026-10-01'), '2026-09-20', 'the hand set date is used');
    const back = m.applyStepPatch(moved.campaign, 'post_art', { dueDate: null }, SESSION, '2026-09-16');
    t.equal(dates.dueDateFor(step(back.campaign, 'post_art'), '2026-10-01'), '2026-09-24', 'clearing returns to 5 business days out');
  });

  t.test('a closed campaign refuses step changes until reopened', () => {
    const c = make('postal');
    const cancelled = m.applyHeaderPatch(c, { status: 'cancelled' }, SESSION);
    t.assert(cancelled.ok, 'cancel is allowed with open steps');
    t.assert(!tick(cancelled.campaign, 'post_recipients').ok, 'a cancelled campaign is read only');
    const reopened = m.applyHeaderPatch(cancelled.campaign, { status: 'open' }, SESSION);
    t.assert(tick(reopened.campaign, 'post_recipients').ok, 'reopening allows work again');
  });

  t.test('complete needs every step finished or not applicable', () => {
    let c = make('on_us');
    const early = m.applyHeaderPatch(c, { status: 'complete' }, SESSION);
    t.assert(!early.ok, 'refused with open steps');
    t.assert(/still open/.test(early.errors[0]), 'and it says how many');
    c.steps = c.steps.map((s) => ({ ...s, done: true, doneAt: '2026-09-01' }));
    t.assert(m.applyHeaderPatch(c, { status: 'complete' }, SESSION).ok, 'accepted when everything is finished');
  });

  t.test('type and parent are fixed once a campaign exists', () => {
    const c = make('postal');
    t.assert(!m.applyHeaderPatch(c, { type: 'sampling' }, SESSION).ok, 'type cannot change');
    t.assert(!m.applyHeaderPatch(c, { parentId: 'CP-00009' }, SESSION).ok, 'parent cannot change');
    t.assert(!m.applyHeaderPatch(c, { participation: 'exhibitor' }, SESSION).ok, 'only an event has participation');
  });

  t.test('where a campaign stands is read in plain words', () => {
    let c = make('postal', { controlDate: '2026-10-01', accountManagerName: 'Alexis Davis' });
    let p = m.progress(c, '2026-09-18');
    t.equal(p.label, 'Not started', 'nothing done');
    t.equal(p.next.key, 'post_recipients', 'the first step is next');
    t.equal(p.overdue, 1, 'recipients were due Sept 17, ten business days before Oct 1');
    t.equal(m.progress(c, '2026-09-17').overdue, 0, 'and are not overdue on the day they are due');

    c = m.applyStepPatch(c, 'post_recipients', { done: true }, SESSION, '2026-09-16').campaign;
    c = m.applyStepPatch(c, 'post_plan', { blocked: 'Waiting on the postage quote' }, SESSION, '2026-09-16').campaign;
    p = m.progress(c, '2026-09-16');
    t.equal(p.label, 'Planning', 'the stage of the next open step');
    t.equal(p.blocked, 1, 'the blocker is counted');
    t.equal(p.firstBlocker.blocked, 'Waiting on the postage quote', 'and shown');

    c.steps = c.steps.map((s) => ({ ...s, done: true, doneAt: '2026-09-16', blocked: '' }));
    t.equal(m.progress(c, '2026-09-16').label, 'Ready to close', 'all finished but still open');
    t.assert(m.progress(make('postal'), '2026-09-16').missingDate, 'a campaign with no date says so');
  });

  t.test('Account Manager is shown by name, other owners as written', () => {
    const c = { accountManagerName: 'Abby Penton' };
    t.equal(m.ownerFor({ owner: 'Account Manager' }, c), 'Abby Penton', 'substituted');
    t.equal(m.ownerFor({ owner: 'Jacob and Account Manager' }, c), 'Jacob and Abby Penton', 'within a pair');
    t.equal(m.ownerFor({ owner: 'Assigned Account Manager' }, c), 'Assigned Account Manager', 'an assigned AM is not guessed');
    t.equal(m.ownerFor({ owner: 'Ryan or Megan' }, c), 'Ryan or Megan', 'named people untouched');
  });

  t.test('header dates come from the steps, one source', () => {
    const c = make('postal', { controlDate: '2026-10-01' });
    const d = m.headerDates(c);
    t.equal(d.prelaunchReview, '2026-09-29', 'two business days before');
    t.equal(d.postLaunchReview, '2026-10-15', 'fourteen days after');
    t.equal(d.workingStart, '2026-09-17', 'the earliest due date');
  });

  t.test('the picker for everyone else carries names and ids only', () => {
    const c = { ...make('trade_show', { budget: 12000, notes: 'secret', accountManagerName: 'Jacob' }), id: 'CP-00001' };
    const closed = { ...make('postal'), id: 'CP-00002', status: 'cancelled' };
    const out = m.pickerShape([c, closed]);
    t.equal(out.length, 1, 'closed campaigns are not offered');
    t.equal(Object.keys(out[0]).sort().join(','), 'channels,id,name', 'no steps, budget, notes, owners or history');
    t.equal(out[0].channels[0].type, 'email', 'MailMe still finds an email slot to attach to');
  });

  t.test('mine means my Account Manager record or my own creation', () => {
    t.assert(m.isMine({ accountManagerId: 'EMP-4', createdBy: 'ryan' }, 'hannah', 'EMP-4'), 'by employee id');
    t.assert(m.isMine({ createdBy: 'Hannah' }, 'hannah', null), 'by creator, case-insensitive');
    t.assert(!m.isMine({ accountManagerName: 'Hannah Posey' }, 'hannah', null), 'never by guessing from a display name');
  });

  /* ================= store and route ================= */

  kv.clear();
  seedUsers();
  // The old sample campaigns and one of their rows, as the pre-rebuild app
  // stored them. MailMe emails point at these MC- ids.
  kv.set('marketmachine:campaigns', JSON.stringify({ 'MC-00001': { id: 'MC-00001', name: 'SAMPLE: Spring' },
    'MC-00002': { id: 'MC-00002', name: 'SAMPLE: Fall' } }));
  kv.set('marketmachine:entries:MC-00001', JSON.stringify([{ id: 'r1' }]));

  await t.test('someone who is not an Admin is refused, even with the app ticked', async () => {
    for (const who of [HANNAH, SNEAKY]) {
      t.equal((await call({ as: who, method: 'POST', body: { type: 'postal', name: 'X' } })).statusCode, 403, who.username + ' cannot create');
      t.equal((await call({ as: who, query: { id: 'CP-00001' } })).statusCode, 403, who.username + ' cannot open a campaign');
      t.equal((await call({ as: who, method: 'PATCH', query: { id: 'CP-00001' }, body: { name: 'Y' } })).statusCode, 403, who.username + ' cannot edit');
      t.equal((await call({ as: who, method: 'DELETE', query: { legacy: 'all' } })).statusCode, 403, who.username + ' cannot delete');
    }
    t.equal(await store.legacyCount(), 2, 'the refused delete really did nothing');
  });

  await t.test('an Admin creates campaigns with CP ids that cannot collide with the old MC ones', async () => {
    const a = await call({ as: RYAN, method: 'POST', body: { type: 'trade_show', name: 'ISS Long Beach', controlDate: '2027-01-15', participation: 'exhibitor' } });
    t.equal(a.statusCode, 201, 'created: ' + JSON.stringify(a.body));
    t.equal(a.body.campaign.id, 'CP-00001', 'the first new id');
    const b = await call({ as: JACOB, method: 'POST', body: { type: 'postal', parentId: 'CP-00001' } });
    t.equal(b.statusCode, 201, 'a connected campaign: ' + JSON.stringify(b.body));
    t.equal(b.body.campaign.id, 'CP-00002', 'the next id');
    t.equal(b.body.campaign.controlDate, '2027-01-15', 'it started from the event date');
    const bad = await call({ as: RYAN, method: 'POST', body: { type: 'christmas', parentId: 'CP-00001' } });
    t.equal(bad.statusCode, 400, 'a type that cannot connect is refused');
  });

  await t.test('the Admin list and detail carry where each campaign stands', async () => {
    const list = await call({ as: RYAN });
    t.equal(list.statusCode, 200, 'listed');
    t.equal(list.body.campaigns.length, 2, 'both campaigns');
    t.equal(list.body.legacyCount, 2, 'and the old samples are counted for Settings');
    const show = list.body.campaigns.find((c) => c.id === 'CP-00001');
    t.equal(show.childCount, 1, 'the event knows it holds one campaign');
    t.assert(show.progress && show.progress.next, 'with a next step');
    const detail = await call({ as: RYAN, query: { id: 'CP-00001' } });
    t.equal(detail.body.children.length, 1, 'the connected campaign is summarised on the event');
    t.equal(detail.body.children[0].typeLabel, 'Postal', 'by its own type');
    const child = await call({ as: RYAN, query: { id: 'CP-00002' } });
    t.equal(child.body.parent.id, 'CP-00001', 'and the child links back');
  });

  await t.test('everyone else still gets the MailMe picker, and nothing more', async () => {
    const res = await call({ as: HANNAH });
    t.equal(res.statusCode, 200, 'the bare list read is allowed');
    t.assert(res.body.limited, 'marked as limited');
    t.equal(res.body.campaigns.length, 2, 'both open campaigns are offered');
    const keys = Object.keys(res.body.campaigns[0]).sort().join(',');
    t.equal(keys, 'channels,id,name', 'only names, ids and the email slot');
  });

  await t.test('the launch gate holds through the real route', async () => {
    const early = await call({ as: RYAN, method: 'PATCH', query: { id: 'CP-00002', step: 'post_ship' }, body: { done: true } });
    t.equal(early.statusCode, 400, 'shipping before the review is refused');
    const review = await call({ as: RYAN, method: 'PATCH', query: { id: 'CP-00002', step: 'prelaunch_review' }, body: { done: true } });
    t.equal(review.statusCode, 200, 'the review is approved');
    const ship = await call({ as: JACOB, method: 'PATCH', query: { id: 'CP-00002', step: 'post_ship' }, body: { done: true } });
    t.equal(ship.statusCode, 200, 'then shipping is allowed');
    const saved = await store.getCampaign('CP-00002');
    t.equal(saved.steps.find((s) => s.key === 'post_ship').doneBy, 'Jacob Whitman', 'who did it is stored');
    t.assert(saved.history.some((h) => /approved by Ryan Toney/.test(h.what)), 'the approval is in the history');
  });

  await t.test('edits to two campaigns do not overwrite each other', async () => {
    await call({ as: RYAN, method: 'PATCH', query: { id: 'CP-00001', step: 'ts_identity' }, body: { notes: 'Booth 412' } });
    await call({ as: JACOB, method: 'PATCH', query: { id: 'CP-00002' }, body: { audience: 'Leftover list' } });
    t.equal((await store.getCampaign('CP-00001')).steps.find((s) => s.key === 'ts_identity').notes, 'Booth 412', 'the first edit survived');
    t.equal((await store.getCampaign('CP-00002')).audience, 'Leftover list', 'and so did the second');
  });

  await t.test('an event cannot be deleted while it holds campaigns', async () => {
    const refused = await call({ as: RYAN, method: 'DELETE', query: { id: 'CP-00001' } });
    t.equal(refused.statusCode, 400, 'refused with a connected campaign under it');
    t.equal((await call({ as: RYAN, method: 'DELETE', query: { id: 'CP-00002' } })).statusCode, 200, 'the child goes first');
    t.equal((await call({ as: RYAN, method: 'DELETE', query: { id: 'CP-00001' } })).statusCode, 200, 'then the event');
    t.equal((await call({ as: RYAN })).body.campaigns.length, 0, 'both are gone from the list');
    const next = await call({ as: RYAN, method: 'POST', body: { type: 'postal', name: 'After' } });
    t.equal(next.body.campaign.id, 'CP-00001', 'an emptied index starts again from one');
  });

  await t.test('the old sample campaigns are deleted for good from Settings', async () => {
    const res = await call({ as: RYAN, method: 'DELETE', query: { legacy: 'all' } });
    t.equal(res.statusCode, 200, 'cleared');
    t.equal(res.body.removed, 2, 'both old campaigns');
    t.equal(await store.legacyCount(), 0, 'nothing left');
    t.equal(JSON.parse(kv.get('marketmachine:entries:MC-00001')).length, 0, 'their rows are gone too');
    t.assert((await store.getCampaign('CP-00001')), 'and the new campaign was not touched');
  });

  await t.test('a signed-out request is refused outright', async () => {
    const res = fakeRes();
    await route({ method: 'GET', query: {}, headers: {} }, res);
    t.equal(res.statusCode, 401, 'no session, no names');
  });

  /* ================= wiring that has to stay true ================= */

  t.test('the app is registered, themed and reachable through the seam', () => {
    const reg = read('js/registry.js');
    const entry = reg.slice(reg.indexOf("id: 'marketmachine'"));
    const block = entry.slice(0, entry.indexOf("defaultView"));
    ["['campaigns', 'Campaigns']", "['calendar', 'Timeline']", "['settings', 'Settings']"].forEach((v) =>
      t.assert(block.includes(v), 'the registry is missing ' + v));
    t.assert(!/'entry'|'definitions'/.test(block), 'the retired screens are gone from the rail');
    t.assert(/entry: 'marketmachine\/index\.js'/.test(block), 'the registry points at the folder, not a file');
    t.assert(!exists('apps/marketmachine.js'), 'the old single file is gone, so it cannot go stale beside the folder');
    const api = read('js/api.js');
    t.assert(/mkCampaigns:\s*'\/api\/marketmachine\/campaigns'/.test(api), 'ENDPOINTS.mkCampaigns');
    t.assert(!/mkEntries/.test(api), 'no endpoint points at the deleted rows route');
    t.assert(api.includes("'/api/marketmachine/"), 'the route is live, not mock data');
    t.assert(!exists('api/marketmachine/entries.js') && !exists('api/marketmachine/samples.js'), 'retired routes are deleted');
    const tokens = read('css/tokens.css');
    const mmBlock = tokens.slice(tokens.indexOf('data-app="marketmachine"'));
    t.assert(/--accent:\s*#6E1E2B/.test(mmBlock.slice(0, mmBlock.indexOf('}'))), 'the maroon accent');
  });

  t.test('the screen goes through the seam and owns no colors', () => {
    const app = MODULE_FILES.map(read).join('\n');
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    t.assert(!/\bfetch\(/.test(code), 'no fetch in the app');
    t.assert(!/#[0-9a-fA-F]{3,8}\b(?![^\n]*TOKEN-EXEMPT)/.test(app.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'#' \+ id|'#mk[A-Za-z]+|#mkStage-|`#\$\{/g, '')), 'no hex colors in the app');
  });

  t.test('hand-synced app id lists still include MarketMachine', () => {
    ['api/sitework.js', 'api/notifications.js'].forEach((p) =>
      t.assert(/"marketmachine"/.test(read(p)), p + ' is missing marketmachine'));
  });

  t.test('BackBone still reads the lead list from here, with its fallback', () => {
    const src = read('api/marketmachine/initiatives.js');
    t.assert(/\|\| *"initiatives"/.test(src), 'an absent kind still defaults to initiatives');
    const main = read('apps/backbone/main.js');
    t.assert(/ENDPOINTS\.mkInitiatives/.test(main) && /loadMarketingInitiatives\(\)/.test(main), 'BackBone still loads it');
  });

  t.test('MarketMachine being down never blocks sending email', () => {
    const app = read('apps/mailme.js');
    const fn = app.slice(app.indexOf('async function loadMarketingCampaigns'));
    t.assert(/catch/.test(fn.slice(0, 600)), 'MailMe loads the campaign list softly');
    t.assert(/Not part of a campaign/.test(app), 'and a standalone email is still a real choice');
  });

  await t.test('every screen is wired to the others it calls', async () => {
    // Splitting one 94 KB file into a folder moved functions between modules.
    // A renderer calling ui.somethingGone() passes a syntax check and breaks
    // the moment somebody opens a campaign, so the factories are really built
    // here and the names really compared.
    const app = { state: {}, api: {}, root: { querySelector: () => null }, ui: {} };
    const made = {};
    for (const name of ['shared', 'list', 'new', 'detail', 'connect', 'calc', 'timeline', 'settings']) {
      const mod = await import(`../apps/marketmachine/${name}.js`);
      const fns = mod.default(app);
      Object.entries(fns).forEach(([fn, impl]) => {
        t.equal(typeof impl, 'function', `${name}.js: ${fn} is not a function`);
        t.assert(!made[fn], `${fn} is defined in two screens (${made[fn]} and ${name}.js)`);
        made[fn] = name + '.js';
      });
      Object.assign(app.ui, fns);
    }
    // index.js hangs its own loading and saving functions on ui as well.
    const index = read('apps/marketmachine/index.js');
    const assigned = index.slice(index.indexOf('Object.assign(ui, {'));
    assigned.slice(0, assigned.indexOf('});')).replace('Object.assign(ui, {', '')
      .split(',').map((x) => x.trim()).filter(Boolean)
      .forEach((fn) => { made[fn] = 'index.js'; });
    t.assert(made.loadList && made.openCampaign, 'index.js shares its loaders with the screens');

    const called = new Set();
    MODULE_FILES.map(read).forEach((src) => {
      (src.match(/\bui\.(\w+)\(/g) || []).forEach((m) => called.add(m.slice(3, -1)));
    });
    called.forEach((fn) => t.assert(made[fn], `something calls ui.${fn}(), which no screen defines`));
    ['renderList', 'renderDetail', 'renderTimeline', 'renderSettings', 'renderNew'].forEach((fn) =>
      t.assert(made[fn], fn + ' went missing in the split'));
    t.assert(called.size >= 12, 'the screens really do call each other through ui (' + called.size + ')');
    ['renderDetail', 'renderList', 'amOptions', 'connectionsSection', 'calculationsSection']
      .forEach((fn) => t.assert(called.has(fn), 'nothing calls ui.' + fn + ' any more, which means a screen lost its renderer'));
  });

  t.test('no screen file is near the 100 KB upload limit', () => {
    MODULE_FILES.forEach((f) => {
      const kb = read(f).length / 1024;
      t.assert(kb < 90, `${f} is ${Math.round(kb)} KB, close to the limit that forces clone-and-push`);
    });
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
