// api/traveltrack/settings.js — Org Settings (shop-wide) + Account Settings
// (per-user), in one route since both come back together for the Settings view.
//
// GET   -> { org, account } — org always included (read-only for most roles,
//          the front end hides edit controls for anyone without can_edit +
//          data_scope "all"), account is always the CALLER's own.
// PATCH -> ?scope=org updates Org Settings (data_scope "all" + can_edit only).
//          ?scope=account (default) updates the caller's own Account Settings.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateOrgSettings, validateAccountSettings } from "../../lib/traveltrack/schema.js";
import { getOrgSettings, saveOrgSettings, getAccountSettings, saveAccountSettings } from "../../lib/traveltrack/store.js";

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
    const user = sess.username ? await getUser(sess.username) : null;
    const role = await getRole(user ? user.role : sess.role);
    const scope = (role && role.data_scope) || "all";
    const canEdit = role ? !!role.can_edit : true;
    const canEditOrg = scope === "all" && canEdit;

    if (req.method === "GET") {
      const org = await getOrgSettings();
      const account = await getAccountSettings(sess.username);
      return res.status(200).json({ org, account, can_edit_org: canEditOrg });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const target = (req.query && req.query.scope) || "account";

      if (target === "org") {
        if (!canEditOrg) return res.status(403).json({ error: "Only an admin/manager can edit Org Settings" });
        const { ok, errors, patch } = validateOrgSettings(body);
        if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
        const org = await saveOrgSettings(patch, sess.username);
        return res.status(200).json({ ok: true, org });
      }

      const { ok, errors, patch } = validateAccountSettings(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      const account = await saveAccountSettings(sess.username, patch);
      return res.status(200).json({ ok: true, account });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("traveltrack/settings route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
