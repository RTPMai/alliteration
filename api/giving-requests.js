// api/giving-requests.js — read and update donation requests.
//
//   GET    /api/giving-requests            list (what the app loads)
//   GET    /api/giving-requests?id=REQ-1   one request
//   PATCH  /api/giving-requests?id=REQ-1   record a decision or a classification
//   POST   /api/giving-requests?action=backfill
//                                          pull existing Jotform submissions
//
// Everything here requires a signed-in session. The public webhook lives in
// api/giving-intake.js and can only create.

import { requireAuth } from "../lib/session.js";
import { listRequests, getRequest, updateRequest, buildRequest, saveRequest, alreadyHave } from "../lib/giving.js";
import { isConfigured } from "../lib/kv.js";

const JOTFORM_API = "https://api.jotform.com";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const id = (req.query && req.query.id) || body.id || null;
  const action = (req.query && req.query.action) || body.action || "";

  try {
    if (req.method === "GET") {
      if (id) {
        const row = await getRequest(id);
        if (!row) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(row);
      }
      const requests = await listRequests();
      return res.status(200).json({ requests });
    }

    if (req.method === "POST" && action === "backfill") {
      // Writing a batch of records is an admin action.
      if (sess.role !== "admin" && sess.role !== "manager") {
        return res.status(403).json({ error: "Backfill requires admin or manager" });
      }
      return await backfill(req, res, body);
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      if (!id) return res.status(400).json({ error: "id is required" });

      const patch = {};
      if (body.status)   patch.status = body.status;
      if (body.note !== undefined) patch.note = body.note;
      if (body.request)  patch.request = body.request;   // human classification
      if (body.account)  patch.account = body.account;
      if (body.override !== undefined) patch.override = body.override;

      // Stamp WHO decided from the session, never from the payload — otherwise
      // the audit trail is whatever the client claimed.
      if (body.status) patch.decidedBy = sess.name || sess.username;

      const row = await updateRequest(id, patch);
      return res.status(200).json({ ok: true, request: row });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("giving-requests error:", e);
    const isClient = /not found|required/i.test(e.message);
    return res.status(isClient ? 400 : 500).json({ error: e.message });
  }
}

/* ------------------------------------------------------------------ *
 * BACKFILL
 *
 * One-time pull of submissions already sitting in Jotform. Safe to run more
 * than once: anything already stored is skipped by submission id.
 * ------------------------------------------------------------------ */

async function backfill(req, res, body) {
  const apiKey = process.env.JOTFORM_API_KEY;
  const formId = process.env.JOTFORM_FORM_ID;

  if (!apiKey || !formId) {
    return res.status(503).json({
      error: "Backfill needs JOTFORM_API_KEY and JOTFORM_FORM_ID in the environment."
    });
  }

  // Default to the start of this calendar year. Older submissions are for
  // events that already happened; they would all disqualify on lead time and
  // bury the live queue.
  const since = body.since || new Date().getFullYear() + "-01-01";

  const url = JOTFORM_API + "/form/" + encodeURIComponent(formId) +
              "/submissions?apiKey=" + encodeURIComponent(apiKey) +
              "&limit=1000&orderby=created_at";

  let payload;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    try { payload = JSON.parse(text); }
    catch (e) { throw new Error("Jotform returned a non-JSON response (HTTP " + r.status + ")"); }
    if (!r.ok) {
      throw new Error("Jotform API error " + r.status + ": " + (payload.message || text.slice(0, 120)));
    }
  } catch (e) {
    return res.status(502).json({ error: "Could not reach Jotform: " + e.message });
  }

  const subs = Array.isArray(payload.content) ? payload.content : [];

  const result = { found: subs.length, imported: 0, skipped: 0, tooOld: 0, failed: 0, errors: [] };

  for (const sub of subs) {
    try {
      const created = String(sub.created_at || "").slice(0, 10);
      if (created && created < since) { result.tooOld++; continue; }

      if (await alreadyHave(sub.id)) { result.skipped++; continue; }

      const row = buildRequest(sub, {
        jotformId: sub.id,
        source: "jotform-backfill",
        submittedAt: sub.created_at
          ? new Date(sub.created_at).toISOString()
          : new Date().toISOString()
      });

      await saveRequest(row);
      result.imported++;
    } catch (e) {
      result.failed++;
      // Keep going. One malformed submission should not abort the whole import.
      if (result.errors.length < 5) result.errors.push({ id: sub.id, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, since, ...result });
}
