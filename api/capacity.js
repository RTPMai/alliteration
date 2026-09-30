// PUT IN: api/capacity.js
// api/capacity.js: time off for BackBone's Capacity card.
//
// GET ?names=Alexis Davis|Hannah Posey
//   -> { canSeeOut, out: { "Alexis Davis": [{ start_date, end_date, type, status }] } }
//
// The quotes and jobs half of Capacity already reaches the screen through the
// ops snapshot. This route adds the other half: which account managers are
// out this week and next.
//
// WHO SEES IT. Time off belongs to CrewCore, whose rule (Sep 22 2026) is that
// the team calendar is for admins and supervisors. So this answers only for
// the Admin flag or a time off approver (Ryan and Megan). Anybody else with
// BackBone gets canSeeOut: false and the card shows jobs and quotes without
// availability. Widening that is a one-line change here if Ryan wants AMs to
// see each other's days out.
//
// WHAT IT SENDS. Dates, the kind of day (full or part) and approved or
// pending. Never hours, balances, notes or reasons. And only for the names
// the card asked about, so it cannot be used to read the whole shop's
// calendar.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { permsFor } from "../lib/users.js";
import { listEmployees } from "../lib/crewcore/store.js";
import { listRequests, getPolicyDoc } from "../lib/crewcore/pto-store.js";
import { canApprove } from "../lib/crewcore/pto.js";
import { samePerson, workWeeks } from "../lib/backbone/capacity.js";

/** May this caller see account managers' days out? Exported for the tests. */
export async function capacityAccess(username) {
  const perms = await permsFor(username);
  const admin = !!(perms && perms.superuser === true);
  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  const read = admin || tabs.includes("backbone");
  let seeOut = admin;
  if (read && !seeOut) {
    try { seeOut = canApprove(username, await getPolicyDoc()); } catch (e) { seeOut = false; }
  }
  return { read, seeOut };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const can = await capacityAccess(sess.username);
    if (!can.read) return res.status(403).json({ error: "Capacity is part of BackBone, which this account cannot open." });
    if (!can.seeOut) return res.status(200).json({ canSeeOut: false, out: {} });

    const names = String((req.query && req.query.names) || "")
      .split("|").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!names.length) return res.status(200).json({ canSeeOut: true, out: {} });

    const weeks = workWeeks();
    const from = weeks.thisWeek[0];
    const to = weeks.nextWeek[weeks.nextWeek.length - 1];

    const [employees, requests] = await Promise.all([listEmployees(), listRequests()]);
    const out = {};
    names.forEach((name) => {
      const emp = employees.find((e) => e && e.status !== "terminated" && samePerson(e.name, name));
      out[name] = !emp ? [] : requests
        .filter((r) => r && r.employee_id === emp.id && (r.status === "approved" || r.status === "pending"))
        .filter((r) => String(r.end_date || r.start_date) >= from && String(r.start_date) <= to)
        .map((r) => ({ start_date: r.start_date, end_date: r.end_date || r.start_date, type: r.type || "all_days", status: r.status }));
      if (!emp) out[name].unmatched = true;
    });
    // Say which names had no CrewCore record, so the card can tell "not out"
    // apart from "we could not find this person".
    const unmatched = names.filter((n) => out[n].unmatched);
    names.forEach((n) => { delete out[n].unmatched; });
    return res.status(200).json({ canSeeOut: true, out, unmatched, from, to });
  } catch (e) {
    console.error("capacity error:", e);
    return res.status(500).json({ error: e.message });
  }
}
