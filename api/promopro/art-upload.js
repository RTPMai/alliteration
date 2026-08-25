// api/promopro/art-upload.js — hand the browser a one-file upload token.
//
// POST, called by the browser twice during an upload: once to ask for a
// token, once when the upload finishes. Both go through @vercel/blob's
// handleUpload, which owns that protocol.
//
// WHY THIS EXISTS
// Artwork used to travel to api/promopro/art.js as base64 inside a JSON
// body. Vercel refuses any request body over 4.5 MB, and base64 inflates a
// file by a third, so the real ceiling was about 3.3 MB. QuickBooks, which
// this app replaces, accepts 20 MB. Being worse than the thing you replace
// is not a tradeoff, it is a regression.
//
// The file now goes browser to blob storage directly and never passes
// through a function, so the body limit does not apply.
//
// WHAT THIS ROUTE STILL CONTROLS, which is the point
// The browser cannot upload anything without a token from here, and this
// route decides, per file: that the caller is signed in and allowed to edit
// purchase orders, that the PO exists, that the PO is not already at its
// file limit, what the file may be called and where it lands, which content
// types are allowed, and the maximum size. The token is good for that one
// pathname and nothing else. So the browser gained the ability to send
// bytes, not the ability to decide anything.
//
// Files stay PRIVATE. Vendors read them through api/promopro/art-file.js
// with a signed, expiring, revocable link, exactly as before.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { handleUpload } from "@vercel/blob/client";
import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getSettings } from "../../lib/promopro/store.js";
import { artSigningAvailable } from "../../lib/promopro/art-token.js";
import { blobToken, blobTokenSource, blobTokenCandidates } from "../../lib/promopro/blob-token.js";

// 20 MB, to match what QuickBooks accepted, so nobody has to think about
// whether a file that used to be fine still is.
export const MAX_ART_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 12;

const ALLOWED_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/svg+xml",
  "application/pdf", "application/postscript", "application/illustrator",
  "image/vnd.adobe.photoshop", "image/tiff", "application/zip",
  "application/octet-stream",
];

function safeFilename(name) {
  return String(name || "artwork")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "artwork";
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  // GET is a readiness check, not part of the upload.
  //
  // The upload library reports every failure as "Failed to retrieve the
  // client token", whatever actually went wrong, so the specific reason this
  // route returned never reaches the person looking at the screen. This
  // walks the same steps in order and reports which one fails, in plain
  // words. Same idea as MailMe's webhook heartbeat, and for the same reason:
  // a subsystem that can only say "it did not work" costs an afternoon every
  // time it breaks.
  if (req.method === "GET") return diagnose(req, res, sess);

  try {
    const settings = await getSettings();
    if (!(await canEditSession(sess, settings))) {
      return res.status(403).json({ error: "Read-only access" });
    }

    // Refuse rather than upload something we cannot later hand to a vendor.
    if (!artSigningAvailable()) {
      return res.status(500).json({
        error: "SESSION_SECRET is not set on this deployment, so artwork links cannot be signed. Nothing was uploaded.",
      });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    // Passed explicitly rather than left to the SDK's own lookup, which only
    // knows the name BLOB_READ_WRITE_TOKEN. See lib/promopro/blob-token.js.
    const token = blobToken();
    if (!token) {
      return res.status(500).json({
        error: "No Blob read-write token is available on this deployment. Open /api/promopro/art-upload while signed in for the details.",
      });
    }

    const result = await handleUpload({
      token,
      request: req,
      body,

      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {};
        try { payload = clientPayload ? JSON.parse(clientPayload) : {}; } catch (e) { payload = {}; }

        const poId = String(payload.poId || "");
        if (!poId) throw new Error("poId is required");

        const po = await getPo(poId);
        if (!po) throw new Error("Purchase order not found");

        const art = Array.isArray(po.art) ? po.art : [];
        if (art.length >= MAX_FILES) {
          throw new Error(`A purchase order can hold ${MAX_FILES} art files.`);
        }

        // The token is scoped to this one pathname, so a browser cannot use
        // it to write anywhere else in the store.
        return {
          allowedContentTypes: ALLOWED_TYPES,
          maximumSizeInBytes: MAX_ART_BYTES,
          addRandomSuffix: true,
          access: "private",
          // Carried through to onUploadCompleted, which runs later and in a
          // different request with no session of its own.
          tokenPayload: JSON.stringify({
            poId,
            by: String(sess.username || "").toLowerCase(),
            filename: safeFilename(payload.filename || pathname),
          }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Called by Vercel server-to-server once the bytes have landed. This
        // is where the file is recorded against the PO, rather than trusting
        // the browser to come back and say so: a client that could name its
        // own blob could attach a file nobody checked.
        let meta = {};
        try { meta = tokenPayload ? JSON.parse(tokenPayload) : {}; } catch (e) { meta = {}; }

        const poId = String(meta.poId || "");
        if (!poId) return;

        const po = await getPo(poId);
        if (!po) return;

        const art = Array.isArray(po.art) ? po.art : [];

        // The callback can be retried, so adding the same blob twice has to
        // be a no-op rather than a duplicate row.
        if (art.some((a) => a.url === blob.url)) return;

        await updatePo(poId, {
          art: art.concat([{
            id: `af_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            pathname: blob.pathname,
            url: blob.url,
            filename: meta.filename || blob.pathname.split("/").pop(),
            contentType: blob.contentType || "application/octet-stream",
            bytes: Number(blob.size) || 0,
            uploadedBy: meta.by || "",
            uploadedAt: new Date().toISOString(),
          }]),
        });
      },
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error("promopro/art-upload route error:", e);
    // 400 rather than 500: nearly everything that reaches here is a rejected
    // upload (too big, wrong type, PO full) and the browser shows the message.
    return res.status(400).json({ error: e.message });
  }
}

/**
 * Walk the upload preconditions in order and report the first thing missing.
 * Read-only apart from one tiny test file, which is deleted immediately.
 */
async function diagnose(req, res, sess) {
  const checks = [];
  // Each check carries BOTH phrasings: what it is called when it passes, and
  // what the PROBLEM is when it does not. Reporting a failure by its check
  // name produces "First problem: BLOB_READ_WRITE_TOKEN is set", which reads
  // as the opposite of what happened.
  const add = (name, ok, problem, detail) =>
    checks.push({ name, ok, problem: problem || name, detail: detail || "" });

  try {
    const settings = await getSettings();
    const canEdit = await canEditSession(sess, settings);
    add("you can edit purchase orders", canEdit,
      "you do not have permission to edit purchase orders",
      canEdit ? "" : "your role is not on the edit list in PromoPro Settings");

    add("SESSION_SECRET is set", artSigningAvailable(),
      "SESSION_SECRET is NOT set on this deployment",
      "artwork links cannot be signed without it");

    const source = blobTokenSource();
    const hasBlobToken = source !== null;
    add(
      "a Blob read-write token is available" + (source ? " (from " + source + ")" : ""),
      hasBlobToken,
      "no Blob read-write token is available on this deployment",
      // Names only, never values. A readiness check that prints a credential
      // is worse than the fault it exists to explain.
      "blob-related variables present: " +
        (blobTokenCandidates().join(", ") || "none at all") +
        ". Connect a Blob store to this project in Vercel under Storage, then redeploy."
    );

    // The one that cannot be checked by looking: does this blob store
    // actually accept a PRIVATE file? Private blobs are a newer feature, and
    // a store that predates them fails here rather than at any of the steps
    // above. A 20-byte file, written and removed.
    if (hasBlobToken) {
      try {
        const { put, del } = await import("@vercel/blob");
        const probe = await put(`promopro/_diag/${Date.now()}.txt`, "readiness probe", {
          token: blobToken(),
          access: "private",
          contentType: "text/plain",
          addRandomSuffix: true,
        });
        add("the blob store accepts private files", true);
        try { await del(probe.url); } catch (e) { /* a stray 20-byte file is harmless */ }
      } catch (e) {
        add("the blob store accepts private files", false,
          "the blob store refused a private file", (e && e.message) || String(e));
      }
    }

    // And the step the browser actually hits first.
    if (hasBlobToken) {
      try {
        const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
        await generateClientTokenFromReadWriteToken({
          token: blobToken(),
          pathname: "promopro/_diag/probe.txt",
          access: "private",
          maximumSizeInBytes: MAX_ART_BYTES,
          validUntil: Date.now() + 60000,
        });
        add("an upload token can be minted", true);
      } catch (e) {
        add("an upload token can be minted", false,
          "an upload token could not be minted", (e && e.message) || String(e));
      }
    }

    const failed = checks.filter((c) => !c.ok);
    return res.status(200).json({
      ok: failed.length === 0,
      summary: failed.length === 0
        ? "Everything artwork uploads need is in place."
        : failed[0].problem + (failed[0].detail ? ". " + failed[0].detail + "." : "."),
      checks,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, summary: "The check itself failed: " + e.message, checks });
  }
}
