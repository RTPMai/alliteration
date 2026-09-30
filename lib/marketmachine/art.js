// PUT IN: lib/marketmachine/art.js
//
// lib/marketmachine/art.js — the rules for a campaign's art files.
//
// Ryan, Sep 29 2026: "if only selected platforms get art, there needs to be a
// place to upload the art." Each platform ticked on a campaign gets its own
// art: a file uploaded here, or a link when the file lives somewhere else
// (Dropbox, Canva, a video too big to post through a web request).
//
// Pure functions so the tests call them without blob storage. The route is
// api/marketmachine/campaigns.js with ?art=1; it goes through the existing
// campaigns endpoint so no new entry is needed in js/api.js.
//
// WHERE FILES GO, AND WHY PUBLIC. The shared public blob store, under a
// random name nobody can guess, the same arrangement MailMe images and
// TravelTrack receipts use. Social art is made to be posted publicly, and a
// private file behind an expiring link would break every time somebody
// copied the address into a scheduler. Removing art from a campaign drops it
// from the campaign; the stored file is left alone, because it may already be
// scheduled on a platform.
//
// ESM. Do NOT convert to module.exports.

// Vercel refuses a request body over 4.5 MB and base64 adds a third, so about
// 3.3 MB of file is the ceiling for an upload through a function. Anything
// bigger (video, a layered PSD) goes in as a link instead, and the screen
// says so rather than failing.
export const MAX_ART_BYTES = 3 * 1024 * 1024;

export const ART_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
};

const DATA_URL_RE = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

/** Check a posted file. Returns { ok, error, mediaType, base64, bytes }. */
export function parseArtUpload(dataUrl) {
  const m = DATA_URL_RE.exec(typeof dataUrl === "string" ? dataUrl.trim() : "");
  if (!m) return { ok: false, error: "That file could not be read. Try again, or add it as a link." };
  const declared = m[1].toLowerCase();
  const mediaType = declared === "image/jpg" ? "image/jpeg" : declared;
  if (!ART_TYPES[mediaType]) {
    return { ok: false, error: "Upload a PNG, JPG, GIF, WebP, PDF or MP4. Anything else, add as a link." };
  }
  const base64 = m[2];
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(base64.length * 3 / 4) - pad;
  if (bytes <= 0) return { ok: false, error: "That file is empty." };
  if (bytes > MAX_ART_BYTES) {
    return { ok: false, error: "That file is over 3 MB. Put it in Dropbox or Drive and add it as a link instead." };
  }
  return { ok: true, mediaType, base64, bytes };
}

/** Where one art file lands. `rand` must be unguessable (16+ characters). */
export function artPath(campaignId, platform, name, mediaType, rand, now) {
  const d = now ? new Date(now) : new Date();
  const month = d.toISOString().slice(0, 7);
  const base = String(name || "art")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "art";
  const id = String(rand || "").replace(/[^A-Za-z0-9]/g, "");
  if (id.length < 16) throw new Error("artPath needs a random id of at least 16 characters");
  const cid = String(campaignId || "campaign").replace(/[^A-Za-z0-9-]/g, "").slice(0, 30) || "campaign";
  const plat = String(platform || "other").replace(/[^a-z_]/g, "").slice(0, 20) || "other";
  return `marketmachine/art/${month}/${cid}/${plat}/${id}-${base}.${ART_TYPES[mediaType] || "bin"}`;
}

export function artPutOptions(mediaType, token) {
  return {
    access: "public",
    contentType: mediaType,
    addRandomSuffix: false,
    allowOverwrite: false,
    ...(token ? { token } : {}),
  };
}

/** A link added as art: a full web address, nothing else. */
export function checkArtLink(url) {
  const s = String(url || "").trim();
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(s)) {
    return { ok: false, error: "Paste the full web address, starting with https://" };
  }
  return { ok: true, url: s.slice(0, 1000) };
}
