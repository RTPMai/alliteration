// test/crewcore-timeclock.test.cjs
/**
 * CrewCore time clock contract tests.
 *
 * Rush build, Aug 2026, replacing the shop's broken clock in/out system.
 * This suite exists because a time clock has two properties nothing else in
 * the shell has:
 *
 *   1. It is PUBLIC. api/crewcore/clock.js takes a passcode over an
 *      unauthenticated endpoint, inside the most sensitive app in the shell.
 *      The tests below pin exactly how narrow that surface is, so a later
 *      edit cannot widen it without a red suite.
 *
 *   2. It is money. These hours become paychecks. A timezone bug that files
 *      a 6 AM punch under the wrong day, or a week boundary that lands a
 *      Saturday shift in the wrong pay week, shows up as a short check
 *      rather than an exception in a log. That is why the date handling gets
 *      more coverage here than anything else in the file.
 *
 * lib/crewcore/timeclock.js is an ES module and the harness is CommonJS, so
 * it loads through a dynamic import and the tests run after it resolves.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

Promise.all([
  import(path.join(ROOT, 'lib/crewcore/timeclock.js')),
  import(path.join(ROOT, 'lib/crewcore/schema.js')),
]).then(([tc, schema]) => {
  const {
    localParts, localToIso, weekKeyFor, weekDates, weekKeysInRange, addDays,
    validatePin, validateShiftEdit, shiftHours, isStale, roundHours,
    summarizeWeek, newShift, MAX_SHIFT_HOURS, SHOP_TIMEZONE, timeKeys,
  } = tc;
  const { stripSecrets, stripAdminFields, SECRET_FIELDS, validateSettings, defaultSettings } = schema;

  /* ---- timezone: the expensive bugs ---------------------------------- */

  t.test('the shop clock runs on Central time, not UTC, not the server default', () => {
    t.equal(SHOP_TIMEZONE, 'America/Chicago', 'punches are bucketed in shop-local time');
  });

  t.test('a late evening punch keeps the LOCAL date, not the UTC one', () => {
    // 9 PM Central on Aug 14 is already Aug 15 in UTC. Filing this under the
    // UTC date would move an evening shift into the next day, and at a week
    // boundary into the next pay week.
    const lp = localParts('2026-08-15T02:00:00Z');
    t.equal(lp.date, '2026-08-14', 'evening punch must stay on the local calendar day');
    t.equal(lp.time, '21:00', 'and read as the wall clock the person saw');
  });

  t.test('an early morning punch reads as the same wall clock in summer and winter', () => {
    // The original reason for all of this: 6 AM Central is 11:00 UTC in
    // summer and 12:00 UTC in winter. The stored instant differs, what the
    // person punched does not.
    t.equal(localParts('2026-08-14T11:00:00Z').time, '06:00', 'summer, CDT');
    t.equal(localParts('2026-01-15T12:00:00Z').time, '06:00', 'winter, CST');
  });

  t.test('a typed local time converts back to the right instant, summer and winter', () => {
    t.equal(localToIso('2026-08-14', '07:00'), '2026-08-14T12:00:00.000Z', 'CDT is UTC-5');
    t.equal(localToIso('2026-01-14', '07:00'), '2026-01-14T13:00:00.000Z', 'CST is UTC-6');
  });

  t.test('a correction typed on a daylight saving changeover day lands on the right hour', () => {
    // Both changeover days in 2026: spring forward Mar 8, fall back Nov 1.
    // A single-pass conversion (read the offset at the naive timestamp and
    // stop) puts a 6 AM punch off by a full hour on BOTH of these dates,
    // in opposite directions. 6 AM is when the shop opens, so this is not a
    // theoretical edge: it is a wrong paycheck twice a year, for the
    // earliest shift, caught by nobody.
    [['2026-03-08', '06:00'], ['2026-11-01', '06:00'],
     ['2026-03-08', '03:00'], ['2026-11-01', '03:00']].forEach(([date, time]) => {
      const back = localParts(localToIso(date, time));
      t.equal(back.time, time, 'wrong hour on ' + date);
      t.equal(back.date, date, 'wrong day on ' + date);
    });
  });

  t.test('a local time round trips through storage unchanged', () => {
    ['00:15', '06:30', '12:00', '17:45', '23:59'].forEach((time) => {
      const back = localParts(localToIso('2026-08-14', time)).time;
      t.equal(back, time, 'round trip failed for ' + time);
    });
  });

  /* ---- pay weeks ------------------------------------------------------ */

  t.test('the pay week is keyed by its start date and honors the configured start day', () => {
    // Aug 14 2026 is a Friday.
    t.equal(weekKeyFor('2026-08-14', 0), '2026-08-09', 'Sunday start');
    t.equal(weekKeyFor('2026-08-14', 1), '2026-08-10', 'Monday start');
    t.equal(weekKeyFor('2026-08-14', 5), '2026-08-14', 'a Friday start week begins on that Friday');
  });

  t.test('a date that IS the week start stays in its own week', () => {
    t.equal(weekKeyFor('2026-08-09', 0), '2026-08-09', 'Sunday must not roll back a week');
  });

  t.test('a week is seven consecutive days from the key', () => {
    const d = weekDates('2026-08-09');
    t.equal(d.length, 7, 'seven days');
    t.equal(d[0], '2026-08-09', 'starts on the key');
    t.equal(d[6], '2026-08-15', 'ends six days later');
  });

  t.test('date math crosses month and year boundaries', () => {
    t.equal(addDays('2026-08-31', 1), '2026-09-01', 'month rollover');
    t.equal(addDays('2026-12-31', 1), '2027-01-01', 'year rollover');
    t.equal(addDays('2026-03-01', -1), '2026-02-28', 'backwards over a month edge');
  });

  t.test('a date range resolves to every week bucket it touches', () => {
    const keys = weekKeysInRange('2026-08-10', '2026-08-25', 0);
    t.equal(keys[0], '2026-08-09', 'starts at the week containing the start date');
    t.equal(keys[keys.length - 1], '2026-08-23', 'ends at the week containing the end date');
    t.equal(keys.length, 3, 'three weeks span that range');
  });

  /* ---- passcodes ------------------------------------------------------ */

  t.test('a passcode must be four to six digits', () => {
    t.equal(validatePin('4821').ok, true, 'four digits is fine');
    t.equal(validatePin('482137').ok, true, 'six digits is fine');
    t.equal(validatePin('482').ok, false, 'three digits is too short');
    t.equal(validatePin('4821379').ok, false, 'seven digits is too long');
    t.equal(validatePin('48a1').ok, false, 'letters are not digits');
    t.equal(validatePin('').ok, false, 'blank is not a passcode');
  });

  t.test('guessable passcodes are refused outright', () => {
    // Buddy punching is the entire risk model of a shared kiosk, and it
    // starts with everyone using 1234.
    ['0000', '1111', '9999'].forEach((p) => {
      t.equal(validatePin(p).ok, false, p + ' should be refused');
    });
    ['1234', '4321', '012345', '9876'].forEach((p) => {
      t.equal(validatePin(p).ok, false, p + ' should be refused');
    });
  });

  /* ---- shift math ----------------------------------------------------- */

  t.test('hours are the difference between the two punches', () => {
    t.equal(shiftHours({ in_at: '2026-08-14T12:00:00Z', out_at: '2026-08-14T20:30:00Z' }), 8.5,
      'eight and a half hours');
  });

  t.test('an open shift has no hours yet, rather than zero', () => {
    // Zero would quietly add nothing to a week total and look correct.
    // Null forces the caller to decide what an unfinished shift means.
    t.equal(shiftHours({ in_at: '2026-08-14T12:00:00Z', out_at: null }), null, 'open shift');
  });

  t.test('an open shift goes stale once it runs past a believable day', () => {
    const now = new Date('2026-08-15T12:00:00Z');
    t.equal(isStale({ in_at: '2026-08-14T12:00:00Z', out_at: null }, now), true,
      'a day old and still open is a forgotten clock-out');
    t.equal(isStale({ in_at: '2026-08-15T04:00:00Z', out_at: null }, now), false,
      'an eight hour shift in progress is just a shift in progress');
    t.equal(isStale({ in_at: '2026-08-14T12:00:00Z', out_at: '2026-08-14T20:00:00Z' }, now), false,
      'a closed shift is never stale');
  });

  t.test('rounding shapes totals only when it is switched on', () => {
    t.equal(roundHours(7.93, 0), 7.93, 'zero means exact, which is the default');
    t.equal(roundHours(7.93, 15), 8, 'quarter hour rounding');
    t.equal(roundHours(7.93, 6), 7.9, 'tenth of an hour rounding');
  });

  /* ---- weekly rollup -------------------------------------------------- */

  const week = [
    { id: 'a', in_at: '2026-08-10T12:00:00Z', out_at: '2026-08-10T20:00:00Z' }, // Mon 8h
    { id: 'b', in_at: '2026-08-11T12:00:00Z', out_at: '2026-08-11T21:00:00Z' }, // Tue 9h
    { id: 'c', in_at: '2026-08-12T12:00:00Z', out_at: '2026-08-12T16:00:00Z' }, // Wed 4h
    { id: 'd', in_at: '2026-08-12T17:00:00Z', out_at: '2026-08-12T21:00:00Z' }, // Wed 4h again
  ];

  t.test('two shifts on one day add up on that day', () => {
    // Lunch is a second shift, which is how payroll wants to see it.
    const s = summarizeWeek(week, { weekKey: '2026-08-09', weekStartDay: 0 });
    t.equal(s.days['2026-08-12'], 8, 'a split day totals both halves');
    t.equal(s.total_hours, 25, 'week total');
  });

  t.test('every day of the week is present, even the empty ones', () => {
    const s = summarizeWeek(week, { weekKey: '2026-08-09', weekStartDay: 0 });
    t.equal(Object.keys(s.days).length, 7, 'seven days so the grid has no holes');
    t.equal(s.days['2026-08-09'], 0, 'an unworked day reads zero, not undefined');
  });

  t.test('overtime is split out past the configured threshold', () => {
    const s = summarizeWeek(week, { weekKey: '2026-08-09', weekStartDay: 0, overtimeAfter: 20 });
    t.equal(s.total_hours, 25, 'total is unchanged');
    t.equal(s.overtime_hours, 5, 'five hours past the threshold');
    t.equal(s.regular_hours, 20, 'the rest is regular');
  });

  t.test('no overtime is reported under the threshold', () => {
    const s = summarizeWeek(week, { weekKey: '2026-08-09', weekStartDay: 0, overtimeAfter: 40 });
    t.equal(s.overtime_hours, 0, '25 hours is not overtime at a 40 hour threshold');
  });

  t.test('a forgotten clock-out is flagged, not silently dropped', () => {
    const withOpen = week.concat([{ id: 'e', in_at: '2026-08-13T12:00:00Z', out_at: null }]);
    const s = summarizeWeek(withOpen, {
      weekKey: '2026-08-09', weekStartDay: 0, now: new Date('2026-08-15T12:00:00Z'),
    });
    t.equal(s.open_shifts, 1, 'the open shift is counted');
    t.assert(s.flags.some((f) => f.kind === 'missed_out'), 'and raised as something to fix');
    t.equal(s.total_hours, 25, 'an unfinished shift contributes no invented hours');
  });

  t.test('an impossible shift length is flagged as a probable missed punch', () => {
    const s = summarizeWeek([
      { id: 'x', in_at: '2026-08-10T12:00:00Z', out_at: '2026-08-11T14:00:00Z' },
    ], { weekKey: '2026-08-09', weekStartDay: 0 });
    t.assert(s.flags.some((f) => f.kind === 'too_long'), '26 hours should not pass unremarked');
  });

  /* ---- admin corrections ---------------------------------------------- */

  t.test('a correction needs an employee, a date, and a clock-in time', () => {
    t.equal(validateShiftEdit({ date: '2026-08-14', in_time: '07:00' }).ok, false, 'no employee');
    t.equal(validateShiftEdit({ employee_id: 'EMP-1', in_time: '07:00' }).ok, false, 'no date');
    t.equal(validateShiftEdit({ employee_id: 'EMP-1', date: '2026-08-14' }).ok, false, 'no in time');
    t.equal(validateShiftEdit({ employee_id: 'EMP-1', date: '2026-08-14', in_time: '07:00' }).ok, true,
      'those three are enough');
  });

  t.test('a correction converts wall clock times to stored instants', () => {
    const { ok, record } = validateShiftEdit({
      employee_id: 'EMP-1', date: '2026-08-14', in_time: '07:00', out_time: '15:30',
    });
    t.assert(ok, 'should validate');
    t.equal(localParts(record.in_at).time, '07:00', 'in time survives');
    t.equal(localParts(record.out_at).time, '15:30', 'out time survives');
    t.equal(shiftHours(record), 8.5, 'and the math comes out right');
  });

  t.test('an out time before the in time is read as crossing midnight', () => {
    // Second shift is real. The alternative is asking someone to type
    // tomorrow's date into a field labelled with today's.
    const { ok, record } = validateShiftEdit({
      employee_id: 'EMP-1', date: '2026-08-14', in_time: '22:00', out_time: '06:00',
    });
    t.assert(ok, 'an overnight shift should be accepted');
    t.equal(shiftHours(record), 8, 'eight hours across midnight');
    t.equal(localParts(record.out_at).date, '2026-08-15', 'the out punch lands on the next day');
  });

  t.test('a correction longer than a believable shift is refused', () => {
    const out = validateShiftEdit({
      employee_id: 'EMP-1', date: '2026-08-14', in_time: '06:00', out_time: '05:00',
    });
    // 06:00 to 05:00 next day is 23 hours, past MAX_SHIFT_HOURS.
    t.equal(out.ok, false, 'a 23 hour shift is a typo, not a shift');
    t.assert(MAX_SHIFT_HOURS < 24, 'the ceiling has to be under a full day for that to hold');
  });

  t.test('a correction can leave the shift open', () => {
    const { ok, record } = validateShiftEdit({
      employee_id: 'EMP-1', date: '2026-08-14', in_time: '07:00', out_time: '',
    });
    t.assert(ok, 'a blank out time is allowed');
    t.equal(record.out_at, null, 'and records as an open shift');
  });

  t.test('a fresh kiosk punch opens a shift and nothing else', () => {
    const s = newShift({ employeeId: 'EMP-1', at: '2026-08-14T12:00:00Z' });
    t.equal(s.out_at, null, 'clocking in does not close anything');
    t.equal(s.source, 'kiosk', 'and is recorded as coming from the kiosk');
  });

  /* ---- the passcode never leaves the server ---------------------------- */

  t.test('the passcode hash is stripped from every employee read', () => {
    const rec = { id: 'EMP-1', name: 'Margo', clock_pin_hash: 'scrypt$16384$aa$bb', hourly_rate: 24 };
    const out = stripSecrets(rec);
    t.equal('clock_pin_hash' in out, false, 'the hash must never reach a client');
    t.equal(out.has_clock_pin, true, 'but whether one exists is fine to report');
    t.equal(out.hourly_rate, 24, 'stripSecrets is not the admin filter, it leaves the rest alone');
  });

  t.test('a self-serve read strips the passcode hash too', () => {
    // stripAdminFields is the function standing between an employee and a
    // coworker's record. If the secret strip is not chained into it, a
    // self-serve payload carries the hash.
    const out = stripAdminFields({ id: 'EMP-1', name: 'Margo', clock_pin_hash: 'x', hourly_rate: 24, notes: 'n' });
    t.equal('clock_pin_hash' in out, false, 'hash gone');
    t.equal('hourly_rate' in out, false, 'rate gone');
    t.equal('notes' in out, false, 'notes gone');
  });

  t.test('the secret list names the passcode hash', () => {
    t.assert(SECRET_FIELDS.includes('clock_pin_hash'), 'clock_pin_hash must be listed as a secret');
  });

  t.test('employees.js hashes a passcode and never writes it in the clear', () => {
    const src = read('api/crewcore/employees.js');
    t.assert(src.includes('hashPassword'), 'the passcode must be hashed with the shared scrypt helper');
    const code = stripComments(src);
    t.assert(!/clock_pin_hash\s*=\s*(body|input)\./.test(code),
      'a raw passcode must never be assigned straight to clock_pin_hash');
    t.assert(code.includes('stripSecrets'), 'every employee response must go through stripSecrets');
  });

  t.test('a blank passcode field leaves the stored one alone', () => {
    // The form sends nothing when the field is untouched. If "absent" were
    // treated as "clear", editing anyone's phone number would knock them
    // off the kiosk.
    const code = stripComments(read('api/crewcore/employees.js'));
    t.assert(/body\.clock_pin\s*===\s*undefined/.test(code),
      'an absent clock_pin must be distinguished from an empty one');
  });

  /* ---- the public endpoint stays narrow -------------------------------- */

  t.test('the kiosk endpoint exists and is marked public on purpose', () => {
    t.assert(exists('api/crewcore/clock.js'), 'api/crewcore/clock.js must exist');
    const src = read('api/crewcore/clock.js');
    t.assert(/PUBLIC BY DESIGN/.test(src),
      'a login-free route inside CrewCore has to say so, the way scan-status.js does');
  });

  t.test('the kiosk endpoint does not require a session, by design', () => {
    const code = stripComments(read('api/crewcore/clock.js'));
    t.assert(!/requireAuth/.test(code),
      'requiring a session here would defeat the point: production has no logins');
  });

  t.test('the kiosk name list exposes names and nothing else', () => {
    // This is the whole privacy surface of the public page. If a future edit
    // returns the employee record instead of a projection, pay rates and
    // phone numbers go on the open internet.
    const code = stripComments(read('api/crewcore/clock.js'));
    const projection = /\.map\(\(e\)\s*=>\s*\(\{\s*id:\s*e\.id,\s*name:\s*e\.name,\s*department:\s*e\.department[^}]*\}\)\)/;
    t.assert(projection.test(code), 'the roster response must be an explicit id/name/department projection');
    ['hourly_rate', 'apparel_stipend', 'notes', 'phone', 'email', 'start_date'].forEach((f) => {
      t.assert(!code.includes('e.' + f), 'the public roster must not read ' + f);
    });
  });

  t.test('the kiosk verifies the passcode against the hash, not a comparison', () => {
    const code = stripComments(read('api/crewcore/clock.js'));
    t.assert(code.includes('verifyPassword'), 'must use the shared timing-safe verify');
    t.assert(!/pin\s*===\s*emp\./.test(code), 'never compare a passcode directly');
  });

  t.test('the kiosk locks out guessing per employee, not just per IP', () => {
    // Per-IP alone is useless here: everyone punches from the same tablet on
    // the same shop IP, so a shared limit would either be so high it stops
    // nothing or would lock out the whole shop at shift change.
    const code = stripComments(read('api/crewcore/clock.js'));
    t.assert(/clock:pin:\$\{employeeId\}/.test(code), 'the attempt counter must be keyed per employee');
    t.assert(code.includes('resetKey'), 'a correct code should clear the counter');
  });

  t.test('a wrong name and a wrong passcode give the same answer', () => {
    // Different messages would turn the kiosk into a way to confirm which
    // codes are close.
    const code = stripComments(read('api/crewcore/clock.js'));
    t.assert(/const deny = \(\)/.test(code), 'there should be one shared denial path');
  });

  t.test('the kiosk can only punch, never read hours or write anything else', () => {
    const code = stripComments(read('api/crewcore/clock.js'));
    ['updateEmployee', 'saveEmployee', 'deleteEmployee', 'listWeek', 'listRange', 'deleteShift']
      .forEach((fn) => {
        t.assert(!code.includes(fn), 'the public endpoint must not be able to call ' + fn);
      });
  });

  t.test('the whole kiosk can be switched off without a deploy', () => {
    const code = stripComments(read('api/crewcore/clock.js'));
    t.assert(/clock_enabled === false/.test(code), 'a settings switch must be able to close the public surface');
  });

  /* ---- the back side stays gated --------------------------------------- */

  t.test('timecards require a session', () => {
    t.assert(exists('api/crewcore/timecards.js'), 'api/crewcore/timecards.js must exist');
    const code = stripComments(read('api/crewcore/timecards.js'));
    t.assert(code.includes('requireAuth'), 'the back side is not public');
  });

  t.test('only an admin can change a timecard', () => {
    const code = stripComments(read('api/crewcore/timecards.js'));
    t.assert(/if \(!isAdmin\) return res\.status\(403\)/.test(code),
      'writes must be gated behind one admin check, before any method branch');
    const gateAt = code.indexOf('if (!isAdmin) return res.status(403)');
    ['POST', 'PATCH', 'DELETE'].forEach((m) => {
      const at = code.indexOf(`req.method === "${m}"`);
      t.assert(at > gateAt, m + ' must be handled after the admin gate, not before it');
    });
  });

  t.test('salaried staff stay out of the timecard grid', () => {
    // A salaried person never punches, so leaving them in means a permanent
    // row of 0.00 on the one screen whose job is making a wrong number
    // obvious.
    const code = stripComments(read('api/crewcore/timecards.js'));
    t.assert(/if \(!only\) employees = employees\.filter\(\(e\) => e\.clock_enabled !== false\)/.test(code),
      'non-punching staff must be filtered out of the default grid');
  });

  t.test('a salaried person is still reachable when picked by name', () => {
    // Anyone who moved from hourly to salary still has real past weeks, and
    // a final or corrected timecard has to be openable.
    const code = stripComments(read('api/crewcore/timecards.js'));
    const filterLine = code.slice(code.indexOf('clock_enabled !== false'));
    t.assert(code.indexOf('if (!only)') < code.indexOf('clock_enabled !== false'),
      'the exclusion must be skipped when a specific employee is requested');
    t.assert(filterLine.length > 0, 'filter present');
  });

  t.test('the pay type control reads in hourly and salary terms', () => {
    // "Punches in and out" made someone ask how to mark salaried staff. The
    // control was right, the words were not.
    const app = read('apps/crewcore.js');
    t.assert(app.includes('Hourly, punches the clock'), 'hourly option must say hourly');
    t.assert(app.includes('Salary, does not punch'), 'salary option must say salary');
  });

  t.test('a self-serve caller sees only their own timecard', () => {
    const code = stripComments(read('api/crewcore/timecards.js'));
    t.assert(code.includes('getEmployeeByUsername'),
      'a non-admin must be resolved to their own record, never to a queried id');
    const selfBranch = code.slice(code.indexOf('getEmployeeByUsername'));
    t.assert(/employees = \[own\]/.test(selfBranch),
      'a self-serve read must be scoped to exactly one employee');
  });

  t.test('a correction is recorded as a correction', () => {
    // A timecard anyone could quietly rewrite is worth nothing if it is ever
    // questioned.
    const code = stripComments(read('api/crewcore/timecards.js'));
    t.assert(code.includes('source: "manual"'), 'an edited shift must be marked as hand-entered');
    t.assert(code.includes('by: username'), 'and must record who did it');
  });

  /* ---- the kiosk page --------------------------------------------------- */

  t.test('the kiosk page exists at the repo root', () => {
    t.assert(exists('clock.html'), 'clock.html must exist for the shop tablet');
  });

  t.test('the kiosk page stays outside the shell', () => {
    // Loading the shell would hit the login gate and defeat the point, the
    // same reason scan.html and unsubscribe.html are standalone.
    const html = read('clock.html');
    t.assert(!/js\/shell\.js/.test(html), 'must not load the shell');
    t.assert(!/js\/registry\.js/.test(html), 'must not load the registry');
    t.assert(!/js\/api\.js/.test(html), 'must not load the seam');
  });

  t.test('the kiosk page talks to the public endpoint and only that one', () => {
    const html = read('clock.html');
    t.assert(html.includes('/api/crewcore/clock'), 'must call the public punch endpoint');
    ['/api/crewcore/employees', '/api/crewcore/timecards', '/api/crewcore/settings']
      .forEach((p) => {
        t.assert(!html.includes(p), 'the kiosk must not be able to reach ' + p);
      });
  });

  t.test('the kiosk page clears itself between people', () => {
    // A wall tablet that keeps the last person's name on screen invites the
    // next person to punch as them.
    const html = read('clock.html');
    t.assert(/setTimeout\(function \(\) \{ showNames\(\); \}/.test(html),
      'an abandoned passcode screen must time out back to the name list');
  });

  /* ---- wiring ----------------------------------------------------------- */

  t.test('the Time Clock view is registered in CrewCore', () => {
    const src = read('js/registry.js');
    const block = src.slice(src.indexOf("id: 'crewcore'"), src.indexOf("id: 'mailme'"));
    t.assert(/\['timeclock', 'Time Clock'\]/.test(block), 'the view must be in the registry');
  });

  t.test('CrewCore stays deny-by-default even with a public page attached', () => {
    // The kiosk being public must not have loosened the app itself.
    const src = read('js/registry.js');
    const block = src.slice(src.indexOf("id: 'crewcore'"), src.indexOf("id: 'mailme'"));
    t.assert(!/roles:\s*\[/.test(block), 'no role should be granted crewcore by the registry');
  });

  t.test('the self-serve employee role can actually reach the Time Clock view', () => {
    // Building a self-serve view and forgetting to grant it is a silent
    // failure: the rail just does not show it, no error anywhere.
    const users = read('lib/users.js');
    const block = users.slice(users.indexOf('employee: {'), users.indexOf('employee: {') + 700);
    t.assert(block.includes('crewcore:timeclock'),
      'the employee role must be granted the timeclock view or the self-serve screen is dead code');
  });

  t.test('per-view grants come from code, not from a stale stored roles blob', () => {
    // Nothing in the UI edits tabs, so a stored tabs array is only ever a
    // snapshot of an older DEFAULT_ROLES. If storage wins, every view added
    // to a scoped role from now on is invisible on any deploy where roles
    // were ever saved. That is exactly how the Time Clock view was
    // unreachable before this was fixed.
    const users = read('lib/users.js');
    const fn = users.slice(users.indexOf('export async function getRoles'), users.indexOf('export async function getRole('));
    t.assert(/tabs: DEFAULT_ROLES\[name\]\.tabs\.slice\(\)/.test(fn),
      'getRoles must take tabs from DEFAULT_ROLES, not from stored');
  });

  t.test('the timecards endpoint goes through the seam', () => {
    const src = read('js/api.js');
    t.assert(/ccTimecards:\s*'\/api\/crewcore\/timecards'/.test(src),
      'the back side must be a named ENDPOINT');
  });

  t.test('the PUBLIC punch endpoint is deliberately not in the seam', () => {
    // clock.html is not an app module and does not load api.js. Listing the
    // public route as an ENDPOINT would imply an app can call it, which
    // would mean two paths to the same punch with different auth.
    const src = read('js/api.js');
    t.assert(!/'\/api\/crewcore\/clock'/.test(src),
      'the public kiosk route should not be exposed as a shell endpoint');
  });

  t.test('the kiosk has a short URL on the tablet', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const hit = (vercel.rewrites || []).find((r) => r.source === '/clock');
    t.assert(hit, 'vercel.json needs a /clock rewrite');
    t.equal(hit.destination, '/clock.html', 'it should land on the kiosk page');
  });

  t.test('the app view never calls fetch directly', () => {
    const code = stripComments(read('apps/crewcore.js'));
    t.assert(!/\bfetch\s*\(/.test(code), 'CrewCore must go through ctx.api like every other app');
  });

  /* ---- settings ---------------------------------------------------------- */

  t.test('time clock settings default to something usable on day one', () => {
    const d = defaultSettings();
    t.equal(d.clock_enabled, true, 'the clock ships on, it is replacing a system already in use');
    t.equal(d.week_start_day, 0, 'Sunday');
    t.equal(d.overtime_after_hours, 40, 'forty hour week');
    t.equal(d.clock_round_minutes, 0, 'exact by default: rounding is a decision, not a default');
  });

  t.test('the week start day is validated as a real day', () => {
    t.equal(validateSettings({ week_start_day: 3 }).ok, true, 'Wednesday is a real day');
    t.equal(validateSettings({ week_start_day: 7 }).ok, false, 'there is no day 7');
    t.equal(validateSettings({ week_start_day: -1 }).ok, false, 'or day -1');
  });

  t.test('rounding is limited to the intervals payroll actually uses', () => {
    t.equal(validateSettings({ clock_round_minutes: 15 }).ok, true, 'quarter hour');
    t.equal(validateSettings({ clock_round_minutes: 0 }).ok, true, 'exact');
    t.equal(validateSettings({ clock_round_minutes: 37 }).ok, false, 'nothing arbitrary');
  });

  t.test('storage keys are namespaced under CrewCore, not loose in KV', () => {
    t.assert(timeKeys.week('EMP-1', '2026-08-09').startsWith('crewcore_data:'),
      'shift buckets must sit under the CrewCore prefix');
    t.assert(timeKeys.open('EMP-1').startsWith('crewcore_data:'),
      'the open-shift pointer too');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
}).catch((e) => {
  console.log('  FAIL could not import the time clock modules: ' + e.message);
  process.exit(1);
});
