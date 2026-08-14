// lib/crewcore/timeclock.js — CrewCore time clock: pure logic, no storage.
//
// Added Aug 2026 as a rush replacement for the shop's broken clock in/out
// system. Two surfaces feed off this file:
//   - clock.html + api/crewcore/clock.js — the PUBLIC kiosk. Pick a name,
//     type a passcode, clock in or out. No shell login (that is the whole
//     point: production staff do not all have accounts).
//   - api/crewcore/timecards.js + the Time Clock view in apps/crewcore.js —
//     the back side. Read, filter, correct, export.
//
// WHY SHIFTS AND NOT PUNCHES. A punch log (a flat list of in/out events)
// makes "who is clocked in right now" and "what did this week total" both
// into replay problems, and a single missing event silently shifts every
// pair after it. This file stores a SHIFT instead: one record with in_at and
// out_at. Clocking in opens a shift, clocking out closes it. A forgotten
// clock-out is then a visible open shift on one day, not a corrupted week.
// Lunch is just a second shift for that day, which is also how payroll
// wants to see it.
//
// TIMEZONE. Every timestamp is stored as a UTC ISO string. Every DAY and
// WEEK decision is made in shop-local time (America/Chicago). This matters:
// a 6:00 AM Central punch is 11:00 or 12:00 UTC depending on daylight
// saving, and bucketing on the UTC date would file early-morning punches
// under the right day in winter and the wrong day in summer, or push a late
// Saturday shift into the next pay week. localParts() and localToIso()
// below are the only places that conversion happens.
//
// ESM. Do NOT convert to module.exports.

import { KEY_PREFIX } from "./schema.js";

export const SHOP_TIMEZONE = "America/Chicago";

// A shift longer than this is treated as a forgotten clock-out rather than a
// real shift. Deliberately generous: a genuine 14-hour press day during a
// rush should not get auto-flagged, but nobody works 18 hours.
export const MAX_SHIFT_HOURS = 18;

export const PUNCH_SOURCES = ["kiosk", "manual"];

export const timeKeys = {
  // One key per employee per week. A week of shifts for one person is a
  // handful of small records, and the back side almost always asks for
  // "this week, everybody" — 14 reads, in parallel, not a table scan.
  week: (employeeId, weekKey) => `${KEY_PREFIX}:shifts:${employeeId}:${weekKey}`,
  // Pointer to the currently open shift so a clock-out does not have to
  // guess which week bucket to look in around a week boundary.
  open: (employeeId) => `${KEY_PREFIX}:shift_open:${employeeId}`,
  // Index of every week key that has ever been written for an employee, so
  // a date-range report knows which buckets exist without probing blindly.
  weekIndex: (employeeId) => `${KEY_PREFIX}:shift_weeks:${employeeId}`,
};

/* ---- local time ---------------------------------------------------------- */

function partsOf(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const out = {};
  f.formatToParts(date).forEach((p) => { out[p.type] = p.value; });
  // Node has historically formatted midnight as "24" under hour12:false.
  if (out.hour === "24") out.hour = "00";
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
  };
}

function pad(n) { return String(n).padStart(2, "0"); }

/**
 * Shop-local calendar date and wall-clock time for a UTC instant.
 * Returns { date: "2026-08-14", time: "07:02", hour, minute }.
 */
export function localParts(iso, tz = SHOP_TIMEZONE) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = partsOf(d, tz);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    hour: p.hour,
    minute: p.minute,
  };
}

function offsetMsAt(date, tz) {
  const p = partsOf(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - date.getTime();
}

/**
 * Turns a shop-local wall clock reading ("2026-08-14", "07:02") into a UTC
 * ISO string. Used by the admin correction form, where someone types the
 * time the person actually started, not a UTC instant.
 *
 * Two passes: the first guess uses the offset in effect at the naive
 * timestamp, the second re-reads the offset at that corrected instant. That
 * second pass is what keeps the two DST changeover days honest.
 */
export function localToIso(dateStr, timeStr, tz = SHOP_TIMEZONE) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ""));
  if (!dm || !tm) return null;
  const naive = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), 0);
  let ts = naive - offsetMsAt(new Date(naive), tz);
  ts = naive - offsetMsAt(new Date(ts), tz);
  return new Date(ts).toISOString();
}

/** Today's date in shop-local terms, as "YYYY-MM-DD". */
export function localToday(tz = SHOP_TIMEZONE, now = new Date()) {
  return localParts(now, tz).date;
}

/* ---- work weeks ----------------------------------------------------------- */
// Date-only arithmetic runs in UTC on purpose. These values carry no time of
// day, so no offset applies and no DST edge can shift a date by a day.

export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

/**
 * The pay week a date falls in, identified by its START date. Keying on the
 * start date rather than an ISO week number means the configurable week
 * start day (Sunday by default, Monday if the shop switches) needs no
 * translation table, and the key sorts and reads correctly on its own.
 */
export function weekKeyFor(dateStr, weekStartDay = 0) {
  const back = (dayOfWeek(dateStr) - Number(weekStartDay) + 7) % 7;
  return addDays(dateStr, -back);
}

export function weekDates(weekKey) {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekKey, i));
}

/** Every week key touched by an inclusive date range, oldest first. */
export function weekKeysInRange(startDate, endDate, weekStartDay = 0) {
  const out = [];
  let k = weekKeyFor(startDate, weekStartDay);
  const last = weekKeyFor(endDate, weekStartDay);
  let guard = 0;
  while (k <= last && guard < 520) { // 10 years of weeks, then stop
    out.push(k);
    k = addDays(k, 7);
    guard += 1;
  }
  return out;
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---- passcodes ------------------------------------------------------------ */

/**
 * Kiosk passcode rules. Four to six digits, because it gets typed on a
 * touchscreen a dozen times a day with wet or inky hands, and anything
 * longer gets written on the wall next to the tablet.
 *
 * Guessable codes are rejected outright rather than warned about. The whole
 * risk model of a shared kiosk is buddy punching, and "everyone's code is
 * 1234" is exactly how that starts.
 */
export function validatePin(pin) {
  const s = String(pin == null ? "" : pin).trim();
  if (!/^\d{4,6}$/.test(s)) {
    return { ok: false, error: "Passcode must be 4 to 6 digits." };
  }
  if (/^(\d)\1+$/.test(s)) {
    return { ok: false, error: "Passcode can't be the same digit repeated." };
  }
  const asc = "0123456789";
  const desc = "9876543210";
  if (asc.includes(s) || desc.includes(s)) {
    return { ok: false, error: "Passcode can't be a run of digits in order." };
  }
  return { ok: true, pin: s };
}

/* ---- shifts --------------------------------------------------------------- */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Hours worked, or null while the shift is still open. */
export function shiftHours(shift) {
  if (!shift || !shift.in_at || !shift.out_at) return null;
  const ms = new Date(shift.out_at).getTime() - new Date(shift.in_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return round2(ms / 3600000);
}

/** True once an open shift has run past the point of being believable. */
export function isStale(shift, now = new Date()) {
  if (!shift || shift.out_at) return false;
  const ms = now.getTime() - new Date(shift.in_at).getTime();
  return ms > MAX_SHIFT_HOURS * 3600000;
}

/**
 * Payroll-facing rounding of a TOTAL, never of the stored punch itself.
 * The raw in and out times stay exactly as they were recorded — that record
 * is the one that matters if anyone ever has to answer for it — and this
 * only shapes what gets added up and exported. roundMinutes of 0 (the
 * default) means no rounding at all.
 */
export function roundHours(hours, roundMinutes = 0) {
  const h = Number(hours) || 0;
  const r = Number(roundMinutes) || 0;
  if (!r) return round2(h);
  const step = r / 60;
  return round2(Math.round(h / step) * step);
}

/**
 * Rolls a set of shifts up into one week for one employee: hours per day,
 * the week total, overtime past the threshold, and anything a human needs
 * to look at (open shifts, impossible lengths).
 */
export function summarizeWeek(shifts, opts = {}) {
  const {
    weekKey,
    weekStartDay = 0,
    overtimeAfter = 40,
    roundMinutes = 0,
    timezone = SHOP_TIMEZONE,
    now = new Date(),
  } = opts;

  const key = weekKey || (shifts && shifts.length
    ? weekKeyFor(localParts(shifts[0].in_at, timezone).date, weekStartDay)
    : null);

  const days = {};
  (key ? weekDates(key) : []).forEach((d) => { days[d] = 0; });

  let total = 0;
  let open = 0;
  const flags = [];

  (shifts || []).forEach((s) => {
    const lp = localParts(s.in_at, timezone);
    if (!lp) return;
    const h = shiftHours(s);
    if (h == null) {
      open += 1;
      if (isStale(s, now)) {
        flags.push({ shift_id: s.id, date: lp.date, kind: "missed_out",
          message: "Clocked in and never clocked out." });
      }
      return;
    }
    if (h > MAX_SHIFT_HOURS) {
      flags.push({ shift_id: s.id, date: lp.date, kind: "too_long",
        message: `Shift is ${h} hours long. Probably a missed clock-out.` });
    }
    if (days[lp.date] === undefined) days[lp.date] = 0;
    days[lp.date] += h;
    total += h;
  });

  Object.keys(days).forEach((d) => { days[d] = roundHours(days[d], roundMinutes); });

  const rounded = roundHours(total, roundMinutes);
  const ot = overtimeAfter > 0 && rounded > overtimeAfter ? round2(rounded - overtimeAfter) : 0;

  return {
    week_key: key,
    days,
    total_hours: rounded,
    regular_hours: round2(rounded - ot),
    overtime_hours: ot,
    open_shifts: open,
    flags,
  };
}

/* ---- validation for admin corrections ------------------------------------- */

/**
 * Validates a manually entered or corrected shift. The kiosk never comes
 * through here — it stamps the current instant, which needs no validating.
 * This is for the back side, where someone types "Margo started at 6:30 and
 * I forgot to have her clock out."
 *
 * Accepts local date plus wall-clock times and converts, rather than taking
 * ISO strings, because that is what the form collects and doing the
 * conversion in one place keeps a hand-typed correction on a DST changeover
 * day from landing an hour off.
 */
export function validateShiftEdit(input, opts = {}) {
  const { timezone = SHOP_TIMEZONE, partial = false } = opts;
  const errors = [];
  const rec = {};

  if (!partial && !input.employee_id) errors.push("employee_id is required");
  else if (input.employee_id !== undefined) rec.employee_id = String(input.employee_id);

  const date = String(input.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push("date must be YYYY-MM-DD");
  }

  const inTime = String(input.in_time || "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(inTime)) {
    errors.push("Clock-in time is required (HH:MM)");
  }

  if (errors.length) return { ok: false, errors };

  rec.in_at = localToIso(date, inTime, timezone);
  if (!rec.in_at) return { ok: false, errors: ["Could not read the clock-in time"] };

  const outTime = String(input.out_time || "").trim();
  if (outTime) {
    if (!/^\d{1,2}:\d{2}$/.test(outTime)) {
      return { ok: false, errors: ["Clock-out time must be HH:MM"] };
    }
    // An out time earlier in the day than the in time is read as an
    // overnight shift rather than rejected: second shift crossing midnight
    // is real, and the alternative is making someone type tomorrow's date
    // into a field labelled with today's.
    let outDate = date;
    if (outTime <= inTime) outDate = addDays(date, 1);
    rec.out_at = localToIso(outDate, outTime, timezone);
    if (!rec.out_at) return { ok: false, errors: ["Could not read the clock-out time"] };

    const hrs = shiftHours({ in_at: rec.in_at, out_at: rec.out_at });
    if (hrs == null || hrs <= 0) {
      return { ok: false, errors: ["Clock-out has to come after clock-in"] };
    }
    if (hrs > MAX_SHIFT_HOURS) {
      return { ok: false, errors: [`That is ${hrs} hours. Check the times, or split it into two shifts.`] };
    }
  } else {
    rec.out_at = null;
  }

  if (input.note !== undefined) rec.note = String(input.note || "").trim().slice(0, 300);

  return { ok: true, record: rec };
}

/** Shape a fresh kiosk clock-in. */
export function newShift({ employeeId, at = new Date().toISOString(), source = "kiosk", id }) {
  return {
    id: id || null,
    employee_id: String(employeeId),
    in_at: at,
    out_at: null,
    source: PUNCH_SOURCES.includes(source) ? source : "kiosk",
    note: "",
    created_at: at,
  };
}
