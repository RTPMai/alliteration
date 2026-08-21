// api/promopro/art-file.js — hand a vendor one artwork file, against a
// signed link.
//
// GET ?t=<token>
//
// PUBLIC BY DESIGN, in the same narrow sense as ShopStock's scan endpoint:
// no session is required, because the vendor will never have one. What makes
// that acceptable here and did not make it acceptable before is that the
// token is the credential. It names one file on one purchase order, it
// carries an expiry, and it stops working when the order's artRev is bumped.
// A blob URL, by contrast, was permanent and unrevokable once forwarded.
//
// A signed-in member of staff can also fetch by ?poId=&id= without a token,
// which is what the app's own screen uses so the list of attachments does
// not need a token minted for every row on every render.
//
// FAILURES SAY WHICH FAILURE IT WAS. "Expired" and "wrong signature" are
// different problems with different fixes, and a flat 403 for both is what
// generates the phone call this app exists to avoid.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { head } from "@vercel/blob";
import { getSession } from "../../lib/session.js";
import { getPo } from "../../lib/promopro/store.js";
import { readArtToken } from "../../lib/promopro/art-token.js";

function fail(res, code, message) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(code).send(
    `<!doctype html><meta charset="utf-8"><title>Artwork</title>` +
    `<div style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 1.5em">` +
    `<h1 style="font-size:20px">${message.title}</h1><p>${message.body}</p></div>`
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const q = req.query || {};
    let poId = "";
    let fileId = "";

    if (q.t) {
      const token = readArtToken(String(q.t));
      if (!token.ok) {
        if (token.reason === "expired") {
          return fail(res, 410, {
            title: "This artwork link has expired.",
            body: "Links are time limited. Reply to the purchase order email and we will send a fresh one.",
          });
        }
        if (token.reason === "unconfigured") {
          console.error("[promopro] art-file called but SESSION_SECRET is not set");
          return fail(res, 500, {
            title: "This link cannot be checked right now.",
            body: "Something is misconfigured on our side. Please let us know.",
          });
        }
        return fail(res, 403, {
          title: "This artwork link is not valid.",
          body: "It may have been revoked or copied incorrectly. Reply to the purchase order email for a new one.",
        });
      }
      poId = token.poId;
      fileId = token.fileId;

      const po = await getPo(poId);
      if (!po) return fail(res, 404, { title: "Not found.", body: "That purchase order no longer exists." });

      // The revocation check. A bumped counter kills every link issued
      // before it, in one write, without a list of what was handed out.
      if ((Number(po.artRev) || 0) !== token.rev) {
        return fail(res, 403, {
          title: "This artwork link has been withdrawn.",
          body: "Reply to the purchase order email and we will send a current one.",
        });
      }

      return await stream(res, po, fileId);
    }

    // Staff path. No token, but a real session and the ids in the query.
    const sess = getSession(req);
    if (!sess) return fail(res, 403, { title: "Sign in required.", body: "This file needs a valid link or a signed-in account." });

    poId = String(q.poId || "");
    fileId = String(q.id || "");
    if (!poId || !fileId) return res.status(400).json({ error: "poId and id are required" });

    const po = await getPo(poId);
    if (!po) return fail(res, 404, { title: "Not found.", body: "That purchase order no longer exists." });

    return await stream(res, po, fileId);
  } catch (e) {
    console.error("promopro/art-file route error:", e);
    return fail(res, 500, { title: "Something went wrong.", body: "Please try again, or let us know." });
  }
}

async function stream(res, po, fileId) {
  const file = (Array.isArray(po.art) ? po.art : []).find((a) => a.id === fileId);
  if (!file) {
    return fail(res, 404, {
      title: "That file is no longer attached to this order.",
      body: "It may have been replaced. Reply to the purchase order email and we will send the current artwork.",
    });
  }

  // Private blobs are fetched with the store token attached, which is why
  // this has to be proxied rather than redirected: a redirect would send the
  // browser to a URL it cannot read.
  const meta = await head(file.url);
  const upstream = await fetch(meta.downloadUrl || file.url);
  if (!upstream.ok) {
    console.error("[promopro] blob fetch failed", upstream.status, file.url);
    return fail(res, 502, { title: "The file could not be read.", body: "Please try again in a moment." });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader("Content-Type", file.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(buf.length));
  // A vendor wants the file on their machine, not rendered in a tab.
  res.setHeader("Content-Disposition", `attachment; filename="${String(file.filename || "artwork").replace(/"/g, "")}"`);
  return res.status(200).send(buf);
}
