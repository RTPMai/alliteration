// PUT IN: lib/sitework/attachments.js
// lib/sitework/attachments.js — image attachments on a sticky note.
//
// WHY IMAGES ONLY, AND WHY THE SIMPLE UPLOAD PATH.
// The ask was screenshots. PromoPro uploads straight from the browser to blob
// storage to get past Vercel's 4.5 MB request-body ceiling, which it needs for
// 20 MB print artwork, and that costs 600 lines and two signed-token flows.
// A screenshot is a few hundred kilobytes, and the browser shrinks anything
// larger before it is ever sent, so the ceiling stops being the constraint and
// the plain data-URL POST that api/intake-upload.js and
// api/traveltrack/receipt.js already use is enough. Same shape as both, on
// purpose.
//
// If somebody ever needs a PDF or a screen recording on a note, this is the
// wrong foundation and PromoPro's is the right one. That is a deliberate limit,
// not an oversight.

/* ------------------------------------------------------------------ *
 * LIMITS
 * ------------------------------------------------------------------ */

// A Vercel function refuses a request body over 4.5 MB, and base64 inflates a
// file by a third, so anything above roughly 3.3 MB decoded cannot arrive at
// all. 3 MB leaves room for the rest of the JSON body.
//
// The browser downscales before sending, so hitting this at all means something
// unusual: a photograph, or a very large PNG screenshot of a 4K display that
// somehow survived the resize. The message says what to do rather than just
// refusing.
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

// Longest edge the browser resizes down to before uploading. A screenshot is
// still readable at this width, and it takes a 4K grab from several megabytes
// to a few hundred kilobytes.
export const MAX_IMAGE_EDGE = 1600;

// Per note. A sticky is a short reminder, not an album. Six is more than any
// real note has needed and the cap exists so one note cannot quietly become the
// reason the board takes a second to load.
export const MAX_ATTACHMENTS_PER_NOTE = 6;

// No SVG. It is an image to a browser and a script host to an attacker: an
// uploaded .svg served from our own domain can carry script that runs with the
// session cookie attached. The other upload routes in this repo accept it
// because their files are downloaded as artwork, never rendered inline on the
// board the way these thumbnails are.
export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const DATA_URL_RE = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

/**
 * Check a posted data URL. Returns { ok, error, mediaType, base64, bytes }.
 *
 * The declared media type is checked against the allowlist rather than
 * believed, and the byte count is computed from the payload rather than read
 * from a field the caller sent, because both come from the browser.
 */
export function parseImageDataUrl(dataUrl) {
  const m = DATA_URL_RE.exec(str(dataUrl));
  if (!m) return { ok: false, error: "That does not look like an image." };

  const declared = m[1].toLowerCase();
  const mediaType = declared === "image/jpg" ? "image/jpeg" : declared;
  const base64 = m[2];

  if (!ALLOWED_TYPES.includes(mediaType)) {
    return {
      ok: false,
      error: mediaType === "image/svg+xml"
        // Said plainly rather than as a generic refusal, because somebody
        // pasting a logo will otherwise try three more times.
        ? "SVG files cannot be attached here. Paste a screenshot of it instead."
        : "Only images can be attached to a note.",
    };
  }

  // Base64 is four characters per three bytes, minus padding.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;

  if (bytes <= 0) return { ok: false, error: "That image is empty." };
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: "That image is too big to attach, even after resizing. " +
        "Crop it to the part that matters and try again.",
    };
  }

  return { ok: true, mediaType, base64, bytes };
}

const EXT_FOR = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The storage path for an attachment. Every file lives under its own note's
 * folder, which is what makes "delete the note, delete its files" answerable by
 * listing rather than by trusting a stored list to be complete.
 *
 * The note id and the attachment id are the whole path. The uploader's filename
 * never appears in it: a name arriving from a browser can contain slashes and
 * dots, and a path built from one is a path somebody else can aim.
 */
export function attachmentPath(noteId, attachmentId, mediaType) {
  const ext = EXT_FOR[mediaType] || "png";
  return "sitework/" + safeSegment(noteId) + "/" + safeSegment(attachmentId) + "." + ext;
}

function safeSegment(v) {
  return str(v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "unknown";
}

/**
 * The display name. A pasted screenshot has no filename at all, so it gets one
 * rather than an empty label, and anything supplied is stripped of path
 * separators and truncated.
 */
export function displayName(name, mediaType) {
  const clean = str(name).replace(/[\\/]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  if (clean) return clean;
  return "Pasted image." + (EXT_FOR[mediaType] || "png");
}

/** The record stored on the note. */
export function buildAttachment({ id, url, pathname, name, mediaType, bytes, by, now }) {
  return {
    id: str(id),
    url: str(url),
    pathname: str(pathname),
    name: displayName(name, mediaType),
    type: str(mediaType),
    bytes: Number(bytes) || 0,
    addedBy: str(by).toLowerCase(),
    addedAt: new Date(now || Date.now()).toISOString(),
  };
}

export function attachmentsOf(note) {
  const list = note && Array.isArray(note.attachments) ? note.attachments : [];
  return list.filter((a) => a && typeof a === "object" && str(a.id));
}

export function isFull(note) {
  return attachmentsOf(note).length >= MAX_ATTACHMENTS_PER_NOTE;
}

/**
 * Who may take an attachment off a note: whoever put it there, whoever wrote
 * the note, or an admin.
 *
 * Wider than canDeleteNote on purpose. Deleting a note destroys somebody's
 * thinking; removing a screenshot you yourself pasted onto their note is
 * tidying up after your own mistake, and needing an admin for that is friction
 * with nothing behind it.
 */
export function canRemoveAttachment(note, attachment, user) {
  const u = user && typeof user === "object" ? user : {};
  if (u.superuser === true) return true;
  const me = str(u.username).toLowerCase();
  if (!me) return false;
  if (me === str(attachment && attachment.addedBy).toLowerCase()) return true;
  return me === str(note && note.createdBy).toLowerCase();
}

/** Human size for the thumbnail caption. */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/* ------------------------------------------------------------------ *
 * MERGING
 *
 * These are the two decisions the route makes around its storage calls, kept
 * here rather than inline so they can be called directly by a test. The route
 * itself is then only: check the gate, talk to blob storage, call one of these.
 *
 * That split exists because @vercel/blob cannot be exercised offline (it
 * resolves credentials before it makes any request, and blocks when it cannot),
 * so anything left inside the route is only reachable by reading it.
 * ------------------------------------------------------------------ */

/**
 * Add an attachment to whatever the note looks like RIGHT NOW.
 *
 * The caller must pass a freshly read note, not the one it read before
 * uploading. An upload takes a moment, and somebody else adding an image in
 * that window would be silently dropped by merging onto the stale copy.
 *
 * Returns null when the fresh note has filled up in the meantime, so the caller
 * knows to delete the file it just uploaded rather than orphan it.
 */
export function mergeAttachment(freshNote, attachment) {
  if (!freshNote) return null;
  const list = attachmentsOf(freshNote);
  if (list.length >= MAX_ATTACHMENTS_PER_NOTE) return null;
  if (list.some((a) => a.id === attachment.id)) return list.slice();
  return list.concat([attachment]);
}

/** The list with one attachment gone. Returns null if it was not there. */
export function withoutAttachment(note, attachmentId) {
  const list = attachmentsOf(note);
  if (!list.some((a) => a.id === attachmentId)) return null;
  return list.filter((a) => a.id !== attachmentId);
}
