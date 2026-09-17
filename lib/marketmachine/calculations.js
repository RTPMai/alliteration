// PUT IN: lib/marketmachine/calculations.js
//
// lib/marketmachine/calculations.js — the five visible calculations.
//
// PHASE 3 of the MarketMachine rebuild (Sept 2026). Jacob's handoff, section
// 7, word for word:
//
//   Expected orders        = Qualified contacts x Historical conversion rate
//   Expected revenue       = Expected orders x Average order value
//   Expected gross profit  = Expected orders x Average gross profit per order
//   Event ROI              = (Influenced gross profit - Total event expense)
//                            / Total event expense x 100
//   Strategic completion   = Completed priority meetings, findings, and next
//                            steps / Planned total x 100
//
// "Show formula, current values, source record, estimate or actual label,
// result, and last updated time. If a denominator is zero or required data is
// unavailable, show a plain-language status instead of an invalid number."
//
// WHERE EACH INPUT COMES FROM. Only two inputs have a record behind them in
// Alliteration today, and those two are read, never typed:
//   - Qualified contacts: the leads connected to the campaign (BackBone),
//     counted once across an event. Until any are connected, a typed estimate
//     is used and labelled as one.
//   - Travel expense: TravelTrack receipts on connected trips, not counting
//     rejected ones.
// Everything else is TYPED, with who typed it, when, and where the number came
// from. The handoff does not say how P&M's historical conversion rate or
// average order value should be worked out, and picking a formula for them
// would be deciding a business question in code. A typed number with a named
// source is honest; a computed one nobody agreed to is not.
//
// AN EVENT'S NUMBERS ARE ITS OWN. A trade show's influenced gross profit is
// what is typed on the trade show. It is not the sum of its connected
// campaigns' figures, because the same order is usually credited on both and
// adding them would count it twice.
//
// Pure. The browser imports it; tests call it directly.
//
// ESM. Do NOT convert to module.exports.

export const CALC_INPUTS = {
  qualifiedContactsEstimate: { label: "Qualified contacts, estimate", kind: "count",
    hint: "Used until leads are connected. Then the connected leads are counted instead." },
  conversionRate: { label: "Historical conversion rate", kind: "percent",
    hint: "The share of qualified contacts that usually become an order, as a percent." },
  averageOrderValue: { label: "Average order value", kind: "money" },
  averageGrossProfit: { label: "Average gross profit per order", kind: "money" },
  otherExpense: { label: "Other event expense", kind: "money",
    hint: "Registration, booth, freight, materials. Travel receipts are added from TravelTrack automatically, so leave them out." },
  influencedGrossProfit: { label: "Influenced gross profit, actual", kind: "money",
    hint: "Gross profit on orders the Account Managers confirm this campaign influenced." },
  strategicPlanned: { label: "Planned priority meetings, findings, and next steps", kind: "count", strategic: true },
  strategicCompleted: { label: "Completed priority meetings, findings, and next steps", kind: "count", strategic: true },
};

export const CALC_KEYS = Object.keys(CALC_INPUTS);

const round = (n, places) => {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
};

/**
 * Validate and apply one typed input. Returns { ok, errors, campaign }.
 * A blank value clears the input: "we do not know" is a real answer and must
 * be sayable without inventing a zero.
 */
export function applyCalcInput(current, body, session) {
  const b = body || {};
  const key = String(b.key || "");
  const spec = CALC_INPUTS[key];
  if (!spec) return { ok: false, errors: ["Unknown calculation input"], campaign: current };

  const raw = b.value === null || b.value === undefined ? "" : String(b.value).replace(/[$,%\s]/g, "");
  let value = null;
  if (raw !== "") {
    const n = Number(raw);
    if (!isFinite(n) || n < 0) return { ok: false, errors: [`${spec.label} must be a number, zero or more`], campaign: current };
    if (spec.kind === "percent" && n > 100) return { ok: false, errors: [`${spec.label} is a percent, 100 or less`], campaign: current };
    if (spec.kind === "count" && !Number.isInteger(n)) return { ok: false, errors: [`${spec.label} must be a whole number`], campaign: current };
    value = spec.kind === "money" ? round(n, 2) : n;
  }
  const source = String(b.source == null ? "" : b.source).trim().slice(0, 200);
  if (value !== null && spec.kind !== "count" && key !== "otherExpense" && !source) {
    return { ok: false, errors: [`Say where the ${spec.label.toLowerCase()} came from`], campaign: current };
  }

  const next = JSON.parse(JSON.stringify(current || {}));
  const calc = next.calc && typeof next.calc === "object" ? next.calc : {};
  const inputs = calc.inputs && typeof calc.inputs === "object" ? calc.inputs : {};
  const who = (session && (session.name || session.username)) || null;
  const at = new Date().toISOString();
  if (value === null) delete inputs[key];
  else inputs[key] = { value, source, by: who, at };
  calc.inputs = inputs;
  next.calc = calc;

  const history = Array.isArray(next.history) ? next.history : [];
  history.push({ at, by: who, what: value === null ? `Cleared ${spec.label.toLowerCase()}` : `Set ${spec.label.toLowerCase()} to ${value}${source ? ` (${source})` : ""}` });
  next.history = history.slice(-200);
  next.updatedAt = at;
  return { ok: true, errors: [], campaign: next };
}

function typed(campaign, key) {
  const e = campaign && campaign.calc && campaign.calc.inputs && campaign.calc.inputs[key];
  return e && typeof e.value === "number" ? e : null;
}

const fromTyped = (label, e) => ({ label, value: e.value, source: e.source ? `Typed: ${e.source}` : "Typed", basis: "estimate", at: e.at, by: e.by });
const missingInput = (label) => ({ label, value: null, source: "Not entered", basis: null, at: null });

function latest(inputs) {
  return inputs.map((i) => i.at).filter(Boolean).sort().pop() || null;
}

function result(key, title, formula, inputs, value, status, basis, unit) {
  return { key, title, formula, inputs, value, status, basis, unit, updatedAt: latest(inputs) };
}

/**
 * All the calculations for a campaign.
 *
 * `connections` is the output of connectionDetail() for the same campaign, so
 * connected leads and travel are the counted-once figures. `now` stamps the
 * two read-live inputs, because a figure read from TravelTrack a second ago
 * is as fresh as it gets.
 */
export function computeCalculations(campaign, connections, opts) {
  const o = opts || {};
  const now = o.now || new Date().toISOString();
  const conn = connections || {};
  const out = [];

  // Qualified contacts: connected leads when there are any, else the estimate.
  const leads = conn.leads || {};
  let contacts;
  if (leads.unavailable) {
    const est = typed(campaign, "qualifiedContactsEstimate");
    contacts = est ? fromTyped("Qualified contacts", est)
      : { label: "Qualified contacts", value: null, source: "BackBone did not answer", basis: null, at: null };
  } else if ((leads.count || 0) > 0) {
    contacts = { label: "Qualified contacts", value: leads.count, source: `${leads.count} lead${leads.count === 1 ? "" : "s"} connected in BackBone`, basis: "actual", at: now };
  } else {
    const est = typed(campaign, "qualifiedContactsEstimate");
    contacts = est ? fromTyped("Qualified contacts", est) : missingInput("Qualified contacts");
  }

  const rateE = typed(campaign, "conversionRate");
  const rate = rateE ? { ...fromTyped("Historical conversion rate", rateE), display: rateE.value + "%" } : missingInput("Historical conversion rate");
  const aovE = typed(campaign, "averageOrderValue");
  const aov = aovE ? fromTyped("Average order value", aovE) : missingInput("Average order value");
  const agpE = typed(campaign, "averageGrossProfit");
  const agp = agpE ? fromTyped("Average gross profit per order", agpE) : missingInput("Average gross profit per order");

  const needs = (inputs) => {
    const gap = inputs.find((i) => i.value === null);
    return gap ? (gap.source === "Not entered" ? `Needs ${gap.label.toLowerCase()}` : gap.source) : null;
  };

  // 1. Expected orders
  let orders = null;
  let ordersStatus = needs([contacts, rate]);
  if (!ordersStatus) orders = round(contacts.value * (rate.value / 100), 1);
  out.push(result("expectedOrders", "Expected orders", "Qualified contacts × Historical conversion rate",
    [contacts, rate], orders, ordersStatus, "estimate", "orders"));

  const ordersInput = { label: "Expected orders", value: orders, source: "From expected orders above", basis: "estimate", at: latest([contacts, rate]) };

  // 2. Expected revenue
  let revenue = null;
  let revenueStatus = orders === null ? "Needs expected orders first" : needs([aov]);
  if (!revenueStatus) revenue = round(orders * aov.value, 2);
  out.push(result("expectedRevenue", "Expected revenue", "Expected orders × Average order value",
    [ordersInput, aov], revenue, revenueStatus, "estimate", "money"));

  // 3. Expected gross profit
  let grossProfit = null;
  let gpStatus = orders === null ? "Needs expected orders first" : needs([agp]);
  if (!gpStatus) grossProfit = round(orders * agp.value, 2);
  out.push(result("expectedGrossProfit", "Expected gross profit", "Expected orders × Average gross profit per order",
    [ordersInput, agp], grossProfit, gpStatus, "estimate", "money"));

  // 4. Event ROI, estimated and actual.
  const budget = typeof campaign.budget === "number" ? campaign.budget : null;
  const roi = (profit, expense) => round(((profit - expense) / expense) * 100, 1);

  const estExpense = budget === null ? missingInput("Total event expense")
    : { label: "Total event expense", value: budget, source: "Approved budget on this campaign", basis: "estimate", at: campaign.updatedAt || null };
  const estProfit = { label: "Influenced gross profit", value: grossProfit, source: "Expected gross profit above", basis: "estimate", at: latest([contacts, rate, agp]) };
  let estRoi = null;
  let estRoiStatus = grossProfit === null ? "Needs expected gross profit first"
    : budget === null ? "Needs an approved budget on the campaign"
      : budget === 0 ? "The budget is zero, so ROI cannot be calculated" : null;
  if (!estRoiStatus) estRoi = roi(grossProfit, budget);
  out.push(result("eventRoiEstimate", "Event ROI, estimated", "(Influenced gross profit − Total event expense) ÷ Total event expense × 100",
    [estProfit, estExpense], estRoi, estRoiStatus, "estimate", "percent"));

  const travel = conn.travel || {};
  const otherE = typed(campaign, "otherExpense");
  const actualExpenseValue = travel.unavailable ? null : round((Number(travel.total) || 0) + (otherE ? otherE.value : 0), 2);
  const travelInput = travel.unavailable
    ? { label: "Travel expense", value: null, source: "TravelTrack did not answer", basis: null, at: null }
    : { label: "Travel expense", value: Number(travel.total) || 0, source: `${(travel.trips || []).length} connected trip${(travel.trips || []).length === 1 ? "" : "s"} in TravelTrack, rejected receipts left out`, basis: "actual", at: now };
  const otherInput = otherE ? { ...fromTyped("Other event expense", otherE), basis: "actual" }
    : { label: "Other event expense", value: 0, source: "None entered", basis: "actual", at: null };
  const actualProfitE = typed(campaign, "influencedGrossProfit");
  const actualProfit = actualProfitE ? { ...fromTyped("Influenced gross profit", actualProfitE), basis: "actual" } : missingInput("Influenced gross profit");

  let actRoi = null;
  let actRoiStatus = travel.unavailable ? "TravelTrack did not answer, so actual expense is unknown"
    : actualProfit.value === null ? "Needs influenced gross profit"
      : actualExpenseValue === 0 ? "No expense recorded yet, so ROI cannot be calculated" : null;
  if (!actRoiStatus) actRoi = roi(actualProfit.value, actualExpenseValue);
  out.push(result("eventRoiActual", "Event ROI, actual", "(Influenced gross profit − Total event expense) ÷ Total event expense × 100",
    [actualProfit, travelInput, otherInput, { label: "Total event expense", value: actualExpenseValue, source: "Travel plus other expense", basis: "actual", at: latest([travelInput, otherInput]) }],
    actRoi, actRoiStatus, "actual", "percent"));

  // 5. Strategic completion, on events only.
  if (o.strategic) {
    const planE = typed(campaign, "strategicPlanned");
    const doneE = typed(campaign, "strategicCompleted");
    const planned = planE ? { ...fromTyped("Planned total", planE), basis: "actual" } : missingInput("Planned total");
    const completed = doneE ? { ...fromTyped("Completed", doneE), basis: "actual" } : missingInput("Completed");
    let pct = null;
    let status = needs([completed, planned]);
    if (!status && planned.value === 0) status = "Nothing was planned, so completion cannot be calculated";
    if (!status) pct = round((completed.value / planned.value) * 100, 1);
    out.push(result("strategicCompletion", "Strategic completion", "Completed priority meetings, findings, and next steps ÷ Planned total × 100",
      [completed, planned], pct, status, "actual", "percent"));
  }

  return out;
}
