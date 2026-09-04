// PUT IN: api/archived-clients.js
// api/archived-clients.js — archive and restore customers on the BackBone roster.
//
// GET   -> every client archive stamp, keyed by customer id.
// POST  -> { customer_id, reason, note }  archive one
//          { customer_id, restore: true } put one back
//
// WHY THIS IS ITS OWN RECORD AND NOT A FLAG ON THE CUSTOMER.
// The roster is rebuilt from Printavo by the sync. Anything written onto a
// synced row is erased by the next reconcile, so an archive written there would
// last until the following morning and then quietly undo itself. Stamps live
// here and are folded onto the roster WHEN IT IS READ, which is exactly how
// merges already survive a reconcile.
//
// THE REASON IS CHECKED HERE, NOT ONLY IN THE BROWSER. The list is the point of
// the feature; a route that took any string would make the list a suggestion.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { permsFor } from "../lib/users.js";
import { getArchiveReasons, getClientArchives, setClientArchive } from "../lib/backbone/archive-store.js";
import { archiveRecord, restoreRecord } from "../lib/backbone/archive.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Archiving a customer hides them from every AM's roster at once, so it is not
// a per-person view preference. Same gate as the reason list, and for the same
// reason data_scope is not consulted.
async function canArchive(sess) {
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
        clients: await getClientArchives(),
        canArchive: await canArchive(sess),
      });
    }

    if (req.method === "POST") {
      if (!(await canArchive(sess))) {
        return res.status(403).json({
          error: "Archiving a client is admin only: it takes them off the roster for the whole team.",
        });
      }

      const body = parseBody(req);
      const id = String(body.customer_id == null ? "" : body.customer_id).trim();
      if (!id) return res.status(400).json({ error: "A customer_id is required." });

      if (body.restore === true) {
        const existing = (await getClientArchives())[id];
        if (!existing) {
          // Already back on the roster. Saying so beats a 404 that reads like
          // a broken button on a screen that just refreshed.
          return res.status(200).json({ ok: true, restored: false, note: "That client was not archived." });
        }
        // restoreRecord is called for its history entry; the stamp itself is
        // removed from the map rather than stored as a cleared object, so a
        // restored client leaves no row behind in the archive.
        const trail = restoreRecord(existing, { by: sess.username });
        await setClientArchive(id, null);
        return res.status(200).json({ ok: true, restored: true, history: trail.archive_history });
      }

      const reasons = await getArchiveReasons();
      let stamp;
      try {
        // Only the stamp fields are stored, never a copy of the customer. A
        // stored copy would be a second, staler roster the moment Printavo
        // changed anything about them.
        const prior = (await getClientArchives())[id] || {};
        stamp = archiveRecord(prior, {
          reason: body.reason,
          reasons,
          by: sess.username,
          note: body.note,
        });
      } catch (e) {
        return res.status(400).json({ error: e.message, reasons });
      }

      await setClientArchive(id, stamp);
      return res.status(200).json({ ok: true, customer_id: id, stamp });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("archived-clients error:", e);
    return res.status(500).json({ error: e.message });
  }
}
