// api/marketmachine/initiatives.js — the Marketing Initiative Step Library.
//
// WHY THIS MOVED. BackBone's leads pipeline has had a "Marketing initiative"
// dropdown since July, populated from a hardcoded placeholder array with a
// comment saying to replace it with the real names off the Monday "Marketing
// Initiative Templates - Step Library" board. That list describes marketing,
// so it belongs to the marketing app, and putting it here closes the item:
// the names become editable in the UI instead of requiring a deploy.
//
// BackBone reads this. It falls back to its own placeholders if the call
// fails, so a storage blip degrades the dropdown rather than emptying it.
//
// Reading is open to any signed-in user (BackBone calls it for every AM).
// Writing is admin, because this list is a shared vocabulary: one person
// renaming an entry changes what every lead in the pipeline appears to be
// tagged with.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { getInitiatives, saveInitiatives, DEFAULT_INITIATIVES } from "../../lib/marketmachine/store.js";

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

  try {
    if (req.method === "GET") {
      const perms = await permsFor(sess.username);
      const canEdit = !!(perms && (perms.superuser === true || perms.role === "admin"));
      return res.status(200).json({
        initiatives: await getInitiatives(),
        defaults: DEFAULT_INITIATIVES,
        canEdit,
      });
    }

    if (req.method === "PUT" || req.method === "PATCH" || req.method === "POST") {
      const perms = await permsFor(sess.username);
      const admin = !!(perms && (perms.superuser === true || perms.role === "admin"));
      if (!admin) {
        return res.status(403).json({
          error: "Editing the initiative list is admin only: it changes what every lead appears tagged with.",
        });
      }
      const body = parseBody(req);
      if (!Array.isArray(body.initiatives)) {
        return res.status(400).json({ error: "initiatives must be an array" });
      }
      const saved = await saveInitiatives(body.initiatives);
      return res.status(200).json({ ok: true, initiatives: saved });
    }

    res.setHeader("Allow", "GET, PUT, PATCH, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Initiatives request failed" });
  }
}
