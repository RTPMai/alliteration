// PUT IN: api/concontrol/social.js
// api/concontrol/social.js: the social plan.
//
// GET                          -> posts, decisions, goals and rules, what is stuck
// POST   { what: "import", plan } -> load or reload the plan file, admin only
// PATCH  ?id=&kind=post        -> edit a post, or mark it posted
// PATCH  ?id=&kind=decision    -> answer or reopen a decision
// PATCH  kind=condition { key, met } -> tick a real-world condition met
// DELETE ?id=                  -> delete a post, admin only
//
// Read is open to anybody who can open ConControl, same as the program: the
// posting calendar is something the whole team should be able to see. Editing
// is can_edit. Loading the plan writes nearly a hundred records at once, so it
// is admin only, like the other imports.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import {
  readPlan, mergePlan, validatePostPatch, validateDecisionPatch, markEdited,
  socialBlockers, socialSummary, todayCentral, POST_STATUS_LABELS,
} from "../../lib/concontrol/social.js";
import {
  getSettings, listPosts, getPost, savePosts, updatePost, deletePost,
  listDecisions, getDecision, saveDecisions, updateDecision,
  getSocialMeta, saveSocialMeta,
} from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function gate(sess) {
  const perms = await permsFor(sess.username);
  const superuser = !!(perms && perms.superuser === true);
  const admin = superuser || !!(perms && perms.role === "admin");
  return {
    canEdit: superuser || !!(perms && perms.can_edit !== false),
    canDelete: admin,
    canImport: admin,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};
  const id = q.id || null;

  try {
    const settings = await getSettings();
    const event = (q.event && String(q.event)) || settings.event || DEFAULT_EVENT;
    const { canEdit, canDelete, canImport } = await gate(sess);
    const today = todayCentral();

    if (req.method === "GET") {
      const [posts, decisions, meta] = [
        await listPosts(event), await listDecisions(event), await getSocialMeta(event),
      ];
      const conditions = (meta && meta.conditions) || {};
      return res.status(200).json({
        event,
        today,
        posts,
        decisions,
        meta,
        blockers: socialBlockers(posts, decisions, conditions, today),
        summary: socialSummary(posts, decisions, conditions, today),
        canEdit,
        canDelete,
        canImport,
      });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      if (body.what !== "import") return res.status(400).json({ error: "Unknown request" });
      if (!canImport) return res.status(403).json({ error: "Loading the plan is admin only." });

      const read = readPlan(body.plan);
      if (!read.ok) return res.status(400).json({ error: read.error });

      // A plan for a different event is almost certainly the wrong file.
      const foreign = read.posts.filter((p) => !p.id.startsWith(event + "-")).length;
      if (foreign === read.posts.length) {
        return res.status(400).json({
          error: `None of these posts belong to ${event}. Check the file, or change the event in Settings first.`,
        });
      }

      const [posts, decisions, meta] = [
        await listPosts(event), await listDecisions(event), await getSocialMeta(event),
      ];
      const merged = mergePlan(posts, decisions, meta, read, event, sess.username);
      await savePosts(merged.posts);
      await saveDecisions(merged.decisions);
      await saveSocialMeta(event, merged.meta);

      return res.status(200).json({ ok: true, counts: merged.counts, skipped: read.errors, foreign });
    }

    if (req.method === "PATCH") {
      if (!canEdit) return res.status(403).json({ error: "Your account is read-only in ConControl." });
      const body = parseBody(req);
      const kind = q.kind || body.kind || "post";

      if (kind === "condition") {
        const key = String(body.key || "").trim().slice(0, 120);
        if (!key) return res.status(400).json({ error: "Missing condition" });
        const meta = (await getSocialMeta(event)) || { event, conditions: {} };
        const conditions = { ...(meta.conditions || {}) };
        if (body.met === true) conditions[key] = true;
        else delete conditions[key];
        await saveSocialMeta(event, { ...meta, conditions });
        return res.status(200).json({ ok: true, conditions });
      }

      const target = id || body.id;
      if (!target) return res.status(400).json({ error: "Missing id" });

      if (kind === "decision") {
        const before = await getDecision(target);
        if (!before) return res.status(404).json({ error: "Decision not found" });
        const { ok, errors, patch } = validateDecisionPatch(body);
        if (!ok) return res.status(400).json({ error: errors.join("; ") });
        if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });
        if (patch.status === "decided" && before.status !== "decided") {
          patch.decidedAt = new Date().toISOString();
          patch.decidedBy = sess.username;
        }
        if (patch.status === "open") { patch.decidedAt = null; patch.decidedBy = null; }
        const edited = new Set(Array.isArray(before.edited) ? before.edited : []);
        Object.keys(patch).forEach((f) => { if (["status", "answer", "needed_by"].includes(f)) edited.add(f); });
        patch.edited = Array.from(edited);
        const note = patch.status && patch.status !== before.status
          ? historyEntry(patch.status === "decided" ? "decided" : "reopened", sess.username, patch.answer || null)
          : historyEntry("edited", sess.username, null);
        const decision = await updateDecision(target, patch, note);
        return res.status(200).json({ ok: true, decision });
      }

      const before = await getPost(target);
      if (!before) return res.status(404).json({ error: "Post not found" });
      const { ok, errors, patch } = validatePostPatch(body);
      if (!ok) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      if (patch.status === "posted" && before.status !== "posted") {
        patch.postedAt = new Date().toISOString();
        patch.postedBy = sess.username;
      }
      if (patch.status && patch.status !== "posted" && before.status === "posted") {
        patch.postedAt = null;
        patch.postedBy = null;
      }
      patch.edited = markEdited(before, patch);

      const what = patch.status && patch.status !== before.status
        ? `${POST_STATUS_LABELS[before.status] || before.status} to ${POST_STATUS_LABELS[patch.status] || patch.status}`
        : `edited ${Object.keys(patch).filter((f) => f !== "edited").join(", ")}`;
      const post = await updatePost(target, patch, historyEntry(what, sess.username, null));
      return res.status(200).json({ ok: true, post });
    }

    if (req.method === "DELETE") {
      if (!canDelete) return res.status(403).json({ error: "Deleting a post is admin only." });
      if (!id) return res.status(400).json({ error: "Missing post id" });
      const gone = await deletePost(id);
      if (!gone) return res.status(404).json({ error: "Post not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol social route error:", e);
    return res.status(500).json({ error: e.message || "Social request failed" });
  }
}
