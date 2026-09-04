// PUT IN: api/archive-reasons.js
// api/archive-reasons.js — the fixed list of reasons a lead or client can be
// archived under.
//
// GET   -> the list, plus whether the caller may edit it.
// PUT   -> replace the list. Admin only.
//
// WHO CAN READ. Anyone signed in. Every archive screen needs the list to draw
// its dropdown, so gating the read would break archiving for everyone but
// admins while pretending to be a permissions rule.
//
// WHO CAN WRITE. Admin only, and deliberately NOT `data_scope === "all"`.
// data_scope is a sales visibility setting that defaults to "all" on any newly
// created role, so treating it as an admin signal hands the list to whoever
// happened to get a role made for an unrelated reason. Same trap CrewCore hit.
//
// EDITING THE LIST NEVER REWRITES RECORDS. The reason is copied onto the record
// when it is archived. Removing "Not a fit" from the list stops it being chosen
// again; it does not blank the reason on the forty leads already archived under
// it. History has to stay readable after a settings change.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { permsFor } from "../lib/users.js";
import { getArchiveReasons, saveArchiveReasons } from "../lib/backbone/archive-store.js";
import { DEFAULT_ARCHIVE_REASONS, normalizeReasons } from "../lib/backbone/archive.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function canEdit(sess) {
  const perms = await permsFor(sess.username);
  if (!perms) return false;
  if (perms.superuser === true) return true;
  return perms.role === "admin";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method === "GET") {
      return res.status(200).json({
        reasons: await getArchiveReasons(),
        defaults: DEFAULT_ARCHIVE_REASONS,
        canEdit: await canEdit(sess),
      });
    }

    if (req.method === "PUT" || req.method === "POST") {
      if (!(await canEdit(sess))) {
        return res.status(403).json({
          error: "Editing the archive reason list is admin only: it changes the choices everyone gets.",
        });
      }
      const body = parseBody(req);
      if (!Array.isArray(body.reasons)) {
        return res.status(400).json({ error: "Expected { reasons: [...] }" });
      }
      // A list that cleans down to nothing is refused rather than quietly
      // replaced with the defaults, so somebody who deletes every row is told
      // what happened instead of finding the seeded list back tomorrow.
      const cleaned = normalizeReasons(body.reasons);
      const askedForEmpty = body.reasons.every((r) => !String(r == null ? "" : r).trim());
      if (askedForEmpty) {
        return res.status(400).json({
          error: "The list cannot be empty. Archiving requires a reason, so there has to be at least one to pick.",
        });
      }
      const saved = await saveArchiveReasons(cleaned);
      return res.status(200).json({ ok: true, reasons: saved });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("archive-reasons error:", e);
    return res.status(500).json({ error: e.message });
  }
}
