// api/crewcore/settings.js — shop-wide CrewCore settings (admin only).

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { validateSettings, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import { getSettings, saveSettings } from "../../lib/crewcore/store.js";

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
    const isAdmin = isCrewCoreAdmin({
      superuser: user && user.superuser,
      roleName: user ? user.role : sess.role,
    });

    if (req.method === "GET") {
      const settings = await getSettings();
      return res.status(200).json({ settings });
    }

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const { ok, errors, patch } = validateSettings(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      const settings = await saveSettings(patch, sess.username);
      return res.status(200).json({ ok: true, settings });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/settings route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
