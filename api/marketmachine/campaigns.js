// api/marketmachine/campaigns.js — campaigns CRUD plus the rolled-up detail.
//
// GET            -> every campaign with a light rollup
// GET ?id=       -> one campaign, full rollup, linked MailMe emails
// POST           -> create
// PATCH ?id=     -> update (merged, never replaced)
// DELETE ?id=    -> delete, admin only
//
// WHO CAN DO WHAT. Reading is open to any signed-in user: a campaign plan is
// the sort of thing account managers need to see without asking, and hiding
// it just moves the question to Slack. Writing is can_edit. Deleting is admin
// only, because a campaign carries the spend record for work that actually
// happened, and losing it silently loses the only place that was written
// down.
//
// A folder route, not a flat api/marketmachine.js. Vercel treats a file and a
// same-named folder as a route conflict once .js is stripped, and there will
// be a second route here (initiatives).

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { validateCampaignPatch } from "../../lib/marketmachine/schema.js";
import {
  listCampaigns, campaignDetail, createCampaign, updateCampaign, deleteCampaign,
} from "../../lib/marketmachine/store.js";

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

  const id = (req.query && req.query.id) || null;

  try {
    if (req.method === "GET") {
      const { canEdit, canDelete } = await gate(sess);
      if (id) {
        const detail = await campaignDetail(id);
        if (!detail) return res.status(404).json({ error: "Campaign not found" });
        return res.status(200).json({ ...detail, canEdit, canDelete });
      }
      const campaigns = await listCampaigns();
      return res.status(200).json({ campaigns, canEdit, canDelete });
    }

    if (req.method === "POST") {
      const { canEdit } = await gate(sess);
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in MarketMachine." });
      const body = parseBody(req);
      const { ok, errors, patch } = validateCampaignPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!patch.name) return res.status(400).json({ error: "A campaign needs a name" });
      const campaign = await createCampaign({ ...patch, channels: body.channels }, sess);
      return res.status(201).json({ ok: true, campaign });
    }

    if (req.method === "PATCH") {
      const { canEdit } = await gate(sess);
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in MarketMachine." });
      const body = parseBody(req);
      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing campaign id" });
      const { ok, errors, patch } = validateCampaignPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
      const campaign = await updateCampaign(target, patch);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      return res.status(200).json({ ok: true, campaign });
    }

    if (req.method === "DELETE") {
      const { canDelete } = await gate(sess);
      if (!canDelete) {
        return res.status(403).json({
          error: "Deleting a campaign is admin only: it holds the spend record for work that happened.",
        });
      }
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const gone = await deleteCampaign(id);
      if (!gone) return res.status(404).json({ error: "Campaign not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("marketmachine campaigns route error:", e);
    return res.status(500).json({ error: e.message || "Campaign request failed" });
  }
}
