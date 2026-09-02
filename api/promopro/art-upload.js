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

import { handleUpload, handleUploadPresigned } from "@vercel/blob/client";
import { issueSignedToken, head } from "@vercel/blob";
import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getSettings, saveSettings } from "../../lib/promopro/store.js";
import { artSigningAvailable } from "../../lib/promopro/art-token.js";
import { artPrefix } from "../../lib/promopro/art-reconcile.js";
import { blobToken, blobTokenSource, blobTokenCandidates, artStoreId, artStoreSource, artBlobOptions, usingSharedStore, artWebhookKey, artWebhookKeySource } from "../../lib/promopro/blob-token.js";

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

/**
 * WHERE VERCEL SHOULD CALL BACK when an upload finishes.
 *
 * Set explicitly, because the SDK's own guess is fragile and fails quietly.
 * It only works out a callback URL from VERCEL_PROJECT_PRODUCTION_URL (or
 * the preview equivalents), and if that variable is not exposed to the
 * deployment it returns nothing, logs a console warning nobody reads, and
 * simply never asks for a callback. The upload then succeeds and the file is
 * never recorded, which is exactly what happened here: the bytes landed, the
 * purchase order never heard about it.
 *
 * The host on the incoming request is not a guess. It is the deployment the
 * browser is actually talking to.
 */
function callbackUrlFor(req) {
  const base = (process.env.PROMOPRO_PUBLIC_URL || `https://${(req.headers && req.headers.host) || ""}`)
    .replace(/\/+$/, "");
  return `${base}/api/promopro/art-upload`;
}

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

  // THE COMPLETION CALLBACK HAS NO SESSION, AND MUST NOT NEED ONE.
  //
  // This route is called by two different callers. The browser asks for an
  // upload token, carrying your cookie. Then, once the bytes have landed,
  // VERCEL calls back server-to-server to say so, and that request has no
  // cookie and never will.
  //
  // requireAuth used to run before everything, so the callback got a 401 and
  // the file was never attached to the purchase order. The upload itself
  // worked, which is why it looked like the upload had worked and the
  // attachment had silently vanished.
  //
  // That call is NOT unauthenticated. It is signed, and the SDK verifies the
  // signature before invoking onUploadCompleted: Ed25519 against
  // BLOB_WEBHOOK_PUBLIC_KEY on the presigned path, the store's own key on
  // the other. An unsigned or wrongly signed callback is refused there. What
  // it cannot have is a session, because no person is involved.
  let earlyBody = req.body;
  if (typeof earlyBody === "string") {
    try { earlyBody = JSON.parse(earlyBody); } catch (e) { earlyBody = {}; }
  }
  const isCompletionCallback = req.method === "POST"
    && earlyBody && earlyBody.type === "blob.upload-completed";

  if (isCompletionCallback) {
    // A heartbeat, before anything can throw. Same idea as MailMe's webhook
    // heartbeat: without it there is no way to tell "Vercel never called us"
    // apart from "Vercel called and we rejected it", and those have
    // completely different fixes.
    //
    // It records the OUTCOME as well as the arrival, because "arrived and we
    // rejected it" and "arrived and the file is attached" are also two
    // different problems, and the readiness check is the only place anybody
    // ever looks.
    const beat = async (outcome) => {
      try {
        await saveSettings({
          _artCallbackLastAt: new Date().toISOString(),
          _artCallbackLastOutcome: outcome,
        });
      } catch (e) { /* a missing heartbeat must never fail the callback itself */ }
    };
    await beat("arrived, not yet processed");

    try {
      const result = blobToken()
        ? await handleUpload({ token: blobToken(), request: req, body: earlyBody, onBeforeGenerateToken: rejectTokenRequest, onUploadCompleted: recordUpload })
        : await handleUploadPresigned({ request: req, body: earlyBody, getSignedToken: rejectTokenRequest, onUploadCompleted: recordUpload });
      await beat("attached");
      return res.status(200).json(result);
    } catch (e) {
      // A bad signature lands here. Logged loudly: it is either a
      // misconfiguration or somebody poking at the endpoint.
      console.error("promopro/art-upload completion callback rejected:", e && e.message);
      await beat("rejected: " + ((e && e.message) || "unknown"));
      return res.status(400).json({ error: e.message });
    }
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
  if (req.method === "GET") {
    // ?flow=1 answers the one question the browser needs before it starts:
    // which of the two upload calls applies here. The browser cannot work
    // that out for itself, and guessing wrong fails with an error that names
    // no cause.
    if (req.query && req.query.flow === "1") {
      return res.status(200).json({ flow: blobToken() ? "token" : "presigned" });
    }
    return diagnose(req, res, sess);
  }

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

    // THE BROWSER REPORTS ITS OWN FINISHED UPLOAD.
    //
    // Vercel's completion callback arrives a second or two after the bytes
    // land, and the screen used to sit there polling for it. That wait was
    // the whole delay somebody felt when attaching artwork. The browser
    // already knows the upload finished, so it says so, and the callback
    // becomes the backstop rather than the only way a file gets recorded.
    //
    // Nothing here is taken on trust: see attachNow.
    if (body && body.attach === true) {
      return attachNow(req, res, sess, settings, body);
    }

    // TWO WAYS A BLOB STORE CAN BE CONNECTED, and this project uses the
    // newer one.
    //
    // The older way puts a long-lived BLOB_READ_WRITE_TOKEN in the
    // environment. The newer way, which is how `backbone-briefs` is wired,
    // uses a short-lived OIDC token the platform injects per request plus
    // BLOB_STORE_ID, and there is no read-write token anywhere. Vercel's
    // own docs lead with the read-write flow, which is why the first two
    // attempts at this failed.
    //
    // handleUpload() needs a read-write token and cannot work here.
    // handleUploadPresigned() + issueSignedToken() take either, because
    // issueSignedToken explicitly supports OIDC with BLOB_STORE_ID.
    //
    // Both paths are kept: if a read-write token ever appears (a store
    // reconnected the old way, or a second store added) the code should not
    // need editing again.
    const token = blobToken();

    if (!token) {
      return res.status(200).json(await presignedFlow(req, body, sess, settings));
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

        // The path has to be inside the folder belonging to the order the
        // caller named. Without this, a signed-in editor could ask for a
        // token to write anywhere in the artwork store, and the folder would
        // stop meaning anything.
        if (!String(pathname || "").startsWith(artPrefix(poId))) {
          throw new Error("Artwork must be uploaded to its own purchase order's folder.");
        }

        // The token is scoped to this one pathname, so a browser cannot use
        // it to write anywhere else in the store.
        return {
          allowedContentTypes: ALLOWED_TYPES,
          maximumSizeInBytes: MAX_ART_BYTES,
          addRandomSuffix: true,
          access: "private",
          callbackUrl: callbackUrlFor(req),
          // Carried through to onUploadCompleted, which runs later and in a
          // different request with no session of its own.
          tokenPayload: JSON.stringify({
            poId,
            by: String(sess.username || "").toLowerCase(),
            filename: safeFilename(payload.filename || pathname),
          }),
        };
      },

      // Shared with the presigned path so the two cannot drift into
      // attaching files differently.
      onUploadCompleted: recordUpload,
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
 * Never called on the completion path: a callback that somehow asked for a
 * new token would be doing something it has no business doing, and this
 * makes that a refusal rather than an accident.
 */
async function rejectTokenRequest() {
  throw new Error("This callback cannot request an upload token");
}

/**
 * Attach a file the browser has just finished uploading, without waiting for
 * Vercel to call back.
 *
 * WHY THIS IS SAFE, which is the only interesting part.
 *
 * The browser is telling us a file exists. It is not being believed. Three
 * things are checked, and all three have to hold:
 *
 *   1. The caller may edit purchase orders. Same gate as every other write.
 *   2. The path sits inside THIS order's own folder. Only a token we signed
 *      can write there, and we only ever sign one for the order the caller
 *      named, so a blob under that prefix could not have come from anywhere
 *      else.
 *   3. Storage confirms the file is really there, with its real size and
 *      type. A browser cannot invent a file by describing one.
 *
 * So the browser gained the ability to say "it landed, look", not the
 * ability to put a row on a purchase order.
 *
 * Attaching is shared with the callback path and is idempotent, so whichever
 * of the two gets there first wins and the other does nothing.
 */
async function attachNow(req, res, sess, settings, body) {
  if (!(await canEditSession(sess, settings))) {
    return res.status(403).json({ error: "Read-only access" });
  }

  const poId = String(body.poId || "");
  const pathname = String(body.pathname || "");
  if (!poId || !pathname) {
    return res.status(400).json({ error: "poId and pathname are required" });
  }

  const po = await getPo(poId);
  if (!po) return res.status(404).json({ error: "Purchase order not found" });

  // The file must sit in this order's own folder. This is the check that
  // makes the rest of it safe, so it happens before storage is asked
  // anything at all.
  if (!pathname.startsWith(artPrefix(poId))) {
    return res.status(400).json({ error: "That file does not belong to this purchase order." });
  }

  let blob = null;
  try {
    blob = await head(pathname, artBlobOptions());
  } catch (e) {
    // Not an error worth alarming anybody with: the callback will attach it
    // when it arrives. This path is the fast one, not the only one.
    return res.status(202).json({ ok: false, pending: true, error: "Storage has not got that file yet." });
  }

  await recordUpload({
    blob,
    tokenPayload: JSON.stringify({
      poId,
      by: String(sess.username || "").toLowerCase(),
      filename: safeFilename(body.filename || pathname),
    }),
  });

  const after = await getPo(poId);
  return res.status(200).json({ ok: true, art: (after && after.art) || [] });
}

/**
 * The OIDC path. Same decisions as onBeforeGenerateToken above, expressed as
 * a short-lived signed token rather than a client token.
 */
async function presignedFlow(req, body, sess, settings) {
  return handleUploadPresigned({
    request: req,
    body,

    getSignedToken: async (pathname, clientPayload) => {
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

      // Same folder check as the token path. This is what lets the browser
      // report its own finished upload: a blob under this prefix could only
      // have been written by a token we signed for this order.
      if (!String(pathname || "").startsWith(artPrefix(poId))) {
        throw new Error("Artwork must be uploaded to its own purchase order's folder.");
      }

      // The same limits as the other path, carried on the token rather than
      // enforced by us: storage refuses an oversized or wrong-typed file
      // before a byte of it is accepted.
      const signed = await issueSignedToken({
        ...artBlobOptions(),
        pathname,
        operations: ["put"],
        allowedContentTypes: ALLOWED_TYPES,
        maximumSizeInBytes: MAX_ART_BYTES,
        validUntil: Date.now() + 60 * 60 * 1000,
      });

      return {
        token: signed,
        urlOptions: {
          access: "private",
          addRandomSuffix: true,
          callbackUrl: callbackUrlFor(req),
          tokenPayload: JSON.stringify({
            poId,
            by: String(sess.username || "").toLowerCase(),
            filename: safeFilename(payload.filename || pathname),
          }),
        },
      };
    },

    onUploadCompleted: recordUpload,
  });
}

/**
 * Record a finished upload against its purchase order. Shared by both flows
 * so the two paths cannot drift into attaching files differently.
 */
async function recordUpload({ blob, tokenPayload }) {
  let meta = {};
  try { meta = tokenPayload ? JSON.parse(tokenPayload) : {}; } catch (e) { meta = {}; }

  const poId = String(meta.poId || "");
  if (!poId) return;

  const po = await getPo(poId);
  if (!po) return;

  const art = Array.isArray(po.art) ? po.art : [];
  // The callback can be retried, so adding the same blob twice has to be a
  // no-op rather than a duplicate row.
  if (art.some((a) => a.url === blob.url)) return;

  await updatePo(poId, {
    art: art.concat([{
      id: `af_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      pathname: blob.pathname,
      url: blob.url,
      filename: meta.filename || String(blob.pathname || "").split("/").pop(),
      contentType: blob.contentType || "application/octet-stream",
      bytes: Number(blob.size) || 0,
      uploadedBy: meta.by || "",
      uploadedAt: new Date().toISOString(),
    }]),
  });
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

    // Either connection style is fine. What is NOT fine is neither.
    const source = blobTokenSource();
    const hasStoreId = typeof process.env.BLOB_STORE_ID === "string" && process.env.BLOB_STORE_ID.length > 0;
    const connected = source !== null || hasStoreId;
    add(
      source
        ? "the blob store is connected (read-write token from " + source + ")"
        : "the blob store is connected (store id from " + (artStoreSource() || "nowhere") + ", OIDC)",
      connected,
      "no blob store is connected to this deployment",
      // Names only, never values. A readiness check that prints a credential
      // is worse than the fault it exists to explain.
      "blob-related variables present: " +
        (blobTokenCandidates().join(", ") || "none at all") +
        ". Connect a Blob store to this project in Vercel under Storage, then redeploy."
    );
    const hasBlobToken = connected;

    // The one that cannot be checked by looking: does this blob store
    // actually accept a PRIVATE file? Private blobs are a newer feature, and
    // a store that predates them fails here rather than at any of the steps
    // above. A 20-byte file, written and removed.
    if (hasBlobToken) {
      try {
        const { put, del } = await import("@vercel/blob");
        const probe = await put(`promopro/_diag/${Date.now()}.txt`, "readiness probe", {
          // Store and token together. A token is only included when one
          // exists: passing undefined stops the SDK falling back to OIDC.
          ...artBlobOptions(),
          access: "private",
          contentType: "text/plain",
          addRandomSuffix: true,
        });
        add("the blob store accepts private files", true);
        try { await del(probe.url, artBlobOptions()); } catch (e) { /* a stray 20-byte file is harmless */ }
      } catch (e) {
        add("the blob store accepts private files", false,
          "the blob store refused a private file",
          ((e && e.message) || String(e)) +
          " Public and private are a property of the STORE, not the file. Artwork needs its own " +
          "PRIVATE store: create one in Vercel under Storage, connect it to this project, and set " +
          "PROMOPRO_BLOB_STORE_ID to its id. The existing store is in use by BackBone's emailed " +
          "briefs and must stay public.");
      }
    }

    // And the step the browser actually hits first.
    if (hasBlobToken) {
      try {
        if (blobToken()) {
          const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
          await generateClientTokenFromReadWriteToken({
            token: blobToken(),
            pathname: "promopro/_diag/probe.txt",
            access: "private",
            maximumSizeInBytes: MAX_ART_BYTES,
            validUntil: Date.now() + 60000,
          });
        } else {
          // The OIDC path uses a signed token instead, so probe THAT rather
          // than a call that can never work on this deployment.
          await issueSignedToken({
            ...artBlobOptions(),
            pathname: "promopro/_diag/probe.txt",
            operations: ["put"],
            maximumSizeInBytes: MAX_ART_BYTES,
            validUntil: Date.now() + 60000,
          });
        }
        add("an upload token can be minted", true);
      } catch (e) {
        add("an upload token can be minted", false,
          "an upload token could not be minted", (e && e.message) || String(e));
      }
    }

    // Not a pass/fail check, just the two facts that matter when a file
    // uploads and never appears: where we asked Vercel to call back, and
    // whether it ever has.
    const settingsForBeat = await getSettings().catch(() => ({}));
    const lastCallback = settingsForBeat._artCallbackLastAt || null;
    const lastOutcome = settingsForBeat._artCallbackLastOutcome || "";
    add(
      lastCallback
        ? "an upload callback has been received (last " + lastCallback +
          (lastOutcome ? ", " + lastOutcome : "") + ")"
        : "an upload callback has never been received",
      Boolean(lastCallback),
      "Vercel has never called back to confirm an upload",
      "we ask it to call " + callbackUrlFor(req) +
        ". If uploads succeed but nothing attaches, that address is the thing to check."
    );

    // Named separately because the error storage gives for this is about
    // access levels and does not mention that the wrong STORE is in use.
    add(
      usingSharedStore()
        ? "artwork would go to the shared store"
        : "artwork has its own store (" + artStoreSource() + ")",
      !usingSharedStore(),
      "artwork would be written to the shared store, which is public",
      "the shared store cannot hold private files, and it cannot be made private because " +
        "BackBone's emailed briefs are public URLs already in people's inboxes. Create a " +
        "private Blob store, connect it to this project with the prefix PROMOPRO, and redeploy."
    );

    // THE PAIR, NOT THE TWO HALVES.
    //
    // A callback signed by one store and verified against another store's
    // key is refused, and the refusal looks exactly like an upload that
    // silently did not attach. That happened on Aug 25. The check is not
    // "is a key set" but "is the key from the SAME connection as the store".
    add(
      artWebhookKey()
        ? "the callback key belongs to the artwork store (" + artWebhookKeySource() + ")"
        : "the artwork store has no callback key of its own",
      Boolean(artWebhookKey()),
      "the store artwork uses has no matching WEBHOOK_PUBLIC_KEY",
      "the store is " + (artStoreSource() || "not set") + ", so the key must be " +
        String(artStoreSource() || "BLOB_STORE_ID").replace(/_STORE_ID$/, "_WEBHOOK_PUBLIC_KEY") +
        ". Another store's key verifies nothing and fails without saying so"
    );

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
