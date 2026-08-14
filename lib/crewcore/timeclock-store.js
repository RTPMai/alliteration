// lib/crewcore/timeclock-store.js — Upstash access for CrewCore's time clock.
//
// Same plain getRaw/setRaw pattern as lib/crewcore/store.js. The shape worth
// understanding before editing:
//
//   shifts:<employee>:<weekKey>  an ARRAY of shift records for one person,
//                                one pay week. Written whole, never patched
//                                in place.
//   shift_open:<employee>        { week_key, shift_id } while that person is
//                                clocked in, null otherwise.
//   shift_weeks:<employee>       every week key ever written for them, so a
//                                range report reads only real buckets.
//
// The open-shift pointer is what makes clocking out a two-read operation
// instead of a search. It is also the concurrency guard: clocking in checks
// it, so a double tap on the kiosk cannot open two shifts.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import {
  timeKeys, weekKeyFor, weekKeysInRange, localParts, isStale,
  newShift, SHOP_TIMEZONE,
} from "./timeclock.js";

/**
 * Shift ids are random, not sequential. Sequential ids need a global counter
 * read on every punch, and the whole point of the per-week buckets is that a
 * punch touches two keys, not the whole app. Nothing about a shift id needs
 * to be guessable-in-order the way an EMP- number does.
 */
function newShiftId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `SH-${t}-${r}`;
}

/* ---- raw bucket access ---------------------------------------------------- */

export async function listWeekKeys(employeeId) {
  const keys = await getRaw(timeKeys.weekIndex(employeeId));
  return Array.isArray(keys) ? keys : [];
}

export async function getWeekShifts(employeeId, weekKey) {
  const rows = await getRaw(timeKeys.week(employeeId, weekKey));
  return Array.isArray(rows) ? rows : [];
}

async function setWeekShifts(employeeId, weekKey, shifts) {
  await setRaw(timeKeys.week(employeeId, weekKey), shifts);
  const keys = await listWeekKeys(employeeId);
  if (!keys.includes(weekKey)) {
    keys.push(weekKey);
    keys.sort();
    await setRaw(timeKeys.weekIndex(employeeId), keys);
  }
}

export async function getOpenPointer(employeeId) {
  const p = await getRaw(timeKeys.open(employeeId));
  return p && p.shift_id ? p : null;
}

async function setOpenPointer(employeeId, pointer) {
  await setRaw(timeKeys.open(employeeId), pointer);
}

/** The employee's currently open shift record, or null. */
export async function getOpenShift(employeeId) {
  const ptr = await getOpenPointer(employeeId);
  if (!ptr) return null;
  const rows = await getWeekShifts(employeeId, ptr.week_key);
  const shift = rows.find((s) => s.id === ptr.shift_id) || null;
  // Pointer survived but the shift did not (an admin deleted it). Clean up
  // rather than leaving the person permanently unable to clock in.
  if (!shift) {
    await setOpenPointer(employeeId, null);
    return null;
  }
  if (shift.out_at) {
    await setOpenPointer(employeeId, null);
    return null;
  }
  return { ...shift, week_key: ptr.week_key };
}

/* ---- the kiosk path -------------------------------------------------------- */

/**
 * Opens a shift. Returns { ok:false, reason:"already_in", shift } if they
 * are already clocked in on a believable shift.
 *
 * A STALE open shift (past MAX_SHIFT_HOURS, so almost certainly a forgotten
 * clock-out from a previous day) does NOT block the new punch. Blocking it
 * would mean someone who forgot to clock out yesterday cannot start work
 * today until an admin fixes it, which turns one small payroll correction
 * into a person standing at a tablet. The old shift is instead left open and
 * marked, so it shows up on the back side as something to fix.
 */
export async function clockIn(employeeId, opts = {}) {
  const {
    at = new Date().toISOString(),
    weekStartDay = 0,
    timezone = SHOP_TIMEZONE,
    source = "kiosk",
  } = opts;

  const open = await getOpenShift(employeeId);
  if (open) {
    if (!isStale(open, new Date(at))) {
      return { ok: false, reason: "already_in", shift: open };
    }
    const rows = await getWeekShifts(employeeId, open.week_key);
    const idx = rows.findIndex((s) => s.id === open.id);
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], missed_out: true };
      await setWeekShifts(employeeId, open.week_key, rows);
    }
    await setOpenPointer(employeeId, null);
  }

  const localDate = localParts(at, timezone).date;
  const weekKey = weekKeyFor(localDate, weekStartDay);
  const shift = newShift({ employeeId, at, source, id: newShiftId() });

  const rows = await getWeekShifts(employeeId, weekKey);
  rows.push(shift);
  await setWeekShifts(employeeId, weekKey, rows);
  await setOpenPointer(employeeId, { week_key: weekKey, shift_id: shift.id });

  return { ok: true, shift: { ...shift, week_key: weekKey }, closed_stale: !!open };
}

/** Closes the open shift. Returns { ok:false, reason:"not_in" } if there isn't one. */
export async function clockOut(employeeId, opts = {}) {
  const { at = new Date().toISOString() } = opts;

  const open = await getOpenShift(employeeId);
  if (!open) return { ok: false, reason: "not_in" };

  const rows = await getWeekShifts(employeeId, open.week_key);
  const idx = rows.findIndex((s) => s.id === open.id);
  if (idx < 0) {
    await setOpenPointer(employeeId, null);
    return { ok: false, reason: "not_in" };
  }

  rows[idx] = { ...rows[idx], out_at: at };
  await setWeekShifts(employeeId, open.week_key, rows);
  await setOpenPointer(employeeId, null);

  return { ok: true, shift: { ...rows[idx], week_key: open.week_key } };
}

/* ---- the back side --------------------------------------------------------- */

/** Every shift for one employee in one week, oldest first. */
export async function listWeek(employeeId, weekKey) {
  const rows = await getWeekShifts(employeeId, weekKey);
  return rows
    .slice()
    .sort((a, b) => String(a.in_at).localeCompare(String(b.in_at)))
    .map((s) => ({ ...s, week_key: weekKey }));
}

/**
 * Shifts for one employee across an inclusive local-date range. Reads only
 * week buckets that actually exist in the index, so a report over a quiet
 * quarter costs nothing.
 */
export async function listRange(employeeId, startDate, endDate, weekStartDay = 0) {
  const wanted = weekKeysInRange(startDate, endDate, weekStartDay);
  const known = await listWeekKeys(employeeId);
  const keys = wanted.filter((k) => known.includes(k));
  const buckets = await Promise.all(keys.map((k) => listWeek(employeeId, k)));
  return buckets.flat();
}

/** Admin-entered shift. The record must already be through validateShiftEdit. */
export async function addShift(record, opts = {}) {
  const { weekStartDay = 0, timezone = SHOP_TIMEZONE, by = null } = opts;
  const localDate = localParts(record.in_at, timezone).date;
  const weekKey = weekKeyFor(localDate, weekStartDay);

  const shift = {
    id: newShiftId(),
    employee_id: String(record.employee_id),
    in_at: record.in_at,
    out_at: record.out_at || null,
    source: "manual",
    note: record.note || "",
    created_at: new Date().toISOString(),
    created_by: by,
  };

  const rows = await getWeekShifts(shift.employee_id, weekKey);
  rows.push(shift);
  await setWeekShifts(shift.employee_id, weekKey, rows);

  // A manually added shift left open becomes the open shift, so the kiosk
  // agrees with the back side about whether that person is on the clock.
  if (!shift.out_at) {
    await setOpenPointer(shift.employee_id, { week_key: weekKey, shift_id: shift.id });
  }

  return { ...shift, week_key: weekKey };
}

/**
 * Edits a shift in place. If the corrected in time moves the shift into a
 * DIFFERENT pay week, the record is moved between buckets rather than left
 * filed under the old week, which would quietly hide it from the week it now
 * belongs to.
 */
export async function updateShift(employeeId, weekKey, shiftId, patch, opts = {}) {
  const { weekStartDay = 0, timezone = SHOP_TIMEZONE, by = null } = opts;

  const rows = await getWeekShifts(employeeId, weekKey);
  const idx = rows.findIndex((s) => s.id === shiftId);
  if (idx < 0) return null;

  const merged = {
    ...rows[idx],
    ...patch,
    id: rows[idx].id,
    employee_id: rows[idx].employee_id,
    missed_out: patch.out_at ? false : rows[idx].missed_out,
    edited_by: by,
    edited_at: new Date().toISOString(),
  };

  const newWeek = weekKeyFor(localParts(merged.in_at, timezone).date, weekStartDay);

  if (newWeek === weekKey) {
    rows[idx] = merged;
    await setWeekShifts(employeeId, weekKey, rows);
  } else {
    rows.splice(idx, 1);
    await setWeekShifts(employeeId, weekKey, rows);
    const target = await getWeekShifts(employeeId, newWeek);
    target.push(merged);
    await setWeekShifts(employeeId, newWeek, target);
  }

  // Keep the open pointer honest in both directions: closing a shift clears
  // it, reopening one (or moving an open one) re-points it.
  const ptr = await getOpenPointer(employeeId);
  if (merged.out_at) {
    if (ptr && ptr.shift_id === shiftId) await setOpenPointer(employeeId, null);
  } else {
    await setOpenPointer(employeeId, { week_key: newWeek, shift_id: shiftId });
  }

  return { ...merged, week_key: newWeek };
}

export async function deleteShift(employeeId, weekKey, shiftId) {
  const rows = await getWeekShifts(employeeId, weekKey);
  const next = rows.filter((s) => s.id !== shiftId);
  if (next.length === rows.length) return false;
  await setWeekShifts(employeeId, weekKey, next);

  const ptr = await getOpenPointer(employeeId);
  if (ptr && ptr.shift_id === shiftId) await setOpenPointer(employeeId, null);
  return true;
}

/** Everyone currently on the clock, for the dashboard "in the shop now" card. */
export async function whoIsIn(employeeIds) {
  const rows = await Promise.all(
    (employeeIds || []).map(async (id) => {
      const shift = await getOpenShift(id);
      return shift ? { employee_id: id, since: shift.in_at, shift_id: shift.id } : null;
    })
  );
  return rows.filter(Boolean);
}
