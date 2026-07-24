// api/leads-save.js — write the leads list.
//
// THE WRITE IS CHECKED. An earlier version never inspected the storage
// response: a failed write returned { ok: true } and the browser believed the
// leads were saved when they were not. Silent data loss is the worst failure
// mode here, because nobody re-enters what they think is already stored.

import { requireAuth } from "../lib/session.js";
import { KEYS, kvSet, isConfigured } from "../lib/backbone-store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { leads } = body;
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: "Expected { leads: [...] }" });
  }

  try {
    // kvSet throws on a non-2xx, so a failed write cannot be reported as success.
    await kvSet(KEYS.leads, { leads, savedAt: new Date().toISOString() });
    return res.status(200).json({ ok: true, count: leads.length });
  } catch (e) {
    console.error("leads-save error:", e);
    return res.status(500).json({ error: e.message });
  }
}
