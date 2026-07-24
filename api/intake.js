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

import { getSession } from "../lib/session.js";
import { KEYS, readKey, kvSet, isConfigured } from "../lib/backbone-store.js";

const MAX_SUBMISSIONS = 2000;

function clean(v, max) {
  if (v == null) return "";
  return String(v).trim().slice(0, max || 2000);
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
    const entry = {
      id: "SUB-" + Date.now().toString(36).toUpperCase(),
      submitted_at: new Date().toISOString(),
      status: "new",
      company: clean(body.company, 200),
      contact: clean(body.contact, 200),
      project: clean(body.project, 400),
      vision: clean(body.vision, 4000),
      links: clean(body.links, 1000),
      entry: clean(body.entry, 200),
      // Anything else the form sends is kept verbatim so a field added to the
      // form is not silently dropped before anyone notices it is missing.
      extra: body,
    };

    if (!entry.company && !entry.contact) {
      return res.status(400).json({ error: "A company or a contact is required" });
    }

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
