// api/intake.js — BackBone's public "Start a Project" form.
//
// THE SOURCE FILE WAS BROKEN. In the standalone repo, api/intake.js and
// intake.html are byte-identical: the API file contains the HTML page. So the
// public form posted to an endpoint that returned a web page, and every
// submission was lost. This is the handler that file was supposed to contain,
// written to the shape the form sends and the Inbox reads.
//
// TWO MODES, deliberately different about auth:
//
//   POST /api/intake              PUBLIC. A prospect filling in the form is not
//                                 signed in and never will be. Can only CREATE.
//   GET  /api/intake              SESSION. Reads the queue for the Inbox.
//   POST /api/intake?mode=update  SESSION. Writes status changes back.
//
// The public half is narrow on purpose: it appends one submission and can
// neither read nor modify anything. The worst a bad actor achieves is junk in
// the Inbox, which a human sees and dismisses.
//
// COLLISION NOTE: ErrorEngine also shipped an api/intake.js. Under the shell
// BackBone keeps this route and ErrorEngine's moves to /api/errors, which is
// why ERRORS_ENDPOINT exists in js/api.js.
//
// SCHEMA NOTE (Aug 2026 fix): this handler used to flatten the post body into
// flat clean(body.company, ...) strings. That never matched what the actual
// intake.html wizard sends (POST body is { submission: { entry, company,
// contact, project, vision, internal } }, each a nested object) or what the
// Inbox in apps/backbone/main.js reads (s.company.name, s.contact.email,
// s.project.details, etc). Every real submission was silently rejected with
// "A company or a contact is required" before this fix. Now the handler
// stores the submission object as-is (sanitized/size-capped), matching the
// intake_v1 shape the form and Inbox already agree on.

import { getSession } from "../lib/session.js";
import { KEYS, readKey, kvSet, isConfigured } from "../lib/backbone-store.js";

const MAX_SUBMISSIONS = 2000;
const MAX_STRING = 4000;
const MAX_ARRAY = 25;
const MAX_DEPTH = 6;

// Recursively trims strings, caps string/array size, and drops anything past
// MAX_DEPTH, so a hostile POST can't blow up KV value size or nest forever.
// The public path is unauthenticated by design, so this is the only guard.
function sanitize(val, depth) {
  depth = depth || 0;
  if (val == null) return val;
  if (depth > MAX_DEPTH) return null;
  if (typeof val === "string") return val.trim().slice(0, MAX_STRING);
  if (typeof val === "boolean" || typeof val === "number") return val;
  if (Array.isArray(val)) {
    return val.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
  }
  if (typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val).slice(0, 40)) {
      out[k] = sanitize(val[k], depth + 1);
    }
    return out;
  }
  return null;
}

function clean(v) {
  return v == null ? "" : String(v).trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch (e) { body = Object.fromEntries(new URLSearchParams(body)); }
  }
  if (!body || typeof body !== "object") body = {};

  const mode = (req.query && req.query.mode) || body.mode || "";

  try {
    // ---- read the queue (Inbox) ----
    if (req.method === "GET") {
      const sess = getSession(req);
      if (!sess) return res.status(401).json({ error: "Not authenticated" });

      const data = await readKey(KEYS.intake);
      const submissions = (data && Array.isArray(data.submissions)) ? data.submissions : [];
      return res.status(200).json({ submissions });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- write status changes back (Inbox) ----
    if (mode === "update") {
      const sess = getSession(req);
      if (!sess) return res.status(401).json({ error: "Not authenticated" });

      if (!Array.isArray(body.submissions)) {
        return res.status(400).json({ error: "Expected { submissions: [...] }" });
      }
      await kvSet(KEYS.intake, {
        submissions: body.submissions,
        savedAt: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, count: body.submissions.length });
    }

    // ---- a new submission from the public form ----
    // No session required, and none possible. This path can only append.
    // intake.html posts { submission: { entry, company, contact, project,
    // vision, internal } } — the same nested shape the Inbox reads back.
    const submission = (body.submission && typeof body.submission === "object")
      ? body.submission
      : body; // tolerate a bare object too, in case a future caller skips the wrapper

    const company = sanitize(submission.company, 0) || {};
    const contact = sanitize(submission.contact, 0) || {};

    if (!clean(company.name) && !clean(contact.name) && !clean(contact.email) && !clean(contact.phone)) {
      return res.status(400).json({ error: "A company or a contact is required" });
    }

    const entry = {
      id: "SUB-" + Date.now().toString(36).toUpperCase(),
      submitted_at: new Date().toISOString(),
      status: "new",
      entry: sanitize(submission.entry, 0) || {},
      company: company,
      contact: contact,
      project: sanitize(submission.project, 0) || {},
      vision: sanitize(submission.vision, 0) || null,
      internal: !!submission.internal,
      links: {}, // filled in later by attach-to-client / convert-to-lead
    };

    const data = await readKey(KEYS.intake);
    const submissions = (data && Array.isArray(data.submissions)) ? data.submissions : [];

    submissions.unshift(entry);
    // Cap the stored list. Unbounded growth eventually exceeds the value size
    // limit and the whole queue fails to save, losing everything rather than
    // the oldest entry.
    if (submissions.length > MAX_SUBMISSIONS) submissions.length = MAX_SUBMISSIONS;

    await kvSet(KEYS.intake, { submissions, savedAt: new Date().toISOString() });

    return res.status(201).json({ ok: true, id: entry.id });
  } catch (e) {
    console.error("intake error:", e);
    return res.status(500).json({ error: e.message });
  }
}
