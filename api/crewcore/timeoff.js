// PUT IN: api/crewcore/timeoff.js
// api/crewcore/timeoff.js: PTO requests, approvals, balances and policy.
//
// Sep 21 2026. PTO is back in CrewCore, this time as the ledger (Ryan's
// call, reversing Aug 2026). The arithmetic is in lib/crewcore/pto.js and is
// shared with the screen; this route decides who may see and do what.
//
// WHO SEES WHAT
//   An employee:       their own balance, their own requests and
//                      adjustments. Nobody else's anything.
//   An approver or a   the whole team's balances, every request, every
//   CrewCore admin:    adjustment. Names, start dates and hours only: no
//                      pay rate, no notes off the employee record.
//
// WHO DOES WHAT
//   Anyone linked:     request time off for themselves, cancel their own
//                      request while it is still pending.
//   Approvers only:    approve, deny, cancel an approved request, log time
//                      off for someone else, adjust a balance. Approvers are a list of usernames in
//                      the policy (Ryan and Megan). NOT "any admin": being a
//                      CrewCore admin does not make somebody an approver, and
//                      an empty list means nobody can approve at all.
//   CrewCore admins:   edit the policy and the approver list (Settings).
//
// PTO EXEMPT (Sep 21 2026): Ryan and Megan. No balance is kept for an exempt
// person. Time off they log is approved on the spot, nobody is asked, and it
// still shows on "who's out" so the shop knows they are gone.
//
// STARTING BALANCES were removed from the screen and this route the same
// day (Ryan entered them by hand). Any already on a roster record still
// count; see ptoLedger() in lib/crewcore/pto.js.
//
// A request's note never goes into a notification. Notifications are visible
// to everyone signed in, and "why I need Tuesday off" is nobody's business
// but the approver's.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import { listEmployees, getEmployee, getEmployeeByUsername } from "../../lib/crewcore/store.js";
import {
  validateAdjustment, validatePolicy,
  withPolicyVersion, policyForYear, canApprove, ptoBalance, ptoLedger,
  requestActions, requestYear,
} from "../../lib/crewcore/pto.js";
import {
  listRequests, getRequest, saveRequest,
  listAdjustments, getAdjustment, saveAdjustment, deleteAdjustment,
  getPolicyDoc, savePolicyDoc,
} from "../../lib/crewcore/pto-store.js";
import { sendDecisionEmail, DEFAULT_TIMEOFF_FROM } from "../../lib/crewcore/pto-email.js";
import { createTimeoffRequest, notifyTimeoff, shopYear, span } from "../../lib/crewcore/pto-request.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function parseYear(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 2000 && n <= 2100 ? n : shopYear();
}

/**
 * Email the employee and record what happened on the request, so the screen
 * can say "emailed" or why not. Never throws; the decision is already saved.
 */
async function emailEmployee({ request, event, note, doc, sess, scope }) {
  try {
    const emp = await getEmployee(request.employee_id);
    if (!emp) return request;
    const [allReq, allAdj] = await Promise.all([listRequests(), listAdjustments()]);
    const balance = ptoBalance({
      employee: emp,
      requests: allReq.filter((r) => r.employee_id === emp.id),
      adjustments: allAdj.filter((a) => a.employee_id === emp.id),
      policyDoc: doc,
    }, requestYear(request));
    const byName = (scope.own && scope.own.name) || (scope.user && scope.user.name) || sess.username;
    const out = await sendDecisionEmail({
      employee: emp, request, event, note, balance, byName,
      from: doc.email_from || DEFAULT_TIMEOFF_FROM,
      replyTo: scope.own && scope.own.email,
    });
    return saveRequest({
      ...request,
      email: { event, sent: !!out.sent, to: out.to || null, why: out.why || null, at: new Date().toISOString() },
    });
  } catch (e) {
    console.error("[crewcore/timeoff] email step failed, the decision was still saved:", e.message);
    return request;
  }
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const doc = await getPolicyDoc();
  return {
    user,
    doc,
    isAdmin: isCrewCoreAdmin({ superuser: user && user.superuser, roleName: user ? user.role : sess.role }),
    isApprover: canApprove(sess.username, doc),
    own: await getEmployeeByUsername(sess.username),
  };
}

/** What a team row carries. Deliberately narrow: see the header. */
function teamRow(e, balance) {
  return {
    id: e.id, name: e.name, department: e.department || "", status: e.status || "active",
    start_date: e.start_date || "", username: e.username || null,
    pto_exempt: e.pto_exempt === true,
    balance: e.pto_exempt === true ? null : balance,
  };
}

function refuse(res, code, msg) {
  return res.status(code).json({ error: msg });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const scope = await callerScope(sess);
    const { doc, isAdmin, isApprover, own } = scope;
    const teamView = isAdmin || isApprover;
    const me = {
      username: sess.username,
      employee_id: own ? own.id : null,
      is_admin: isAdmin,
      is_approver: isApprover,
    };

    /* ---- GET ------------------------------------------------------------ */
    if (req.method === "GET") {
      const year = parseYear(req.query && req.query.year);
      const policy = policyForYear(doc, year);
      const approversSet = doc.approvers.length > 0;

      if (teamView) {
        const [employees, requests, adjustments] = await Promise.all([listEmployees(), listRequests(), listAdjustments()]);
        const withActivity = new Set(requests.map((r) => r.employee_id));
        const team = employees
          .filter((e) => e.status !== "terminated" || withActivity.has(e.id))
          .map((e) => teamRow(e, ptoBalance({
            employee: e,
            requests: requests.filter((r) => r.employee_id === e.id),
            adjustments: adjustments.filter((a) => a.employee_id === e.id),
            policyDoc: doc,
          }, year)));
        // Who could be picked as an approver: people with a login. Names and
        // usernames only.
        const accounts = employees.filter((e) => e.username && e.status !== "terminated")
          .map((e) => ({ username: e.username, name: e.name }));
        return res.status(200).json({
          scope: "team", year, policy, policy_doc: isAdmin ? doc : undefined,
          approvers: doc.approvers, approvers_set: approversSet, accounts,
          team, requests, adjustments, me,
        });
      }

      if (!own) return res.status(200).json({ scope: "self", linked: false, year, policy, me, approvers_set: approversSet });

      const [allReq, allAdj] = await Promise.all([listRequests(), listAdjustments()]);
      const requests = allReq.filter((r) => r.employee_id === own.id);
      const adjustments = allAdj.filter((a) => a.employee_id === own.id);
      const o = { employee: own, requests, adjustments, policyDoc: doc };
      const exempt = own.pto_exempt === true;
      return res.status(200).json({
        scope: "self", linked: true, year, policy, me, approvers_set: approversSet,
        exempt,
        balance: exempt ? null : ptoBalance(o, year),
        ledger: exempt ? [] : ptoLedger({ ...o, throughYear: year }),
        requests, adjustments,
      });
    }

    /* ---- PATCH: the policy (Settings) ------------------------------------ */
    if (req.method === "PATCH") {
      if (!isAdmin) return refuse(res, 403, "Admin access required");
      const body = parseBody(req);
      const v = validatePolicy(body);
      if (!v.ok) return res.status(400).json({ error: "Validation failed", details: v.errors });
      let next = Object.keys(v.policy).length
        ? withPolicyVersion(doc, shopYear(), v.policy, sess.username)
        : { ...doc, updated_at: new Date().toISOString(), updated_by: sess.username };
      if (v.approvers) next = { ...next, approvers: v.approvers };
      if (v.emailFrom !== undefined) next = { ...next, email_from: v.emailFrom };
      const saved = await savePolicyDoc(next);
      return res.status(200).json({ ok: true, policy_doc: saved, policy: policyForYear(saved, shopYear()) });
    }

    /* ---- DELETE: an adjustment ------------------------------------------- */
    if (req.method === "DELETE") {
      if (!isApprover) return refuse(res, 403, "Only a time off approver can remove an adjustment");
      const id = (req.query && req.query.adjustment) || parseBody(req).adjustment;
      if (!id) return refuse(res, 400, "Missing adjustment id");
      const existing = await getAdjustment(id);
      if (!existing) return refuse(res, 404, "Adjustment not found");
      await deleteAdjustment(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return refuse(res, 405, "Method not allowed");
    }

    /* ---- POST: everything else, by action -------------------------------- */
    const body = parseBody(req);
    const action = String(body.action || "request");
    const now = new Date().toISOString();

    if (action === "request") {
      // For yourself, unless you are an approver logging it for somebody.
      let emp = own;
      if (body.employee_id && (!own || body.employee_id !== own.id)) {
        if (!isApprover) return refuse(res, 403, "Only a time off approver can log time off for someone else");
        emp = await getEmployee(body.employee_id);
        if (!emp) return refuse(res, 404, "Employee not found");
      }
      if (!emp) return refuse(res, 400, "Your login isn't linked to an employee record yet. Ask an admin to link it.");

      // The rules for a new request live in lib/crewcore/pto-request.js,
      // shared with the kiosk at /clock so the two doors cannot drift apart.
      const made = await createTimeoffRequest({
        emp, body, doc, by: sess.username, isApprover, source: "app",
      });
      if (!made.ok) return res.status(400).json({ error: "Validation failed", details: made.errors });
      let saved = made.request;

      // Logged as approved for somebody else: they hear about it by email,
      // since nobody asked them anything.
      if (saved.status === "approved" && (!own || emp.id !== own.id)) {
        saved = await emailEmployee({ request: saved, event: "logged", note: "", doc, sess, scope });
      }
      return res.status(201).json({ ok: true, request: saved, over_by: made.over_by, approvers_set: doc.approvers.length > 0 });
    }

    if (action === "decide" || action === "cancel") {
      const existing = await getRequest(body.id);
      if (!existing) return refuse(res, 404, "Request not found");
      const isOwner = !!own && existing.employee_id === own.id;
      const can = requestActions(existing, { isApprover, isOwner });

      let status;
      let what;
      if (action === "decide") {
        const d = String(body.decision || "");
        if (d !== "approve" && d !== "deny") return refuse(res, 400, "Decision must be approve or deny");
        if (!(d === "approve" ? can.approve : can.deny)) {
          return refuse(res, isApprover ? 409 : 403, isApprover ? `This request is already ${existing.status}` : "Only a time off approver can do that");
        }
        status = d === "approve" ? "approved" : "denied";
        what = status;
      } else {
        if (!can.cancel) {
          return refuse(res, 403, existing.status === "approved"
            ? "This request is already approved. Ask an approver to cancel it."
            : `This request is already ${existing.status}`);
        }
        status = "cancelled";
        what = "cancelled";
      }

      const note = String(body.note || "").trim().slice(0, 500);
      const updated = {
        ...existing,
        status,
        updated_at: now,
        decided_by: action === "decide" ? sess.username : existing.decided_by,
        decided_at: action === "decide" ? now : existing.decided_at,
        decision_note: action === "decide" ? note : existing.decision_note,
        history: (existing.history || []).concat([{ at: now, by: sess.username, what, note: note || undefined }]),
      };
      let saved = await saveRequest(updated);

      // Tell the person whose time off it is, unless they did it themselves.
      if (!isOwner) {
        saved = await emailEmployee({ request: saved, event: status, note: action === "decide" ? note : "", doc, sess, scope });
        const emp = await getEmployee(saved.employee_id);
        if (emp && emp.username) {
          await notifyTimeoff({
            to: emp.username, toName: emp.name,
            title: `Your time off for ${span(saved)} was ${status}`,
            detail: `${saved.hours} hours.` + (action === "decide" && note ? ` Note: ${note}` : ""),
          });
        }
      }
      return res.status(200).json({ ok: true, request: saved });
    }

    if (action === "adjust") {
      if (!isApprover) return refuse(res, 403, "Only a time off approver can adjust a balance");
      const emp = await getEmployee(body.employee_id);
      if (!emp) return refuse(res, 404, "Employee not found");
      const v = validateAdjustment(body);
      if (!v.ok) return res.status(400).json({ error: "Validation failed", details: v.errors });
      const saved = await saveAdjustment({ ...v.record, employee_id: emp.id, created_by: sess.username, created_at: now });
      return res.status(201).json({ ok: true, adjustment: saved });
    }

    return refuse(res, 400, "Unknown action");
  } catch (e) {
    console.error("crewcore/timeoff route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
