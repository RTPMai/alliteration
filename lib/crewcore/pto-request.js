// PUT IN: lib/crewcore/pto-request.js
// lib/crewcore/pto-request.js: making a time off request, in one place.
//
// Two doors lead here, and they must behave the same:
//   api/crewcore/timeoff.js   signed in (the Time Off tab)
//   api/crewcore/clock.js     the kiosk at /clock, name + passcode, no login
//                             (Sep 21 2026, Ryan: "add it to that kiosk")
//
// So the rules live here once: the hours are worked out from the type and
// times, exempt people are approved on the spot, going over the balance
// warns and never blocks, and the approvers are notified of anything pending.
// Neither route can quietly grow its own version.
//
// ESM. Do NOT convert to module.exports.

import { getEmployeeByUsername } from "./store.js";
import {
  validateRequest, policyForYear, ptoBalance, overBy, requestYear, requestSummary, usesPto,
} from "./pto.js";
import { listRequests, listAdjustments, saveRequest } from "./pto-store.js";
import { nextNotificationId, saveNotification } from "../notifications/store.js";

/** The shop's calendar year, not the server's. The server runs on UTC. */
export function shopYear(now = new Date()) {
  const y = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric" }).format(now);
  return parseInt(y, 10);
}

function fmtDay(d) {
  const [y, m, day] = String(d || "").split("-").map(Number);
  if (!y) return String(d || "");
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 2", "Oct 1 to Oct 8", "Oct 2, Leaving 3:00 PM". */
export function span(r) {
  const days = r.start_date === r.end_date ? fmtDay(r.start_date) : `${fmtDay(r.start_date)} to ${fmtDay(r.end_date)}`;
  const kind = r.type && r.type !== "all_days" ? requestSummary(r) : "";
  return kind ? `${days}, ${kind}` : days;
}

/**
 * Raise a notification. Fails soft, always: the request is already saved.
 * The employee's reason never goes in one; notifications are visible to
 * everyone signed in.
 */
export async function notifyTimeoff({ to, toName, title, detail }) {
  const assignedTo = String(to || "").trim().toLowerCase();
  if (!assignedTo) return;
  try {
    const id = await nextNotificationId();
    const now = new Date().toISOString();
    await saveNotification({
      id,
      title: String(title).slice(0, 200),
      detail: String(detail || "").slice(0, 2000),
      types: ["need"],
      appIds: ["crewcore"],
      assignedTo,
      assignedToName: toName || assignedTo,
      status: "open",
      visibility: "team",
      dueDate: null,
      link: null,
      createdBy: "crewcore",
      createdByName: "CrewCore time off",
      createdAt: now,
      doneAt: null, doneBy: null, doneByName: null,
      history: [{ at: now, by: "crewcore", byName: "CrewCore time off", what: "created" }],
    });
  } catch (e) {
    console.error("[crewcore/timeoff] notification failed, the request was still saved:", e.message);
  }
}

/**
 * The balance row a request would come out of.
 */
export async function balanceFor(emp, doc, year) {
  const [allReq, allAdj] = await Promise.all([listRequests(), listAdjustments()]);
  return ptoBalance({
    employee: emp,
    requests: allReq.filter((r) => r.employee_id === emp.id),
    adjustments: allAdj.filter((a) => a.employee_id === emp.id),
    policyDoc: doc,
  }, year);
}

/**
 * Validate, save and announce one request.
 *
 * @param {object} o
 * @param {object} o.emp              the employee it is for
 * @param {object} o.body             the submitted fields
 * @param {object} o.doc              the policy document
 * @param {string} o.by               who made it (a username, or "kiosk")
 * @param {boolean} o.isApprover      may override hours and pre-approve
 * @param {string} o.source           "app" or "kiosk", recorded on the request
 * @returns {{ ok, request?, over_by?, errors? }}
 */
export async function createTimeoffRequest(o) {
  const { emp, body, doc } = o;
  const by = String(o.by || "").toLowerCase();
  const isApprover = !!o.isApprover;
  const now = new Date().toISOString();

  const reqYear = parseInt(String((body && body.start_date) || "").slice(0, 4), 10) || shopYear();
  const v = validateRequest(body, policyForYear(doc, reqYear), { allowHours: isApprover });
  if (!v.ok) return { ok: false, errors: v.errors };

  const exempt = emp.pto_exempt === true;
  const preApproved = exempt || (isApprover && body.approved === true);
  const atKiosk = o.source === "kiosk";
  const what = exempt ? "logged (PTO exempt)" : preApproved ? "logged as approved" : atKiosk ? "requested at the kiosk" : "requested";
  const rec = {
    ...v.record,
    employee_id: emp.id,
    employee_name: emp.name,
    status: preApproved ? "approved" : "pending",
    requested_by: by,
    source: atKiosk ? "kiosk" : "app",
    created_at: now,
    updated_at: now,
    decided_by: preApproved ? (exempt && !isApprover ? "exempt" : by) : null,
    decided_at: preApproved ? now : null,
    decision_note: "",
    history: [{ at: now, by, what }],
  };

  // Warn, never block: an approver decides whether going over is fine.
  const bal = await balanceFor(emp, doc, requestYear(rec));
  // Nothing to go over when it does not come out of PTO.
  const over = exempt || !usesPto(rec) ? 0 : overBy(bal, rec.hours);

  const saved = await saveRequest(rec);

  if (saved.status === "pending") {
    const detail = `${saved.employee_name}: ${span(saved)}, ${saved.hours} hours` +
      (usesPto(saved) ? " of PTO." : ", NOT using PTO (unpaid).") +
      (over ? ` That is ${over} hours more than they have left.` : "") +
      (atKiosk ? " Sent from the time clock kiosk." : "");
    for (const a of doc.approvers) {
      if (a === by) continue;
      const acct = await getEmployeeByUsername(a);
      await notifyTimeoff({ to: a, toName: acct ? acct.name : a, title: `Time off request from ${saved.employee_name}`, detail });
    }
  }
  return { ok: true, request: saved, over_by: over, balance: bal };
}
