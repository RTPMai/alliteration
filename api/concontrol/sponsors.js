// api/concontrol/sponsors.js — sponsor records for ConControl.
//
// GET             -> every sponsor for the current event, plus the rollup
// GET ?event=     -> a different event's list
// GET ?id=        -> one sponsor
// POST            -> create
// PATCH ?id=      -> update (merged, never replaced)
// DELETE ?id=     -> delete, admin only
//
// WHO CAN DO WHAT. Reading is open to any signed-in user, same call as
// PromoPro: "did that sponsor ever send their logo" is a question anybody
// working the event should be able to answer without asking Ryan. Writing is
// can_edit. Deleting is admin only, because a sponsor record carries the only
// evidence of what was agreed and what was paid, and losing it silently loses
// the thing an invoice dispute turns on.
//
// A folder route, not a flat api/concontrol.js. Vercel treats a file and a
// same-named folder as a route conflict once .js is stripped, and there is
// already a second route here (inquiry.js).

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import {
  validateSponsorPatch, newSponsor, rollup, tierAvailability, momentAvailability,
  DEFAULT_EVENT,
} from "../../lib/concontrol/schema.js";
import {
  listSponsors, getSponsor, saveSponsor, updateSponsor, deleteSponsor,
  nextSponsorId, getSettings,
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

    if (req.method === "GET") {
      const { canEdit, canDelete } = await gate(sess);

      if (id) {
        const sponsor = await getSponsor(id);
        if (!sponsor) return res.status(404).json({ error: "Sponsor not found" });
        return res.status(200).json({ sponsor, settings, canEdit, canDelete });
      }

      const sponsors = await listSponsors(event);
      return res.status(200).json({
        sponsors,
        event,
        settings,
        // Computed server side from the same function the screen uses, so a
        // total on a phone and a total on a laptop cannot disagree.
        totals: rollup(sponsors),
        // What is still sellable. Presenting is 1 and Gold is 3, and both
        // numbers are printed on the public sponsor page, so the answer has to
        // come from the records rather than from somebody's memory of who said
        // yes in October.
        tiers: tierAvailability(sponsors, settings.tiers),
        moments: momentAvailability(sponsors),
        canEdit,
        canDelete,
      });
    }

    if (req.method === "POST") {
      const { canEdit } = await gate(sess);
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });

      const body = parseBody(req);
      const { ok, errors, patch } = validateSponsorPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!patch.company) return res.status(400).json({ error: "A sponsor needs a company name" });

      const newId = await nextSponsorId();
      const record = { ...newSponsor(newId, sess.username), ...patch, id: newId };
      if (!record.event) record.event = event;
      await saveSponsor(record);
      return res.status(201).json({ ok: true, sponsor: record });
    }

    if (req.method === "PATCH") {
      const { canEdit } = await gate(sess);
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });

      const body = parseBody(req);
      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing sponsor id" });

      const { ok, errors, patch } = validateSponsorPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const sponsor = await updateSponsor(target, patch);
      if (!sponsor) return res.status(404).json({ error: "Sponsor not found" });
      return res.status(200).json({ ok: true, sponsor });
    }

    if (req.method === "DELETE") {
      const { canDelete } = await gate(sess);
      if (!canDelete) {
        return res.status(403).json({
          error: "Deleting a sponsor is admin only: the record holds what was agreed and what was paid.",
        });
      }
      if (!id) return res.status(400).json({ error: "Missing sponsor id" });
      const gone = await deleteSponsor(id);
      if (!gone) return res.status(404).json({ error: "Sponsor not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol sponsors route error:", e);
    return res.status(500).json({ error: e.message || "Sponsor request failed" });
  }
}
