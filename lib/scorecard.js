// lib/scorecard.js — the customer tier, computable on the server.
//
// WHY THIS EXISTS. BackBone's Scorecard computes a customer's tier (Platinum,
// Gold, Silver, Bronze, Valuable Dirt) from a weighted composite. That math
// lived only inside apps/backbone/main.js, which runs in the browser, so
// nothing server-side could ask "what tier is this customer?".
//
// GivingGauge needs exactly that. Its engine pays 24 of 28 relationship points
// for a Gold customer and 6 for a customer with no tier, so an account that
// reads Gold on BackBone's roster and blank in GivingGauge scores 18 points
// lower for no reason a human could see. Ankeny Christian Academy is the case
// that surfaced it: Gold on the roster, "no tier assigned" on the request.
//
// THIS IS A PORT, NOT A REWRITE. The weights, bands and tier cut-offs are
// copied from main.js exactly. test/backbone.test.cjs asserts that both copies
// still agree, so a change to one that is not mirrored turns the suite red
// rather than quietly scoring two different answers in two screens.

/* ---- star bands (verbatim from main.js) ---------------------------------- */

export function starForRevenue(v, ytd) {
  if (ytd) return v >= 40000 ? 5 : v >= 25000 ? 4 : v >= 10000 ? 3 : v >= 2500 ? 2 : 1;
  return v >= 80000 ? 5 : v >= 50000 ? 4 : v >= 20000 ? 3 : v >= 5000 ? 2 : 1;
}

export function starForInvoices(v, ytd) {
  if (ytd) return v >= 50 ? 5 : v >= 25 ? 4 : v >= 10 ? 3 : v >= 3 ? 2 : 1;
  return v >= 100 ? 5 : v >= 50 ? 4 : v >= 20 ? 3 : v >= 6 ? 2 : 1;
}

export function starForAvgInvoice(v) {
  return v >= 1500 ? 5 : v >= 1000 ? 4 : v >= 500 ? 3 : v >= 100 ? 2 : 1;
}

export function parseEmployeeCount(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const nums = String(v).replace(/,/g, "").match(/\d+/g);
  if (!nums) return NaN;
  const n = parseInt(nums[0], 10);
  return isNaN(n) ? NaN : n;
}

export function starForEmployees(v) {
  const n = parseEmployeeCount(v);
  if (isNaN(n)) return null;
  return n >= 501 ? 5 : n >= 201 ? 4 : n >= 51 ? 3 : n >= 11 ? 2 : 1;
}

// A gap of 0 means several invoices landed the same day for a customer with
// very few orders. That is a data artifact, not high-frequency ordering, so it
// is treated as unavailable rather than scored 5 stars.
export function starForFrequency(medianGapDays) {
  if (medianGapDays === null || medianGapDays === undefined ||
      isNaN(medianGapDays) || medianGapDays <= 0) return null;
  const ordersPerMonth = 30 / medianGapDays;
  return ordersPerMonth >= 10 ? 5 : ordersPerMonth >= 5 ? 4
       : ordersPerMonth >= 3 ? 3 : ordersPerMonth >= 1 ? 2 : 1;
}

export function starForDistanceMiles(miles) {
  if (miles === null || miles === undefined || isNaN(miles)) return null;
  return miles <= 15 ? 5 : miles <= 40 ? 4 : miles <= 100 ? 3 : miles <= 300 ? 2 : 1;
}

/* ---- weights and tier bands (verbatim from main.js) ---------------------- */

export const SCORECARD_WEIGHTS = {
  revenue: 0.18,
  invoices: 0.16,
  avg_invoice: 0.10,
  frequency: 0.10,
  growth: 0.08,
  employees: 0.10,
  communication: 0.06,
  csr: 0.06,
  specialty_billing: 0.06,
  contact_role: 0.06,
  distance: 0.04
};

export const TIER_BANDS = [
  { min: 4.5, tier: "Platinum" },
  { min: 3.5, tier: "Gold" },
  { min: 2.5, tier: "Silver" },
  { min: 1.5, tier: "Bronze" }
];

export function tierForTotal(total) {
  for (const b of TIER_BANDS) if (total >= b.min) return b.tier;
  return "Valuable Dirt";
}

/* ---- the composite ------------------------------------------------------- */

/**
 * Weighted tier for one customer.
 *
 * `basis` is "ytd" for the current calendar year, anything else for lifetime.
 * Only criteria with data participate: the weights of the available ones are
 * renormalised, so a customer with 4 of 11 filled in is not punished for the
 * seven nobody has entered yet.
 */
export function computeTier(customer, enrichment, basis) {
  const c = customer || {};
  const enr = enrichment || {};
  const ytd = basis === "ytd";

  const curYear = String(new Date().getFullYear());
  let revenue = Number(c.total_revenue || 0);
  let invoices = Number(c.invoice_count || 0);
  if (ytd) {
    revenue = (c.revenue_by_year && c.revenue_by_year[curYear] !== undefined)
      ? c.revenue_by_year[curYear] : 0;
    invoices = (c.invoices_by_year && c.invoices_by_year[curYear] !== undefined)
      ? c.invoices_by_year[curYear] : 0;
  }
  const avgInvoice = invoices > 0 ? revenue / invoices : 0;

  const empVal = parseEmployeeCount(enr.employees);
  const growthVal = parseInt(enr.growth_potential, 10);
  const commVal = parseInt(enr.client_communication, 10);
  const csrVal = parseInt(enr.csr_needs, 10);
  const cadenceFreqScore = starForFrequency(c.median_gap_days);
  const freqVal = parseInt(enr.order_frequency_monthly, 10);
  const billingVal = parseInt(enr.specialty_billing, 10);
  const contactVal = parseInt(enr.contact_role, 10);

  const manualDistVal = parseInt(enr.distance_from_shop, 10);
  const autoMiles = (enr.distance_miles !== undefined && enr.distance_miles !== null &&
    enr.distance_miles !== "") ? parseFloat(enr.distance_miles) : NaN;
  const autoDistScore = starForDistanceMiles(isNaN(autoMiles) ? null : autoMiles);
  const distanceScore = !isNaN(manualDistVal) ? manualDistVal : autoDistScore;

  const criteria = {
    revenue:     { score: starForRevenue(revenue, ytd), available: true },
    invoices:    { score: starForInvoices(invoices, ytd), available: true },
    avg_invoice: { score: starForAvgInvoice(avgInvoice), available: true },
    employees:   { score: isNaN(empVal) ? null : starForEmployees(empVal), available: !isNaN(empVal) },
    growth:      { score: isNaN(growthVal) ? null : growthVal, available: !isNaN(growthVal) },
    communication: { score: isNaN(commVal) ? null : commVal, available: !isNaN(commVal) },
    csr:         { score: isNaN(csrVal) ? null : csrVal, available: !isNaN(csrVal) },
    frequency:   {
      score: cadenceFreqScore !== null ? cadenceFreqScore : (isNaN(freqVal) ? null : freqVal),
      available: cadenceFreqScore !== null || !isNaN(freqVal)
    },
    // Entered 1 (standard) .. 5 (very hard). Hard billing is operational strain,
    // so the composite uses the inverted value.
    specialty_billing: { score: isNaN(billingVal) ? null : (6 - billingVal), available: !isNaN(billingVal) },
    contact_role: { score: isNaN(contactVal) ? null : contactVal, available: !isNaN(contactVal) },
    distance:    {
      score: distanceScore !== null && distanceScore !== undefined ? distanceScore : null,
      available: distanceScore !== null && distanceScore !== undefined
    }
  };

  let weightedSum = 0, weightTotal = 0, availableCount = 0;
  Object.keys(criteria).forEach((k) => {
    const crit = criteria[k];
    const w = SCORECARD_WEIGHTS[k];
    if (crit.available) {
      weightedSum += w * crit.score;
      weightTotal += w;
      availableCount++;
    }
  });

  const total = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    total,
    tier: tierForTotal(total),
    completeness: availableCount + "/11",
    period_revenue: revenue,
    period_invoices: invoices,
    period_avg_invoice: avgInvoice
  };
}
