// api/customer-match.js — find a customer in BackBone's roster.
//
// WHY THIS EXISTS. GivingGauge scores a donation request out of 100, and 46 of
// those points come from the requesting organisation's relationship and spend.
// Until a request is matched to a real account, those 46 score zero, so every
// arriving request looks like an F regardless of merit. A real customer's
// request is indistinguishable from a stranger's.
//
// The roster lives in BackBone. This endpoint is the bridge: given a name, it
// returns candidates and the account shape the scoring engine expects.
//
// IT SUGGESTS, IT DOES NOT DECIDE. Name matching is fuzzy and the cost of a
// wrong match is a wrong score on a real decision, so every candidate carries a
// confidence and the final match is a human's to confirm.

import { requireAuth } from "../lib/session.js";
import { readRoster, isConfigured } from "../lib/backbone-store.js";
// The matching logic lives in lib/ so the intake path can match automatically
// too. This endpoint stays the human-facing "suggest candidates" surface.
import { similarity, confidenceOf, toAccount } from "../lib/customer-match.js";

/* ------------------------------------------------------------------ *
 * HANDLER
 * ------------------------------------------------------------------ */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // The roster is client revenue data. Same guard as api/data.js.
  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  // Refresh mode: ?ids=C-1042,C-3310 returns a fresh account object per id.
  // GivingGauge calls this on queue load so a match made months ago carries
  // TODAY's revenue and recency figures, not the ones frozen at match time.
  // (Stale matched numbers quietly skewed scores once; this is the fix.)
  const ids = (req.query && req.query.ids) || "";
  if (String(ids).trim()) {
    try {
      const data = await readRoster();
      if (!data || !Array.isArray(data.synced)) {
        return res.status(200).json({ accounts: {} });
      }
      const enrichment = data.enrichment || {};
      const wanted = new Set(String(ids).split(",").map((s) => s.trim()).filter(Boolean));
      const accounts = {};
      data.synced.forEach((c) => {
        const cid = String(c.customer_id);
        if (!wanted.has(cid)) return;
        // Score 1: this is a confirmed id lookup, not a fuzzy name guess.
        accounts[cid] = toAccount(c, enrichment[c.customer_id], 1);
      });
      return res.status(200).json({ accounts });
    } catch (e) {
      console.error("customer-match refresh error:", e);
      return res.status(500).json({ error: "Refresh failed" });
    }
  }

  const q = (req.query && (req.query.name || req.query.q)) || "";
  if (!String(q).trim()) {
    return res.status(400).json({ error: "A name is required" });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);

  try {
    // Folded, so a donation is scored against the whole client rather than
    // whichever of their two records happened to match the name.
    const data = await readRoster();
    if (!data || !Array.isArray(data.synced)) {
      return res.status(200).json({ query: q, candidates: [] });
    }

    const enrichment = data.enrichment || {};

    const scored = data.synced
      .map((c) => ({ c, score: similarity(q, c.company_name || c.name) }))
      // Below this, the shared tokens are usually a city or a generic word and
      // the suggestion is noise rather than a lead.
      .filter((row) => row.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const candidates = scored.map((row) =>
      toAccount(row.c, enrichment[row.c.customer_id], row.score));

    return res.status(200).json({
      query: q,
      candidates,
      // A single high-confidence hit is safe to preselect; anything else is a
      // suggestion the reviewer confirms.
      autoMatch: (candidates.length === 1 && candidates[0].matchConfidence === "high")
        ? candidates[0]
        : null
    });
  } catch (e) {
    console.error("customer-match error:", e);
    return res.status(500).json({ error: e.message });
  }
}
