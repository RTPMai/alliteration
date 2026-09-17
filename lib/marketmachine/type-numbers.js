// PUT IN: lib/marketmachine/type-numbers.js
//
// lib/marketmachine/type-numbers.js — each campaign's own numbers.
//
// PHASE 4 (Sept 2026), from the campaign master documents. Phase 3 built the
// five shared calculations every campaign gets. Each master ALSO defines
// formulas of its own, a scorecard of metrics to fill in at the review dates,
// and in one case a rule that warns rather than blocks.
//
// Every formula here is copied from its master, wording and all. Where a
// master does not define one, this file has nothing for that campaign rather
// than a formula somebody invented: Postal, Christmas Gifting and Live Screen
// Printing masters have not arrived, so those three carry the shared five and
// no more.
//
// THE RULE EVERY FORMULA FOLLOWS, in the masters' own words: "If a required
// value is missing or the denominator is zero, show Not available or Not
// applicable with a reason, never an invalid number."
//
// Pure data plus small functions. No storage, no network.
//
// ESM. Do NOT convert to module.exports.

/**
 * Two calendar months before a date. The last day of a short month is kept
 * inside that month: two months before May 31 is March 31, not March 2 by way
 * of a 31st that April does not have.
 */
export function monthsBefore(iso, months) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const target = (y * 12 + (m - 1)) - months;
  const ty = Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}


/** A division that refuses to produce a number out of nothing. */
function rate(top, bottom, zeroWhat) {
  if (top === null || bottom === null) return { value: null };
  if (bottom === 0) return { value: null, status: `${zeroWhat} is zero, so this cannot be calculated` };
  return { value: Math.round((top / bottom) * 1000) / 10 };
}

function money(v) {
  return v === null ? null : Math.round(v * 100) / 100;
}

/**
 * Per-campaign numbers, keyed by campaign type.
 *
 *   inputs     typed by a person, on top of the shared ones
 *   calcs      formula text shown to the team, plus how to work it out
 *   scorecard  the metric rows the master asks for at the review dates
 *   advisories warnings; they never stop the work (Ryan, Sept 2026)
 */
export const TYPE_NUMBERS = {
  parade: {
    inputs: [
      { key: "par_planned", label: "Planned giveaway shirts", kind: "count" },
      { key: "par_stock", label: "Usable stock on hand", kind: "count" },
      { key: "par_starting", label: "Starting quantity", kind: "count" },
      { key: "par_remaining", label: "Remaining quantity", kind: "count" },
      { key: "par_damaged", label: "Damaged or otherwise accounted for", kind: "count" },
      { key: "par_costs", label: "Recorded campaign costs", kind: "money" },
      { key: "par_support", label: "Approved support actually applied", kind: "money" },
      { key: "par_cta", label: "Tracked CTA interactions", kind: "count" },
    ],
    calcs: [
      { key: "par_order_gap", title: "Order gap", unit: "count",
        formula: "Planned giveaway shirts − usable stock; minimum zero",
        needs: ["par_planned", "par_stock"],
        run: (v) => ({ value: Math.max(0, v.par_planned - v.par_stock) }) },
      { key: "par_distributed", title: "Distributed quantity", unit: "count",
        formula: "Starting quantity − remaining quantity − documented damage or other disposition",
        needs: ["par_starting", "par_remaining", "par_damaged"],
        run: (v) => ({ value: v.par_starting - v.par_remaining - v.par_damaged }) },
      { key: "par_net_expense", title: "Net campaign expense", unit: "money",
        formula: "Recorded campaign costs − approved support actually applied",
        needs: ["par_costs", "par_support"],
        run: (v) => ({ value: money(v.par_costs - v.par_support) }),
        note: "Support is subtracted once. Do not also deduct it from the recorded costs." },
      { key: "par_cost_per_cta", title: "Cost per CTA interaction", unit: "money",
        formula: "Net campaign expense ÷ tracked CTA interactions",
        needs: ["par_costs", "par_support", "par_cta"],
        run: (v) => v.par_cta === 0
          ? { value: null, status: "No CTA interactions recorded yet, so cost per interaction cannot be calculated" }
          : { value: money((v.par_costs - v.par_support) / v.par_cta) } },
    ],
    scorecard: ["Shirts planned / stock / ordered / distributed", "Supplier support / special pricing",
      "Float tasks completed / issues", "Starting quantity / final count / leftovers",
      "QR scans / button clicks / CTA placement", "Identified contacts / orders / influenced revenue",
      "Shirts + inserts + float + other expense"],
  },

  on_us: {
    inputs: [
      { key: "onus_item", label: "Item cost", kind: "money" },
      { key: "onus_decoration", label: "Decoration", kind: "money" },
      { key: "onus_packaging", label: "Packaging", kind: "money" },
      { key: "onus_freight", label: "Freight", kind: "money" },
      { key: "onus_released", label: "Gifts released", kind: "count" },
      { key: "onus_delivered", label: "Gifts with confirmed delivery or handoff", kind: "count" },
    ],
    calcs: [
      { key: "onus_gift_cost", title: "Gift cost", unit: "money",
        formula: "Item cost + decoration + packaging + freight",
        needs: ["onus_item", "onus_decoration", "onus_packaging", "onus_freight"],
        run: (v) => ({ value: money(v.onus_item + v.onus_decoration + v.onus_packaging + v.onus_freight) }) },
      { key: "onus_delivery", title: "Delivery completion", unit: "percent",
        formula: "Gifts with confirmed delivery or handoff ÷ gifts released × 100",
        needs: ["onus_delivered", "onus_released"],
        run: (v) => rate(v.onus_delivered, v.onus_released, "Gifts released"),
        note: "Held for the Account Manager is not delivered." },
    ],
    scorecard: ["Gifts planned / produced / shipped / handed off", "Fulfillment accuracy / completion time",
      "Delivery exceptions", "Stock movement / gift and decoration cost",
      "Client responses / relationship notes", "Confirmed business outcome or N/A reason"],
  },

  sampling: {
    inputs: [
      { key: "samp_delivered", label: "Delivered recipients", kind: "count" },
      { key: "samp_responding", label: "Responding recipients", kind: "count" },
      { key: "samp_ordered", label: "Recipients who ordered", kind: "count" },
      { key: "samp_cost", label: "Total campaign cost", kind: "money" },
    ],
    calcs: [
      { key: "samp_response", title: "Response rate", unit: "percent",
        formula: "Responding recipients ÷ delivered recipients × 100",
        needs: ["samp_responding", "samp_delivered"],
        run: (v) => rate(v.samp_responding, v.samp_delivered, "Delivered recipients") },
      { key: "samp_conversion", title: "Conversion rate", unit: "percent",
        formula: "Recipients who ordered ÷ delivered recipients × 100",
        needs: ["samp_ordered", "samp_delivered"],
        run: (v) => rate(v.samp_ordered, v.samp_delivered, "Delivered recipients") },
      { key: "samp_cost_per", title: "Sample cost per conversion", unit: "money",
        formula: "Total campaign cost ÷ converted recipients",
        needs: ["samp_cost", "samp_ordered"],
        run: (v) => v.samp_ordered === 0
          ? { value: null, status: "Nobody has ordered yet, so cost per conversion cannot be calculated" }
          : { value: money(v.samp_cost / v.samp_ordered) } },
    ],
    scorecard: ["Packages sent / delivered / exceptions", "Responses / response rate", "Meetings booked",
      "Orders / conversion rate", "Reactivated clients / reactivation rate", "Revenue / gross margin",
      "Sample + production + freight cost", "Sample cost per conversion"],
  },

  referral: {
    inputs: [
      { key: "ref_distinct", label: "Distinct confirmed referred people", kind: "count" },
      { key: "ref_ordered", label: "Confirmed referred people with a first order", kind: "count" },
      { key: "ref_revenue", label: "Linked order revenue through November 30", kind: "money" },
    ],
    calcs: [
      { key: "ref_conversion", title: "Referral conversion", unit: "percent",
        formula: "Confirmed referred people with a first order ÷ distinct confirmed referred people × 100",
        needs: ["ref_ordered", "ref_distinct"],
        run: (v) => rate(v.ref_ordered, v.ref_distinct, "Distinct confirmed referred people") },
      { key: "ref_fiscal_revenue", title: "First fiscal-year revenue", unit: "money",
        formula: "Sum of linked order revenue from the first order through that fiscal year's November 30",
        needs: ["ref_revenue"],
        run: (v) => ({ value: money(v.ref_revenue) }),
        note: "A December first order runs through the FOLLOWING November 30. Never a rolling twelve months. Revenue is reported separately from the referral count and is never the tie-breaker." },
    ],
    scorecard: ["Referrals received / pending AM review", "Distinct confirmed referred people",
      "Referrers thanked / thank-you timeliness", "First-order conversions / new clients",
      "Revenue through first fiscal-year November 30", "Leading referrer / tie / award recipient",
      "Duplicate corrections / relationship notes"],
  },

  poll: {
    inputs: [
      { key: "poll_pre_delivered", label: "Delivered pre-poll emails", kind: "count" },
      { key: "poll_yes", label: "Confirmed yes respondents", kind: "count" },
      { key: "poll_invites", label: "Delivered poll invites", kind: "count" },
      { key: "poll_responded", label: "Participants who responded", kind: "count" },
      { key: "poll_completed", label: "Completed polls", kind: "count" },
    ],
    calcs: [
      { key: "poll_optin", title: "Opt-in rate", unit: "percent",
        formula: "Confirmed yes respondents ÷ delivered pre-poll emails × 100",
        needs: ["poll_yes", "poll_pre_delivered"],
        run: (v) => rate(v.poll_yes, v.poll_pre_delivered, "Delivered pre-poll emails") },
      { key: "poll_response", title: "Poll response rate", unit: "percent",
        formula: "Participants who responded ÷ delivered poll invites × 100",
        needs: ["poll_responded", "poll_invites"],
        run: (v) => rate(v.poll_responded, v.poll_invites, "Delivered poll invites") },
      { key: "poll_completion", title: "Completion rate", unit: "percent",
        formula: "Completed polls ÷ delivered poll invites × 100",
        needs: ["poll_completed", "poll_invites"],
        run: (v) => rate(v.poll_completed, v.poll_invites, "Delivered poll invites") },
    ],
    scorecard: ["Pre-poll sent / delivered", "Affirmative opt-ins / declines / no response",
      "Actual poll sent / delivered", "Responses / completed polls",
      "Question-level findings / data quality", "Decision informed / next steps",
      "High-value follow-ups / opportunities"],
  },

  in_order_gifting: {
    inputs: [
      { key: "iog_need_date", label: "Client need-in-hand date", kind: "date" },
      { key: "iog_recipients", label: "Gift recipients", kind: "count" },
      { key: "iog_later_order", label: "Gift recipients with a later order", kind: "count" },
      { key: "iog_influenced", label: "AM-confirmed influenced order revenue", kind: "money" },
    ],
    calcs: [
      { key: "iog_distribution", title: "Distribution timing", unit: "date",
        formula: "Client need-in-hand date − 2 calendar months",
        needs: ["iog_need_date"],
        run: (v) => ({ value: monthsBefore(v.iog_need_date, 2) }),
        note: "Two months, not the older one-month timing." },
      { key: "iog_repeat", title: "Repeat-order rate", unit: "percent",
        formula: "Gift recipients with a later order ÷ gift recipients × 100",
        needs: ["iog_later_order", "iog_recipients"],
        run: (v) => rate(v.iog_later_order, v.iog_recipients, "Gift recipients") },
      { key: "iog_influenced_revenue", title: "Influenced revenue", unit: "money",
        formula: "Sum of unique AM-confirmed influenced order revenue",
        needs: ["iog_influenced"],
        run: (v) => ({ value: money(v.iog_influenced) }),
        note: "Each order counts once. An interaction alone does not prove the campaign caused the order." },
    ],
    scorecard: ["Qualifying orders / gifts inserted", "Pack accuracy / on-time shipment", "Gift quantity / cost",
      "Recipients / CTA interactions / customer reactions", "Repeat orders / conversion",
      "Influenced revenue / confirmed invoice links", "Successful gifts / next-theme changes"],
  },

  picks: {
    inputs: [
      { key: "picks_sent", label: "Sent messages", kind: "count" },
      { key: "picks_bounces", label: "MailMe-reported bounces", kind: "count" },
      { key: "picks_clickers", label: "Unique clickers", kind: "count" },
      { key: "picks_audience", label: "Named audience denominator", kind: "count" },
      { key: "picks_orders", label: "AM-confirmed attributed orders", kind: "count" },
    ],
    calcs: [
      { key: "picks_delivered", title: "Delivered messages", unit: "count",
        formula: "Sent messages − MailMe-reported bounces",
        needs: ["picks_sent", "picks_bounces"],
        run: (v) => ({ value: v.picks_sent - v.picks_bounces }) },
      { key: "picks_click_rate", title: "Unique click rate", unit: "percent",
        formula: "Unique clickers ÷ delivered messages × 100",
        needs: ["picks_clickers", "picks_sent", "picks_bounces"],
        run: (v) => rate(v.picks_clickers, v.picks_sent - v.picks_bounces, "Delivered messages"),
        note: "The primary measure. Opens are directional only." },
      { key: "picks_attributed", title: "Attributed conversion", unit: "percent",
        formula: "AM-confirmed attributed orders ÷ named audience denominator × 100",
        needs: ["picks_orders", "picks_audience"],
        run: (v) => rate(v.picks_orders, v.picks_audience, "The named audience") },
    ],
    scorecard: ["Picks per Account Manager", "Sent / delivered / bounces", "Unique clicks / unique click rate",
      "Clicks by product / vendor / placement", "Attributed orders / revenue"],
  },

  digital_platform: {
    inputs: [
      { key: "dp_engagements", label: "Engagements", kind: "count" },
      { key: "dp_reach", label: "Stated reach or impression denominator", kind: "count" },
      { key: "dp_clicks", label: "Destination clicks", kind: "count" },
      { key: "dp_impressions", label: "Impressions", kind: "count" },
      { key: "dp_spend", label: "Actual paid spend", kind: "money" },
      { key: "dp_results", label: "Selected result count", kind: "count" },
    ],
    calcs: [
      { key: "dp_engagement_rate", title: "Engagement rate", unit: "percent",
        formula: "Engagements ÷ stated reach or impression denominator × 100",
        needs: ["dp_engagements", "dp_reach"],
        run: (v) => rate(v.dp_engagements, v.dp_reach, "The stated denominator"),
        note: "Say which denominator was used. Reach and impressions are not the same number." },
      { key: "dp_ctr", title: "Click-through rate", unit: "percent",
        formula: "Destination clicks ÷ impressions × 100",
        needs: ["dp_clicks", "dp_impressions"],
        run: (v) => rate(v.dp_clicks, v.dp_impressions, "Impressions") },
      { key: "dp_cost_per_result", title: "Cost per result", unit: "money",
        formula: "Actual paid spend ÷ selected result count",
        needs: ["dp_spend", "dp_results"],
        run: (v) => v.dp_results === 0
          ? { value: null, status: "No results recorded yet, so cost per result cannot be calculated" }
          : { value: money(v.dp_spend / v.dp_results) } },
    ],
    scorecard: ["Reach / impressions", "Engagements / engagement rate", "Destination clicks / CTR",
      "Paid spend / cost per result", "Responses / leads / orders / revenue"],
  },

  live_customization: {
    inputs: [
      { key: "lc_blank", label: "Current blank product price", kind: "money" },
      { key: "lc_decoration", label: "Chosen decoration price", kind: "money" },
      { key: "lc_taken", label: "Items taken", kind: "count" },
      { key: "lc_not_customized", label: "NOT CUSTOMIZED", kind: "count" },
      { key: "lc_damaged", label: "DAMAGED DURING APPLICATION", kind: "count" },
    ],
    calcs: [
      { key: "lc_price", title: "Finished item price", unit: "money",
        formula: "Current blank product price + chosen decoration price",
        needs: ["lc_blank", "lc_decoration"],
        run: (v) => ({ value: money(v.lc_blank + v.lc_decoration) }),
        note: "The current Account Manager confirms current pricing. Do not reuse an old price." },
      { key: "lc_completed", title: "Event completed units", unit: "count",
        formula: "Taken − NOT CUSTOMIZED − DAMAGED DURING APPLICATION",
        needs: ["lc_taken", "lc_not_customized", "lc_damaged"],
        run: (v) => ({ value: v.lc_taken - v.lc_not_customized - v.lc_damaged }) },
    ],
    scorecard: ["Items taken / completed / exceptions", "Designs used / placements",
      "Invoice reconciliation", "Event cost / staffing hours"],
  },

  try_on_day: {
    inputs: [
      { key: "tod_expected", label: "Expected participants", kind: "count",
        hint: "The firm minimum is 25. Below that, Jacob approves the exception." },
      { key: "tod_invited", label: "Invited participant group", kind: "count" },
      { key: "tod_participants", label: "Actual participants", kind: "count" },
      { key: "tod_buyers", label: "Identified participant buyers", kind: "count" },
      { key: "tod_profit", label: "Attributable gross profit", kind: "money" },
      { key: "tod_expense", label: "Campaign expense", kind: "money" },
      { key: "tod_outgoing", label: "Outgoing sample quantity", kind: "count" },
      { key: "tod_usable", label: "Usable returned", kind: "count" },
      { key: "tod_damaged", label: "Damaged returned", kind: "count" },
      { key: "tod_missing", label: "Missing", kind: "count" },
    ],
    calcs: [
      { key: "tod_participation", title: "Participation rate", unit: "percent",
        formula: "Actual participants ÷ invited participant group × 100",
        needs: ["tod_participants", "tod_invited"],
        run: (v) => rate(v.tod_participants, v.tod_invited, "The invited group") },
      { key: "tod_conversion", title: "Participant conversion", unit: "percent",
        formula: "Identified participant buyers ÷ actual participants × 100",
        needs: ["tod_buyers", "tod_participants"],
        run: (v) => rate(v.tod_buyers, v.tod_participants, "Actual participants"),
        note: "Only when identities support the comparison. Store-session conversion is a different measure and is labelled separately." },
      { key: "tod_roi", title: "Try On Day ROI", unit: "percent",
        formula: "(Attributable gross profit − campaign expense) ÷ campaign expense × 100",
        needs: ["tod_profit", "tod_expense"],
        run: (v) => v.tod_expense === 0
          ? { value: null, status: "No campaign expense recorded, so ROI cannot be calculated" }
          : { value: Math.round(((v.tod_profit - v.tod_expense) / v.tod_expense) * 1000) / 10 },
        note: "Count each cost once. Costs already taken out of gross profit are not subtracted again." },
      { key: "tod_count_check", title: "Count check", unit: "count",
        formula: "Outgoing quantity − (usable returned + damaged returned + missing)",
        needs: ["tod_outgoing", "tod_usable", "tod_damaged", "tod_missing"],
        run: (v) => {
          const diff = v.tod_outgoing - (v.tod_usable + v.tod_damaged + v.tod_missing);
          return { value: diff, flag: diff !== 0 ? "These do not reconcile. Every difference needs a dated explanation." : null };
        },
        note: "Zero means the count reconciles. Only the verified usable quantity is counted back into stockroom inventory, once." },
    ],
    scorecard: ["Expected / actual participants", "Store orders / sales", "Identified buyers / conversion",
      "Samples out / usable returned / damaged / missing", "Sample and delivery cost",
      "Client feedback / repeat value"],
    advisories: [
      { key: "tod_min", needs: ["tod_expected"],
        test: (v) => v.tod_expected < 25,
        text: "Under the 25-participant minimum. The master makes 25 firm, so this needs Jacob's approval as a sales exception before it goes ahead." },
    ],
  },
};

export function typeNumbers(typeKey) {
  return TYPE_NUMBERS[typeKey] || { inputs: [], calcs: [], scorecard: [], advisories: [] };
}

/** Types whose master has not arrived, so they carry only the shared five. */
export const TYPES_WITHOUT_A_MASTER = ["postal", "christmas", "live_screen_printing"];

/** A stable id for a scorecard row, so renaming a label later never orphans entries. */
export function metricKey(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}
