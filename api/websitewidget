// api/websitewidget/sites.js — manage the list of sites WebsiteWidget tracks.
//
// GET: any signed-in user (the dashboard needs this list to build its site
//      tabs). PATCH/POST/DELETE: admin or superuser only, same gate crewcore
//      settings uses — this changes what data source the whole team's
//      dashboard reads from, not a personal preference.
//
// Property ids are not secrets, so unlike GA4_CLIENT_EMAIL/GA4_PRIVATE_KEY
// (which stay in Vercel env vars), they live here in KV and can be added or
// changed without a redeploy. See lib/websitewidget/sites-store.js.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { getSites, addSite, updateSite, deleteSite } from "../../lib/websitewidget/sites-store.js";

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
    const isAdmin = (role && role.data_scope === "all") || (user && user.superuser === true);

    if (req.method === "GET") {
      const sites = await getSites();
      return res.status(200).json({ sites });
    }

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "POST") {
      const body = parseBody(req);
      const site = await addSite(body);
      return res.status(200).json({ ok: true, site });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const { id, ...patch } = body;
      if (!id) return res.status(400).json({ error: "id is required" });
      const site = await updateSite(id, patch);
      return res.status(200).json({ ok: true, site });
    }

    if (req.method === "DELETE") {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: "id is required" });
      const sites = await deleteSite(id);
      return res.status(200).json({ ok: true, sites });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("websitewidget/sites route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
