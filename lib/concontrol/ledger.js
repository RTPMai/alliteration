// lib/concontrol/ledger.js — ConControl money.
//
// One ledger holding both sides: what the event takes in and what it spends.
// Two lists would mean two shapes, two screens and two places to forget a
// number, and the only question anybody asks is "are we ahead or behind",
// which needs both halves in the same arithmetic.
//
// SPONSOR INCOME IS NOT ENTERED HERE. It is already recorded on the sponsor,
// payment by payment, and typing it again is how two numbers that should
// agree stop agreeing. budgetSummary() reads sponsor payments directly and
// marks them as coming from the sponsor records, so the income total is right
// without anybody keeping it in step. Entries of kind "income" are for the
// other money: ticket sales, a refund, anything that is not a sponsor.
//
// ESM. Do NOT convert to module.exports.

import { money, isoDate, paidTotal, CLOSED_STATUSES, STATUSES } from "./schema.js";

export const ENTRY_KINDS = ["income", "spend"];

/**
 * Where a spend commitment is up to. A quote is not money out and a paid bill
 * is not money still to find, and a budget that cannot tell them apart says
 * the same number in October and in April.
 */
export const ENTRY_STATES = ["estimate", "committed", "paid"];
export const ENTRY_STATE_LABELS = {
  estimate: "Estimate",
  committed: "Committed",
  paid: "Paid",
};

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

export function newEntry(id, who, event) {
  return {
    id,
    event,
    kind: "spend",
    state: "estimate",
    category: "",
    description: "",
    amount: null,
    date: null,
    vendor: "",
    invoiceNumber: "",
    notes: "",
    createdAt: new Date().toISOString(),
    createdBy: str(who) || null,
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

export function validateEntryPatch(body, categories) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const patch = {};
  const cats = Array.isArray(categories) ? categories : null;

  if ("kind" in b) {
    const kind = str(b.kind);
    if (!ENTRY_KINDS.includes(kind)) errors.push(`Unknown kind "${kind}"`);
    else patch.kind = kind;
  }

  if ("state" in b) {
    const state = str(b.state);
    if (!ENTRY_STATES.includes(state)) errors.push(`Unknown state "${state}"`);
    else patch.state = state;
  }

  if ("category" in b) {
    const cat = str(b.category);
    // Checked against the list when one is supplied, because a typo'd
    // category silently becomes its own row in every rollup.
    if (cat && cats && !cats.includes(cat)) errors.push(`"${cat}" is not one of the categories`);
    else patch.category = cat;
  }

  if ("description" in b) {
    const d = str(b.description);
    if (!d) errors.push("An entry needs a description");
    else patch.description = d.slice(0, 200);
  }

  if ("amount" in b) {
    if (b.amount === null || b.amount === "") patch.amount = null;
    else {
      const amt = money(b.amount);
      if (amt === null) errors.push("Amount is not a number");
      else if (amt < 0) errors.push("Amount cannot be negative. A refund is income, not negative spend");
      else patch.amount = amt;
    }
  }

  if ("date" in b) {
    if (b.date === null || b.date === "") patch.date = null;
    else {
      const d = isoDate(b.date);
      if (!d) errors.push("Date must be YYYY-MM-DD");
      else patch.date = d;
    }
  }

  if ("vendor" in b) patch.vendor = str(b.vendor).slice(0, 120);
  if ("invoiceNumber" in b) patch.invoiceNumber = str(b.invoiceNumber).slice(0, 60);
  if ("notes" in b) patch.notes = str(b.notes).slice(0, 2000);
  if ("event" in b) patch.event = str(b.event);

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Budget versus actual, with sponsor income folded in from the sponsor records.
 *
 * THREE SPEND NUMBERS, NOT ONE. `paid` is money gone. `committed` is money
 * promised and not yet gone. `estimated` is a guess. They are reported apart
 * because "we have spent 12,000" and "we are on the hook for 12,000" are
 * different sentences, and collapsing them is how a budget looks fine in
 * January and does not in April.
 *
 * An entry with no amount is counted as a GAP, never as zero. Same rule the
 * sponsor rollup uses for an unpriced sponsor and MarketMachine uses for a
 * missing reach figure.
 */
export function budgetSummary(entries, sponsors, budget) {
  const rows = Array.isArray(entries) ? entries : [];
  const spons = Array.isArray(sponsors) ? sponsors : [];

  const spend = { paid: 0, committed: 0, estimated: 0, gaps: 0 };
  const otherIncome = { received: 0, expected: 0, gaps: 0 };

  for (const e of rows) {
    const amt = money(e.amount);
    if (amt === null) {
      if (e.kind === "income") otherIncome.gaps += 1;
      else spend.gaps += 1;
      continue;
    }
    if (e.kind === "income") {
      if (e.state === "paid") otherIncome.received += amt;
      else otherIncome.expected += amt;
      continue;
    }
    if (e.state === "paid") spend.paid += amt;
    else if (e.state === "committed") spend.committed += amt;
    else spend.estimated += amt;
  }

  // Sponsor money, read from the records rather than re-entered.
  const live = spons.filter((s) => !CLOSED_STATUSES.includes(
    STATUSES.includes(s && s.status) ? s.status : "inquiry"
  ));
  let sponsorCollected = 0;
  let sponsorCommitted = 0;
  for (const s of live) {
    sponsorCollected += paidTotal(s);
    const c = money(s.committed);
    if (c !== null) sponsorCommitted += c;
  }

  const incomeIn = round(sponsorCollected + otherIncome.received);
  const incomeExpected = round(Math.max(0, sponsorCommitted - sponsorCollected) + otherIncome.expected);
  const spendOut = round(spend.paid);
  const spendAhead = round(spend.committed + spend.estimated);

  return {
    sponsorCollected: round(sponsorCollected),
    sponsorCommitted: round(sponsorCommitted),
    otherIncome: { received: round(otherIncome.received), expected: round(otherIncome.expected), gaps: otherIncome.gaps },
    spend: {
      paid: round(spend.paid),
      committed: round(spend.committed),
      estimated: round(spend.estimated),
      gaps: spend.gaps,
    },
    incomeIn,
    incomeExpected,
    spendOut,
    spendAhead,
    // Today's position: money in against money gone.
    net: round(incomeIn - spendOut),
    // Where it lands if everything promised on both sides happens.
    projected: round(incomeIn + incomeExpected - spendOut - spendAhead),
    budget: money(budget),
    budgetLeft: money(budget) === null ? null : round(money(budget) - spendOut - spendAhead),
  };
}

/** Spend by category, biggest first, with the gaps named rather than hidden. */
export function byCategory(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e.kind !== "income");
  const map = new Map();
  let gaps = 0;

  for (const e of rows) {
    const cat = str(e.category) || "Uncategorised";
    const amt = money(e.amount);
    if (amt === null) { gaps += 1; continue; }
    const cur = map.get(cat) || { category: cat, paid: 0, ahead: 0, count: 0 };
    if (e.state === "paid") cur.paid += amt;
    else cur.ahead += amt;
    cur.count += 1;
    map.set(cat, cur);
  }

  const out = Array.from(map.values()).map((r) => ({
    ...r,
    paid: round(r.paid),
    ahead: round(r.ahead),
    total: round(r.paid + r.ahead),
  }));
  out.sort((a, b) => b.total - a.total);
  return { rows: out, gaps };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
