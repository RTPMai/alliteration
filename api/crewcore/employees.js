// api/crewcore/employees.js — employee roster CRUD, scoped by role.
//
// GET    -> data_scope "all": every employee. data_scope "own": just the
//           caller's own record (via their linked username), with
//           ADMIN_ONLY_FIELDS stripped even for that own record.
// POST   -> create an employee. Admin-scope only (data_scope "all" + can_edit
//           is not required here — CrewCore write access is admin/superuser
//           by design, not gated on the generic can_edit flag other apps use,
//           since a record here is pay and review data, not a lead or trip).
// PATCH  -> edit. Admin-scope only.
// DELETE -> admin-scope only.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateEmployee, stripAdminFields } from "../../lib/crewcore/schema.js";
import {
  listEmployees, getEmployee, getEmployeeByUsername,
  saveEmployee, updateEmployee, deleteEmployee, seedFromContactList,
} from "../../lib/crewcore/store.js";

// Checks the "Shell username (optional)" link before saving, rather than
// letting a typo silently save. A broken link leaves a self-serve employee
// stuck seeing "ask an admin to link your account" with nothing pointing at
// why — this catches it at write time instead.
//   - blank/null username is always fine, the link is optional
//   - the username must belong to a REAL shell account
//   - it can't already be claimed by a DIFFERENT employee record (one login,
//     one employee record — otherwise two people could resolve to the same
//     self-serve identity)
async function checkUsernameLink(username, ownEmployeeId) {
  if (!username) return null; // optional field, nothing to check
  const user = await getUser(username);
  if (!user) return "Shell username \"" + username + "\" does not match any Alliteration account.";

  const all = await listEmployees();
  const claimedBy = all.find(
    (e) => e.id !== ownEmployeeId && String(e.username || "").toLowerCase() === String(username).toLowerCase()
  );
  if (claimedBy) {
    return "Shell username \"" + username + "\" is already linked to " + (claimedBy.name || claimedBy.id) + ".";
  }
  return null;
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    // Superusers always get the admin view, same convention canAccess() uses
    // in js/registry.js for stub-app visibility.
    isAdmin: (role && role.data_scope === "all") || (user && user.superuser === true),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { isAdmin } = await callerScope(sess);

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      const seed = req.query && req.query.seed;

      // One-time roster seed from the Wix Contact List, admin-triggered.
      if (seed === "1") {
        if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
        const result = await seedFromContactList(sess.username);
        return res.status(200).json(result);
      }

      if (isAdmin) {
        if (id) {
          const emp = await getEmployee(id);
          if (!emp) return res.status(404).json({ error: "Employee not found" });
          return res.status(200).json({ employee: emp });
        }
        const employees = await listEmployees();
        return res.status(200).json({ employees });
      }

      // Self-serve: only the caller's own record, and only the non-sensitive
      // fields. No id lookup for anyone else — an id in the query is ignored
      // for a self-serve caller rather than honored, so there is no way to
      // fetch a coworker's record by guessing an EMP-##### id.
      const own = await getEmployeeByUsername(sess.username);
      if (!own) return res.status(200).json({ employee: null });
      return res.status(200).json({ employee: stripAdminFields(own) });
    }

    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateEmployee(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const usernameError = await checkUsernameLink(record.username, null);
      if (usernameError) return res.status(400).json({ error: usernameError });

      record.created_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const employee = await saveEmployee(record);
      return res.status(201).json({ ok: true, employee });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing employee id" });

      const existing = await getEmployee(id);
      if (!existing) return res.status(404).json({ error: "Employee not found" });

      const { ok, errors, record } = validateEmployee(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      if (record.username !== undefined) {
        const usernameError = await checkUsernameLink(record.username, id);
        if (usernameError) return res.status(400).json({ error: usernameError });
      }

      const employee = await updateEmployee(id, record);
      return res.status(200).json({ ok: true, employee });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing employee id" });

      const existing = await getEmployee(id);
      if (!existing) return res.status(404).json({ error: "Employee not found" });

      await deleteEmployee(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/employees route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
