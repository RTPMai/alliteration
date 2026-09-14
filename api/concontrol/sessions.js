// api/concontrol/sessions.js — the program grid.
//
// GET         -> sessions for the event, plus conflicts and the public agenda
// POST        -> create
// PATCH ?id=  -> update
// DELETE ?id= -> delete, admin only
//
// Read is open to any signed-in user: the schedule is the thing everybody in
// the building needs and nobody should have to ask for. Writing is can_edit.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import {
  validateSessionPatch, newSession, scheduleConflicts, publicAgenda,
} from "../../lib/concontrol/program.js";
import {
  listSessions, getSession, saveSession, updateSession, deleteSession,
  nextSessionId, listSpeakers, getSettings,
} from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function gate(sess) {
  const perms = await permsFor(sess.username);
  const superuser = !!(perms && perms.superuser === true);
  return {
    canEdit: superuser || !!(perms && perms.can_edit !== false),
    canDelete: superuser || !!(perms && perms.role === "admin"),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};
  const id = q.id || null;

  try {
    const settings = await getSettings();
    const event = (q.event && String(q.event)) || settings.event || DEFAULT_EVENT;
    const { canEdit, canDelete } = await gate(sess);

    if (req.method === "GET") {
      if (id) {
        const session = await getSession(id);
        if (!session) return res.status(404).json({ error: "Session not found" });
        return res.status(200).json({ session, canEdit, canDelete });
      }
      const sessions = await listSessions(event);
      const speakers = await listSpeakers(event);
      return res.status(200).json({
        sessions,
        speakers,
        event,
        settings,
        conflicts: scheduleConflicts(sessions),
        agenda: publicAgenda(sessions, speakers),
        canEdit,
        canDelete,
      });
    }

    if (req.method === "POST" || req.method === "PATCH") {
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });
      const body = parseBody(req);
      const speakerIds = (await listSpeakers(event)).map((s) => s.id);
      const { ok, errors, patch } = validateSessionPatch(body, speakerIds);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });

      if (req.method === "POST") {
        if (!patch.title) return res.status(400).json({ error: "A session needs a title" });
        const newId = await nextSessionId();
        const record = { ...newSession(newId, sess.username, event), ...patch, id: newId };
        record.history = [historyEntry("created", sess.username, null)];
        await saveSession(record);
        return res.status(201).json({ ok: true, session: record });
      }

      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing session id" });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const before = await getSession(target);
      if (!before) return res.status(404).json({ error: "Session not found" });
      const note = patch.status && patch.status !== before.status
        ? historyEntry(`status ${before.status} to ${patch.status}`, sess.username, null)
        : null;

      const session = await updateSession(target, patch, note);
      return res.status(200).json({ ok: true, session });
    }

    if (req.method === "DELETE") {
      if (!canDelete) return res.status(403).json({ error: "Deleting a session is admin only." });
      if (!id) return res.status(400).json({ error: "Missing session id" });
      const gone = await deleteSession(id);
      if (!gone) return res.status(404).json({ error: "Session not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol sessions route error:", e);
    return res.status(500).json({ error: e.message || "Session request failed" });
  }
}
