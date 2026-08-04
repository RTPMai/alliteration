// api/crewcore/stipend.js — apparel stipend spend log and balances.
//
// GET    -> data_scope "all": every spend entry (optionally ?employee_id=).
//           data_scope "own": just the caller's own spend log, plus a
//           computed balance (allotment minus this year's spend).
// POST   -> log a spend entry. Admin-scope only — a self-serve employee can
//           see their own balance but cannot add or edit entries themselves;
//           this mirrors how the physical purchase actually happens (an
//           admin or bookkeeper records what was bought against the
//           allotment, not the employee self-reporting).
// DELETE -> admin-scope only.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateStipendSpend } from "../../lib/crewcore/schema.js";
import {
  listStipendSpends, getStipendSpend, saveStipendSpend, deleteStipendSpend,
  usedStipendThisYear, getEmployeeByUsername,
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

    if (req.method === "GET") {
      if (isAdmin) {
        const empId = req.query && req.query.employee_id;
        let spends = await listStipendSpends();
        if (empId) spends = spends.filter((s) => s.employee_id === empId);
        return res.status(200).json({ spends });
      }

      const own = await getEmployeeByUsername(sess.username);
      if (!own) return res.status(200).json({ spends: [], balance: null });

      const all = await listStipendSpends();
      const mine = all.filter((s) => s.employee_id === own.id);
      const year = new Date().getFullYear();
      const used = await usedStipendThisYear(own.id, year);
      const allotted = own.apparel_stipend || 0;
      const balance = {
        year,
        allotted,
        used: Math.round(used * 100) / 100,
        remaining: Math.round(Math.max(0, allotted - used) * 100) / 100,
      };
      return res.status(200).json({ spends: mine, balance });
    }

    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateStipendSpend(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      record.logged_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const spend = await saveStipendSpend(record);
      return res.status(201).json({ ok: true, spend });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing spend id" });
      const existing = await getStipendSpend(id);
      if (!existing) return res.status(404).json({ error: "Spend entry not found" });
      await deleteStipendSpend(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/stipend route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
