// PUT IN: api/mailme/images.js
// api/mailme/images.js: upload one image for use in a MailMe email body.
//
// POST { dataUrl, name } -> { ok, url }
//
// The composer's Image button resizes the picture in the browser, posts it
// here, and writes the returned URL into the body as markdown. Rules (types,
// size, where it lands, and why it is public and never deleted) live in
// lib/mailme/images.js so tests can call them without blob storage.
//
// Same simple data-URL shape as api/sitework-attach.js and
// api/traveltrack/receipt.js, not PromoPro's direct-to-storage flow: an
// email image is a few hundred KB after resizing, so Vercel's 4.5 MB body
// limit is not the constraint that forced PromoPro's 600 lines.
//
// ACCESS: signed in, MailMe granted, and allowed to edit MailMe. Checked
// here, not borrowed from another route.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import { parseEmailImage, emailImagePath, emailImagePutOptions } from "../../lib/mailme/images.js";

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
  if (!(await requireMailMe(sess, res))) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await canEditMailMe(sess))) {
    return res.status(403).json({ error: "Your account can view MailMe but not change it." });
  }

  const body = parseBody(req);
  const parsed = parseEmailImage(body.dataUrl);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const pathname = emailImagePath(body.name, parsed.mediaType, randomBytes(12).toString("hex"));
    const blob = await put(pathname, Buffer.from(parsed.base64, "base64"),
      emailImagePutOptions(parsed.mediaType, process.env.BLOB_READ_WRITE_TOKEN));
    return res.status(200).json({ ok: true, url: blob.url, bytes: parsed.bytes });
  } catch (e) {
    console.error("mailme/images upload failed:", e);
    return res.status(500).json({ error: "The image could not be stored: " + (e && e.message ? e.message : "unknown error") });
  }
}
