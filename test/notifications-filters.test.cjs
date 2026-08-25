// PUT IN: test/notifications-filters.test.cjs
/**
 * Notification filtering and the "My team" tab (Ryan's ask, Aug 25 2026).
 *
 * These call the real functions in lib/notifications/filters.js with real
 * notification shapes and check the answers. That is the point of putting
 * the rules in lib/ instead of inside the app file: a test that greps
 * apps/notifications.js for the word "filter" proves the letters are there,
 * not that a due-date comparison is right. See test/route-imports.test.cjs
 * for the incident that made that distinction expensive.
 *
 * `today` is passed in everywhere rather than read from the clock, so
 * "overdue" means something specific and this suite does not start failing
 * at midnight.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

Promise.all([
  import(path.join(ROOT, 'lib/notifications/filters.js')),
  import(path.join(ROOT, 'lib/crewcore/schema.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(([f, cc, reg]) => {
  const {
    DUE_FILTERS, STATUS_FILTERS, EMPTY_FILTERS, DUE_VALUES, STATUS_VALUES,
    normalizeFilters, activeFilterCount, matchesFilters, applyFilters,
    teamPool, addDays, todayLocalISO, TEAM_SCOPES,
  } = f;
  const { validateEmployee } = cc;
  const { SHELL_APPS } = reg;

  const TODAY = '2026-08-25';

  // A minimal notification, overridable per test. Anything not named here is
  // the boring case: open, one app, one type, nothing due.
  function note(over) {
    return Object.assign({
      id: 'N-1',
      title: 'Reprint the Prairie Trail hoodies',
      types: ['task'],
      appIds: ['backbone'],
      status: 'open',
      assignedTo: 'hannah',
      assignedToName: 'Hannah Posey',
      createdBy: 'ryan',
      createdByName: 'Ryan Toney',
      dueDate: null,
      link: null,
      createdAt: '2026-08-20T14:00:00.000Z',
    }, over || {});
  }

  /* ---- defaults --------------------------------------------------------- */

  t.test('the default filter set is "open, everything else unfiltered"', () => {
    t.equal(EMPTY_FILTERS.status, 'open', 'an inbox is what is left to do, not an archive');
    t.equal(EMPTY_FILTERS.due, 'any');
    t.equal(EMPTY_FILTERS.q, '');
    t.equal(activeFilterCount(EMPTY_FILTERS), 0, 'the default state must count as zero filters on');
  });

  t.test('every picker value is one the filter actually understands', () => {
    DUE_FILTERS.forEach((d) => t.equal(DUE_VALUES.includes(d.value), true, 'stray due option: ' + d.value));
    STATUS_FILTERS.forEach((s) => t.equal(STATUS_VALUES.includes(s.value), true, 'stray status option: ' + s.value));
    t.equal(DUE_VALUES.includes(EMPTY_FILTERS.due), true);
    t.equal(STATUS_VALUES.includes(EMPTY_FILTERS.status), true);
  });

  t.test('an unknown filter value falls back to the default, it does not empty the screen', () => {
    const n = normalizeFilters({ due: 'sometime', status: 'maybe' });
    t.equal(n.due, 'any', 'a junk due value must not hide everything');
    t.equal(n.status, 'open');
  });

  t.test('normalizeFilters copes with nothing at all', () => {
    const n = normalizeFilters(undefined);
    t.equal(n.status, 'open');
    t.equal(n.q, '');
  });

  t.test('activeFilterCount counts each filter that is actually doing something', () => {
    t.equal(activeFilterCount({ ...EMPTY_FILTERS, q: 'hoodie' }), 1);
    t.equal(activeFilterCount({ ...EMPTY_FILTERS, q: 'hoodie', appId: 'backbone' }), 2);
    t.equal(activeFilterCount({ ...EMPTY_FILTERS, status: 'all', due: 'overdue' }), 2);
    t.equal(activeFilterCount({ ...EMPTY_FILTERS, q: '   ' }), 0, 'whitespace is not a filter');
  });

  /* ---- status ----------------------------------------------------------- */

  t.test('the default hides completed items and "all" brings them back', () => {
    const done = note({ status: 'done' });
    t.equal(matchesFilters(done, EMPTY_FILTERS, TODAY), false);
    t.equal(matchesFilters(done, { ...EMPTY_FILTERS, status: 'done' }, TODAY), true);
    t.equal(matchesFilters(done, { ...EMPTY_FILTERS, status: 'all' }, TODAY), true);
    t.equal(matchesFilters(note(), { ...EMPTY_FILTERS, status: 'all' }, TODAY), true);
  });

  t.test('a record with no status at all is treated as open, not dropped', () => {
    const legacy = note({ status: undefined });
    t.equal(matchesFilters(legacy, EMPTY_FILTERS, TODAY), true);
  });

  /* ---- app and type: array membership ------------------------------------ */

  t.test('the app filter matches membership of the tag array, not the first tag', () => {
    const n = note({ appIds: ['backbone', 'promopro'] });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, appId: 'promopro' }, TODAY), true,
      'a second app tag must still match');
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, appId: 'mailme' }, TODAY), false);
  });

  t.test('the type filter matches membership too', () => {
    const n = note({ types: ['need', 'handoff'] });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, type: 'handoff' }, TODAY), true);
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, type: 'task' }, TODAY), false);
  });

  t.test('a notification with no tags is filtered out, never crashed on', () => {
    const n = note({ appIds: undefined, types: undefined });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, appId: 'backbone' }, TODAY), false);
    t.equal(matchesFilters(n, EMPTY_FILTERS, TODAY), true, 'untagged still shows when nothing is filtered');
  });

  /* ---- due dates --------------------------------------------------------- */

  t.test('overdue means before today, and today is not overdue', () => {
    const filt = { ...EMPTY_FILTERS, due: 'overdue' };
    t.equal(matchesFilters(note({ dueDate: '2026-08-24' }), filt, TODAY), true);
    t.equal(matchesFilters(note({ dueDate: TODAY }), filt, TODAY), false,
      'something due today has not been missed yet');
    t.equal(matchesFilters(note({ dueDate: '2026-08-26' }), filt, TODAY), false);
  });

  t.test('"due today" is exactly today', () => {
    const filt = { ...EMPTY_FILTERS, due: 'today' };
    t.equal(matchesFilters(note({ dueDate: TODAY }), filt, TODAY), true);
    t.equal(matchesFilters(note({ dueDate: '2026-08-24' }), filt, TODAY), false);
  });

  t.test('"within 7 days" includes overdue, because overdue still needs doing this week', () => {
    const filt = { ...EMPTY_FILTERS, due: 'week' };
    t.equal(matchesFilters(note({ dueDate: '2026-08-20' }), filt, TODAY), true, 'overdue counts');
    t.equal(matchesFilters(note({ dueDate: TODAY }), filt, TODAY), true);
    t.equal(matchesFilters(note({ dueDate: '2026-09-01' }), filt, TODAY), true, 'the seventh day is inside');
    t.equal(matchesFilters(note({ dueDate: '2026-09-02' }), filt, TODAY), false, 'the eighth is not');
  });

  t.test('an undated item is excluded from every date filter except "no due date"', () => {
    const n = note({ dueDate: null });
    ['overdue', 'today', 'week'].forEach((due) => {
      t.equal(matchesFilters(n, { ...EMPTY_FILTERS, due }, TODAY), false, due + ' must not match an undated item');
    });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, due: 'none' }, TODAY), true);
    t.equal(matchesFilters(note({ dueDate: TODAY }), { ...EMPTY_FILTERS, due: 'none' }, TODAY), false);
  });

  t.test('addDays crosses a month end without losing a day', () => {
    t.equal(addDays('2026-08-25', 7), '2026-09-01');
    t.equal(addDays('2026-02-28', 1), '2026-03-01', '2026 is not a leap year');
    t.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  t.test('addDays spans the daylight-saving change without a 23-hour day', () => {
    // US DST ends Nov 1 2026. Local-time arithmetic here would land a day short.
    t.equal(addDays('2026-10-30', 7), '2026-11-06');
  });

  t.test('todayLocalISO reads the local day, not the UTC one', () => {
    // 8pm Central on the 25th is already the 26th in UTC. The due date on a
    // card is a local calendar day, so this must say the 25th.
    const evening = new Date(2026, 7, 25, 20, 30, 0);
    t.equal(todayLocalISO(evening), '2026-08-25');
  });

  /* ---- search ------------------------------------------------------------ */

  t.test('search covers the title, case-insensitively', () => {
    t.equal(matchesFilters(note(), { ...EMPTY_FILTERS, q: 'PRAIRIE' }, TODAY), true);
    t.equal(matchesFilters(note(), { ...EMPTY_FILTERS, q: 'embroidery' }, TODAY), false);
  });

  t.test('search also finds a person, because that is what people type', () => {
    t.equal(matchesFilters(note(), { ...EMPTY_FILTERS, q: 'hannah' }, TODAY), true, 'assignee name');
    t.equal(matchesFilters(note(), { ...EMPTY_FILTERS, q: 'ryan' }, TODAY), true, 'creator name');
  });

  t.test('search also finds a linked record by its label', () => {
    const n = note({ title: 'Chase the ship date', link: { type: 'client', id: 'C-9', label: 'Ankeny Booster Club' } });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, q: 'booster' }, TODAY), true);
  });

  /* ---- combining and ordering -------------------------------------------- */

  t.test('filters AND together rather than widening the list', () => {
    const n = note({ appIds: ['backbone'], types: ['task'] });
    t.equal(matchesFilters(n, { ...EMPTY_FILTERS, appId: 'backbone', type: 'need' }, TODAY), false,
      'matching one filter is not enough');
  });

  t.test('applyFilters puts open before done, then the nearest due date, then newest', () => {
    const list = [
      note({ id: 'a', status: 'done', dueDate: '2026-08-01' }),
      note({ id: 'b', dueDate: null, createdAt: '2026-08-01T00:00:00.000Z' }),
      note({ id: 'c', dueDate: '2026-08-26' }),
      note({ id: 'd', dueDate: null, createdAt: '2026-08-22T00:00:00.000Z' }),
    ];
    const out = applyFilters(list, { ...EMPTY_FILTERS, status: 'all' }, { today: TODAY });
    t.equal(out.map((n) => n.id).join(','), 'c,d,b,a',
      'dated open work first, then newest undated, and completed last');
  });

  t.test('applyFilters survives junk input instead of throwing at the screen', () => {
    t.equal(applyFilters(null, EMPTY_FILTERS, { today: TODAY }).length, 0);
    t.equal(applyFilters([note()], null, { today: TODAY }).length, 1, 'no filters means everything open');
  });

  /* ---- the team tab ------------------------------------------------------ */

  t.test('teamPool gathers what is assigned to the listed members', () => {
    const list = [
      note({ id: '1', assignedTo: 'hannah' }),
      note({ id: '2', assignedTo: 'abby' }),
      note({ id: '3', assignedTo: 'jacob' }),
    ];
    const out = teamPool(list, [{ username: 'hannah' }, { username: 'abby' }], 'margo');
    t.equal(out.map((n) => n.id).join(','), '1,2');
  });

  t.test('a manager\'s own items stay off their team tab', () => {
    // "Assigned to me" already answers that question, and mixing the two is
    // how a manager loses track of which pile is theirs.
    const list = [note({ id: '1', assignedTo: 'margo' }), note({ id: '2', assignedTo: 'hannah' })];
    const out = teamPool(list, [{ username: 'margo' }, { username: 'hannah' }], 'margo');
    t.equal(out.map((n) => n.id).join(','), '2');
  });

  t.test('an empty team yields an empty pool, never the whole company', () => {
    const list = [note({ assignedTo: 'hannah' })];
    t.equal(teamPool(list, [], 'margo').length, 0);
    t.equal(teamPool(list, null, 'margo').length, 0, 'a failed team lookup must not open the list up');
  });

  t.test('team membership matching ignores username case', () => {
    const list = [note({ assignedTo: 'hannah' })];
    t.equal(teamPool(list, [{ username: 'Hannah' }], 'margo').length, 1);
  });

  t.test('the three team scopes are the ones the route can return', () => {
    const route = read('api/notifications.js');
    TEAM_SCOPES.forEach((s) => {
      t.assert(route.includes('"' + s + '"') || route.includes("'" + s + "'"),
        'api/notifications.js never returns scope ' + s);
    });
  });

  /* ---- CrewCore reports_to ------------------------------------------------ */

  t.test('an employee can record who they report to', () => {
    const { ok, errors, record } = validateEmployee({
      name: 'Hannah Posey', start_date: '2021-03-01', reports_to: 'EMP-2',
    });
    t.equal(ok, true, 'expected valid: ' + (errors || []).join(', '));
    t.equal(record.reports_to, 'EMP-2');
  });

  t.test('reporting to nobody is a real answer, stored as null', () => {
    const { record } = validateEmployee({ name: 'Ryan Toney', start_date: '1987-01-01', reports_to: '' });
    t.equal(record.reports_to, null);
    const fresh = validateEmployee({ name: 'New Hire', start_date: '2026-08-01' });
    t.equal(fresh.record.reports_to, null, 'a new record defaults to nobody, not undefined');
  });

  t.test('an employee cannot report to themselves', () => {
    const fromBody = validateEmployee({ name: 'Loop', start_date: '2026-01-01', id: 'EMP-7', reports_to: 'EMP-7' });
    t.equal(fromBody.ok, false, 'self-reference must be refused');
    const fromRoute = validateEmployee({ reports_to: 'EMP-7' }, { partial: true, id: 'EMP-7' });
    t.equal(fromRoute.ok, false, 'and refused when the id came from the query string, not the body');
  });

  t.test('a partial edit that never mentions reports_to leaves it alone', () => {
    const { ok, record } = validateEmployee({ phone: '515-555-0100' }, { partial: true });
    t.equal(ok, true);
    t.equal(Object.prototype.hasOwnProperty.call(record, 'reports_to'), false,
      'an untouched field must not be reset to null by an unrelated edit');
  });

  t.test('the PATCH route passes the record id in so self-reference is caught', () => {
    const route = read('api/crewcore/employees.js');
    t.assert(/validateEmployee\(body,\s*\{\s*partial:\s*true,\s*id\s*\}/.test(route),
      'the id from ?id= must reach validation');
  });

  /* ---- wiring ------------------------------------------------------------ */

  t.test('the team view is registered so a deep link to it routes', () => {
    const notif = SHELL_APPS.find((a) => a.id === 'notifications');
    t.assert(notif, 'notifications is missing from SHELL_APPS');
    const keys = notif.views.map((v) => v[0]);
    t.equal(keys.includes('team'), true, 'no team view registered');
    t.equal(notif.defaultView, 'inbox', 'the default landing tab should stay the inbox');
  });

  t.test('the app reads its filter rules from lib rather than reimplementing them', () => {
    const app = read('apps/notifications.js');
    t.assert(/from '\.\.\/lib\/notifications\/filters\.js'/.test(app),
      'apps/notifications.js should import the shared filter module');
    t.assert(/applyFilters\(/.test(app), 'the list should be built through applyFilters');
    t.assert(/teamPool\(/.test(app), 'the team tab should be built through teamPool');
  });

  t.test('the team lookup fails closed to an empty team, not an open one', () => {
    const route = read('api/notifications.js');
    const fn = route.slice(route.indexOf('async function resolveTeam'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    t.assert(/catch/.test(body), 'a CrewCore read that throws must not take Notifications down');
    t.assert(/employees = \[\]/.test(body), 'and must fall back to no employees');
  });

  t.test('the team route hands back names and usernames only, never employee records', () => {
    const route = read('api/notifications.js');
    const fn = route.slice(route.indexOf('async function resolveTeam'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    t.assert(!/hourly_rate|clock_pin|apparel_stipend/.test(body),
      'no sensitive employee field may leave this function');
  });

  t.test('a terminated employee drops off their manager\'s team', () => {
    const route = read('api/notifications.js');
    const fn = route.slice(route.indexOf('async function resolveTeam'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    t.assert(/status !== "terminated"/.test(body), 'former staff should not sit on the team tab');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
