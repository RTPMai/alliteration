// api/traveltrack/expenses.js — expense CRUD plus the approval workflow.
//
// GET    -> list expenses (own, or everyone's for data_scope "all"), or ?id=.
// POST   -> submit an expense. Always starts "pending" and attributed to the
//           caller — status and submitted_by are never trusted from the client.
// PATCH  -> edit fields (owner, while pending) or change status (data_scope
//           "all" + can_edit only — that's the approve/reject/reimburse step).
// DELETE -> owner (while pending) or a data_scope "all" + can_edit user.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateExpense, validateStatus } from "../../lib/traveltrack/schema.js";
import {
  listExpenses, getExpense, saveExpense, updateExpense, deleteExpense,
} from "../../lib/traveltrack/store.js";
import { getOrgSettings } from "../../lib/traveltrack/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    scope: (role && role.data_scope) || "all",
    canEdit: role ? !!role.can_edit : true,
    name: (user && user.name) || sess.name || sess.username,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { scope, canEdit, name } = await callerScope(sess);
    const mine = String(sess.username || "").trim().toLowerCase();

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        const expense = await getExpense(id);
        if (!expense) return res.status(404).json({ error: "Expense not found" });
        if (scope !== "all" && String(expense.submitted_by || "").toLowerCase() !== mine) {
          return res.status(403).json({ error: "Not your expense" });
        }
        return res.status(200).json({ expense });
      }
      let expenses = await listExpenses();
      if (scope !== "all") {
        expenses = expenses.filter((e) => String(e.submitted_by || "").toLowerCase() === mine);
      }
      return res.status(200).json({ expenses });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const org = await getOrgSettings();
      const { ok, errors, record } = validateExpense(body, { mileageRate: org.mileage_rate });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      record.status = "pending";
      record.submitted_by = sess.username;
      record.submitted_by_name = name;
      record.approved_by = null;
      record.approved_at = null;
      record.reimbursed_at = null;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const expense = await saveExpense(record);
      return res.status(201).json({ ok: true, expense });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing expense id" });

      const existing = await getExpense(id);
      if (!existing) return res.status(404).json({ error: "Expense not found" });

      const isOwner = String(existing.submitted_by || "").toLowerCase() === mine;

      // ---- Status change: approve / reject / reimburse -----------------
      // A dedicated lane so an approver's PATCH can't also sneak in a rewrite
      // of the amount or category alongside the decision.
      if (body.status !== undefined) {
        if (!(scope === "all" && canEdit)) {
          return res.status(403).json({ error: "Only an approver can change expense status" });
        }
        if (!validateStatus(body.status)) {
          return res.status(400).json({ error: "Invalid status" });
        }
        const patch = { status: body.status };
        if (body.status === "approved") {
          patch.approved_by = sess.username;
          patch.approved_at = new Date().toISOString();
        } else if (body.status === "reimbursed") {
          patch.reimbursed_at = new Date().toISOString();
          if (!existing.approved_by) { patch.approved_by = sess.username; patch.approved_at = new Date().toISOString(); }
        } else if (body.status === "pending") {
          patch.approved_by = null; patch.approved_at = null; patch.reimbursed_at = null;
        }
        const expense = await updateExpense(id, patch);
        return res.status(200).json({ ok: true, expense });
      }

      // ---- Field edit ----------------------------------------------------
      // Owners may only edit their own expense, and only while it's still
      // pending — once an approver has acted, the record is theirs to change.
      if (!(scope === "all" && canEdit)) {
        if (!isOwner) return res.status(403).json({ error: "Not allowed to edit this expense" });
        if (existing.status !== "pending") {
          return res.status(403).json({ error: "This expense has already been reviewed" });
        }
      }

      const org = await getOrgSettings();
      const { ok, errors, record } = validateExpense(
        { ...body, _existingCategory: existing.category },
        { partial: true, mileageRate: org.mileage_rate }
      );
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const expense = await updateExpense(id, record);
      return res.status(200).json({ ok: true, expense });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing expense id" });

      const existing = await getExpense(id);
      if (!existing) return res.status(404).json({ error: "Expense not found" });

      const isOwner = String(existing.submitted_by || "").toLowerCase() === mine;
      const approverCanDelete = scope === "all" && canEdit;
      if (!approverCanDelete && !(isOwner && existing.status === "pending")) {
        return res.status(403).json({ error: "Not allowed to delete this expense" });
      }

      await deleteExpense(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("traveltrack/expenses route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
