// api/crewcore/docs.js — employee documentation: issues and problems.
//
// ADMIN ONLY, EVERY METHOD, INCLUDING GET. This is the one route in CrewCore
// with no self-serve half at all, and that is the whole feature: an entry
// here must never reach the person it is about.
//
// The gate is therefore the FIRST thing after auth, before any method
// branch and before any read. Compare api/crewcore/reviews.js and
// api/crewcore/stipend.js, which both check isAdmin inside GET and then
// again before writes: they have a legitimate own-record answer to give, so
// the shape of the check follows the shape of the answer. Here there is no
// own-record answer, so there is nothing to branch on. A future edit adding
// a GET branch cannot accidentally serve documentation to an employee,
// because the handler has already returned by then.
//
// Documentation also lives under its own KV index rather than as a flagged
// review, so there is no filter anywhere that has to remember to strip it.
// See the note above validateDoc() in lib/crewcore/schema.js.
//
// GET    -> every entry, or one person's with ?employee_id=
// POST   -> write a new entry
// PATCH  -> correct one (partial; only the fields sent change)
// DELETE -> remove one
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { validateDoc, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import {
  listDocs, getDoc, saveDoc, deleteDoc,
} from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function isAdminCaller(sess) {
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
    // THE GATE. Nothing below this line runs for anybody who is not a
    // CrewCore admin, on any method.
    if (!(await isAdminCaller(sess))) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (req.method === "GET") {
      const empId = req.query && req.query.employee_id;
      let docs = await listDocs();
      if (empId) docs = docs.filter((d) => d.employee_id === empId);
      return res.status(200).json({ docs });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateDoc(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      record.created_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const doc = await saveDoc(record);
      return res.status(201).json({ ok: true, doc });
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing entry id" });

      const existing = await getDoc(id);
      if (!existing) return res.status(404).json({ error: "Entry not found" });

      const { ok, errors, record } = validateDoc(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // Merge onto what is stored so untouched fields survive, and pin the
      // identity fields so a body cannot re-point an entry at another id or
      // rewrite who first wrote it. Same shape as the stipend PATCH.
      //
      // employee_id is pinned too: moving an entry from one person's file to
      // another's is not a correction. It is a delete and a re-write, and it
      // should look like one.
      const merged = {
        ...existing,
        ...record,
        id: existing.id,
        employee_id: existing.employee_id,
        created_by: existing.created_by,
        created_at: existing.created_at,
        updated_at: new Date().toISOString(),
        updated_by: sess.username,
      };

      const doc = await saveDoc(merged);
      return res.status(200).json({ ok: true, doc });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing entry id" });
      const existing = await getDoc(id);
      if (!existing) return res.status(404).json({ error: "Entry not found" });
      await deleteDoc(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/docs route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
