// api/crewcore/timecards.js — the back side of the time clock. Session required.
//
// Everything the kiosk cannot do lives here: reading hours across the team,
// filtering by pay week and department, correcting a missed punch, and
// exporting for payroll.
//
// SCOPE, same split as the rest of CrewCore:
//   data_scope "all" or superuser -> the whole team, plus every write.
//   anyone else                   -> their OWN timecard, read only. An
//                                    employee can check their own hours,
//                                    which is the honest version of "the
//                                    clock is broken and nobody knows what
//                                    they worked." They cannot edit them.
//
// Corrections are always writes by a named admin, recorded as such on the
// shift (source "manual", edited_by, edited_at). A timecard that anyone
// could quietly rewrite is worth nothing if it is ever questioned.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import {
  validateShiftEdit, weekKeyFor, weekDates, localParts, localToday,
  summarizeWeek, shiftHours, SHOP_TIMEZONE,
} from "../../lib/crewcore/timeclock.js";
import {
  listWeek, listRange, addShift, updateShift, deleteShift, whoIsIn,
} from "../../lib/crewcore/timeclock-store.js";
import { listEmployees, getEmployee, getEmployeeByUsername, getSettings } from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    isAdmin: (role && role.data_scope === "all") || (user && user.superuser === true),
    username: sess.username,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// CSV export is built CLIENT side, in apps/crewcore.js, from the same week
// payload this route already returns. Two reasons it does not live here: the
// house convention for exports is a Blob download (see TravelTrack and
// ShopStock), and a server-rendered CSV is a second code path that can
// silently disagree with the numbers on screen.

/**
 * Builds one employee's row: their shifts for the window, the per-day and
 * weekly rollup, and (admin only, and only when a rate is on file) an
 * estimated labor cost. The cost is an ESTIMATE and labelled as one — it
 * ignores overtime multipliers, which live in payroll, not here.
 */
function buildRow(emp, shifts, opts, isAdmin) {
  const summary = summarizeWeek(shifts, opts);
  const row = {
    employee: {
      id: emp.id,
      name: emp.name,
      department: emp.department || "",
      status: emp.status,
    },
    shifts: shifts.map((s) => {
      const lin = localParts(s.in_at, opts.timezone);
      const lout = s.out_at ? localParts(s.out_at, opts.timezone) : null;
      return {
        id: s.id,
        week_key: s.week_key,
        date: lin.date,
        in_time: lin.time,
        out_time: lout ? lout.time : null,
        in_at: s.in_at,
        out_at: s.out_at || null,
        hours: shiftHours(s),
        source: s.source || "kiosk",
        note: s.note || "",
        missed_out: !!s.missed_out,
        edited_by: s.edited_by || null,
      };
    }),
    summary,
  };
  if (isAdmin && emp.hourly_rate != null) {
    row.estimated_cost = round2(Number(emp.hourly_rate) * summary.total_hours);
  }
  return row;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { isAdmin, username } = await callerScope(sess);
    const settings = await getSettings();
    const weekStartDay = Number(settings.week_start_day) || 0;
    const timezone = SHOP_TIMEZONE;
    const opts = {
      weekStartDay,
      timezone,
      overtimeAfter: Number(settings.overtime_after_hours) || 0,
      roundMinutes: Number(settings.clock_round_minutes) || 0,
    };
    const q = req.query || {};

    /* ---- READ ------------------------------------------------------- */

    if (req.method === "GET") {
      // Any date inside the week works, so a date picker does not have to
      // know the week start rule.
      const anchor = String(q.week || q.date || "").trim() || localToday(timezone);
      const weekKey = weekKeyFor(anchor, weekStartDay);
      const rangeStart = String(q.start || "").trim();
      const rangeEnd = String(q.end || "").trim();
      const useRange = !!(rangeStart && rangeEnd);

      let employees;
      if (isAdmin) {
        employees = await listEmployees();
        const dept = String(q.dept || "").trim();
        const only = String(q.employee_id || "").trim();
        if (dept) employees = employees.filter((e) => e.department === dept);
        if (only) employees = employees.filter((e) => e.id === only);

        // Salaried staff (clock_enabled false) are left out of the grid.
        // They never punch, so they would sit there showing 0.00 across
        // every day of every week forever, which is noise on the one screen
        // that exists to make a wrong number obvious.
        //
        // Picking someone explicitly in the employee filter still shows
        // them. That matters for anyone who moved from hourly to salary:
        // their old weeks are real and still have to be reachable.
        if (!only) employees = employees.filter((e) => e.clock_enabled !== false);
        // Terminated staff are hidden by default but stay reachable, because
        // a final paycheck is exactly when someone needs their last week.
        if (String(q.include_inactive || "") !== "1") {
          employees = employees.filter((e) => e.status !== "terminated");
        }
      } else {
        const own = await getEmployeeByUsername(username);
        if (!own) {
          return res.status(200).json({
            scope: "own", employee: null, rows: [], week_key: weekKey,
            error_hint: "Your login isn't linked to an employee record yet.",
          });
        }
        employees = [own];
      }

      const rows = await Promise.all(
        employees.map(async (emp) => {
          const shifts = useRange
            ? await listRange(emp.id, rangeStart, rangeEnd, weekStartDay)
            : await listWeek(emp.id, weekKey);
          return buildRow(emp, shifts, { ...opts, weekKey: useRange ? null : weekKey }, isAdmin);
        })
      );

      const totals = rows.reduce((acc, r) => {
        acc.hours = round2(acc.hours + r.summary.total_hours);
        acc.overtime = round2(acc.overtime + r.summary.overtime_hours);
        acc.flags += r.summary.flags.length;
        if (r.estimated_cost != null) acc.cost = round2((acc.cost || 0) + r.estimated_cost);
        return acc;
      }, { hours: 0, overtime: 0, flags: 0, cost: isAdmin ? 0 : null });

      const nowIn = isAdmin ? await whoIsIn(employees.map((e) => e.id)) : [];

      return res.status(200).json({
        scope: isAdmin ? "all" : "own",
        timezone,
        week_start_day: weekStartDay,
        week_key: useRange ? null : weekKey,
        dates: useRange ? null : weekDates(weekKey),
        range: useRange ? { start: rangeStart, end: rangeEnd } : null,
        round_minutes: opts.roundMinutes,
        overtime_after: opts.overtimeAfter,
        rows,
        totals,
        now_in: nowIn.map((n) => {
          const emp = employees.find((e) => e.id === n.employee_id);
          return { ...n, name: emp ? emp.name : n.employee_id, since_local: localParts(n.since, timezone).time };
        }),
      });
    }

    /* ---- WRITES (admin only) ---------------------------------------- */

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateShiftEdit(body, { timezone });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const emp = await getEmployee(record.employee_id);
      if (!emp) return res.status(404).json({ error: "Employee not found" });

      const shift = await addShift(record, { weekStartDay, timezone, by: username });
      return res.status(200).json({ ok: true, shift });
    }

    if (req.method === "PATCH") {
      const employeeId = String(q.employee_id || "").trim();
      const weekKey = String(q.week || "").trim();
      const shiftId = String(q.id || "").trim();
      if (!employeeId || !weekKey || !shiftId) {
        return res.status(400).json({ error: "employee_id, week, and id are all required" });
      }
      const body = parseBody(req);
      const { ok, errors, record } = validateShiftEdit(
        { ...body, employee_id: employeeId }, { timezone }
      );
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const updated = await updateShift(employeeId, weekKey, shiftId, {
        in_at: record.in_at, out_at: record.out_at, note: record.note || "", source: "manual",
      }, { weekStartDay, timezone, by: username });

      if (!updated) return res.status(404).json({ error: "Shift not found" });
      return res.status(200).json({ ok: true, shift: updated });
    }

    if (req.method === "DELETE") {
      const employeeId = String(q.employee_id || "").trim();
      const weekKey = String(q.week || "").trim();
      const shiftId = String(q.id || "").trim();
      if (!employeeId || !weekKey || !shiftId) {
        return res.status(400).json({ error: "employee_id, week, and id are all required" });
      }
      const gone = await deleteShift(employeeId, weekKey, shiftId);
      if (!gone) return res.status(404).json({ error: "Shift not found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[timecards]", e);
    return res.status(500).json({ error: "Server error" });
  }
}
