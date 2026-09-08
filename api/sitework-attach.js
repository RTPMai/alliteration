// PUT IN: api/sitework-attach.js
// api/sitework-attach.js — image attachments on a Site Work note.
//
// WHY THIS IS A FLAT FILE AND NOT api/sitework/attach.js
// Vercel treats a file and a same-named folder as a route conflict once ".js"
// is stripped, so api/sitework.js and api/sitework/ cannot both exist. That is
// the same constraint that forced WebsiteWidget's routes into a folder in
// August, arriving from the other direction. Hence the hyphen.
//
// WHY NOT PART OF api/sitework.js
// That route answers with the whole board on GET and takes a small JSON patch
// otherwise. This one takes a megabyte of base64. Keeping them apart keeps the
// board's own requests small and means a change to one cannot slow the other.
//
// ACCESS. Identical to api/sitework.js: the per-account Admin flag or a role
// with "stickies" ticked, and writing additionally needs can_edit. Duplicated
// deliberately rather than imported, because a route that gets its gate from
// another route is a route whose gate can be removed by editing a file that
// looks unrelated.
//
// Env: BLOB_READ_WRITE_TOKEN, already set in the Vercel project.

import { put, del } from "@vercel/blob";
import { requireAuth } from "../lib/session.js";
import { getUser, permsFor } from "../lib/users.js";
import { getNote, updateNote } from "../lib/sitework/store.js";
import {
  parseImageDataUrl, attachmentPath, buildAttachment, attachmentsOf,
  isFull, canRemoveAttachment, mergeAttachment, withoutAttachment,
  MAX_ATTACHMENTS_PER_NOTE,
} from "../lib/sitework/attachments.js";

const SITE_APP_ID = "stickies";

/**
 * The blob token, read and passed EXPLICITLY rather than letting the SDK find
 * it in the environment.
 *
 * The SDK resolves credentials in a fixed order and tries OIDC discovery
 * BEFORE it looks at BLOB_READ_WRITE_TOKEN. On Vercel that resolves instantly
 * and costs nothing, which is why the older upload routes in this repo get away
 * with saying nothing. Off Vercel it goes looking for a token that is not
 * there, which is a delay on every upload and a hang with no network at all.
 *
 * Passing it removes that step. PromoPro reached the same conclusion from the
 * other direction and has blobToken() in lib/promopro/blob-token.js.
 */
function blobOptions(extra) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return Object.assign({}, extra, token ? { token } : {});
}

async function isBuilder(sess) {
  if (!sess.username) return false;
  const user = await getUser(sess.username);
  if (!user) return false;
  if (user.superuser === true) return true;
  const perms = await permsFor(sess.username);
  const tabs = Array.isArray(perms && perms.tabs) ? perms.tabs : [];
  return tabs.includes(SITE_APP_ID);
}

async function canWrite(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  if (user && user.superuser === true) return true;
  const perms = await permsFor(sess.username);
  return !!(perms && perms.can_edit !== false);
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function newAttachmentId() {
  return "att_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  // Fail closed ahead of every branch, so a method added later cannot ship
  // ungated by being forgotten. Same shape as api/sitework.js.
  if (!(await isBuilder(sess))) {
    return res.status(403).json({ error: "Site Work is admin only" });
  }
  if (!(await canWrite(sess))) {
    return res.status(403).json({ error: "Your role can view Site Work but not change it" });
  }

  const me = String(sess.username || "").toLowerCase();

  try {
    if (req.method === "POST") {
      const body = parseBody(req);
      const noteId = String(body.noteId || "");
      if (!noteId) return res.status(400).json({ error: "Missing note id" });

      const note = await getNote(noteId);
      if (!note) return res.status(404).json({ error: "Note not found" });

      if (isFull(note)) {
        return res.status(400).json({
          error: "A note can hold " + MAX_ATTACHMENTS_PER_NOTE + " images. Remove one first.",
        });
      }

      const parsed = parseImageDataUrl(body.dataUrl);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const id = newAttachmentId();
      const pathname = attachmentPath(noteId, id, parsed.mediaType);

      // addRandomSuffix is off: the path is already unique because the
      // attachment id is, and a predictable path is what lets a delete find the
      // file later without storing a second copy of where it went.
      const blob = await put(pathname, Buffer.from(parsed.base64, "base64"), blobOptions({
        access: "public",
        contentType: parsed.mediaType,
        addRandomSuffix: false,
        allowOverwrite: false,
      }));

      const attachment = buildAttachment({
        id,
        url: blob.url,
        pathname,
        name: body.name,
        mediaType: parsed.mediaType,
        bytes: parsed.bytes,
        by: me,
      });

      // Re-read immediately before writing. The note was fetched before an
      // upload that takes a moment, and somebody else may have added one in
      // between; merging onto the stale copy would drop theirs.
      const fresh = await getNote(noteId);
      if (!fresh) {
        await del(blob.url, blobOptions()).catch(() => {});
        return res.status(404).json({ error: "That note was deleted while the image was uploading." });
      }
      const nextList = mergeAttachment(fresh, attachment);
      if (!nextList) {
        await del(blob.url, blobOptions()).catch(() => {});
        return res.status(400).json({ error: "Somebody else filled this note up while that was uploading." });
      }

      const merged = await updateNote(noteId, {
        attachments: nextList,
        updatedAt: new Date().toISOString(),
        // Attaching a screenshot IS editing the note, unlike dragging it.
        updatedBy: me,
      });

      return res.status(201).json({ ok: true, attachment, note: merged });
    }

    if (req.method === "DELETE") {
      const q = req.query || {};
      const body = parseBody(req);
      const noteId = String(q.noteId || body.noteId || "");
      const attachmentId = String(q.attachmentId || body.attachmentId || "");
      if (!noteId || !attachmentId) {
        return res.status(400).json({ error: "Missing note id or attachment id" });
      }

      const note = await getNote(noteId);
      if (!note) return res.status(404).json({ error: "Note not found" });

      const list = attachmentsOf(note);
      const attachment = list.find((a) => a.id === attachmentId);
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });

      const user = await getUser(sess.username);
      if (!canRemoveAttachment(note, attachment, { username: sess.username, superuser: user && user.superuser })) {
        return res.status(403).json({
          error: "Only the person who added an image, the person who wrote the note, or an admin can remove it",
        });
      }

      // The RECORD comes off first and the file second. If the blob delete
      // fails, the worst outcome is an orphaned file nobody can see. If the
      // order were reversed, a failed record update would leave a thumbnail on
      // the board pointing at a file that no longer exists.
      const merged = await updateNote(noteId, {
        attachments: withoutAttachment(note, attachmentId),
        updatedAt: new Date().toISOString(),
        updatedBy: me,
      });
      await del(attachment.url, blobOptions()).catch(() => {});

      return res.status(200).json({ ok: true, note: merged });
    }

    res.setHeader("Allow", "POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("sitework-attach route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
