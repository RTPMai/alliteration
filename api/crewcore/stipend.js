// api/crewcore/stipend.js — apparel stipend spend log and balances.
//
// GET    -> admin (superuser or the admin role): every spend entry
//           (optionally ?employee_id=). Everyone else: their own log, plus a
//           computed balance for ?year= (defaults to the current year).
//           The stipend re-ups every Jan 1, so a balance only means anything
//           against a stated year. Callers may look back at closed years;
//           the log itself is returned whole and filtered by the screen.
// POST   -> log a spend entry. Admin-scope only — a self-serve employee can
//           see their own balance but cannot add or edit entries themselves;
//           this mirrors how the physical purchase actually happens (an
//           admin or bookkeeper records what was bought against the
//           allotment, not the employee self-reporting).
// PATCH  -> correct an existing entry (admin-scope only). Partial: only the
//           fields sent are changed. A wrong amount or a mistyped date is a
//           correction, not a reason to delete and re-key the purchase, so
//           the entry keeps its id and its original created_at.
// DELETE -> admin-scope only.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { validateStipendSpend, stipendBalance, spendsFor, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import {
  listStipendSpends, getStipendSpend, saveStipendSpend, deleteStipendSpend,
  getEmployeeByUsername,
} from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/**
 * A year for balance math. Anything unparseable falls back to the current
 * year rather than erroring: a bad query string should not cost the caller
 * their whole stipend screen.
 */
function parseYear(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 2000 || n > 2100) return new Date().getFullYear();
  return n;
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return { isAdmin: isCrewCoreAdmin({
    superuser: user && user.superuser,
    roleName: user ? user.role : sess.role,
  }) };
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
      const mine = spendsFor(all, own.id, null);
      const year = parseYear(req.query && req.query.year);
      const balance = stipendBalance(own.apparel_stipend, mine, year);
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

    if (req.method === "PATCH" || req.method === "PUT") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing spend id" });

      const existing = await getStipendSpend(id);
      if (!existing) return res.status(404).json({ error: "Spend entry not found" });

      const { ok, errors, record } = validateStipendSpend(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // Merge onto the stored entry so untouched fields survive, and pin the
      // identity fields so a body cannot re-point an entry at a different id.
      const merged = {
        ...existing,
        ...record,
        id: existing.id,
        created_at: existing.created_at,
        logged_by: existing.logged_by,
        updated_at: new Date().toISOString(),
        updated_by: sess.username,
      };

      const spend = await saveStipendSpend(merged);
      return res.status(200).json({ ok: true, spend });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing spend id" });
      const existing = await getStipendSpend(id);
      if (!existing) return res.status(404).json({ error: "Spend entry not found" });
      await deleteStipendSpend(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/stipend route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
