// PUT IN: lib/crewcore/pto.js
// lib/crewcore/pto.js: time off: policy, grants, carryover and balances.
//
// Sep 21 2026, Ryan's call, reversing the Aug 2026 "PTO stays in QuickBooks"
// decision. CrewCore is now the ledger for PTO balances, not just a request
// form. What he decided:
//
//   * CrewCore tracks balances and accruals.
//   * Ryan or Megan approve. Nobody else. (policy.approvers, a list of
//     usernames set in Settings. Empty means NOBODY can approve, and the
//     screen says so, rather than falling back to "any admin".)
//   * PTO only. No separate sick or unpaid buckets.
//   * A lump sum every Jan 1, tracked in hours.
//   * Unused hours carry over up to a cap.
//
// The amounts come from the Employee Handbook's Paid Time Off section: 10
// days for a new hire (prorated for the year they start), 15 days after a
// full year, granted Jan 1. At 8 hours a day that is 80 and 120 hours. Every
// number is a Setting, not a constant.
//
// NOTE: the Handbook text still says PTO "does not rollover". Ryan chose a
// carryover cap. The default cap here is 0, which is what the Handbook says
// today, so nothing changes until somebody sets a real cap in Settings and
// updates the Handbook to match.
//
// ---- HOW A BALANCE IS WORKED OUT -----------------------------------------
//
// Nothing is written on Jan 1. There is no cron that can fail to run and
// leave everybody at zero. A balance is COMPUTED every time it is asked for,
// year by year, from four stored things:
//
//   1. the employee's start date (for the grant tier and new hire proration)
//   2. an optional starting balance per employee (the hours they had left in
//      QuickBooks on switchover), which replaces the grant for that one year
//   3. manual adjustments (event comp time, corrections), each with a reason
//   4. approved requests
//
// For each year from the first tracked year to the one asked about:
//
//     start     = starting balance (that year only) OR grant + carried in
//     carried   = min(cap, what was left at the end of last year)
//     balance   = start + adjustments - approved hours
//
// Pending requests are shown beside the balance, never subtracted from it.
// A balance can go negative (an approver said yes to more than was left);
// that is reported as a fact, not clamped away.
//
// ---- WHY THE POLICY IS VERSIONED BY YEAR ---------------------------------
//
// If the grant or the cap changes in 2027, 2026's history must not change
// with it. Otherwise raising the cap would quietly hand everybody extra
// hours carried out of a year that already closed under the old rule. So
// the policy is stored as versions keyed by the year they take effect, and
// every year is worked out with the version in force for it. Same lesson as
// the time clock's pay week: a setting must never rewrite what was stored
// under the old one.
//
// No imports on purpose: the screen imports this file too, so the browser
// and the server do the same arithmetic. Same pattern as poHealth() in
// PromoPro and stipendBalance() in schema.js.
//
// ESM. Do NOT convert to module.exports.

export const PTO_REQUEST_STATUSES = ["pending", "approved", "denied", "cancelled"];

export const DEFAULT_POLICY = Object.freeze({
  hours_per_day: 8,
  // Highest tier whose min_years is at or under the full years someone has
  // completed by Jan 1 wins. min_years 0 is the new hire tier.
  tiers: [
    { min_years: 0, hours: 80 },   // Handbook: 10 days
    { min_years: 1, hours: 120 },  // Handbook: 15 days after a full year
  ],
  // Handbook: "pro-rated for the year in which they start".
  prorate_first_year: true,
  // Handbook today: does not roll over. Ryan wants a cap; 0 until it is set.
  carryover_cap_hours: 0,
});

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function norm(u) {
  return String(u || "").trim().toLowerCase();
}

function isDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

function yearOf(day) {
  const y = parseInt(String(day || "").slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function dayNum(day) {
  return Math.round(Date.parse(day + "T00:00:00Z") / 86400000);
}

function daysInYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

// ---- Policy ---------------------------------------------------------------

/**
 * One policy version, cleaned. Anything missing or broken falls back to the
 * default for that field rather than failing, so a half-saved record cannot
 * zero out everybody's grant.
 */
export function cleanPolicy(p) {
  const src = p && typeof p === "object" ? p : {};
  const out = {
    hours_per_day: Number(src.hours_per_day) > 0 ? round2(src.hours_per_day) : DEFAULT_POLICY.hours_per_day,
    prorate_first_year: src.prorate_first_year === undefined ? DEFAULT_POLICY.prorate_first_year : src.prorate_first_year !== false,
    carryover_cap_hours: Number(src.carryover_cap_hours) >= 0 && src.carryover_cap_hours !== "" && src.carryover_cap_hours != null
      ? round2(src.carryover_cap_hours) : DEFAULT_POLICY.carryover_cap_hours,
  };
  const tiers = Array.isArray(src.tiers) ? src.tiers
    .map((t) => ({ min_years: Math.floor(Number(t && t.min_years)), hours: round2(Number(t && t.hours)) }))
    .filter((t) => Number.isFinite(t.min_years) && t.min_years >= 0 && Number.isFinite(t.hours) && t.hours >= 0)
    : [];
  out.tiers = tiers.length ? sortTiers(tiers) : DEFAULT_POLICY.tiers.map((t) => ({ ...t }));
  // A tier list with no new hire tier would hand a new hire nothing at all.
  if (out.tiers[0].min_years !== 0) out.tiers.unshift({ min_years: 0, hours: out.tiers[0].hours });
  return out;
}

function sortTiers(tiers) {
  // One tier per min_years; the last one given wins.
  const by = new Map();
  tiers.forEach((t) => by.set(t.min_years, t));
  return Array.from(by.values()).sort((a, b) => a.min_years - b.min_years);
}

/**
 * Validates a policy edit from Settings. Returns the cleaned version or the
 * reasons it was refused. Stricter than cleanPolicy(): a person typing a
 * number gets told when it is wrong, rather than having it silently replaced.
 */
export function validatePolicy(input) {
  const b = input && typeof input === "object" ? input : {};
  const errors = [];
  if (b.hours_per_day !== undefined) {
    const v = Number(b.hours_per_day);
    if (!(v > 0 && v <= 24)) errors.push("Hours in a work day must be between 0 and 24");
  }
  if (b.carryover_cap_hours !== undefined) {
    const v = Number(b.carryover_cap_hours);
    if (b.carryover_cap_hours === "" || !(v >= 0)) errors.push("Carryover cap must be 0 or more hours");
  }
  if (b.tiers !== undefined) {
    if (!Array.isArray(b.tiers) || !b.tiers.length) {
      errors.push("At least one grant tier is required");
    } else {
      b.tiers.forEach((t, i) => {
        const y = Number(t && t.min_years);
        const h = Number(t && t.hours);
        if (!(Number.isInteger(y) && y >= 0)) errors.push(`Tier ${i + 1}: years must be a whole number, 0 or more`);
        if (!(h >= 0)) errors.push(`Tier ${i + 1}: hours must be 0 or more`);
      });
      if (!b.tiers.some((t) => Number(t && t.min_years) === 0)) {
        errors.push("One tier must start at 0 years, or new hires get nothing");
      }
    }
  }
  let approvers;
  if (b.approvers !== undefined) {
    if (!Array.isArray(b.approvers)) errors.push("Approvers must be a list of usernames");
    else approvers = Array.from(new Set(b.approvers.map(norm).filter(Boolean)));
  }
  if (errors.length) return { ok: false, errors };
  // Only the fields that were sent. withPolicyVersion() lays this over the
  // version already in force, so saving the cap alone never resets the tiers.
  const policy = {};
  ["hours_per_day", "carryover_cap_hours", "tiers", "prorate_first_year"].forEach((k) => {
    if (b[k] !== undefined) policy[k] = b[k];
  });
  if (policy.prorate_first_year !== undefined) policy.prorate_first_year = policy.prorate_first_year !== false;
  return { ok: true, policy, approvers };
}

/**
 * The stored document: { start_year, approvers, versions: { "2026": {...} } }.
 * Always returns a usable shape.
 */
export function cleanPolicyDoc(doc, today = new Date()) {
  const d = doc && typeof doc === "object" ? doc : {};
  const versions = {};
  Object.keys(d.versions || {}).forEach((k) => {
    const y = parseInt(k, 10);
    if (Number.isFinite(y)) versions[String(y)] = cleanPolicy(d.versions[k]);
  });
  const sy = parseInt(d.start_year, 10);
  return {
    start_year: Number.isFinite(sy) ? sy : today.getFullYear(),
    approvers: Array.isArray(d.approvers) ? Array.from(new Set(d.approvers.map(norm).filter(Boolean))) : [],
    versions,
    updated_at: d.updated_at || null,
    updated_by: d.updated_by || null,
  };
}

/**
 * The policy in force for a year: the latest version that took effect on or
 * before it. A year before every version uses the earliest one. No versions
 * at all means the Handbook defaults.
 */
export function policyForYear(doc, year) {
  const d = cleanPolicyDoc(doc);
  const ys = Object.keys(d.versions).map(Number).sort((a, b) => a - b);
  if (!ys.length) return cleanPolicy(DEFAULT_POLICY);
  let pick = ys[0];
  ys.forEach((y) => { if (y <= Number(year)) pick = y; });
  return d.versions[String(pick)];
}

/**
 * Saves an edit as the version for `fromYear` onward. Earlier years keep
 * whatever was in force for them, which is the whole point of versioning.
 */
export function withPolicyVersion(doc, fromYear, policy, by, now = new Date()) {
  const d = cleanPolicyDoc(doc, now);
  const versions = { ...d.versions };
  // The first save ever freezes the defaults that were in force before it,
  // so a year already being tracked does not pick up the new numbers.
  if (!Object.keys(versions).length && Number(fromYear) > d.start_year) {
    versions[String(d.start_year)] = cleanPolicy(DEFAULT_POLICY);
  }
  versions[String(fromYear)] = cleanPolicy({ ...policyForYear(d, fromYear), ...policy });
  return { ...d, versions, updated_at: now.toISOString(), updated_by: by || null };
}

export function canApprove(username, doc) {
  const u = norm(username);
  if (!u) return false;
  return cleanPolicyDoc(doc).approvers.includes(u);
}

// ---- Grants ---------------------------------------------------------------

/** Full years completed between a start date and Jan 1 of `year`. */
export function fullYearsBy(startDate, year) {
  if (!isDay(startDate)) return 0;
  const [sy, sm, sd] = startDate.split("-").map(Number);
  let years = Number(year) - sy;
  // Jan 1 of `year` has not yet reached the anniversary unless the start was
  // itself Jan 1.
  if (sm > 1 || sd > 1) years -= 1;
  return Math.max(0, years);
}

export function tierHours(policy, years) {
  const p = cleanPolicy(policy);
  let h = p.tiers[0].hours;
  p.tiers.forEach((t) => { if (t.min_years <= years) h = t.hours; });
  return h;
}

/**
 * Hours granted on Jan 1 of `year` (or on the start date, for a new hire).
 * No start date on file: treated as a new hire tier, full year, rather than
 * guessed at.
 */
export function grantFor(employee, year, policy) {
  const p = cleanPolicy(policy);
  const start = employee && employee.start_date;
  if (!isDay(start)) return tierHours(p, 0);
  const sy = yearOf(start);
  if (sy > year) return 0;
  if (sy === year) {
    const base = tierHours(p, 0);
    if (!p.prorate_first_year) return base;
    // Days left in the year counting the start day, to the nearest hour.
    const left = dayNum(`${year}-12-31`) - dayNum(start) + 1;
    return Math.round(base * left / daysInYear(year));
  }
  return tierHours(p, fullYearsBy(start, year));
}

// ---- Requests ---------------------------------------------------------------

/** Weekdays between two days, both ends counted. */
export function weekdaysBetween(start, end) {
  if (!isDay(start) || !isDay(end) || end < start) return 0;
  let n = 0;
  for (let d = dayNum(start); d <= dayNum(end); d++) {
    const dow = new Date(d * 86400000).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** What the request form fills in for hours before a person changes it. */
export function estimateHours(start, end, policy) {
  return round2(weekdaysBetween(start, end) * cleanPolicy(policy).hours_per_day);
}

export function requestYear(r) {
  return yearOf(r && r.start_date);
}

/**
 * A new request. Hours are what the person says they need, not derived from
 * the dates, because a half day, a four-day week or a Saturday shift are all
 * real. The dates bound it: no more than 24 hours a day across the range.
 *
 * One calendar year per request. Dec 30 to Jan 2 is two requests, because
 * the hours come out of two different years' balances.
 */
export function validateRequest(input) {
  const b = input && typeof input === "object" ? input : {};
  const errors = [];
  const rec = {};
  const start = String(b.start_date || "").trim();
  const end = String(b.end_date || start).trim();
  if (!isDay(start)) errors.push("Pick a first day off");
  if (!isDay(end)) errors.push("Pick a last day off");
  if (isDay(start) && isDay(end)) {
    if (end < start) errors.push("The last day can't be before the first day");
    else if (yearOf(start) !== yearOf(end)) errors.push("Split time off that crosses New Year's into two requests, one per year");
  }
  rec.start_date = start;
  rec.end_date = end;
  const h = Number(b.hours);
  if (!(h > 0)) errors.push("Hours must be more than 0");
  else if (isDay(start) && isDay(end) && end >= start && h > (dayNum(end) - dayNum(start) + 1) * 24) {
    errors.push("That's more hours than there are in those days");
  } else rec.hours = round2(h);
  rec.note = String(b.note || "").trim().slice(0, 500);
  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

export function validateAdjustment(input) {
  const b = input && typeof input === "object" ? input : {};
  const errors = [];
  const y = parseInt(b.year, 10);
  const h = Number(b.hours);
  const reason = String(b.reason || "").trim().slice(0, 300);
  if (!(Number.isFinite(y) && y >= 2000 && y <= 2100)) errors.push("Pick a year");
  if (!Number.isFinite(h) || h === 0) errors.push("Hours can't be 0. Use a minus sign to take hours away");
  if (!reason) errors.push("Say why. An adjustment with no reason is a mystery next year");
  if (errors.length) return { ok: false, errors };
  return { ok: true, record: { year: y, hours: round2(h), reason } };
}

export function validateOpening(input) {
  const b = input && typeof input === "object" ? input : {};
  if (b.hours === null || b.hours === "") return { ok: true, record: null };
  const y = parseInt(b.year, 10);
  const h = Number(b.hours);
  const errors = [];
  if (!(Number.isFinite(y) && y >= 2000 && y <= 2100)) errors.push("Pick a year");
  if (!Number.isFinite(h)) errors.push("Starting balance must be a number of hours");
  if (errors.length) return { ok: false, errors };
  return { ok: true, record: { year: y, hours: round2(h) } };
}

// ---- The ledger -------------------------------------------------------------

/**
 * Year by year balance for one person, from the first tracked year through
 * `throughYear`.
 *
 * @param {object} o
 * @param {object} o.employee      needs start_date, may carry pto_opening
 * @param {Array}  o.requests      this person's requests, any status
 * @param {Array}  o.adjustments   this person's adjustments
 * @param {object} o.policyDoc     the stored, versioned policy
 * @param {number} o.throughYear
 */
export function ptoLedger(o) {
  const emp = (o && o.employee) || {};
  const doc = cleanPolicyDoc(o && o.policyDoc);
  const through = Number(o && o.throughYear) || new Date().getFullYear();
  const reqs = Array.isArray(o && o.requests) ? o.requests.filter(Boolean) : [];
  const adjs = Array.isArray(o && o.adjustments) ? o.adjustments.filter(Boolean) : [];
  const opening = emp.pto_opening && Number.isFinite(Number(emp.pto_opening.year)) ? emp.pto_opening : null;

  const hireYear = isDay(emp.start_date) ? yearOf(emp.start_date) : null;
  let first = opening ? Number(opening.year) : Math.max(doc.start_year, hireYear || doc.start_year);
  const rows = [];
  let prev = null;

  for (let y = first; y <= through; y++) {
    const policy = policyForYear(doc, y);
    const isOpening = opening && Number(opening.year) === y;
    const grant = isOpening ? 0 : grantFor(emp, y, policy);
    const endOfLast = prev ? prev.balance : 0;
    const carried = isOpening || !prev ? 0 : Math.min(policy.carryover_cap_hours, Math.max(0, endOfLast));
    const lapsed = isOpening || !prev ? 0 : round2(Math.max(0, endOfLast) - carried);
    const startHours = isOpening ? round2(Number(opening.hours) || 0) : round2(grant + carried);
    const adjusted = round2(adjs.filter((a) => Number(a.year) === y).reduce((s, a) => s + (Number(a.hours) || 0), 0));
    const yearReqs = reqs.filter((r) => requestYear(r) === y);
    const used = round2(yearReqs.filter((r) => r.status === "approved").reduce((s, r) => s + (Number(r.hours) || 0), 0));
    const pending = round2(yearReqs.filter((r) => r.status === "pending").reduce((s, r) => s + (Number(r.hours) || 0), 0));
    const balance = round2(startHours + adjusted - used);
    prev = {
      year: y,
      source: isOpening ? "opening" : "grant",
      grant, carried, lapsed,
      start: startHours,
      adjusted, used, pending, balance,
      // What would be left if everything pending were approved.
      after_pending: round2(balance - pending),
      cap: policy.carryover_cap_hours,
    };
    rows.push(prev);
  }
  return rows;
}

/** The one year a screen usually wants, or a zero row for a year not tracked. */
export function ptoBalance(o, year) {
  const y = Number(year) || new Date().getFullYear();
  const rows = ptoLedger({ ...o, throughYear: y });
  const row = rows.find((r) => r.year === y);
  if (row) return row;
  return { year: y, source: "none", grant: 0, carried: 0, lapsed: 0, start: 0, adjusted: 0, used: 0, pending: 0, balance: 0, after_pending: 0, cap: 0 };
}

/** Whether a request would take someone past what they have left. */
export function overBy(balanceRow, hours) {
  const left = Number(balanceRow && balanceRow.after_pending) || 0;
  return round2(Math.max(0, Number(hours || 0) - left));
}

/**
 * Who is out between two days, for the "coming up" list. Approved and
 * pending both show; the screen marks which is which. Sorted by first day.
 */
export function whoIsOut(requests, from, to) {
  return (Array.isArray(requests) ? requests : [])
    .filter((r) => r && (r.status === "approved" || r.status === "pending"))
    .filter((r) => isDay(r.start_date) && isDay(r.end_date) && r.end_date >= from && r.start_date <= to)
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
}

/**
 * What a caller may do to a request. One definition, so the screen draws
 * the buttons the server will honour.
 */
export function requestActions(r, { isApprover = false, isOwner = false } = {}) {
  const st = r && r.status;
  return {
    approve: isApprover && st === "pending",
    deny: isApprover && st === "pending",
    // The person asking can take back a request nobody has answered yet.
    // Once approved, only an approver can cancel it, because by then the
    // schedule was planned around it.
    cancel: (isOwner && st === "pending") || (isApprover && (st === "pending" || st === "approved")),
  };
}
