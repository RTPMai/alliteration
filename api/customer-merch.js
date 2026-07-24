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
import { KEYS, readKey, isConfigured } from "../lib/backbone-store.js";

/* ------------------------------------------------------------------ *
 * NAME MATCHING
 * ------------------------------------------------------------------ */

// Words that carry no identifying signal. "Ankeny Christian Academy Inc" and
// "Ankeny Christian Academy" are the same org; "Foundation" and "Association"
// appear in hundreds of names.
const NOISE = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "co", "corp", "corporation",
  "company", "the", "and", "of", "a", "an", "foundation", "association",
  "organization", "organisation", "group", "services", "service"
]);

function tokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w));
}

/**
 * 0..1 similarity between two organisation names.
 *
 * Token overlap rather than edit distance: organisations get renamed, extended
 * and abbreviated far more often than they get misspelt, so "Ankeny Christian
 * Academy" vs "Ankeny Christian Academy Eagles" should score high while
 * "Ankeny Parks" vs "Ankeny Christian Academy" should not.
 */
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;

  const setB = new Set(B);
  const shared = A.filter((w) => setB.has(w));
  if (!shared.length) return 0;

  // Dice coefficient: rewards overlap without punishing one name for being
  // longer, which matters because rosters carry fuller legal names than a form.
  const dice = (2 * shared.length) / (A.length + B.length);

  // An exact match on the full normalised string is unambiguous.
  if (A.join(" ") === B.join(" ")) return 1;

  return dice;
}

function confidenceOf(score) {
  if (score >= 0.95) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ *
 * ACCOUNT SHAPE
 * ------------------------------------------------------------------ */

function daysBetween(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

/** Median gap between orders, which the engine uses to spot an overdue account. */
function medianGap(dates) {
  const ds = (dates || [])
    .map((d) => new Date(d).getTime())
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  if (ds.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / 86400000);
  gaps.sort((a, b) => a - b);

  const mid = Math.floor(gaps.length / 2);
  return Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
}

/**
 * Build the account object the scoring engine reads.
 *
 * Field names are the ENGINE's, not the roster's. The engine is a verbatim port
 * and must not be edited to accommodate a different shape, so the translation
 * happens here.
 */
function toAccount(customer, enrichment, score) {
  const enr = enrichment || {};
  const orderDates = customer.order_dates || enr.order_dates || [];

  return {
    found: true,
    matchConfidence: confidenceOf(score),
    matchScore: Number(score.toFixed(3)),

    customerId: customer.customer_id,
    name: customer.company_name || customer.name || "",

    tier: enr.tier || customer.tier || "C",
    lifetimeRevenue: Number(customer.lifetime_revenue || customer.total_revenue || 0),
    ytdRevenue: Number(customer.ytd_revenue || 0),
    priorYtdRevenue: Number(customer.prior_ytd_revenue || 0),
    orderCount: Number(customer.order_count || 0),

    daysSinceLastOrder: daysBetween(customer.last_order_date),
    medianGapDays: medianGap(orderDates),
    isFirstYear: !!customer.is_first_year,
    trendingStrong: Number(customer.ytd_revenue || 0) > Number(customer.prior_ytd_revenue || 0),

    owner: enr.account_manager || customer.account_manager || null
  };
}

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

  const q = (req.query && (req.query.name || req.query.q)) || "";
  if (!String(q).trim()) {
    return res.status(400).json({ error: "A name is required" });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);

  try {
    const data = await readKey(KEYS.data);
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
