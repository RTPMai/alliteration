// api/marketmachine/entries.js — dated performance rows.
//
// GET    ?campaignId=       -> every row for a campaign, plus totals and the
//                              breakdowns by creative and platform
// POST                      -> create a row
// PATCH  ?campaignId=&id=   -> update a row (merged, never replaced)
// DELETE ?campaignId=&id=   -> delete a row
//
// WHO CAN DO WHAT. Reading is any signed-in user, same as campaigns: these
// are the numbers the app exists to show. Writing is can_edit. Deleting is
// can_edit too, NOT admin, which is a deliberate difference from campaigns: a
// row is one week of one channel and a typo in it is best fixed by whoever
// typed it, whereas a campaign is the spend record for a whole piece of work.
// Making people wait for an admin to remove a mistyped row would guarantee
// the mistyped row stays.
//
// EVERY ROW IS ALWAYS SCOPED BY CAMPAIGN, including on delete, because the
// rows live under a per-campaign key. An id alone is not enough to find one,
// and that is on purpose: it means a stray id can never reach into a campaign
// the caller did not name.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { validateEntryPatch } from "../../lib/marketmachine/entries.js";
import {
  listEntries, createEntry, updateEntry, deleteEntry, getCampaign,
} from "../../lib/marketmachine/store.js";
import {
  decorateEntry, totalEntries, totalsByCreative, totalsByPlatform,
} from "../../lib/marketmachine/entries.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function canEditFor(sess) {
  const perms = await permsFor(sess.username);
  const superuser = !!(perms && perms.superuser === true);
  return superuser || !!(perms && perms.can_edit !== false);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};
  const body = parseBody(req);
  const campaignId = String(q.campaignId || body.campaignId || "");
  const id = String(q.id || body.id || "");

  try {
    if (req.method === "GET") {
      if (!campaignId) return res.status(400).json({ error: "Missing campaignId" });
      const campaign = await getCampaign(campaignId);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      const rows = await listEntries(campaignId);
      return res.status(200).json({
        entries: rows.map(decorateEntry),
        totals: totalEntries(rows),
        byCreative: totalsByCreative(rows, campaign.creatives || []),
        byPlatform: totalsByPlatform(rows),
        canEdit: await canEditFor(sess),
      });
    }

    if (req.method === "POST") {
      if (!await canEditFor(sess)) {
        return res.status(403).json({ error: "Your role is read-only in MarketMachine." });
      }
      const { ok, errors, patch } = validateEntryPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!patch.campaignId) return res.status(400).json({ error: "Missing campaignId" });
      const entry = await createEntry({ ...body, ...patch }, sess);
      // createEntry returns null when the campaign does not exist. Reported as
      // a 404 rather than a 500: the request was well formed, the campaign is
      // just gone, and the difference matters when someone has a stale tab open.
      if (!entry) return res.status(404).json({ error: "Campaign not found" });
      return res.status(201).json({ ok: true, entry: decorateEntry(entry) });
    }

    if (req.method === "PATCH") {
      if (!await canEditFor(sess)) {
        return res.status(403).json({ error: "Your role is read-only in MarketMachine." });
      }
      if (!campaignId || !id) return res.status(400).json({ error: "Missing campaignId or id" });
      const { ok, errors, patch } = validateEntryPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
      const entry = await updateEntry(campaignId, id, patch);
      if (!entry) return res.status(404).json({ error: "Row not found" });
      return res.status(200).json({ ok: true, entry: decorateEntry(entry) });
    }

    if (req.method === "DELETE") {
      if (!await canEditFor(sess)) {
        return res.status(403).json({ error: "Your role is read-only in MarketMachine." });
      }
      if (!campaignId || !id) return res.status(400).json({ error: "Missing campaignId or id" });
      const gone = await deleteEntry(campaignId, id);
      if (!gone) return res.status(404).json({ error: "Row not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("marketmachine entries route error:", e);
    return res.status(500).json({ error: e.message || "Performance row request failed" });
  }
}
