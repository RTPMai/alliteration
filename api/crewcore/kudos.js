// api/crewcore/kudos.js — kudos: credit handed out across the shop.
//
// The opposite of api/crewcore/docs.js in every respect that matters, and
// deliberately so:
//
// GET    -> anyone signed in with CrewCore access. The whole feed, plus the
//           names needed to write one and enough about the caller for the
//           screen to know what it may offer. Praise only the two people
//           involved can see is a private message, not kudos.
// POST   -> anyone signed in. A manager giving credit and one employee
//           thanking another are the same record; the app has no reason to
//           tell them apart.
// DELETE -> the author, or an admin. NOT the recipient — see canDeleteKudos()
//           in lib/crewcore/schema.js.
//
// There is no PATCH. A kudos is a couple of lines about a colleague; if it is
// wrong it gets deleted and written again, which is cheaper than an edit
// trail on something this small.
//
// WHY THIS ROUTE HANDS BACK NAMES. A self-serve employee cannot open the
// roster (admin only since Aug 2026), so without a name list here they would
// have nobody to pick. What is returned is names and ids ONLY, of people who
// have not been terminated, never the department, rate, stipend or anything
// else on an employee record. Everybody in the building already knows who
// works here, and the kiosk at /clock lists the same names to anyone standing
// in front of it.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { validateKudos, canDeleteKudos, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import {
  listKudos, getKudos, saveKudos, deleteKudos,
  listEmployees, getEmployee, getEmployeeByUsername,
} from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return {
    user,
    isAdmin: isCrewCoreAdmin({
      superuser: user && user.superuser,
      roleName: user ? user.role : sess.role,
    }),
  };
}

/** Display name for the caller, preferring the account's own name field. */
function callerName(sess, user, ownEmployee) {
  return String((user && user.name) || (ownEmployee && ownEmployee.name) || sess.username || "").trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { user, isAdmin } = await callerScope(sess);
    // An admin account may well have no employee record of its own. That is
    // fine for giving kudos (the author is recorded by username) and simply
    // means nothing is filtered out of the picker for them.
    const own = await getEmployeeByUsername(sess.username);

    if (req.method === "GET") {
      const kudos = await listKudos();
      const roster = await listEmployees();

      // Names only. Terminated employees are left out of the picker but
      // stay resolvable in the feed below, so an old kudos to somebody who
      // has since left still reads as their name rather than an id.
      const people = roster
        .filter((e) => e.status !== "terminated")
        .filter((e) => !(own && e.id === own.id))
        .map((e) => ({ id: e.id, name: e.name }));

      const names = {};
      roster.forEach((e) => { names[e.id] = e.name; });

      return res.status(200).json({
        kudos,
        people,
        names,
        me: {
          username: sess.username,
          employee_id: own ? own.id : null,
          is_admin: isAdmin,
        },
      });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateKudos(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const target = await getEmployee(record.to_employee_id);
      if (!target) return res.status(400).json({ error: "That person is not on the roster" });
      if (target.status === "terminated") {
        return res.status(400).json({ error: "That person no longer works here" });
      }

      // NO SELF-KUDOS. Refused here rather than left to the picker not
      // offering your own name: the screen is not the gate anywhere else in
      // this app either.
      if (own && own.id === target.id) {
        return res.status(400).json({ error: "Kudos go to somebody else, not yourself" });
      }

      record.to_name = target.name;
      record.from_username = sess.username;
      record.from_name = callerName(sess, user, own);
      record.from_employee_id = own ? own.id : null;
      record.created_at = new Date().toISOString();

      const kudos = await saveKudos(record);
      return res.status(201).json({ ok: true, kudos });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing kudos id" });

      const existing = await getKudos(id);
      if (!existing) return res.status(404).json({ error: "Kudos not found" });

      if (!canDeleteKudos(existing, { username: sess.username, isAdmin })) {
        return res.status(403).json({ error: "Only whoever wrote it, or an admin, can remove a kudos" });
      }

      await deleteKudos(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/kudos route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
