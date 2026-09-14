// api/concontrol/speakers.js — proposals, confirmations, and what they owe us.
//
// GET         -> speakers for the event, with material progress
// POST        -> create
// PATCH ?id=  -> update
// DELETE ?id= -> delete, admin only
//
// Read is open to any signed-in user. A speaker record holds a bio and a
// headshot, which are things people hand out on purpose. Writing is can_edit.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import {
  validateSpeakerPatch, newSpeaker, materialProgress, programBlockers,
} from "../../lib/concontrol/program.js";
import {
  listSpeakers, getSpeaker, saveSpeaker, updateSpeaker, deleteSpeaker,
  nextSpeakerId, listSessions, getSettings,
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
        const speaker = await getSpeaker(id);
        if (!speaker) return res.status(404).json({ error: "Speaker not found" });
        return res.status(200).json({ speaker, progress: materialProgress(speaker), canEdit, canDelete });
      }
      const speakers = await listSpeakers(event);
      const sessions = await listSessions(event);
      return res.status(200).json({
        speakers,
        event,
        settings,
        blockers: programBlockers(sessions, speakers),
        canEdit,
        canDelete,
      });
    }

    if (req.method === "POST" || req.method === "PATCH") {
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });
      const body = parseBody(req);
      const { ok, errors, patch } = validateSpeakerPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });

      if (req.method === "POST") {
        if (!patch.name) return res.status(400).json({ error: "A speaker needs a name" });
        const newId = await nextSpeakerId();
        const record = { ...newSpeaker(newId, sess.username, event), ...patch, id: newId };
        record.history = [historyEntry("created", sess.username, null)];
        await saveSpeaker(record);
        return res.status(201).json({ ok: true, speaker: record });
      }

      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing speaker id" });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const before = await getSpeaker(target);
      if (!before) return res.status(404).json({ error: "Speaker not found" });
      const note = patch.status && patch.status !== before.status
        ? historyEntry(`status ${before.status} to ${patch.status}`, sess.username, null)
        : null;

      const speaker = await updateSpeaker(target, patch, note);
      return res.status(200).json({ ok: true, speaker });
    }

    if (req.method === "DELETE") {
      if (!canDelete) {
        return res.status(403).json({
          error: "Deleting a speaker is admin only: a proposal we passed on is next year's list.",
        });
      }
      if (!id) return res.status(400).json({ error: "Missing speaker id" });
      // A session pointing at a deleted speaker renders as a blank name on the
      // public agenda, so this refuses rather than leaving a dangling id.
      const sessions = await listSessions(event);
      const used = sessions.filter((s) => (s.speakerIds || []).includes(id));
      if (used.length) {
        return res.status(409).json({
          error: `That speaker is on ${used.length} session${used.length === 1 ? "" : "s"}. Take them off first.`,
          sessions: used.map((s) => ({ id: s.id, title: s.title })),
        });
      }
      const gone = await deleteSpeaker(id);
      if (!gone) return res.status(404).json({ error: "Speaker not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol speakers route error:", e);
    return res.status(500).json({ error: e.message || "Speaker request failed" });
  }
}
