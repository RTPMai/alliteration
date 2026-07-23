// api/giving-intake.js — the Jotform webhook.
//
// Jotform POSTs here the moment someone submits the donation form. Point the
// form's webhook at:
//     https://<your-domain>/api/giving-intake
//
// NO SESSION REQUIRED. Jotform is not signed in and never will be, so this
// endpoint is necessarily public. That is the same shape as BackBone's and
// ErrorEngine's intake routes.
//
// Because it is public, it is deliberately narrow:
//   - it only ever CREATES a pending request; it cannot read, edit or delete
//   - it stores the submission and nothing else
//   - an optional shared secret can be required via ?token=
//
// The worst a bad actor can do is add junk to the review queue, which a human
// sees and declines. That is an acceptable blast radius for a form endpoint.

import { buildRequest, saveRequest, alreadyHave } from "../lib/giving.js";
import { isConfigured } from "../lib/kv.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  // Optional shared secret. Set JOTFORM_WEBHOOK_TOKEN and append
  // ?token=... to the webhook URL in Jotform to reject anything else.
  const expected = process.env.JOTFORM_WEBHOOK_TOKEN;
  if (expected) {
    const got = (req.query && req.query.token) || "";
    if (got !== expected) return res.status(401).json({ error: "Bad token" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch (e) {
        // Jotform can post form-encoded rather than JSON.
        body = Object.fromEntries(new URLSearchParams(body));
      }
    }
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Empty submission" });
    }

    const jotformId = body.submissionID || body.submission_id || null;

    // Jotform retries on a non-2xx, so the same submission can arrive twice.
    // Without this check a retry would create a duplicate queue entry.
    if (await alreadyHave(jotformId)) {
      return res.status(200).json({ ok: true, duplicate: true, jotformId });
    }

    const row = buildRequest(body, {
      jotformId,
      source: "jotform-webhook",
      submittedAt: new Date().toISOString()
    });

    await saveRequest(row);

    return res.status(201).json({
      ok: true,
      id: row.id,
      org: row.request.orgName,
      needsReview: row.needsReview.length
    });
  } catch (e) {
    console.error("giving-intake error:", e);
    // 200 on failure would make Jotform believe it was delivered and never
    // retry, so a transient storage blip would silently lose a submission.
    return res.status(500).json({ error: e.message });
  }
}
