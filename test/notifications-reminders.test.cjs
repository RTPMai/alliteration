// PUT IN: test/notifications-reminders.test.cjs
/**
 * Reminders (Ryan's ask, Sep 16 2026): a fourth notification type with a
 * "remind on" (trigger) date as well as a due date.
 *
 * The behaviour under test is one sentence: a reminder stays out of the way
 * until its day, then shows up like any other open item. That sentence is
 * spread across four places (the schema's rules, the filter bar, the index
 * the rail badge counts from, and the route), and they all have to agree on
 * what "not yet" means, so every one is exercised here with real calls.
 *
 * Days are passed in wherever the code accepts one. Where the route reads the
 * real clock, the dates used are years away on either side (2099, 2020), so
 * this file does not start failing on some particular morning.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';

/* ---- fake Upstash (stores values, same shape as the other route tests) -- */

const kv = new Map();

global.fetch = async (url, opts) => {
  const u = String(url);
  const get = u.match(/\/get\/(.+)$/);
  if (get) {
    const key = decodeURIComponent(get[1]);
    return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
  }
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse((opts && opts.body) || '[]');
    const out = cmds.map(([op, key, val]) => {
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
      if (op === 'INCR') {
        const n = Number(kv.get(key) || 0) + 1;
        kv.set(key, String(n));
        return { result: n };
      }
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-notification-reminders';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  superuser: true },
    margo: { username: 'margo', name: 'Margo' },
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

const RYAN = { username: 'ryan', name: 'Ryan' };
const MARGO = { username: 'margo', name: 'Margo' };

async function call(route, as, method, query, body) {
  const req = { method, query: query || {}, body: body || {}, headers: { cookie: await makeCookie(as) } };
  const res = fakeRes();
  await route(req, res);
  return res;
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

const FUTURE = '2099-03-01';
const FUTURE_DUE = '2099-03-15';
const PAST = '2020-01-01';

(async () => {
  const schema = await import(path.join(ROOT, 'lib/notifications/schema.js'));
  const filters = await import(path.join(ROOT, 'lib/notifications/filters.js'));
  const store = await import(path.join(ROOT, 'lib/notifications/store.js'));
  const route = (await import(path.join(ROOT, 'api/notifications.js'))).default;

  const { validateNew, validatePatch, settleReminder, isWaiting, todayInZone, TYPES, REMINDER_TYPE } = schema;
  const { applyFilters, matchesFilters, countWaiting, STATUS_FILTERS, normalizeFilters } = filters;

  const APP_IDS = ['backbone', 'general'];
  const USERS = ['ryan', 'margo'];
  const base = (over) => Object.assign({
    title: 'Renew the Gildan partner agreement', types: ['reminder'], appIds: ['general'], assignedTo: 'margo',
  }, over || {});

  /* ---- the type and its rules ------------------------------------------ */

  t.test('Reminder is a type the picker offers', () => {
    t.equal(REMINDER_TYPE, 'reminder');
    t.assert(TYPES.some((x) => x.value === 'reminder' && x.label === 'Reminder'), 'Reminder missing from TYPES');
  });

  t.test('the "pick a type" refusal names Reminder too', () => {
    const { errors } = validateNew(base({ types: [] }), APP_IDS, USERS);
    t.assert(/Reminder/.test(errors.join(' ')), 'the reason should list every button on screen: ' + errors.join(' '));
  });

  t.test('a reminder without a remind-on date is refused, and says why', () => {
    const { ok, errors } = validateNew(base(), APP_IDS, USERS);
    t.equal(ok, false, 'a reminder with no date to remind on is just a task');
    t.assert(/remind on/.test(errors.join(' ')), 'the reason should name the missing date: ' + errors.join(' '));
  });

  t.test('a reminder with both dates saves both', () => {
    const { ok, errors, record } = validateNew(base({ triggerDate: '2026-10-01', dueDate: '2026-10-08' }), APP_IDS, USERS);
    t.equal(ok, true, 'expected valid: ' + errors.join(', '));
    t.equal(record.triggerDate, '2026-10-01');
    t.equal(record.dueDate, '2026-10-08');
  });

  t.test('the due date stays optional on a reminder', () => {
    const { ok, record } = validateNew(base({ triggerDate: '2026-10-01' }), APP_IDS, USERS);
    t.equal(ok, true);
    t.equal(record.dueDate, null);
  });

  t.test('reminding after the thing is due is refused; the same day is fine', () => {
    const late = validateNew(base({ triggerDate: '2026-10-09', dueDate: '2026-10-08' }), APP_IDS, USERS);
    t.equal(late.ok, false, 'a reminder that shows up after the deadline is no reminder');
    t.assert(/after the due date/.test(late.errors.join(' ')), late.errors.join(' '));
    const same = validateNew(base({ triggerDate: '2026-10-08', dueDate: '2026-10-08' }), APP_IDS, USERS);
    t.equal(same.ok, true, 'remind me the morning it is due is a reasonable ask');
  });

  t.test('a garbage remind-on date is refused', () => {
    const { ok, errors } = validateNew(base({ triggerDate: 'next tuesday-ish' }), APP_IDS, USERS);
    t.equal(ok, false);
    t.assert(/triggerDate is not a valid date/.test(errors.join(' ')), errors.join(' '));
  });

  t.test('a notification that is not a reminder never stores a trigger date', () => {
    // A stray trigger date on a task would hide it from its assignee with no
    // Reminder pill to explain why.
    const { ok, record } = validateNew(base({ types: ['task'], triggerDate: FUTURE }), APP_IDS, USERS);
    t.equal(ok, true);
    t.equal(record.triggerDate, null);
  });

  t.test('a patch can set or clear the date; the cross-field rule waits for the merged record', () => {
    t.equal(validatePatch({ triggerDate: '2026-11-02' }, APP_IDS, USERS).patch.triggerDate, '2026-11-02');
    t.equal(validatePatch({ triggerDate: '' }, APP_IDS, USERS).patch.triggerDate, null);
    t.equal(validatePatch({ triggerDate: 'nope' }, APP_IDS, USERS).ok, false);
  });

  t.test('settleReminder judges the whole record', () => {
    const tagged = settleReminder({ types: ['task', 'reminder'], triggerDate: null });
    t.assert(tagged.errors.length === 1, 'tagging an old task Reminder with no date must be refused');
    const untagged = settleReminder({ types: ['task'], triggerDate: FUTURE });
    t.equal(untagged.errors.length, 0);
    t.equal(untagged.triggerDate, null, 'taking the Reminder tag off must clear the date that was hiding it');
  });

  /* ---- "not yet" ------------------------------------------------------- */

  t.test('isWaiting: before the day yes, on the day and after no', () => {
    const r = { status: 'open', triggerDate: '2026-10-01' };
    t.equal(isWaiting(r, '2026-09-30'), true, 'the day before it should still be waiting');
    t.equal(isWaiting(r, '2026-10-01'), false, 'it has to show up ON its day, not the day after');
    t.equal(isWaiting(r, '2026-10-02'), false);
  });

  t.test('isWaiting: done early is done, and no date is never waiting', () => {
    t.equal(isWaiting({ status: 'done', triggerDate: '2026-10-01' }, '2026-09-01'), false);
    t.equal(isWaiting({ status: 'open' }, '2026-09-01'), false);
    t.equal(isWaiting(null, '2026-09-01'), false);
  });

  t.test("today is the shop's calendar, not the server's UTC one", () => {
    // 10:30 PM Central on Sep 15 is already Sep 16 in UTC. A reminder for the
    // 16th must not show up at bedtime on the 15th.
    t.equal(todayInZone(new Date('2026-09-16T03:30:00Z')), '2026-09-15', 'daylight time');
    t.equal(todayInZone(new Date('2026-01-10T05:30:00Z')), '2026-01-09', 'standard time');
    t.equal(todayInZone(new Date('2026-07-01T05:00:00Z')), '2026-07-01', 'midnight Central is the new day');
  });

  /* ---- the filter bar -------------------------------------------------- */

  const DAY = '2026-09-16';
  const list = [
    { id: 'a', title: 'live task', types: ['task'], status: 'open', createdAt: '2026-09-01' },
    { id: 'b', title: 'later reminder', types: ['reminder'], status: 'open', triggerDate: '2026-12-01' },
    { id: 'c', title: 'sooner reminder', types: ['reminder'], status: 'open', triggerDate: '2026-10-01' },
    { id: 'd', title: 'arrived reminder', types: ['reminder'], status: 'open', triggerDate: DAY },
    { id: 'e', title: 'done', types: ['task'], status: 'done' },
  ];
  const ids = (arr) => arr.map((n) => n.id).join(',');

  t.test('Scheduled reminders is a status filter option', () => {
    t.assert(STATUS_FILTERS.some((s) => s.value === 'scheduled'), 'no way to reach a reminder you set');
    t.equal(normalizeFilters({ status: 'scheduled' }).status, 'scheduled', 'normalizing must not throw it away');
  });

  t.test('Open leaves out reminders that have not reached their day', () => {
    t.equal(ids(applyFilters(list, { status: 'open' }, { today: DAY })).split(',').sort().join(','), 'a,d',
      'the arrived reminder belongs in Open, the two future ones do not');
  });

  t.test('Scheduled shows only the waiting ones, soonest first', () => {
    t.equal(ids(applyFilters(list, { status: 'scheduled' }, { today: DAY })), 'c,b');
  });

  t.test('Open and completed shows everything: live, then scheduled, then done', () => {
    const got = ids(applyFilters(list, { status: 'all' }, { today: DAY }));
    t.equal(got.split(',').length, 5);
    t.assert(got.indexOf('e') === 8, 'done goes last: ' + got);
    t.assert(got.indexOf('c') < got.indexOf('b'), 'scheduled soonest first: ' + got);
    t.assert(got.indexOf('d') < got.indexOf('c') && got.indexOf('a') < got.indexOf('c'),
      'what is live now outranks what is coming: ' + got);
  });

  t.test('Completed does not include scheduled reminders', () => {
    t.equal(matchesFilters(list[1], { status: 'done' }, DAY), false);
  });

  t.test('countWaiting drives the "N scheduled reminders" shortcut', () => {
    t.equal(countWaiting(list, DAY), 2);
    t.equal(countWaiting(list, '2026-12-01'), 0, 'everything has arrived by Dec 1');
  });

  /* ---- the index the rail badge counts from ---------------------------- */

  t.test('the summary carries the trigger date so the count never reads a record', () => {
    t.equal(store.summaryOf({ id: 'N-1', triggerDate: '2026-10-01' }).triggerDate, '2026-10-01');
    t.equal(store.summaryOf({ id: 'N-2' }).triggerDate, null);
  });

  t.test('the rail count skips a reminder until its day, then counts it', () => {
    const summaries = [
      { id: 'N-1', assignedTo: 'margo', createdBy: 'ryan', status: 'open', visibility: 'team', triggerDate: '2026-10-01' },
      { id: 'N-2', assignedTo: 'margo', createdBy: 'ryan', status: 'open', visibility: 'team', triggerDate: null },
    ];
    const bell = { assignedTo: 'margo', status: 'open' };
    t.equal(store.countSummaries(summaries, bell, 'margo', '2026-09-30'), 1, 'the day before: only the plain item');
    t.equal(store.countSummaries(summaries, bell, 'margo', '2026-10-01'), 2, 'on the day it lights up');
  });

  t.test('an older summary with no trigger field still counts', () => {
    const legacy = [{ id: 'N-9', assignedTo: 'margo', createdBy: 'ryan', status: 'open', visibility: 'team' }];
    t.equal(store.countSummaries(legacy, { assignedTo: 'margo', status: 'open' }, 'margo', DAY), 1,
      'nothing written before reminders existed may drop off the badge');
  });

  /* ---- the route, end to end ------------------------------------------- */

  seed();

  const bellFor = async (who) => (await call(route, who, 'GET',
    { assignedTo: who.username, status: 'open', count: '1' })).body.count;

  let futureId = null;

  await check('creating a future reminder saves it but leaves the badge alone', async () => {
    const res = await call(route, RYAN, 'POST', {}, base({ triggerDate: FUTURE, dueDate: FUTURE_DUE }));
    t.equal(res.statusCode, 201, JSON.stringify(res.body));
    futureId = res.body.notification.id;
    t.equal(res.body.notification.triggerDate, FUTURE);
    t.equal(await bellFor(MARGO), 0, 'Margo should not be nudged about something months away');
  });

  await check('a reminder whose day has come counts straight away', async () => {
    const res = await call(route, RYAN, 'POST', {}, base({ title: 'Order the Flyover Con badges', triggerDate: PAST }));
    t.equal(res.statusCode, 201, JSON.stringify(res.body));
    t.equal(await bellFor(MARGO), 1);
  });

  await check('the server refuses a reminder with no date, whatever the form did', async () => {
    const res = await call(route, RYAN, 'POST', {}, base());
    t.equal(res.statusCode, 400);
  });

  await check('?status=open leaves the waiting reminder out of the list too', async () => {
    const res = await call(route, MARGO, 'GET', { assignedTo: 'margo', status: 'open' });
    const got = res.body.notifications.map((n) => n.id);
    t.assert(!got.includes(futureId), 'the list and the count must agree');
    t.equal(got.length, 1);
    const everything = await call(route, MARGO, 'GET', {});
    t.assert(everything.body.notifications.some((n) => n.id === futureId),
      'the screen loads unfiltered and must still receive it, or Scheduled is always empty');
  });

  await check('moving the reminder date past the due date is refused on edit', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { triggerDate: '2099-04-01' });
    t.equal(res.statusCode, 400, JSON.stringify(res.body));
    t.assert(/after the due date/.test((res.body.details || []).join(' ')));
  });

  await check('pulling the due date in before the reminder date is refused too', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { dueDate: '2099-02-01' });
    t.equal(res.statusCode, 400, 'the rule is about the record, not whichever field was sent');
  });

  await check('changing the reminder date is logged in History with before and after', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { triggerDate: '2099-03-02' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    const last = res.body.notification.history.slice(-1)[0];
    t.equal(last.action, 'edited');
    const change = (last.changes || []).find((c) => c.field === 'triggerDate');
    t.assert(change && change.from === FUTURE && change.to === '2099-03-02', JSON.stringify(last));
  });

  await check('an edit that re-sends the same reminder date does not log a change', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { title: 'Renew it', triggerDate: '2099-03-02' });
    const last = res.body.notification.history.slice(-1)[0];
    t.assert(!(last.fields || []).includes('triggerDate'), 'the edit form always sends the date; unchanged is not a change');
  });

  await check('taking the Reminder tag off clears the date and puts it on the badge', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { types: ['task'] });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(res.body.notification.triggerDate, null);
    t.equal(await bellFor(MARGO), 2, 'a plain task is open now');
  });

  await check('tagging an existing task Reminder without a date is refused', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { types: ['task', 'reminder'] });
    t.equal(res.statusCode, 400);
  });

  await check('tagging it Reminder with a future date takes it back off the badge', async () => {
    const res = await call(route, RYAN, 'PATCH', { id: futureId }, { types: ['reminder'], triggerDate: FUTURE });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(await bellFor(MARGO), 1);
  });

  process.exit(t.report());
})().catch((e) => {
  console.log('  FAIL notifications-reminders suite could not run: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
