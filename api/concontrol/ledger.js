// api/concontrol/ledger.js — income and spend for ConControl.
//
// GET             -> every entry for the event, the budget summary, by category
// POST            -> create
// PATCH ?id=      -> update (merged, never replaced)
// DELETE ?id=     -> delete, admin only
//
// WHO CAN DO WHAT. Reading is NOT open to everyone here, unlike sponsors. What
// the event costs and whether it made money is a different kind of fact from
// "did that sponsor send a logo", and it sits with the people who run the
// budget. can_edit reads and writes; admin deletes.
//
// Sponsor income is never entered here. budgetSummary() reads it off the
// sponsor records, so the two cannot drift.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import { validateEntryPatch, newEntry, budgetSummary, byCategory } from "../../lib/concontrol/ledger.js";
import {
  listEntries, getEntry, saveEntry, updateEntry, deleteEntry, nextEntryId,
  listSponsors, getSettings,
} from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function gate(sess) {
  const perms = await permsFor(sess.username);
  const superuser = !!(perms && perms.superuser === true);
  const admin = superuser || !!(perms && perms.role === "admin");
  return {
    canSee: superuser || !!(perms && perms.can_edit !== false),
    canEdit: superuser || !!(perms && perms.can_edit !== false),
    canDelete: admin,
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
    const { canSee, canEdit, canDelete } = await gate(sess);

    if (!canSee) {
      return res.status(403).json({ error: "The event budget is not open to read-only accounts." });
    }

    if (req.method === "GET") {
      if (id) {
        const entry = await getEntry(id);
        if (!entry) return res.status(404).json({ error: "Entry not found" });
        return res.status(200).json({ entry, canEdit, canDelete });
      }
      const [entries, sponsors] = [await listEntries(event), await listSponsors(event)];
      return res.status(200).json({
        entries,
        event,
        settings,
        summary: budgetSummary(entries, sponsors, settings.budget),
        categories: byCategory(entries),
        canEdit,
        canDelete,
      });
    }

    if (req.method === "POST") {
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });
      const body = parseBody(req);
      const { ok, errors, patch } = validateEntryPatch(body, settings.categories);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!patch.description) return res.status(400).json({ error: "An entry needs a description" });

      const newId = await nextEntryId();
      const record = { ...newEntry(newId, sess.username, event), ...patch, id: newId };
      if (!record.event) record.event = event;
      record.history = [historyEntry("created", sess.username, null)];
      await saveEntry(record);
      return res.status(201).json({ ok: true, entry: record });
    }

    if (req.method === "PATCH") {
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });
      const body = parseBody(req);
      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing entry id" });

      const { ok, errors, patch } = validateEntryPatch(body, settings.categories);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const before = await getEntry(target);
      if (!before) return res.status(404).json({ error: "Entry not found" });
      // The one change worth a trail line on money: a state move, because
      // "when did this stop being an estimate" is the question a budget
      // argument turns on.
      const note = patch.state && patch.state !== before.state
        ? historyEntry(`marked ${patch.state}`, sess.username, null)
        : null;

      const entry = await updateEntry(target, patch, note);
      return res.status(200).json({ ok: true, entry });
    }

    if (req.method === "DELETE") {
      if (!canDelete) {
        return res.status(403).json({ error: "Deleting a ledger entry is admin only." });
      }
      if (!id) return res.status(400).json({ error: "Missing entry id" });
      const gone = await deleteEntry(id);
      if (!gone) return res.status(404).json({ error: "Entry not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol ledger route error:", e);
    return res.status(500).json({ error: e.message || "Ledger request failed" });
  }
}
