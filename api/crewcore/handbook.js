// api/crewcore/handbook.js — the Employee Handbook, read-only content plus
// self-serve acknowledgment.
//
// GET  -> the full handbook content, PLUS (self-serve callers only) whether
//         the caller's own record is acknowledged against the current
//         version. No scope split on the content itself: anyone who can
//         open CrewCore (admin or self-serve "employee" role) can read the
//         whole handbook — there's no sensitive figure in it beyond the
//         stipend dollar amounts, which are already public shop policy
//         (posted on the internal Wix site before this), not per-employee
//         pay data.
// POST -> self-serve ONLY. Records that the CALLER has read and agreed to
//         the CURRENT handbook version on their own employee record. An
//         admin can never acknowledge on someone else's behalf here — that
//         would defeat the point of an acknowledgment. Admin callers get
//         403; there is nothing for an admin to acknowledge through this
//         route (see the mount-time gate in apps/crewcore.js, which only
//         applies to self-serve callers with a linked record in the first
//         place).
//
// The content itself lives in lib/crewcore/handbook-content.js as static
// data (see that file's header for why it's not KV-backed). This route
// exists mainly so the front end goes through the seam like everything
// else, and so the shape can change later (e.g. versioning, KV-backed
// edits) without the app needing to change.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { HANDBOOK_SECTIONS, HANDBOOK_UPDATED } from "../../lib/crewcore/handbook-content.js";
import { validateHandbookAck, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import { getEmployeeByUsername, updateEmployee } from "../../lib/crewcore/store.js";

async function callerIsAdmin(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return isCrewCoreAdmin({
    superuser: user && user.superuser,
    roleName: user ? user.role : sess.role,
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method === "GET") {
      const isAdmin = await callerIsAdmin(sess);
      if (isAdmin) {
        // Admins aren't gated on acknowledgment — nothing to report.
        return res.status(200).json({ sections: HANDBOOK_SECTIONS, updated: HANDBOOK_UPDATED });
      }

      const own = await getEmployeeByUsername(sess.username);
      const acknowledged = !!(own && own.handbook_ack_version === HANDBOOK_UPDATED);
      return res.status(200).json({
        sections: HANDBOOK_SECTIONS,
        updated: HANDBOOK_UPDATED,
        acknowledged,
        ack_version: own ? own.handbook_ack_version || null : null,
        ack_at: own ? own.handbook_ack_at || null : null,
      });
    }

    if (req.method === "POST") {
      const isAdmin = await callerIsAdmin(sess);
      if (isAdmin) {
        return res.status(403).json({ error: "Admins acknowledge nothing here — this records a self-serve employee's own agreement." });
      }

      const own = await getEmployeeByUsername(sess.username);
      if (!own) {
        return res.status(404).json({ error: "Your login isn't linked to an employee record yet. Ask an admin to add it in CrewCore's Roster." });
      }

      const { ok, errors, patch } = validateHandbookAck(HANDBOOK_UPDATED);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const employee = await updateEmployee(own.id, patch);
      return res.status(200).json({
        ok: true,
        acknowledged: true,
        ack_version: employee.handbook_ack_version,
        ack_at: employee.handbook_ack_at,
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/handbook route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
