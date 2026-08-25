// lib/promopro/art-reconcile.js — storage is the truth about what artwork
// exists for a purchase order.
//
// THE PROBLEM THIS ENDS
// A file was attached to a PO in three steps: upload it, have something
// record it against the order, then read the order when sending. Every one
// of those steps could be a moment behind the one before it, so a PO sent
// seconds after an upload could go to the vendor with the artwork missing.
// The app had grown a confirmation dialog asking whether to send anyway,
// which is a question nobody should ever be asked: the file was uploaded,
// obviously it should be on the email.
//
// So the send stops trusting the record. Every file for an order lives under
// one folder that only that order's upload tokens can write to, so listing
// that folder answers "what artwork exists" directly, with no dependence on
// a callback having arrived or a browser having reported anything.
//
// Anything found that is not on the order is added to it, which also repairs
// records left short by a callback that failed earlier.
//
// ESM. Do NOT convert to module.exports.

import { artBlobOptions } from "./blob-token.js";

/** Where one order's artwork lives. Must match api/promopro/art-upload.js. */
export function artPrefix(poId) {
  return `promopro/art/${poId}/`;
}

function guessType(filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ai: "application/illustrator",
    eps: "application/postscript", psd: "image/vnd.adobe.photoshop",
    tif: "image/tiff", tiff: "image/tiff", zip: "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * What artwork does this order actually have?
 *
 * Returns { art, added, listed } where `art` is the reconciled list. Does
 * not write; the caller decides whether to persist, because a send should
 * not fail on a storage write.
 *
 * A listing failure is NOT fatal: it falls back to whatever the order
 * already recorded. Losing the ability to double-check must not cost you the
 * ability to send a purchase order.
 */
export async function reconcileArt(poId, po) {
  const recorded = Array.isArray(po && po.art) ? po.art : [];

  let blobs = [];
  try {
    const { list } = await import("@vercel/blob");
    const result = await list({ ...artBlobOptions(), prefix: artPrefix(poId) });
    blobs = Array.isArray(result && result.blobs) ? result.blobs : [];
  } catch (e) {
    console.error("[promopro] could not list artwork for", poId, e && e.message);
    return { art: recorded, added: [], listed: false };
  }

  const known = new Set(recorded.map((a) => a.pathname).filter(Boolean));
  const added = [];

  blobs.forEach((b) => {
    if (!b || !b.pathname || known.has(b.pathname)) return;
    // Skip the readiness probe's own leftovers, which live elsewhere but
    // guard against a prefix change bringing them into range.
    if (b.pathname.includes("/_diag/")) return;

    const filename = String(b.pathname).split("/").pop();
    added.push({
      id: `af_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      pathname: b.pathname,
      url: b.url,
      filename,
      contentType: b.contentType || guessType(filename),
      bytes: Number(b.size) || 0,
      uploadedBy: "",
      uploadedAt: b.uploadedAt || new Date().toISOString(),
    });
  });

  return { art: recorded.concat(added), added, listed: true };
}
