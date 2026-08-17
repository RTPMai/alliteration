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
// HOW THE VENDOR OPENS IT, AND WHAT THAT COSTS
// The vendor is not signed in and never will be, so the file has to be
// reachable without a login. Blob URLs are public but carry a random suffix,
// which makes them unguessable: the same protection model already accepted
// for BackBone's emailed briefs (api/b.js) and ShopStock's QR scan endpoint.
// It is not the same as access control. Anyone who is forwarded the link can
// open it, and DELETE here removes the file from the PO but does not revoke a
// link somebody already has. For customer logos going to a supplier that is
// the normal trade. If a specific job ever needs artwork that must not leak,
// it should not go through this route.
//
// Blob's forced `Content-Disposition: attachment` is a feature here rather
// than the problem it was for api/b.js: a vendor wants the file downloaded,
// not rendered in a tab.
//
// Env: BLOB_READ_WRITE_TOKEN, already set.

import { put } from "@vercel/blob";
import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo } from "../../lib/promopro/store.js";

const MAX_BYTES = 25 * 1024 * 1024;  // 25 MB. Vendor-ready art runs bigger than an intake reference.
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
    return { error: `That file is ${(bytes / 1048576).toFixed(1)} MB. The limit is 25 MB.` };
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
    if (!(await canEditSession(sess))) {
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

      const name = safeFilename(body.filename);
      const key = `promopro/art/${poId}/${name}`;
      const blob = await put(key, Buffer.from(parsed.base64, "base64"), {
        access: "public",
        contentType: parsed.mediaType,
        addRandomSuffix: true,   // this is what makes the URL unguessable
      });

      const entry = {
        url: blob.url,
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
      const url = String((req.query && req.query.url) || "");
      if (!poId || !url) return res.status(400).json({ error: "poId and url are required" });

      const po = await getPo(poId);
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const art = (Array.isArray(po.art) ? po.art : []).filter((a) => a.url !== url);
      // Deliberately does not delete the blob itself. A vendor may already be
      // working from that link, and pulling the file out from under them mid
      // job causes a worse problem than an orphaned file costs. Removing it
      // here removes it from the PO and from any future email.
      const saved = await updatePo(poId, { art });
      return res.status(200).json({ ok: true, art: saved.art });
    }

    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/art route error:", e);
    return res.status(500).json({ error: "Upload failed. Try again." });
  }
}
