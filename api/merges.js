// api/merges.js — clients that BackBone holds as more than one record.
//
//   GET    /api/merges              the merge groups
//   GET    /api/merges?suggest=1    plus suggested duplicates from the roster
//   POST   /api/merges              create or update a merge
//   DELETE /api/merges?id=MRG-...   unmerge
//   POST   /api/merges?action=dismiss  hide a suggestion that is not a duplicate
//
// READ IS OPEN, WRITE IS ADMIN. Anyone signed in can see that KBS and Kitchen
// Bath Solutions are one client, and being able to see it is the point: an AM
// looking at the roster should be able to tell why a row says "merged from 2
// records". Creating one changes what everybody sees, and renames a client on
// every screen at once, so it is gated.
//
// THE GATE IS THE ADMIN FLAG OR THE ADMIN ROLE, not data_scope. data_scope
// defaults to "all" on any new role, so treating it as an admin permission
// hands a role created for an unrelated reason the ability to weld two clients
// together. That mistake has already been made once in this codebase.
//
// NOTHING IS EVER MERGED WITHOUT A PERSON. The suggestions here are candidates
// with their evidence attached; a silent wrong merge has no symptom, which is
// exactly why it never happens automatically.

import { requireAuth } from "../lib/session.js";
import { permsFor } from "../lib/users.js";
import {
  KEYS, readKey, kvSet, isConfigured, readMergeGroups,
} from "../lib/backbone-store.js";
import { suggestDuplicates, validateGroup, pairKey } from "../lib/backbone-merge.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function canEdit(sess) {
  const perms = await permsFor(sess.username);
  if (perms && perms.superuser === true) return true;
  return !!(perms && perms.role === "admin");
}

/** The whole stored record: groups plus the pairs somebody said were not dupes. */
async function readRecord() {
  const raw = await readKey(KEYS.merges);
  if (!raw) return { groups: [], dismissed: [] };
  if (Array.isArray(raw)) return { groups: raw, dismissed: [] };
  return {
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
  };
}

const nextId = () => "MRG-" + Date.now().toString(36).toUpperCase();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  const action = (req.query && req.query.action) || "";

  try {
    /* ---- read ---------------------------------------------------------- */

    if (req.method === "GET") {
      const record = await readRecord();
      const editable = await canEdit(sess);

      const wantSuggestions = req.query && (req.query.suggest === "1" || req.query.suggest === "true");
      if (!wantSuggestions) {
        return res.status(200).json({ groups: record.groups, canEdit: editable });
      }

      // Suggestions run over the RAW roster, not the folded one. A folded
      // roster has already had the duplicates removed, so scanning it would
      // find nothing and the screen would report a clean roster that is not.
      const data = await readKey(KEYS.data);
      const synced = (data && Array.isArray(data.synced)) ? data.synced : [];

      const suggestions = suggestDuplicates(synced, {
        groups: record.groups,
        dismissed: record.dismissed.map((k) => String(k).split("|")),
        limit: 60,
      });

      return res.status(200).json({
        groups: record.groups,
        suggestions,
        scanned: synced.length,
        canEdit: editable,
      });
    }

    /* ---- write --------------------------------------------------------- */

    if (!(await canEdit(sess))) {
      return res.status(403).json({
        error: "Merging clients is limited to admins: it changes what everyone sees",
      });
    }

    const record = await readRecord();

    // A suggestion that is two genuinely different companies. Remembered, or
    // it comes back at the top of the list tomorrow and the list stops being
    // read at all.
    if (req.method === "POST" && action === "dismiss") {
      const body = parseBody(req);
      const a = String(body.a || "");
      const b = String(body.b || "");
      if (!a || !b) return res.status(400).json({ error: "Two customer ids are required" });

      const key = pairKey(a, b);
      if (record.dismissed.indexOf(key) < 0) record.dismissed.push(key);
      await kvSet(KEYS.merges, record);
      return res.status(200).json({ ok: true, dismissed: record.dismissed.length });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const data = await readKey(KEYS.data);
      const synced = (data && Array.isArray(data.synced)) ? data.synced : [];

      // Editing an existing group must not see itself as a conflict, so it is
      // taken out of the comparison set before validating.
      const editingId = String(body.id || "");
      const others = record.groups.filter((g) => String(g.id) !== editingId);

      const check = validateGroup(body, synced, others);
      if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors });

      const existing = editingId ? record.groups.find((g) => String(g.id) === editingId) : null;

      const group = {
        id: existing ? existing.id : nextId(),
        ...check.group,
        mergedBy: existing ? existing.mergedBy : (sess.name || sess.username),
        mergedAt: existing ? existing.mergedAt : new Date().toISOString(),
        updatedBy: sess.name || sess.username,
        updatedAt: new Date().toISOString(),
      };

      record.groups = existing
        ? record.groups.map((g) => (String(g.id) === editingId ? group : g))
        : record.groups.concat([group]);

      // A pair that has been merged is no longer a suggestion to dismiss.
      const ids = [group.primaryId, ...group.memberIds];
      const merged = new Set();
      ids.forEach((x) => ids.forEach((y) => { if (x !== y) merged.add(pairKey(x, y)); }));
      record.dismissed = record.dismissed.filter((k) => !merged.has(k));

      await kvSet(KEYS.merges, record);
      return res.status(200).json({ ok: true, group, groups: record.groups });
    }

    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || "");
      if (!id) return res.status(400).json({ error: "id is required" });

      const before = record.groups.length;
      record.groups = record.groups.filter((g) => String(g.id) !== id);
      if (record.groups.length === before) {
        return res.status(404).json({ error: "No merge with that id" });
      }

      // Unmerging is a delete and nothing else. The original rows were never
      // edited, so the next read of the roster shows them again exactly as
      // they were.
      await kvSet(KEYS.merges, record);
      return res.status(200).json({ ok: true, groups: record.groups });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("merges error:", e);
    return res.status(500).json({ error: e.message });
  }
}

// Re-exported so the tests can reach the storage shape without duplicating it.
export { readMergeGroups };
