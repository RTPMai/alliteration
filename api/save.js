// api/save.js — write the roster.
//
// PARTIAL WRITES ARE THE POINT. The caller sends `synced`, or `enrichment`, or
// both, and only what it sends is touched. That is what keeps a Printavo sync
// refresh from clobbering manually entered enrichment (account manager, notes,
// scoring) and vice versa. A whole-object overwrite here would silently destroy
// hand-entered data on every sync.
//
// lib/session.js, not lib/auth.js — that file was renamed in BackBone after
// having both api/auth.js and lib/auth.js got them confused and the library was
// overwritten. ESM `import`, not `require`: mixing module systems is what made
// requireAuth undefined and 500'd every call.

import { requireAuth } from "../lib/session.js";
import { KEYS, readKey, kvSet, isConfigured } from "../lib/backbone-store.js";

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

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    const existing = (await readKey(KEYS.data)) ||
      { synced: [], enrichment: {}, lastSynced: null };

    // Only touch what was actually sent.
    const next = {
      synced: body.synced !== undefined ? body.synced : existing.synced,
      enrichment: body.enrichment !== undefined ? body.enrichment : existing.enrichment,
      // lastSynced tracks the ROSTER, so it only moves when synced does.
      lastSynced: body.synced !== undefined ? new Date().toISOString() : existing.lastSynced,
    };

    await kvSet(KEYS.data, next);
    return res.status(200).json({ ok: true, ...next });
  } catch (e) {
    console.error("save error:", e);
    return res.status(500).json({ error: e.message });
  }
}
