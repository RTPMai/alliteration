// PUT IN: lib/marketmachine/forms.js
//
// lib/marketmachine/forms.js: steps that are a small form (Oct 1 2026).
//
// Every campaign step used to be a checkbox and the same five generic boxes
// (notes, links, dates, blocker). Five kinds of step collect real information,
// so they get a form of their own, stored on the step:
//
//   results    the numbers a "record the results" step asks for. They add up
//              into "Results so far" instead of sitting in a notes box.
//   approval   Approve or Send back, with a comment that lands as the
//              step's blocker so the person who has to fix it sees why.
//   audience   who it goes to: a saved MailMe list. The campaign's emails
//              start on that list.
//   picks      Picks with Personality: the season and vendor, and each pick,
//              entered once. The Picks email fills itself in from them.
//   spend      a proposed amount and what it is for. Approving the step
//              after it records the amount as approved spend (Admins only see
//              that total).
//
// Which step gets which form is decided here by step key, so campaigns made
// before today get their forms too. Pure, no storage, importable from the
// browser: the page renders from the same rules the server enforces.
//
// ESM. Do NOT convert to module.exports.

/* ---- the results fields ---------------------------------------------- */

export const RESULT_FIELDS = {
  reach:      { label: "People reached" },
  views:      { label: "Views" },
  engagement: { label: "Engagements" },
  clicks:     { label: "Clicks" },
  scans:      { label: "Scans" },
  recipients: { label: "Recipients" },
  delivered:  { label: "Delivered" },
  responses:  { label: "Responses" },
  replies:    { label: "Replies" },
  leads:      { label: "Leads" },
  quotes:     { label: "Quotes" },
  orders:     { label: "Orders" },
  revenue:    { label: "Revenue", money: true },
  returned:   { label: "Returned pieces" },
};
export const RESULT_KEYS = Object.keys(RESULT_FIELDS);

/** Which numbers each results step asks for, in the order shown. */
const RESULTS_STEPS = {
  dp_platform_results: ["reach", "views", "engagement", "clicks"],
  dp_sales_results:    ["responses", "leads", "orders", "revenue"],
  dp_final_results:    ["reach", "clicks", "responses", "leads", "orders", "revenue"],
  poll_results:        ["responses"],
  picks_report:        ["clicks", "replies", "orders", "revenue"],
  ref_revenue:         ["orders", "revenue"],
  samp_results:        ["responses", "leads", "orders", "revenue"],
  post_results:        ["responses", "orders", "revenue", "returned"],
  iog_results:         ["responses", "orders", "revenue"],
  xmas_report:         ["recipients", "delivered", "responses", "orders", "revenue"],
  par_results:         ["scans", "clicks"],
  tod_first_results:   ["orders", "revenue"],
  tod_tracking:        ["orders", "revenue"],
  ts_60:               ["leads", "quotes", "orders", "revenue"],
  qe_results:          ["replies", "orders", "revenue"],
};

const AUDIENCE_STEPS = ["dp_audience", "poll_audience", "picks_audience", "samp_recipients",
  "post_recipients", "xmas_recipients", "qe_audience"];
const SPEND_STEPS = ["dp_paid_proposal", "samp_plan", "xmas_choose"];
const PICKS_INFO_STEPS = ["picks_trigger"];
const PICKS_STEPS = ["picks_select"];
// Steps done IN the email itself (Oct 1 2026): writing, testing, sending.
// Opening one of these opens the campaign's email right there, so nobody
// goes looking for a separate Email section.
export const EMAIL_STEPS = ["qe_write", "qe_test", "qe_send", "dp_email_copy",
  "poll_prepoll_copy", "poll_prepoll_send", "poll_copy", "poll_send", "poll_reminder",
  "picks_copy", "picks_build", "picks_send"];

// Shipping, delivery and counts (Oct 1 2026): the physical steps that have a
// few facts worth keeping, so they are typed once in the step, not in notes.
const SHIP_STEPS = ["samp_send", "post_ship", "xmas_deliver", "onus_deliver"];
const DELIVERED_STEPS = ["samp_delivered", "post_delivered", "tod_return"];
export const COUNT_FIELDS = {
  start: "Starting quantity",
  out: "Went out",
  back: "Came back usable",
  damaged: "Damaged",
  missing: "Missing",
  left: "Left over",
};
const COUNT_STEPS = {
  ts_start_count: ["start"],
  ts_final_count: ["start", "left"],
  par_count: ["left"],
  lsp_return: ["out", "back", "damaged"],
  lc_return: ["out", "back", "damaged"],
  tod_count: ["out", "back", "damaged", "missing"],
};
export const SHIP_METHODS = { carrier: "Shipped by carrier", hand: "Hand delivered", held: "Held for the next visit", mail: "Mailed" };

/**
 * TOOLS IN A STEP (Oct 1 2026). Things that live elsewhere on the page (or
 * in another app) shown right in the step that needs them, so nobody hunts:
 *   platforms  the platform ticks          art       art per platform
 *   postLinks  links to the live posts     invoices  Printavo invoices
 *   budget     the total budget (Admins)   children  connected campaigns
 *   trips      TravelTrack trips           leads     BackBone leads
 * `app` is the other app the step's work happens in: [app id, view, label].
 */
export const STEP_TOOLS = {
  dp_audience: { tools: ["platforms"] },
  dp_art: { tools: ["art"] },
  dp_setup: { tools: ["postLinks"] },
  dp_launch: { tools: ["postLinks"] },
  samp_invoice: { tools: ["invoices"] },
  post_invoice: { tools: ["invoices"] },
  onus_invoice: { tools: ["invoices"] },
  par_invoice: { tools: ["invoices"] },
  lsp_invoice: { tools: ["invoices"] },
  lc_invoice: { tools: ["invoices"] },
  tod_invoice: { tools: ["invoices"] },
  ts_invoices: { tools: ["invoices"] },
  tod_jacob: { tools: ["invoices"] },
  lsp_reconcile: { tools: ["invoices"] },
  lc_reconcile: { tools: ["invoices"] },
  ts_budget: { tools: ["budget"] },
  ts_connected: { tools: ["children"] },
  ts_promises: { tools: ["children"] },
  ts_leftovers: { tools: ["children"] },
  ref_tie: { tools: ["children"] },
  ts_travel: { tools: ["trips"], app: ["traveltrack", "trips", "Open TravelTrack"] },
  ts_expenses: { tools: ["trips"], app: ["traveltrack", "expenses", "Open TravelTrack expenses"] },
  ts_reconcile: { tools: ["trips", "invoices", "children"], app: ["traveltrack", "expenses", "Open TravelTrack expenses"] },
  ts_cards: { tools: ["leads"], app: ["backbone", "inquiries", "Open BackBone"] },
  ts_scans: { tools: ["leads"], app: ["backbone", "inquiries", "Open BackBone"] },
  ts_assign: { tools: ["leads"], app: ["backbone", "inquiries", "Open BackBone"] },
  ts_test: { app: ["backbone", "inquiries", "Open BackBone"] },
  ref_intake: { app: ["backbone", "referrals", "Open BackBone referrals"] },
  ref_validate: { app: ["backbone", "referrals", "Open BackBone referrals"] },
  ref_rank: { app: ["backbone", "referrals", "Open BackBone referrals"] },
  par_plan: { app: ["shopstock", "full", "Check the stockroom in ShopStock"] },
  par_stock: { app: ["shopstock", "full", "Check the stockroom in ShopStock"] },
  tod_kit: { app: ["shopstock", "full", "Open ShopStock"] },
  tod_count: { app: ["shopstock", "full", "Open ShopStock"] },
};
export function toolsFor(step) { return (STEP_TOOLS[(step || {}).key] || {}).tools || []; }
export function appFor(step) { return (STEP_TOOLS[(step || {}).key] || {}).app || null; }
export function countFieldsFor(step) { return (COUNT_STEPS[(step || {}).key] || []).slice(); }

export const MAX_PICKS = 8;
export const PICKS_NEEDED = 5;
export const SEASONS = ["spring", "fall"];
export const VENDORS = { ss: "S&S Activewear", sanmar: "SanMar" };

/**
 * The form a step carries, or "". Approval steps are recognised by their own
 * flag, so a new approval in the catalog gets the buttons without being
 * listed here.
 */
export function formFor(step) {
  const s = step || {};
  if (s.approval) return "approval";
  if (RESULTS_STEPS[s.key]) return "results";
  if (AUDIENCE_STEPS.includes(s.key)) return "audience";
  if (SPEND_STEPS.includes(s.key)) return "spend";
  if (PICKS_INFO_STEPS.includes(s.key)) return "picksInfo";
  if (PICKS_STEPS.includes(s.key)) return "picks";
  if (EMAIL_STEPS.includes(s.key)) return "email";
  if (SHIP_STEPS.includes(s.key)) return "ship";
  if (DELIVERED_STEPS.includes(s.key)) return "delivered";
  if (COUNT_STEPS[s.key]) return "count";
  return "";
}

export function resultFieldsFor(step) {
  return (RESULTS_STEPS[(step || {}).key] || []).slice();
}

/* ---- cleaning what the browser sends ----------------------------------- */

const text = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 200);

/** A whole number or money amount, or null for blank. "We don't know" is not zero. */
function number(v, money) {
  if (v === null || v === undefined || String(v).trim() === "") return { ok: true, value: null };
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: money ? Math.round(n * 100) / 100 : Math.round(n) };
}

const httpsUrl = (v) => /^https:\/\/[^\s]+$/i.test(String(v || "").trim()) ? String(v).trim().slice(0, 600) : "";

/**
 * Validate a form for a step. Returns { ok, errors, form }. Never stores
 * anything the step does not ask for: a results step that asks for orders
 * and revenue keeps orders and revenue and drops the rest.
 */
export function cleanForm(step, input) {
  const kind = formFor(step);
  const b = input && typeof input === "object" ? input : {};
  const errors = [];

  if (kind === "results") {
    const form = {};
    resultFieldsFor(step).forEach((key) => {
      const n = number(b[key], RESULT_FIELDS[key].money);
      if (!n.ok) errors.push(`${RESULT_FIELDS[key].label} must be a number, zero or more`);
      else form[key] = n.value;
    });
    return { ok: !errors.length, errors, form };
  }

  if (kind === "audience") {
    const listId = text(b.listId, 60);
    const listName = text(b.listName, 160);
    const count = number(b.count, false);
    if (!listId && !listName) errors.push("Pick a list, or describe who it goes to");
    return { ok: !errors.length, errors, form: { listId, listName, count: count.ok ? count.value : null } };
  }

  if (kind === "spend") {
    const amount = number(b.amount, true);
    if (!amount.ok) errors.push("The amount must be a number, zero or more");
    const what = text(b.what, 300);
    if (amount.ok && amount.value === null) errors.push("Enter an amount");
    return { ok: !errors.length, errors, form: { amount: amount.ok ? amount.value : null, what } };
  }

  if (kind === "picksInfo") {
    const season = SEASONS.includes(String(b.season)) ? String(b.season) : "";
    const vendor = VENDORS[String(b.vendor)] ? String(b.vendor) : "";
    const year = /^\d{4}$/.test(String(b.year || "").trim()) ? String(b.year).trim() : "";
    if (!season) errors.push("Pick spring or fall");
    if (!vendor) errors.push("Pick the vendor");
    if (!year) errors.push("The year is four digits");
    return { ok: !errors.length, errors, form: { season, year, vendor, teamMember: text(b.teamMember, 60) } };
  }

  if (kind === "picks") {
    const raw = Array.isArray(b.picks) ? b.picks.slice(0, MAX_PICKS) : [];
    const picks = raw.map((p) => {
      const q = p && typeof p === "object" ? p : {};
      return {
        name: text(q.name, 80),
        style: text(q.style, 40),
        msrp: text(q.msrp, 20),
        url: httpsUrl(q.url),
        reason: text(q.reason, 400),
        colors: (Array.isArray(q.colors) ? q.colors : String(q.colors || "").split(","))
          .map((c) => text(c, 40)).filter(Boolean).slice(0, 12),
      };
    }).filter((p) => p.name || p.style || p.msrp || p.url || p.reason || p.colors.length);
    raw.forEach((p, i) => {
      if (p && p.url && !httpsUrl(p.url)) errors.push(`Pick ${i + 1}: the link has to start with https://`);
    });
    return { ok: !errors.length, errors, form: { picks } };
  }

  if (kind === "ship") {
    const method = SHIP_METHODS[String(b.method)] ? String(b.method) : "";
    const date = String(b.date || "").trim();
    if (!method) errors.push("Pick how it went out");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("The date must be a real calendar date");
    return { ok: !errors.length, errors, form: { method, date: date || null, carrier: text(b.carrier, 60), tracking: text(b.tracking, 120) } };
  }

  if (kind === "delivered") {
    const date = String(b.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("Enter the date it arrived");
    return { ok: !errors.length, errors, form: { date: date || null, evidence: text(b.evidence, 600) } };
  }

  if (kind === "count") {
    const form = {};
    countFieldsFor(step).forEach((key) => {
      const n = number(b[key], false);
      if (!n.ok) errors.push(`${COUNT_FIELDS[key]} must be a whole number, zero or more`);
      else form[key] = n.value;
    });
    form.disposition = text(b.disposition, 400);
    // Try On Day samples all come home or are explained: every piece that
    // went out is back, damaged or missing. (At live events the difference
    // is what sold, so there is no such rule there.)
    const f = form;
    if (!errors.length && "missing" in f && [f.out, f.back, f.damaged, f.missing].every((v) => v != null)) {
      const accounted = f.back + f.damaged + f.missing;
      if (accounted !== f.out) errors.push(`${f.out} went out but ${accounted} are accounted for. Check the counts.`);
    }
    return { ok: !errors.length, errors, form };
  }

  if (kind === "email") return { ok: false, errors: ["This step is the email itself; write it in the step"], form: null };

  if (kind === "approval") {
    // Approvals are decided with Approve (done) or a send-back, never by
    // posting a form; see applyStepPatch.
    return { ok: false, errors: ["Use Approve or Send back on this step"], form: null };
  }

  return { ok: false, errors: ["This step has no form"], form: null };
}

/* ---- reading forms back ------------------------------------------------- */

/** A pick has everything the email needs to show it. Photo is added in the email. */
export function pickComplete(p) {
  return !!(p && p.name && p.style && p.msrp && p.url && p.reason);
}

export function picksStatus(form) {
  const picks = (form && Array.isArray(form.picks)) ? form.picks : [];
  const complete = picks.filter(pickComplete).length;
  return { count: picks.length, complete, enough: complete >= PICKS_NEEDED };
}

/**
 * The gate a picks step holds when ticked: five complete picks. Only once
 * picks have been entered here; a campaign whose picks live elsewhere is not
 * held to a form nobody used.
 */
export function picksGate(step) {
  if (formFor(step) !== "picks" || !step.form) return "";
  const st = picksStatus(step.form);
  if (!st.count || st.enough) return "";
  return `Five complete picks are needed (name, style number, MSRP, link and why). ${st.complete} so far.`;
}

/**
 * Results so far, for the whole campaign. Each number comes from the LAST
 * step in the checklist that has it filled in: results steps are snapshots in
 * time ("record the platform numbers", then "final results at the end of the
 * window"), so adding them would count the same clicks twice.
 */
export function resultsTotals(campaign) {
  const steps = Array.isArray(campaign && campaign.steps) ? campaign.steps : [];
  const out = {};
  steps.forEach((s) => {
    if (formFor(s) !== "results" || !s.form) return;
    resultFieldsFor(s).forEach((key) => {
      const v = s.form[key];
      if (v !== null && v !== undefined) out[key] = { value: v, from: s.label };
    });
  });
  return out;
}

/** The spend proposals an approval step is deciding: its earlier spend steps. */
export function proposalsFor(campaign, approvalStep) {
  const steps = Array.isArray(campaign && campaign.steps) ? campaign.steps : [];
  const keys = (approvalStep && approvalStep.after) || [];
  return steps.filter((s) => keys.includes(s.key) && formFor(s) === "spend" && s.form && s.form.amount != null);
}

/** Total approved spend on a campaign: the sum each approval recorded. */
export function approvedSpend(campaign) {
  const steps = Array.isArray(campaign && campaign.steps) ? campaign.steps : [];
  return steps.reduce((sum, s) => sum + (s.approval && s.done && s.form && Number(s.form.approvedAmount) || 0), 0);
}

/** One line for a step's row, so a filled form is visible without opening it. */
export function formSummary(step, fmtMoney) {
  const s = step || {};
  const f = s.form;
  const kind = formFor(s);
  const money = fmtMoney || ((n) => "$" + Number(n).toLocaleString());
  if (!f) return "";
  if (kind === "results") {
    return resultFieldsFor(s).filter((k) => f[k] !== null && f[k] !== undefined)
      .map((k) => `${RESULT_FIELDS[k].label} ${RESULT_FIELDS[k].money ? money(f[k]) : Number(f[k]).toLocaleString()}`).join(" · ");
  }
  if (kind === "audience") return f.listName ? `Goes to: ${f.listName}${f.count != null ? ` (${f.count})` : ""}` : "";
  if (kind === "spend") return f.amount != null ? `Proposed: ${money(f.amount)}${f.what ? `, ${f.what}` : ""}` : "";
  if (kind === "picksInfo") return [f.season, f.year, VENDORS[f.vendor]].filter(Boolean).join(" ");
  if (kind === "picks") { const st = picksStatus(f); return `${st.complete} of ${PICKS_NEEDED} picks complete${st.count > st.complete ? `, ${st.count - st.complete} unfinished` : ""}`; }
  if (kind === "ship") return [SHIP_METHODS[f.method], f.date, f.carrier, f.tracking ? `tracking ${f.tracking}` : ""].filter(Boolean).join(", ");
  if (kind === "delivered") return f.date ? `Arrived ${f.date}` : "";
  if (kind === "count") return countFieldsFor(s).filter((k) => f[k] != null).map((k) => `${COUNT_FIELDS[k]} ${Number(f[k]).toLocaleString()}`).join(" · ");
  if (kind === "approval" && f.decision === "sent_back") return `Sent back by ${f.by || "someone"}: ${f.comment}`;
  return "";
}

/**
 * What the campaign's emails start from: its audience list and, for Picks
 * with Personality, the season, vendor and picks in the Picks design's shape.
 */
export function emailPrefill(campaign) {
  const steps = Array.isArray(campaign && campaign.steps) ? campaign.steps : [];
  const aud = steps.filter((s) => formFor(s) === "audience" && s.form && s.form.listId).pop();
  const info = steps.find((s) => formFor(s) === "picksInfo" && s.form);
  const picks = steps.find((s) => formFor(s) === "picks" && s.form && (s.form.picks || []).length);
  const out = {};
  if (aud) out.listId = aud.form.listId;
  if (info || picks) {
    const pwp = {};
    if (info) {
      if (info.form.season) pwp.season = info.form.season;
      if (info.form.year) pwp.year = info.form.year;
      if (info.form.vendor) pwp.vendor = info.form.vendor;
      if (info.form.teamMember) pwp.teamMember = info.form.teamMember;
    }
    if (picks) {
      pwp.picks = picks.form.picks.map((p) => ({
        name: p.name, style: p.style, msrp: p.msrp, reason: p.reason, url: p.url,
        image: "", alt: p.name, colors: (p.colors || []).map((c) => ({ name: c, hex: "" })), colorCount: "",
      }));
    }
    out.pwp = pwp;
  }
  return out;
}

/**
 * Does this campaign's email live in its steps? True when it has an email
 * step that applies. Then the page has no separate Email section.
 */
export function emailInSteps(campaign) {
  return (Array.isArray(campaign && campaign.steps) ? campaign.steps : [])
    .some((s) => formFor(s) === "email" && !s.notApplicable);
}

/** The email step to open first: the earliest one not done yet, else the last. */
export function nextEmailStep(campaign) {
  const steps = (Array.isArray(campaign && campaign.steps) ? campaign.steps : [])
    .filter((s) => formFor(s) === "email" && !s.notApplicable);
  return steps.find((s) => !s.done) || steps[steps.length - 1] || null;
}
