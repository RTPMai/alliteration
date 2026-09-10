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
  STORAGE_WEEK_START, storageKeyFor, isStorageKey, storageKeysForWindow, payWeekWindow,
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
  // ALWAYS the storage anchor, never the shop's pay-week setting. Filing by
  // the setting is what made every bucket unreachable when it was changed.
  const weekKey = storageKeyFor(localDate);
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

/**
 * Shifts for one employee across an inclusive local-date WINDOW.
 *
 * The window is a pay week, or any range a report asks for. It is matched
 * against the storage buckets that overlap it and then filtered by the shift's
 * real local date, so a Monday-start pay week reads the two Sunday buckets it
 * straddles and keeps only the days inside it.
 *
 * Each shift carries its own STORAGE key as `week_key`, not the window's, so
 * an edit or a delete goes looking in the bucket the record is really in.
 * Handing back the display week here is how a correction would quietly fail to
 * find its own row.
 */
export async function listWindow(employeeId, startDate, endDate, timezone = SHOP_TIMEZONE) {
  await migrateBuckets(employeeId);
  const wanted = storageKeysForWindow(startDate, endDate);
  const known = await listWeekKeys(employeeId);
  const keys = wanted.filter((k) => known.includes(k));

  const buckets = await Promise.all(keys.map(async (k) => {
    const rows = await getWeekShifts(employeeId, k);
    return rows.map((row) => ({ ...row, week_key: k }));
  }));

  return buckets
    .flat()
    .filter((row) => {
      const d = localParts(row.in_at, timezone).date;
      return d >= startDate && d <= endDate;
    })
    .sort((a, b) => String(a.in_at).localeCompare(String(b.in_at)));
}

/** Every shift in the pay week beginning `payWeekStart`, oldest first. */
export async function listWeek(employeeId, payWeekStart, timezone = SHOP_TIMEZONE) {
  const w = payWeekWindow(payWeekStart);
  return await listWindow(employeeId, w.start, w.end, timezone);
}

/** Shifts across an inclusive local-date range. */
export async function listRange(employeeId, startDate, endDate, timezone = SHOP_TIMEZONE) {
  return await listWindow(employeeId, startDate, endDate, timezone);
}

/**
 * ONE-TIME RE-BUCKETING, Sep 2026.
 *
 * Any bucket whose key is not a Sunday was written while the shop's week start
 * was set to something else, back when the setting decided the storage key. It
 * is unreachable from a Sunday-anchored read, so its rows are moved into the
 * Sunday buckets their own dates belong to.
 *
 * Self-identifying: a storage key is a Sunday by definition, so an orphan is
 * exactly a key that is not one. No flag to store, no way to run it twice on
 * the same rows, and nothing to do on an account that never saw the setting
 * change, which is almost all of them.
 *
 * Additive. Rows are written to their new bucket before the old key is
 * dropped from the index, so a failure part way leaves them readable in both
 * places rather than in neither.
 */
export async function migrateBuckets(employeeId, timezone = SHOP_TIMEZONE) {
  const known = await listWeekKeys(employeeId);
  const orphans = known.filter((k) => !isStorageKey(k));
  if (!orphans.length) return { moved: 0, buckets: 0 };

  let moved = 0;
  const touched = new Set();

  for (const key of orphans) {
    const rows = await getWeekShifts(employeeId, key);
    const byBucket = new Map();
    rows.forEach((row) => {
      const target = storageKeyFor(localParts(row.in_at, timezone).date);
      if (!byBucket.has(target)) byBucket.set(target, []);
      byBucket.get(target).push(row);
    });

    for (const [target, incoming] of byBucket) {
      const existing = await getWeekShifts(employeeId, target);
      const seen = new Set(existing.map((r) => r.id));
      const merged = existing.concat(incoming.filter((r) => !seen.has(r.id)));
      await setWeekShifts(employeeId, target, merged);
      touched.add(target);
      moved += incoming.length;
    }
  }

  // Index last: the rows are safely in their new homes by now.
  const next = known.filter((k) => isStorageKey(k));
  touched.forEach((k) => { if (!next.includes(k)) next.push(k); });
  next.sort();
  await setRaw(timeKeys.weekIndex(employeeId), next);

  // Anyone clocked in when the setting changed has a pointer into a bucket
  // that no longer exists. Repoint it rather than leaving them unable to
  // clock out.
  const open = await getOpenPointer(employeeId);
  if (open && !isStorageKey(open.week_key)) {
    for (const k of next) {
      const rows = await getWeekShifts(employeeId, k);
      if (rows.some((r) => r.id === open.shift_id)) {
        await setOpenPointer(employeeId, { week_key: k, shift_id: open.shift_id });
        break;
      }
    }
  }

  return { moved, buckets: orphans.length };
}

/** Admin-entered shift. The record must already be through validateShiftEdit. */
export async function addShift(record, opts = {}) {
  const { timezone = SHOP_TIMEZONE, by = null } = opts;
  const localDate = localParts(record.in_at, timezone).date;
  const weekKey = storageKeyFor(localDate);

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
  const { timezone = SHOP_TIMEZONE, by = null } = opts;

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

  const newWeek = storageKeyFor(localParts(merged.in_at, timezone).date);

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
