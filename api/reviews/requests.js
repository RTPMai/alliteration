// PUT IN: api/reviews/requests.js
// api/reviews/requests.js: the list, and the buttons on it.
//
//   GET                      recent requests (newest first) plus counts
//   GET ?kind=reviewed       customers marked as having left a review
//   POST { action, ... }
//     cancel    { id }                 queued or failed -> cancelled
//     restore   { id }                 cancelled/skipped/failed -> queued
//     send      { id, force }          send now; 409 asks before overriding a skip rule
//     reviewed  { email, invoiceId }   mark a customer as having reviewed
//     unreviewed{ email }              take them back off
//
// Admin only, checked here on every request. Hiding the app from the rail is
// not access control.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { canUseReviews, DENIED } from "../../lib/reviews/access.js";
import { realDeps } from "../../lib/reviews/deps.js";
import { countByStatus } from "../../lib/reviews/schema.js";
import { sendNow, cancel, restore, markReviewed, unmarkReviewed } from "../../lib/reviews/engine.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const perms = await permsFor(sess.username);
    if (!canUseReviews(perms)) return res.status(403).json({ error: DENIED });

    const deps = realDeps();
    const store = deps.store;
    const by = sess.name || sess.username;

    if (req.method === "GET") {
      if (req.query && req.query.kind === "reviewed") {
        const map = await store.getReviewed();
        const reviewed = Object.keys(map).map((email) => Object.assign({ email }, map[email] || {}))
          .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
        return res.status(200).json({ reviewed });
      }
      const limit = Math.min(1000, Math.max(1, parseInt((req.query && req.query.limit) || "500", 10) || 500));
      const ids = await store.recentIds(limit);
      const records = await store.getRecords(ids);
      const [reviewed, settings, state] = await Promise.all([store.getReviewed(), store.getSettings(), store.getState()]);
      records.forEach((r) => { r.customer_reviewed = !!(r.email && reviewed[r.email]); });
      return res.status(200).json({
        records,
        counts: countByStatus(records),
        enabled: !!settings.enabled,
        seeded: !!state.seededAt,
        lastCheck: state.lastCheck || null,
        lastSend: state.lastSend || null,
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req);
    const now = Date.now();
    const id = body.id != null ? String(body.id) : "";

    switch (body.action) {
      case "cancel": {
        const r = await cancel(deps, id, { now, by });
        return res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.reason, record: r.record || null });
      }
      case "restore": {
        const r = await restore(deps, id, { now, by });
        return res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: r.reason, record: r.record || null });
      }
      case "send": {
        const settings = await store.getSettings();
        const r = await sendNow(deps, id, { settings, now, force: body.force === true, by });
        if (r.outcome === "sent") return res.status(200).json({ ok: true, record: r.record });
        if (r.outcome === "needs_confirm") {
          return res.status(409).json({ error: r.reason, needsConfirm: true, reason: r.reason, record: r.record });
        }
        const code = r.outcome === "retry" || r.outcome === "failed" ? 502 : 409;
        return res.status(code).json({ error: r.reason || "Not sent", outcome: r.outcome, record: r.record || null });
      }
      case "reviewed": {
        const r = await markReviewed(deps, body.email, { now, by, invoiceId: body.invoiceId || null });
        return res.status(r.ok ? 200 : 400).json(r.ok ? r : { error: r.reason });
      }
      case "unreviewed": {
        const r = await unmarkReviewed(deps, body.email);
        return res.status(r.ok ? 200 : 400).json(r.ok ? r : { error: r.reason });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || String(e) });
  }
}
