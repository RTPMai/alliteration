// lib/promopro/art-token.js — signed links to artwork a vendor can open.
//
// THE PROBLEM THIS REPLACES
// Artwork used to be uploaded as a PUBLIC blob. The URL carried a random
// suffix, so it was unguessable, and that was the whole of the protection.
// It had two holes worth naming: anyone forwarded the link kept it forever,
// and removing a file from the PO detached it without revoking anything, so
// "I deleted that" was not true. The Vercel Blob SDK now supports private
// blobs, so the file itself can be unreachable and the link can be the thing
// that grants access instead.
//
// HOW IT WORKS
// A link carries poId, the file id and an expiry, plus an HMAC over all of
// it and over the PO's own `artRev` counter. The route verifies the HMAC,
// checks the clock and checks the counter, then streams the file. Nothing
// about the blob is reachable without a token.
//
// THREE THINGS THIS BUYS
//   1. Links expire. A forwarded link stops working.
//   2. Links can be revoked. Bumping artRev on the PO kills every link ever
//      issued for that order in one write, without touching the files.
//   3. Deleting a file actually deletes it.
//
// The signing key is SESSION_SECRET, which is already required everywhere and
// already must be identical across deploys. A separate secret would be one
// more thing to set and one more way for a deploy to half work.
//
// ESM. Do NOT convert to module.exports.

import crypto from "node:crypto";

export const DEFAULT_LINK_DAYS = 90;

function secret() {
  const s = process.env.SESSION_SECRET;
  // The undefined !== undefined trap: a comparison against a secret that was
  // never set must not quietly pass. Callers check this before signing.
  return typeof s === "string" && s.length > 0 ? s : null;
}

export function artSigningAvailable() {
  return secret() !== null;
}

function sign(payload) {
  const key = secret();
  if (!key) throw new Error("SESSION_SECRET is not set, so artwork links cannot be signed");
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * Make a token for one file on one PO.
 *
 * `rev` is the PO's artRev at the time of issue. A later bump invalidates
 * this token without needing a list of what has been issued.
 */
export function makeArtToken({ poId, fileId, rev, expiresAt }) {
  const body = [String(poId), String(fileId), String(rev || 0), String(expiresAt)].join(".");
  return `${Buffer.from(body).toString("base64url")}.${sign(body)}`;
}

/**
 * Verify a token. Returns { ok, poId, fileId, rev, expiresAt, reason }.
 *
 * Every failure gets its own reason so the route can say "this link has
 * expired, ask for a new one" rather than a flat 403, which is the message
 * that generates a phone call.
 */
export function readArtToken(token) {
  const fail = (reason) => ({ ok: false, reason });

  const raw = String(token || "");
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return fail("malformed");

  const encoded = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);

  let body;
  try {
    body = Buffer.from(encoded, "base64url").toString("utf8");
  } catch (e) {
    return fail("malformed");
  }

  let expected;
  try {
    expected = sign(body);
  } catch (e) {
    return fail("unconfigured");
  }

  // Constant-time, and length-checked first because timingSafeEqual throws
  // on a length mismatch rather than returning false.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail("bad signature");

  const [poId, fileId, rev, expiresAt] = body.split(".");
  if (!poId || !fileId) return fail("malformed");

  const exp = Number(expiresAt);
  if (!Number.isFinite(exp)) return fail("malformed");
  if (Date.now() > exp) return fail("expired");

  return { ok: true, poId, fileId, rev: Number(rev) || 0, expiresAt: exp };
}

/** How long a link should last, from settings, with a sane floor and ceiling. */
export function linkDays(settings) {
  const n = Number(settings && settings.artLinkDays);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINK_DAYS;
  return Math.min(3650, Math.round(n));
}

/**
 * The vendor-facing URL for one attachment. Relative, because the absolute
 * base differs between the emailed copy and the screen and only the caller
 * knows which one it is building.
 */
export function artUrlFor(po, file, settings) {
  const expiresAt = Date.now() + linkDays(settings) * 86400000;
  const token = makeArtToken({
    poId: po.id,
    fileId: file.id,
    rev: Number(po.artRev) || 0,
    expiresAt,
  });
  return `/api/promopro/art-file?t=${encodeURIComponent(token)}`;
}
