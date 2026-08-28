// api/sitework.js — Sticky Notes route (Site Work section).
//
// Site Work is the list of what still needs doing to Alliteration itself, kept
// separate from Notifications (the team's hand-off list) on purpose. Access is
// SUPERUSER ONLY, checked here and not merely hidden in the rail: a route that
// relies on the nav to hide it is not gated at all.
//
// Superuser today means Ryan, Jacob and Margo. To narrow it to one person,
// change isBuilder() below; nothing else needs to move.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { getUser } from "../lib/users.js";
import { validateNew, validatePatch } from "../lib/sitework/schema.js";
import {
  listNotes, getNote, saveNote, updateNote, deleteNote, nextNoteId,
} from "../lib/sitework/store.js";

// The app-id allowlist lives server-side rather than importing js/registry.js
// (browser code), so it is kept in sync by hand. Same list api/notifications.js
// keeps, minus "general" — here a blank tag already means "not about one app",
// so a separate General value would be a second way to say the same thing.
// test/sitework.test.cjs asserts this against js/registry.js's real app ids.
const APP_IDS = [
  "backbone", "shopstock", "errorengine", "givinggauge", "traveltrack",
  "crewcore", "mailme", "teletally", "websitewidget", "promopro",
  "stitchsense", "marketmachine",
];

async function isBuilder(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return !!(user && user.superuser === true);
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  // Fail closed, ahead of every branch below, so a new method added later
  // cannot accidentally ship ungated.
  if (!(await isBuilder(sess))) {
    return res.status(403).json({ error: "Site Work is admin only" });
  }

  const me = String(sess.username || "").toLowerCase();

  try {
    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        const rec = await getNote(id);
        if (!rec) return res.status(404).json({ error: "Note not found" });
        return res.status(200).json({ note: rec });
      }

      let list = await listNotes();
      const q = req.query || {};
      if (q.appId) list = list.filter((n) => n.appId === q.appId);
      if (q.status) list = list.filter((n) => n.status === q.status);
      if (q.color) list = list.filter((n) => n.color === q.color);

      return res.status(200).json({ notes: list });
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      // Bulk create, so twenty notes off a desk go up in one call instead of
      // twenty round trips. Same validation per item as a single create.
      if (Array.isArray(body.notes)) {
        if (!body.notes.length) return res.status(400).json({ error: "notes array is empty" });
        if (body.notes.length > 100) return res.status(400).json({ error: "100 notes at a time, maximum" });

        const existing = await listNotes();
        let order = existing.length;
        const created = [];
        const rejected = [];

        for (const raw of body.notes) {
          const { ok, errors, record } = validateNew(raw, APP_IDS);
          if (!ok) { rejected.push({ title: (raw && raw.title) || "", errors }); continue; }
          const full = {
            ...record,
            id: await nextNoteId(),
            status: "open",
            order: order++,
            createdBy: me,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await saveNote(full);
          created.push(full);
        }
        return res.status(201).json({ ok: true, created: created.length, rejected, notes: created });
      }

      const { ok, errors, record } = validateNew(body, APP_IDS);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const existing = await listNotes();
      const full = {
        ...record,
        id: await nextNoteId(),
        status: "open",
        order: existing.length,
        createdBy: me,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveNote(full);
      return res.status(201).json({ ok: true, note: full });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);

      // Reorder after a drag: [{id, order}, ...] in one call rather than one
      // PATCH per card, which on a twenty-note board is twenty writes for a
      // single gesture.
      if (Array.isArray(body.order)) {
        const results = [];
        for (const row of body.order) {
          const id = row && row.id;
          const n = Number(row && row.order);
          if (!id || !Number.isFinite(n)) continue;
          const updated = await updateNote(id, { order: n, updatedAt: new Date().toISOString() });
          if (updated) results.push(id);
        }
        return res.status(200).json({ ok: true, reordered: results.length });
      }

      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing note id" });

      const existing = await getNote(id);
      if (!existing) return res.status(404).json({ error: "Note not found" });

      const { ok, errors, patch } = validatePatch(body, APP_IDS);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "No editable fields in patch" });

      patch.updatedAt = new Date().toISOString();
      if (patch.status === "done" && existing.status !== "done") {
        patch.doneAt = new Date().toISOString();
      }
      if (patch.status === "open") patch.doneAt = null;

      const merged = await updateNote(id, patch);
      return res.status(200).json({ ok: true, note: merged });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing note id" });
      const removed = await deleteNote(id);
      return res.status(200).json({ ok: true, deleted: removed ? id : null });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("sitework route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
