// lib/promopro/art-copy.js — artwork for a reorder.
//
// WHY A COPY AND NOT A POINTER
// A reorder is the same job again, so the same artwork goes to the vendor.
// The tempting shortcut is to let the new purchase order reference the old
// order's files. It is the wrong shape for two reasons that both end with a
// vendor holding the wrong art:
//
//   1. Every order's files live in a folder that only that order's upload
//      tokens can write to, and the send lists that folder to decide what
//      artwork exists (see art-reconcile.js). A file sitting in another
//      order's folder is invisible to that listing, so a reorder would email
//      with nothing attached.
//   2. Shared files mean deleting or replacing art on the old order silently
//      changes what the new one sends. Two orders, one set of bytes, and
//      nobody expecting the second to move.
//
// So the bytes are copied into the new order's own folder. Storage does the
// copying; nothing travels through a function.
//
// A COPY THAT FAILS MUST NOT COST THE ORDER
// Every file is attempted, failures are collected per file and reported back
// by name, and the caller creates the purchase order regardless. An order
// with artwork still to add is a small chore. A lost order is not.
//
// ESM. Do NOT convert to module.exports.

import { artBlobOptions } from "./blob-token.js";
import { artPrefix } from "./art-reconcile.js";

/** The filename part of a stored path, with the folder stripped off. */
export function baseName(file) {
  const from = String((file && (file.filename || file.pathname)) || "artwork");
  return from.split("/").pop() || "artwork";
}

/** Where a copy of this file belongs on the order it is going to. */
export function destinationFor(toPoId, file) {
  return artPrefix(toPoId) + baseName(file);
}

/**
 * Copy every art file on `fromPo` into `toPoId`'s own folder.
 *
 * Returns { art, copied, failed }:
 *   art     the art rows for the new order, in the original's order
 *   copied  the files that made it
 *   failed  [{ filename, error }] for anything that did not, by name
 *
 * `opts.copy` exists so this can be tested by calling it rather than by
 * reading it. Production passes nothing and gets the real storage copy.
 */
export async function copyArt(fromPo, toPoId, opts) {
  const files = Array.isArray(fromPo && fromPo.art) ? fromPo.art : [];
  if (!toPoId) throw new Error("copyArt needs the purchase order it is copying to");
  if (!files.length) return { art: [], copied: [], failed: [] };

  let copy = opts && opts.copy;
  if (!copy) ({ copy } = await import("@vercel/blob"));

  const by = (opts && opts.by) || "";
  const at = new Date().toISOString();

  // All at once. These are server-side copies inside one store, there are at
  // most a dozen, and doing them in sequence is the difference between a
  // reorder that feels instant and one somebody watches.
  const results = await Promise.all(files.map(async (f, i) => {
    const filename = baseName(f);
    try {
      // addRandomSuffix, so copying the same order twice cannot have the
      // second copy land on top of the first.
      const blob = await copy(f.pathname || f.url, destinationFor(toPoId, f), {
        ...artBlobOptions(),
        access: "private",
        addRandomSuffix: true,
        contentType: f.contentType || undefined,
      });
      return {
        ok: true,
        row: {
          id: `af_${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`,
          pathname: blob.pathname,
          url: blob.url,
          filename,
          contentType: f.contentType || "application/octet-stream",
          bytes: Number(f.bytes) || 0,
          uploadedBy: by,
          uploadedAt: at,
          // Where it came from, so a file nobody recognizes on a reorder can
          // be traced back to the order it was copied from.
          copiedFrom: f.pathname || f.url || "",
        },
      };
    } catch (e) {
      return { ok: false, filename, error: (e && e.message) || String(e) };
    }
  }));

  const art = results.filter((r) => r.ok).map((r) => r.row);
  return {
    art,
    copied: art.slice(),
    failed: results.filter((r) => !r.ok).map((r) => ({ filename: r.filename, error: r.error })),
  };
}

/** One sentence for the screen, or "" when everything copied. */
export function copyProblem(failed) {
  const list = Array.isArray(failed) ? failed : [];
  if (!list.length) return "";
  return `The order was created, but ${list.length} art file${list.length === 1 ? "" : "s"} ` +
    `did not copy across (${list.map((f) => f.filename).join(", ")}). Attach ${list.length === 1 ? "it" : "them"} ` +
    `on the new order before sending.`;
}
