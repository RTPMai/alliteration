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
import {
  getInitiatives, saveInitiatives, DEFAULT_INITIATIVES,
  getIndustries, saveIndustries, DEFAULT_INDUSTRIES,
} from "../../lib/marketmachine/store.js";

// SECOND LIST ON THE SAME ROUTE. ?kind=industries serves the industry
// vocabulary, which has identical rules: everyone reads it, admins edit it,
// and free text would fracture it into near-duplicates.
//
// It shares this file rather than getting its own because BackBone already
// calls this endpoint with no parameters and must keep getting exactly the
// same response it gets today. Defaulting `kind` to initiatives guarantees
// that: the existing caller is untouched by construction, not by care.
const LISTS = {
  initiatives: {
    field: "initiatives", get: getInitiatives, save: saveInitiatives,
    defaults: DEFAULT_INITIATIVES,
    denial: "Editing the initiative list is admin only: it changes what every lead appears tagged with.",
  },
  industries: {
    field: "industries", get: getIndustries, save: saveIndustries,
    defaults: DEFAULT_INDUSTRIES,
    denial: "Editing the industry list is admin only: it changes how every campaign is segmented.",
  },
};

const listFor = (q) => LISTS[String((q && q.kind) || "initiatives")] || null;

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
    const list = listFor(req.query);
    if (!list) return res.status(400).json({ error: "Unknown list" });

    if (req.method === "GET") {
      const perms = await permsFor(sess.username);
      const canEdit = !!(perms && (perms.superuser === true || perms.role === "admin"));
      return res.status(200).json({
        [list.field]: await list.get(),
        defaults: list.defaults,
        canEdit,
      });
    }

    if (req.method === "PUT" || req.method === "PATCH" || req.method === "POST") {
      const perms = await permsFor(sess.username);
      const admin = !!(perms && (perms.superuser === true || perms.role === "admin"));
      if (!admin) return res.status(403).json({ error: list.denial });
      const body = parseBody(req);
      if (!Array.isArray(body[list.field])) {
        return res.status(400).json({ error: `${list.field} must be an array` });
      }
      const saved = await list.save(body[list.field]);
      return res.status(200).json({ ok: true, [list.field]: saved });
    }

    res.setHeader("Allow", "GET, PUT, PATCH, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Initiatives request failed" });
  }
}
