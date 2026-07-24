// api/data.js — the roster, filtered to what the caller is allowed to see.
//
// PORTED FROM THE SECURED VERSION. BackBone shipped two copies of this handler:
// api/data.js, which had NO authentication and sent
// `Access-Control-Allow-Origin: *`, and lib/data.js, which fixed both and was
// never wired up. The insecure one was live: the entire client roster — company
// names, revenue, invoice counts, contacts, scores — was readable by anyone who
// knew the URL, from any origin, without signing in.
//
// This is the fixed one:
//   1. requireAuth() — no session, no data.
//   2. Same-origin only; the wildcard CORS header is gone.
//
// Filtering happens SERVER-SIDE, before the response is built. An AM scoped to
// their own accounts never receives the others. Hiding rows in the browser
// would leave the full payload sitting in DevTools.

import { requireAuth } from "../lib/session.js";
import { getUser, getRole } from "../lib/users.js";
import { KEYS, readKey, isConfigured } from "../lib/backbone-store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // GUARD. Everything below this line requires a valid session.
  const sess = requireAuth(req, res);
  if (!sess) return; // 401 already sent

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  try {
    // ?ops=1 returns the Printavo operational slice written by
    // printavo-sync?mode=ops. A separate key so the roster payload stays lean.
    if (req.query.ops === "1" || req.query.ops === "true") {
      const ops = await readKey(KEYS.ops);
      if (!ops) return res.status(200).json({ available: false });
      return res.status(200).json(Object.assign({ available: true }, ops));
    }

    const data = await readKey(KEYS.data);
    if (!data) {
      // Nothing saved yet. An empty shape rather than an error, so a fresh
      // deploy shows an empty roster instead of a broken page.
      return res.status(200).json({ synced: [], enrichment: {}, lastSynced: null });
    }

    let synced = data.synced || [];
    const enrichment = data.enrichment || {};

    // ---- Permission filtering ---------------------------------------------
    const user = sess.username ? await getUser(sess.username) : null;
    const role = await getRole(user ? user.role : sess.role);
    const scope = (role && role.data_scope) || "all";

    if (scope === "own") {
      // Which AM is this? The explicit link on the user record wins; fall back
      // to the display name so a user created without one still works.
      const amName = (user && (user.am_name || user.name)) || "";

      if (!amName) {
        // Scoped to "own" but we cannot tell who they are — fail CLOSED.
        // Returning everything here would silently defeat the restriction.
        return res.status(200).json({
          synced: [], enrichment: {}, lastSynced: data.lastSynced || null,
          scoped: true,
          scope_error: "No account manager linked to this user — ask an admin to set one.",
        });
      }

      const mine = String(amName).trim().toLowerCase();
      synced = synced.filter((c) => {
        const enr = enrichment[c.customer_id] || {};
        return String(enr.account_manager || "").trim().toLowerCase() === mine;
      });

      // Enrichment is keyed by customer_id. Strip the entries whose rows we
      // just removed, or the payload would still carry every client's scoring.
      const keep = new Set(synced.map((c) => String(c.customer_id)));
      const scopedEnrichment = {};
      Object.keys(enrichment).forEach((k) => {
        if (keep.has(String(k))) scopedEnrichment[k] = enrichment[k];
      });

      return res.status(200).json({
        synced,
        enrichment: scopedEnrichment,
        lastSynced: data.lastSynced || null,
        scoped: true,
      });
    }

    return res.status(200).json({
      synced,
      enrichment,
      lastSynced: data.lastSynced || null,
      scoped: false,
    });
  } catch (e) {
    console.error("data error:", e);
    return res.status(500).json({ error: e.message });
  }
}
