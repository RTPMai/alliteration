// api/promopro/art.js — artwork attached to a purchase order.
//
// POST   { poId, data_url, filename }  -> uploads and attaches
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

import { put, del } from "@vercel/blob";
import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getSettings } from "../../lib/promopro/store.js";
import { artSigningAvailable } from "../../lib/promopro/art-token.js";

// THE REAL CEILING, corrected Aug 2026 after a live 413.
//
// This said 25 MB, which was a number nobody could reach. A Vercel function
// caps the REQUEST BODY at 4.5 MB and rejects anything larger with a bare
// 413 before this file runs at all, so the friendly "that file is 26.2 MB"
// message could never fire. The upload is sent as base64, which inflates a
// file by about a third, so the true limit is roughly 3.3 MB of actual file.
//
// 3 MB, checked in the browser BEFORE the request is made, so somebody gets
// a sentence explaining the problem instead of a raw platform error.
//
// This is a stopgap. The proper fix is uploading straight from the browser
// to blob storage, which skips the function and its body limit entirely.
// Manual chunking through this route is not an option: Blob requires every
// part of a multipart upload to be at least 5 MB, which is larger than the
// whole request Vercel will accept.
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 12;

const DATA_URL_RE = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/svg+xml",
  "image/tiff",
  "application/pdf",
  "application/postscript",              // .ai / .eps usually report as this
  "application/illustrator",
  "application/zip",                     // a packaged art folder, common from designers
  "application/octet-stream",            // browsers fall back to this for .ai and friends
]);

// octet-stream could be anything, so require the extension to look like art.
const OCTET_STREAM_EXT_OK = /\.(ai|eps|svg|psd|pdf|indd|tif|tiff|cdr|zip)$/i;

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function parseDataUrl(dataUrl, filename) {
  const m = DATA_URL_RE.exec(String(dataUrl || "").trim());
  if (!m) return { error: "That file could not be read. Try again." };

  const mediaType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  if (!ALLOWED_TYPES.has(mediaType)) {
    return { error: `${mediaType} is not an accepted art file type.` };
  }
  if (mediaType === "application/octet-stream" && !OCTET_STREAM_EXT_OK.test(String(filename || ""))) {
    return { error: "That file type could not be identified as artwork." };
  }

  const base64 = m[2];
  // 4 base64 chars per 3 bytes, minus padding. Checked BEFORE allocating a
  // Buffer, so an oversized upload is rejected rather than decoded first.
  const bytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_BYTES) {
    return {
      error: `That file is ${(bytes / 1048576).toFixed(1)} MB. The limit is 3 MB, because of how the upload has to travel. ` +
             `Send the vendor a compressed copy, or put the full-size art on a link in the notes.`,
    };
  }

  return { mediaType, base64, bytes };
}

function safeFilename(name) {
  return String(name || "art")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "art";
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

    if (req.method === "POST") {
      const body = parseBody(req);
      const poId = String(body.poId || "");
      if (!poId) return res.status(400).json({ error: "poId is required" });

      const po = await getPo(poId);
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const art = Array.isArray(po.art) ? po.art : [];
      if (art.length >= MAX_FILES) {
        return res.status(400).json({ error: `A purchase order can hold ${MAX_FILES} art files.` });
      }

      const parsed = parseDataUrl(body.data_url, body.filename);
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      // Refuse rather than fall back to a public upload. A file the app
      // believes is protected and is not is worse than an upload that failed
      // loudly.
      if (!artSigningAvailable()) {
        return res.status(500).json({
          error: "SESSION_SECRET is not set on this deployment, so artwork links cannot be signed. Nothing was uploaded.",
        });
      }

      const name = safeFilename(body.filename);
      const key = `promopro/art/${poId}/${name}`;
      const blob = await put(key, Buffer.from(parsed.base64, "base64"), {
        access: "private",
        contentType: parsed.mediaType,
        addRandomSuffix: true,
      });

      const entry = {
        // A stable id of our own, because the link the vendor holds must not
        // change when the blob does, and because a URL is a bad primary key.
        id: `af_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        pathname: blob.pathname,
        url: blob.url,           // kept for the signed-in view, not emailed
        filename: name,
        contentType: parsed.mediaType,
        bytes: parsed.bytes,
        uploadedBy: String(sess.username || "").toLowerCase(),
        uploadedAt: new Date().toISOString(),
      };

      const saved = await updatePo(poId, { art: art.concat([entry]) });
      return res.status(200).json({ ok: true, art: saved.art, added: entry });
    }

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
          await del(a.url);
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

    res.setHeader("Allow", "POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/art route error:", e);
    return res.status(500).json({ error: "Upload failed. Try again." });
  }
}
