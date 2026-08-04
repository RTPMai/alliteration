// api/crewcore/pto.js — PTO balances and requests.
//
// GET    -> data_scope "all": every request (optionally ?employee_id=).
//           data_scope "own": just the caller's own requests, plus a computed
//           balance for the current year.
// POST   -> submit a request. Self-serve callers submit for THEMSELVES only
//           (employee_id is forced to their own linked employee record,
//           never taken from the body). Admin-scope may submit on behalf of
//           anyone by passing employee_id.
// PATCH  -> status changes (approve/deny/cancel). Approve/deny is admin-scope
//           only. An employee may cancel their OWN still-pending request.
// DELETE -> admin-scope only.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validatePtoRequest, validatePtoStatus } from "../../lib/crewcore/schema.js";
import {
  listPtoRequests, getPtoRequest, savePtoRequest, updatePtoRequest, deletePtoRequest,
  getEmployeeByUsername, usedPtoDays,
} from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return { isAdmin: (role && role.data_scope === "all") || (user && user.superuser === true) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { isAdmin } = await callerScope(sess);
    const own = await getEmployeeByUsername(sess.username);

    if (req.method === "GET") {
      if (isAdmin) {
        const empId = req.query && req.query.employee_id;
        let requests = await listPtoRequests();
        if (empId) requests = requests.filter((r) => r.employee_id === empId);
        return res.status(200).json({ requests });
      }

      if (!own) return res.status(200).json({ requests: [], balance: null });

      const all = await listPtoRequests();
      const mine = all.filter((r) => r.employee_id === own.id);
      const year = new Date().getFullYear();
      const used = await usedPtoDays(own.id, year);
      const balance = {
        year,
        allotted: own.pto_days_per_year || 0,
        used,
        remaining: Math.max(0, (own.pto_days_per_year || 0) - used),
      };
      return res.status(200).json({ requests: mine, balance });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validatePtoRequest(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      let employeeId;
      if (isAdmin && body.employee_id) {
        employeeId = body.employee_id;
      } else {
        if (!own) {
          return res.status(400).json({
            error: "No employee record is linked to your login. Ask an admin to link your account in CrewCore before requesting time off.",
          });
        }
        employeeId = own.id;
      }

      record.employee_id = employeeId;
      record.status = "pending";
      record.requested_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const request = await savePtoRequest(record);
      return res.status(201).json({ ok: true, request });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing request id" });

      const existing = await getPtoRequest(id);
      if (!existing) return res.status(404).json({ error: "PTO request not found" });

      if (body.status !== undefined) {
        if (!validatePtoStatus(body.status)) {
          return res.status(400).json({ error: "Invalid status" });
        }

        const isOwnRequest = own && existing.employee_id === own.id;

        if (body.status === "cancelled") {
          // Self-cancel allowed only while still pending, and only your own.
          const selfCancelOk = isOwnRequest && existing.status === "pending";
          if (!isAdmin && !selfCancelOk) {
            return res.status(403).json({ error: "Not allowed to cancel this request" });
          }
        } else {
          // approved / denied — admin only.
          if (!isAdmin) {
            return res.status(403).json({ error: "Admin access required to approve or deny" });
          }
        }

        const request = await updatePtoRequest(id, {
          status: body.status,
          decided_by: body.status === "cancelled" ? existing.decided_by || null : sess.username,
          decided_at: new Date().toISOString(),
        });
        return res.status(200).json({ ok: true, request });
      }

      if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
      const { ok, errors, record } = validatePtoRequest(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      const request = await updatePtoRequest(id, record);
      return res.status(200).json({ ok: true, request });
    }

    if (req.method === "DELETE") {
      if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing request id" });
      const existing = await getPtoRequest(id);
      if (!existing) return res.status(404).json({ error: "PTO request not found" });
      await deletePtoRequest(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/pto route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
