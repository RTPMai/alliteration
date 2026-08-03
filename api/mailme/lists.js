// api/mailme/lists.js — saved contact lists (segments).
//
// GET    -> all lists, each with a live member count. ?id= for one, with its
//           resolved members.
// POST   -> create. { name, kind, rule? , members? }
// PATCH  -> edit.
// DELETE -> remove. Deleting a list never deletes contacts.
//
// TWO KINDS:
//   dynamic — a RULE, re-evaluated every read. "All prospects tagged
//             school-districts" stays correct as contacts are imported or
//             re-tagged, with nothing to refresh.
//   static  — an explicit set of contact ids. For a one-off hand-picked
//             group that must not change under you.
//
// Member counts are always computed live rather than stored, for the same
// reason campaign stats are: a cached count that drifts from reality is a
// number nobody can trust or audit.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import {
  listLists, getList, createList, updateList, deleteList, membersOf,
} from "../../lib/mailme/store.js";
import { validateListPatch, SUPPRESSED_STATUSES } from "../../lib/mailme/schema.js";

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
  if (!(await requireMailMe(sess, res))) return;

  try {
    if (req.method === "GET") {
      const id = req.query && req.query.id;

      if (id) {
        const list = await getList(id);
        if (!list) return res.status(404).json({ error: "List not found" });
        const members = await membersOf(list);
        const mailable = members.filter((m) => !SUPPRESSED_STATUSES.includes(m.status));
        return res.status(200).json({
          list,
          members,
          memberCount: members.length,
          mailableCount: mailable.length,
        });
      }

      // Counts for every list. Both numbers are shown because they answer
      // different questions: how big the segment is, and how many of them
      // can actually be emailed.
      const lists = await listLists();
      const withCounts = await Promise.all(lists.map(async (l) => {
        const members = await membersOf(l);
        return {
          ...l,
          memberCount: members.length,
          mailableCount: members.filter((m) => !SUPPRESSED_STATUSES.includes(m.status)).length,
        };
      }));
      return res.status(200).json({ lists: withCounts });
    }

    if (!(await canEditMailMe(sess))) {
      return res.status(403).json({ error: "Your role is read-only in MailMe" });
    }

    if (req.method === "POST") {
      const { ok, errors, patch } = validateListPatch(parseBody(req));
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!patch.name) return res.status(400).json({ error: "A list needs a name" });
      if (patch.kind === "static" && !(patch.members || []).length) {
        return res.status(400).json({ error: "A static list needs at least one member" });
      }
      const list = await createList(patch, sess);
      return res.status(201).json({ ok: true, list });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing list id" });
      const { ok, errors, patch } = validateListPatch(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
      const list = await updateList(id, patch);
      if (!list) return res.status(404).json({ error: "List not found" });
      return res.status(200).json({ ok: true, list });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing list id" });
      const removed = await deleteList(id);
      if (!removed) return res.status(404).json({ error: "List not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme lists route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
