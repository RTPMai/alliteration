// lib/customer-match.js — roster matching, shared.
//
// Extracted from api/customer-match.js so the SERVER can match too. The
// endpoint suggests candidates to a human; the intake path needs the same
// logic to attach a confident match automatically the moment a request
// arrives, instead of leaving every organisation as "Not a customer" until
// somebody clicks Find on each one.
//
// The rule is unchanged: only an UNAMBIGUOUS match is applied without a
// human. Anything less stays a suggestion.

import { computeTier } from "./scorecard.js";

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

  // FIELD NAMES ARE THE ROSTER'S, NOT THE ENGINE'S.
  //
  // The sync writes invoice_count, total_revenue, last_invoice_date,
  // median_gap_days and revenue_by_year. This function used to read
  // order_count, last_order_date and order_dates, which do not exist on a
  // roster record, so a real customer arrived with zero orders and no cadence.
  // The engine then scored order health 0 of 9 and read the account as barely
  // known, while BackBone's roster showed the same customer as Gold with a
  // six-figure history. Keep the fallbacks: older records may carry either.
  const curYear = String(new Date().getFullYear());
  const byYear = customer.revenue_by_year || {};
  const ytdRevenue = Number(byYear[curYear] || customer.ytd_revenue || 0);
  const priorYtdRevenue = Number(byYear[String(Number(curYear) - 1)] ||
    customer.prior_ytd_revenue || 0);

  const orderDates = customer.order_dates || enr.order_dates || [];
  const medianGapDays = customer.median_gap_days != null
    ? Number(customer.median_gap_days)
    : medianGap(orderDates);

  // The tier is a weighted composite, computed rather than stored. Without
  // this the engine sees no tier and pays 6 of 28 relationship points instead
  // of the 24 a Gold customer earns.
  const scorecard = computeTier(customer, enr, "all");

  return {
    found: true,
    matchConfidence: confidenceOf(score),
    matchScore: Number(score.toFixed(3)),

    customerId: customer.customer_id,
    name: customer.company_name || customer.name || "",

    tier: enr.tier || customer.tier || scorecard.tier,
    tierBasis: enr.tier || customer.tier ? "stored" : "computed",
    tierScore: Number(scorecard.total.toFixed(2)),
    tierCompleteness: scorecard.completeness,

    lifetimeRevenue: Number(customer.total_revenue || customer.lifetime_revenue || 0),
    ytdRevenue: ytdRevenue,
    priorYtdRevenue: priorYtdRevenue,
    orderCount: Number(customer.invoice_count || customer.order_count || 0),

    daysSinceLastOrder: daysBetween(customer.last_invoice_date || customer.last_order_date),
    medianGapDays: medianGapDays,
    isFirstYear: !!customer.is_first_year,
    trendingStrong: ytdRevenue > priorYtdRevenue,

    owner: enr.account_manager || customer.account_manager || null
  };
}


/**
 * Best match for a name, or null.
 *
 * Auto-apply only when there is exactly one strong candidate and it is
 * clearly ahead of the runner-up. Two similar names (a school and its
 * booster club) must never silently pick one.
 */
export function autoMatchFor(name, synced, enrichment) {
  const scored = (synced || [])
    .map((c) => ({ c, score: similarity(name, c.company_name || c.name) }))
    .filter((r) => r.score >= 0.3)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const best = scored[0];
  const runnerUp = scored[1];

  if (best.score < 0.6) return null;
  if (runnerUp && best.score - runnerUp.score < 0.15) return null;

  return toAccount(best.c, (enrichment || {})[best.c.customer_id], best.score);
}

export { similarity, confidenceOf, toAccount };
