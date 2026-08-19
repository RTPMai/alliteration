// PUT IN: api/reorder-settings.js
// api/reorder-settings.js — reorder timing thresholds.
//
// GET   -> current thresholds, plus the defaults so a UI can offer "reset".
// PATCH -> update. Merged, not replaced, so a partial save cannot blank a
//          field by omitting it.
//
// WHO CAN TOUCH IT. Any signed-in user can READ: the thresholds explain why a
// customer row says "Overdue", and hiding that would make the roster look
// arbitrary. Writing is gated to admin/superuser, because these numbers change
// what every account manager sees on every screen at once. That split is the
// same one WebsiteWidget's Manage Sites uses, for the same reason.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { permsFor } from "../lib/users.js";
import {
  getReorderSettings, saveReorderSettings, REORDER_DEFAULTS,
} from "../lib/reorder-settings.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function canEdit(sess) {
  const perms = await permsFor(sess.username);
  if (perms && perms.superuser === true) return true;
  return !!(perms && (perms.role === "admin" || perms.data_scope === "all"));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method === "GET") {
      const settings = await getReorderSettings();
      return res.status(200).json({
        settings,
        defaults: REORDER_DEFAULTS,
        canEdit: await canEdit(sess),
      });
    }

    if (req.method === "PATCH" || req.method === "POST") {
      if (!(await canEdit(sess))) {
        return res.status(403).json({
          error: "Changing reorder timing is limited to admins: it changes what everyone sees",
        });
      }
      const body = parseBody(req);
      const result = await saveReorderSettings({
        dueAt: body.dueAt,
        overdueAt: body.overdueAt,
        lapsedAt: body.lapsedAt,
        minOrders: body.minOrders,
        minGapDays: body.minGapDays,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.status(200).json({ settings: result.settings, defaults: REORDER_DEFAULTS });
    }

    res.setHeader("Allow", "GET, PATCH, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Reorder settings failed" });
  }
}
