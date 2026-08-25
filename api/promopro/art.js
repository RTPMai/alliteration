// api/promopro/art.js — artwork attached to a purchase order.
//
// DELETE ?poId=<id>&url=<blob url>     -> detaches and forgets
//
// Same data-URL shape as api/intake-upload.js and api/traveltrack/receipt.js:
// the browser reads the dropped file with FileReader.readAsDataURL() and
// posts it. Kept identical on purpose so there is one upload pattern in this
// codebase rather than three.
//
// HOW THE VENDOR OPENS IT
// CHANGED Aug 2026. Files are stored PRIVATE and are unreachable by URL. The
// vendor gets a signed link through api/promopro/art-file.js instead, which
// carries the PO, the file, an expiry and the PO's artRev counter. See
// lib/promopro/art-token.js for why.
//
// What that fixes, versus the public-blob-with-a-random-suffix model this
// replaces: a forwarded link now expires, revoking every link for an order
// is one counter bump, and DELETE genuinely deletes rather than merely
// detaching a file whose URL keeps working forever.
//
// Env: BLOB_READ_WRITE_TOKEN, already set.

import { del } from "@vercel/blob";
import { artBlobOptions } from "../../lib/promopro/blob-token.js";
import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getSettings } from "../../lib/promopro/store.js";

const MAX_FILES = 12;

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
    const settings = await getSettings();
    if (!(await canEditSession(sess, settings))) {
      return res.status(403).json({ error: "Read-only access" });
    }

    // UPLOADS MOVED OUT, Aug 2026. They now go browser-to-storage via
    // api/promopro/art-upload.js. The base64-through-a-function path that
    // used to live here capped out around 3.3 MB against Vercel's 4.5 MB
    // request limit and failed with a bare 413.
    //
    // Deleted rather than kept as a small-file fallback: two upload paths
    // means two permission surfaces to keep in step, and the one that gets
    // less traffic is the one that drifts.
    //
    // This route still owns DELETE and revoke, which are small JSON calls.

    if (req.method === "DELETE") {
      const poId = String((req.query && req.query.poId) || "");
      const id = String((req.query && req.query.id) || "");
      const url = String((req.query && req.query.url) || "");
      if (!poId || (!id && !url)) return res.status(400).json({ error: "poId and id are required" });

      const po = await getPo(poId);
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const all = Array.isArray(po.art) ? po.art : [];
      const going = all.filter((a) => (id ? a.id === id : a.url === url));
      const art = all.filter((a) => !(id ? a.id === id : a.url === url));

      // The blob really goes now. Under the old public model this had to be
      // left behind, because a vendor might be working from the link and
      // there was no way to give them a new one. With signed links there is:
      // the file is gone, the link 404s with a message, and somebody reissues.
      await Promise.all(going.map(async (a) => {
        if (!a.url) return;
        try {
          await del(a.url, artBlobOptions());
        } catch (e) {
          // An orphaned blob is untidy; a delete that half worked and then
          // threw would leave the PO still pointing at a file that is gone.
          console.error("[promopro] could not remove blob", a.url, e && e.message);
        }
      }));

      const saved = await updatePo(poId, { art });
      return res.status(200).json({ ok: true, art: saved.art });
    }

    // Kill every link ever issued for this order in one write. Used when a
    // link has been forwarded somewhere it should not have been.
    if (req.method === "PATCH") {
      const body = parseBody(req);
      const poId = String(body.poId || "");
      if (!poId) return res.status(400).json({ error: "poId is required" });
      if (body.revoke !== true) return res.status(400).json({ error: "nothing to do" });

      const po = await getPo(poId);
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const saved = await updatePo(poId, { artRev: (Number(po.artRev) || 0) + 1 });
      return res.status(200).json({ ok: true, artRev: saved.artRev });
    }

    res.setHeader("Allow", "PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/art route error:", e);
    return res.status(500).json({ error: "Upload failed. Try again." });
  }
}
