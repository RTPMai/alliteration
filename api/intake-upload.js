// api/intake-upload.js — public art-file upload for the intake form's
// vision board step ("Do you have art ready?" -> drag & drop).
//
// PUBLIC BY DESIGN, same reasoning as api/intake.js: a prospect filling out
// the public form is not signed in and never will be. This endpoint can only
// WRITE a new file to Blob storage and hand back its URL — it cannot read,
// list, or delete anything, so the worst a bad actor gets is wasted Blob
// storage, not access to anyone else's data.
//
// SAME DATA-URL APPROACH AS TRAVELTRACK'S RECEIPT UPLOAD
// (api/traveltrack/receipt.js): the client reads the dropped file with
// FileReader.readAsDataURL() and posts { data_url, filename }. Kept
// consistent with that endpoint's shape on purpose. Unlike the receipt
// endpoint, this one is NOT limited to images — art references are commonly
// PDFs, and sometimes vector/design files (.ai, .eps, .svg) — so the type
// allowlist is wider, and there is no requireAuth() call.
//
// Env: BLOB_READ_WRITE_TOKEN, already set in the Vercel project.

import { put } from "@vercel/blob";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB decoded, generous for a hi-res proof or PDF

// data:<mime>;base64,<data> — mime is checked against an allowlist below,
// not trusted blindly, since it's client-supplied.
const DATA_URL_RE = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/svg+xml",
  "application/pdf",
  "application/postscript",              // .ai / .eps commonly report as this
  "application/illustrator",
  "application/octet-stream",            // browsers fall back to this for unrecognized extensions (.ai often does)
]);

// application/octet-stream is ambiguous (could be anything), so when we see
// it we additionally require the filename extension to look like art.
const OCTET_STREAM_EXT_OK = /\.(ai|eps|svg|psd|pdf|indd)$/i;

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function parseDataUrl(dataUrl, filename) {
  const m = DATA_URL_RE.exec(String(dataUrl || "").trim());
  if (!m) return null;
  const mediaType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  const base64 = m[2];

  if (!ALLOWED_TYPES.has(mediaType)) return null;
  if (mediaType === "application/octet-stream" && !OCTET_STREAM_EXT_OK.test(String(filename || ""))) {
    return null;
  }

  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) return null;

  return { mediaType, base64, bytes };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const safeName = String(body.filename || "art-file")
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .trim()
      .slice(0, 80) || "art-file";

    const parsed = parseDataUrl(body.data_url, safeName);
    if (!parsed) {
      return res.status(400).json({
        error: "Couldn't accept that file. Supported: images, PDF, SVG, AI, EPS, PSD — up to 15 MB each."
      });
    }

    const ext = safeName.includes(".") ? "" : (
      { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
        "image/svg+xml": ".svg", "application/pdf": ".pdf" }[parsed.mediaType] || ""
    );
    const key = `intake/art/${Date.now()}-${safeName}${ext}`;

    const blob = await put(key, Buffer.from(parsed.base64, "base64"), {
      access: "public",
      contentType: parsed.mediaType,
      addRandomSuffix: true,
    });

    return res.status(200).json({ ok: true, url: blob.url, filename: safeName, bytes: parsed.bytes });
  } catch (e) {
    console.error("intake-upload error:", e);
    return res.status(500).json({ error: "Upload failed. Try again, or paste a link instead." });
  }
}
