// PUT IN: lib/mailme/images.js
// lib/mailme/images.js: images inside a MailMe email body.
//
// WHAT THIS IS FOR
// Ryan asked (Sep 24 2026) for images in the body of an email, and for an
// image that works as a button: click it, go somewhere. The Mailchimp /
// Klaviyo pattern. Two halves live here:
//
//   1. UPLOAD RULES. What the browser may send to api/mailme/images.js and
//      where it lands. Pure functions, so the tests call them directly
//      instead of needing blob storage (which blocks offline).
//
//   2. BODY SYNTAX. How an image is written in the body text. The composer
//      is still a plain textarea, so an image is a line of markdown that the
//      Image button writes for you:
//
//          ![Fall catalog|600](https://...png)
//          [![Fall catalog|600](https://...png)](https://pmapparel.com/fall)
//
//      The first is an image. The second is an image you can click. The
//      "|600" is the display width in pixels and is optional. Standard
//      markdown with one addition, the width, borrowed from how Obsidian
//      does it, because Outlook on Windows ignores CSS max-width and draws an
//      image at its real size unless the tag carries a width attribute. A
//      1200px image with no width attribute blows the email out sideways
//      there.
//
// WHY THE FILES ARE PUBLIC
// Every other upload in this repo that leaves the building is private and
// handed out through signed, expiring links (PromoPro artwork). An email
// image cannot work that way: it is fetched by the recipient's mail client,
// possibly years later, with no session and no way to refresh a link. So
// these go to the shared PUBLIC store (the default BLOB_STORE_ID one that
// BackBone briefs and TravelTrack receipts already use), under a random
// name nobody can guess, and they are NEVER deleted by this code. Deleting
// one would put a broken image in every copy of every email already sent.
//
// ESM. Do NOT convert to module.exports.

/* ------------------------------------------------------------------ *
 * UPLOAD LIMITS
 * ------------------------------------------------------------------ */

// A Vercel function refuses a request body over 4.5 MB and base64 inflates a
// file by a third, so about 3.3 MB decoded is the hard ceiling. 3 MB leaves
// room for the rest of the JSON. The browser resizes before sending, so a
// normal image is a few hundred KB and never gets near this.
//
// Also the right limit for email on its own terms: Gmail clips messages and
// people on phones wait for images to load. A 3 MB hero image is already a
// bad email.
export const MAX_EMAIL_IMAGE_BYTES = 3 * 1024 * 1024;

// Longest width the browser resizes down to. Emails display at up to 600px,
// and 1200 is that at 2x, so it stays sharp on phones and retina screens.
export const MAX_EMAIL_IMAGE_EDGE = 1200;

// The widest an image may DISPLAY in the email. 600px is the standard email
// body width; anything wider scrolls sideways in some clients.
export const MAX_DISPLAY_WIDTH = 600;
export const MIN_DISPLAY_WIDTH = 16;

// No SVG: Gmail and Outlook do not display it, so it would arrive as a
// broken image. It is also a script host when served from our own domain.
export const EMAIL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const DATA_URL_RE = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Check a posted data URL. Returns { ok, error, mediaType, base64, bytes }.
 * The media type is checked against the list rather than believed, and the
 * size is computed from the payload rather than read from a field the
 * browser sent.
 */
export function parseEmailImage(dataUrl) {
  const m = DATA_URL_RE.exec(typeof dataUrl === "string" ? dataUrl.trim() : "");
  if (!m) return { ok: false, error: "That does not look like an image." };

  const declared = m[1].toLowerCase();
  const mediaType = declared === "image/jpg" ? "image/jpeg" : declared;
  const base64 = m[2];

  if (!EMAIL_IMAGE_TYPES.includes(mediaType)) {
    return {
      ok: false,
      error: mediaType === "image/svg+xml"
        ? "SVG images do not show up in Gmail or Outlook. Save it as a PNG and try again."
        : "Use a PNG, JPG, GIF or WebP image.",
    };
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  if (bytes <= 0) return { ok: false, error: "That image is empty." };
  if (bytes > MAX_EMAIL_IMAGE_BYTES) {
    return {
      ok: false,
      error: "That image is over 3 MB, which is too heavy for an email. Save a smaller copy and try again.",
    };
  }

  return { ok: true, mediaType, base64, bytes };
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Where an image lands. The random part is the only thing keeping an image
 * from being found by guessing, since the store is public, so it is long.
 * The readable part is just so a person browsing the store can tell what a
 * file is.
 */
export function emailImagePath(name, mediaType, rand, now) {
  const d = now instanceof Date ? now : new Date();
  const month = d.toISOString().slice(0, 7);
  const base = String(name || "image")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "image";
  const id = String(rand || "").replace(/[^A-Za-z0-9]/g, "");
  if (id.length < 16) throw new Error("emailImagePath needs a random id of at least 16 characters");
  return `mailme/images/${month}/${id}-${base}.${EXT[mediaType] || "img"}`;
}

/**
 * The options api/mailme/images.js hands to put(). Here rather than inline in
 * the route so the parts that matter (PUBLIC, never overwrite) are checked by
 * a test: @vercel/blob opens its own network connection, so a successful
 * upload cannot be exercised offline.
 *
 * `token` is the read-write token when one is set; otherwise the SDK uses the
 * platform's OIDC credentials and the default store, which is the public one.
 * Deliberately NOT lib/promopro/blob-token.js: that prefers PromoPro's
 * PRIVATE store, and a private image in an email is a broken image.
 */
export function emailImagePutOptions(mediaType, token) {
  return {
    access: "public",
    contentType: mediaType,
    addRandomSuffix: false,
    allowOverwrite: false,
    // A year. The file never changes (random name, never overwritten), so
    // mail clients and their image proxies can keep it.
    cacheControlMaxAge: 60 * 60 * 24 * 365,
    ...(token ? { token } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * BODY SYNTAX
 *
 * These helpers are what lib/mailme/send.js uses to render. apps/mailme.js
 * carries a copy for the live preview (a round trip per keystroke is not a
 * preview), and test/mailme-images.test.cjs runs both against the same
 * inputs so the copy cannot drift.
 * ------------------------------------------------------------------ */

/** Clamp a requested display width, or null when none was given. */
export function clampDisplayWidth(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(MIN_DISPLAY_WIDTH, Math.min(MAX_DISPLAY_WIDTH, v));
}

/**
 * Write the markdown for one image. What the composer's Image button
 * inserts. `href` makes it clickable; blank means a plain image.
 */
export function imageMarkdown({ src, alt, width, href }) {
  const cleanAlt = String(alt || "").replace(/[[\]|\n]+/g, " ").replace(/\s+/g, " ").trim();
  const w = clampDisplayWidth(width);
  const img = `![${cleanAlt}${w ? `|${w}` : ""}](${src})`;
  return href ? `[${img}](${href})` : img;
}
