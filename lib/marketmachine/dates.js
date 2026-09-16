// PUT IN: lib/marketmachine/dates.js
//
// lib/marketmachine/dates.js — suggested due dates, from one controlling date.
//
// Jacob's handoff (canonical section 4): a campaign has ONE controlling date,
// usually the launch or event date, and every other date is suggested from it.
// "10 business days before launch", "14 days after launch", "12 weeks out".
//
// A suggestion never overwrites a person. When somebody moves a due date by
// hand, that date is stored on the step as `dueOverride` and wins from then on,
// even if the launch date moves later. Recomputing over a deliberate change is
// how a checklist quietly stops meaning what somebody agreed to.
//
// DATES ARE PLAIN YYYY-MM-DD STRINGS, and all arithmetic is done in UTC on
// noon-free calendar days. A due date is a day on a wall calendar in Polk City,
// not an instant; doing this with local Date objects would move dates by one
// across daylight saving changes, twice a year.
//
// BUSINESS DAYS SKIP SATURDAY AND SUNDAY ONLY. The handoff does not name a
// holiday list, and inventing one would put dates in front of the team that
// nobody approved. If P&M wants holidays skipped, that is a list for Settings.
//
// Pure, no imports: the browser imports this file directly.
//
// ESM. Do NOT convert to module.exports.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v) {
  if (!ISO.test(String(v || ""))) return false;
  const [y, m, d] = String(v).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtc(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(dt) {
  return dt.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  if (!isIsoDate(iso)) return null;
  const dt = toUtc(iso);
  dt.setUTCDate(dt.getUTCDate() + Number(n || 0));
  return toIso(dt);
}

export function isWeekend(iso) {
  if (!isIsoDate(iso)) return false;
  const day = toUtc(iso).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Move n business days from a date. Zero returns the date itself, weekend or
 * not: a parade on a Saturday is still on Saturday.
 *
 * Counting starts from the next weekday in the direction of travel, which is
 * how a person counts on a calendar: two business days before a Monday launch
 * is the Thursday before, not the Saturday.
 */
export function addBusinessDays(iso, n) {
  if (!isIsoDate(iso)) return null;
  const steps = Math.trunc(Number(n || 0));
  if (steps === 0) return iso;
  const dir = steps > 0 ? 1 : -1;
  const dt = toUtc(iso);
  let left = Math.abs(steps);
  while (left > 0) {
    dt.setUTCDate(dt.getUTCDate() + dir);
    const day = dt.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return toIso(dt);
}

/**
 * The suggested date for a timing rule, relative to the controlling date.
 *
 *   { bd: -10 }        10 business days before
 *   { days: 14 }       14 calendar days after
 *   { fixed: "10-31" } that month and day, in the controlling date's year
 *   null               no suggested date in the handoff; a person sets one
 *
 * Returns null rather than guessing whenever the controlling date is missing.
 */
export function suggestDate(timing, controlDate) {
  if (!timing || !isIsoDate(controlDate)) return null;
  if (typeof timing.bd === "number") return addBusinessDays(controlDate, timing.bd);
  if (typeof timing.days === "number") return addDays(controlDate, timing.days);
  if (typeof timing.fixed === "string" && /^\d{2}-\d{2}$/.test(timing.fixed)) {
    const candidate = controlDate.slice(0, 4) + "-" + timing.fixed;
    return isIsoDate(candidate) ? candidate : null;
  }
  return null;
}

/** The date a step is actually due: a person's date beats the suggestion. */
export function dueDateFor(step, controlDate) {
  if (step && isIsoDate(step.dueOverride)) return step.dueOverride;
  return suggestDate(step && step.timing, controlDate);
}

/** Plain words for a timing rule, shown next to the due date. */
export function timingLabel(timing, controlLabel) {
  const what = String(controlLabel || "launch").toLowerCase();
  if (!timing) return "Set by the owner";
  if (typeof timing.bd === "number") {
    if (timing.bd === 0) return "On the " + what;
    const n = Math.abs(timing.bd);
    return n + " business day" + (n === 1 ? "" : "s") + (timing.bd < 0 ? " before " : " after ") + what;
  }
  if (typeof timing.days === "number") {
    if (timing.days === 0) return "On the " + what;
    const n = Math.abs(timing.days);
    if (n % 7 === 0 && n >= 14) {
      const w = n / 7;
      return w + " weeks" + (timing.days < 0 ? " before " : " after ") + what;
    }
    return n + " day" + (n === 1 ? "" : "s") + (timing.days < 0 ? " before " : " after ") + what;
  }
  if (typeof timing.fixed === "string") {
    const [m, d] = timing.fixed.split("-").map(Number);
    const month = ["January", "February", "March", "April", "May", "June", "July",
      "August", "September", "October", "November", "December"][m - 1] || "";
    return "By " + month + " " + d;
  }
  return "Set by the owner";
}

/**
 * Today in Central time, as YYYY-MM-DD.
 *
 * Every P&M deadline is a Central calendar day. Using the UTC date would call
 * a task overdue at 7 PM the evening before it is due.
 */
export function todayCentral(now) {
  const at = now instanceof Date ? now : new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(at);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch (e) {
    return at.toISOString().slice(0, 10);
  }
}
