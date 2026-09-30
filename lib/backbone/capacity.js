// PUT IN: lib/backbone/capacity.js
// lib/backbone/capacity.js: who has room for the next job.
//
// Sep 30 2026. Replaces the "Capacity, coming soon" card under BackBone's
// dashboard. Per account manager:
//
//   * open quotes: count and dollar value
//   * open jobs: approved and moving through deposit, art, digitizing and
//     ready to order, plus anything on hold, count and value
//   * days out this week and next, from CrewCore time off
//
// and from those, "jobs per day in the office this week", which is what
// decides who has room. Someone with eight jobs who is out Thursday and
// Friday has less room than someone with ten who is in all week.
//
// WHERE THE NUMBERS COME FROM. Quotes and jobs are the Printavo ops sync's
// workload snapshot (api/printavo-sync.js, the same statuses the Account
// Managers card counts). A job that has moved on into production is no
// longer in those statuses, so it no longer counts against the AM: by then
// the work is the shop floor's, not the AM's. Dollar values arrived with the
// same Sep 30 change; a snapshot taken before it has counts and no values,
// and the screen says so rather than showing $0.
//
// Days out are Monday to Friday only (the shop's week). A full-day request
// counts one day per weekday it covers; a half day, late arrival, early
// leave or appointment counts half a day. Pending requests count too and
// are marked, because "probably out Friday" still matters for handing work
// out.

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function shopDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z");
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

function weekday(day) {
  return new Date(day + "T12:00:00Z").getUTCDay(); // 0 Sunday
}

/**
 * This week's and next week's workdays, Monday to Friday, Central time.
 * On a Saturday or Sunday, "this week" is the coming one.
 */
export function workWeeks(now = new Date()) {
  const today = shopDay(now);
  const wd = weekday(today);
  const monday = wd === 0 ? addDays(today, 1) : wd === 6 ? addDays(today, 2) : addDays(today, 1 - wd);
  const week = (start) => [0, 1, 2, 3, 4].map((i) => addDays(start, i));
  return { today, thisWeek: week(monday), nextWeek: week(addDays(monday, 7)) };
}

/** Lowercase letters and spaces, for matching "Alexis Davis" across apps. */
export function personKey(name) {
  return String(name == null ? "" : name).toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does a CrewCore employee name belong to this BackBone account manager?
 * Exact match on the full name first. Failing that, the same first and last
 * word, which covers a middle name or initial on one side and not the other.
 * A first name alone never matches: two Jacobs would collide.
 */
export function samePerson(a, b) {
  const x = personKey(a);
  const y = personKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" ");
  const ys = y.split(" ");
  if (xs.length < 2 || ys.length < 2) return false;
  return xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

/**
 * Days out, per weekday, from time off requests.
 * @returns {Object<string, {amount: number, pending: boolean}>} keyed by date
 */
export function daysOut(requests, days) {
  const set = new Set(days || []);
  const out = {};
  (Array.isArray(requests) ? requests : []).forEach((r) => {
    if (!r || (r.status !== "approved" && r.status !== "pending")) return;
    if (!ISO.test(String(r.start_date)) || !ISO.test(String(r.end_date || r.start_date))) return;
    const full = (r.type || "all_days") === "all_days";
    const end = r.end_date || r.start_date;
    let d = r.start_date;
    let guard = 0;
    while (d <= end && guard++ < 400) {
      if (set.has(d)) {
        const amt = full ? 1 : 0.5;
        const prev = out[d] || { amount: 0, pending: false };
        out[d] = {
          amount: Math.min(1, prev.amount + amt),
          pending: prev.pending || r.status === "pending",
        };
      }
      if (!full) break; // a part day is the one day it names
      d = addDays(d, 1);
    }
  });
  return out;
}

function sumOut(map, days) {
  return days.reduce((t, d) => t + ((map[d] && map[d].amount) || 0), 0);
}

/**
 * The capacity rows.
 *
 * @param {object}   o
 * @param {string[]} o.ams       account manager names (BackBone's list)
 * @param {Array}    o.roster    rows with customer_id and am
 * @param {Array}    o.workload  ops snapshot rows: customer_id, quotes,
 *                               inProgress, onHold, and (from Sep 30)
 *                               quotesValue, inProgressValue, onHoldValue
 * @param {Object|null} o.out    { [amName]: requests[] } or null when the
 *                               viewer may not see time off
 * @param {Date}     o.now
 */
export function computeCapacity({ ams = [], roster = [], workload = [], out = null, now = new Date() } = {}) {
  const weeks = workWeeks(now);
  const custToAm = {};
  (Array.isArray(roster) ? roster : []).forEach((r) => {
    if (r && r.customer_id != null && r.am && ams.indexOf(r.am) !== -1) custToAm[String(r.customer_id)] = r.am;
  });
  const hasValues = (Array.isArray(workload) ? workload : []).some((w) =>
    w && (w.quotesValue !== undefined || w.inProgressValue !== undefined || w.onHoldValue !== undefined));

  const rows = {};
  ams.forEach((am) => {
    rows[am] = { am, quotes: 0, quotesValue: 0, jobs: 0, jobsValue: 0, onHold: 0 };
  });
  let unassigned = { quotes: 0, jobs: 0 };
  (Array.isArray(workload) ? workload : []).forEach((w) => {
    if (!w) return;
    const am = w.customer_id != null ? custToAm[String(w.customer_id)] : null;
    const q = Number(w.quotes) || 0;
    const j = (Number(w.inProgress) || 0) + (Number(w.onHold) || 0);
    if (!am) { unassigned.quotes += q; unassigned.jobs += j; return; }
    const r = rows[am];
    r.quotes += q;
    r.jobs += j;
    r.onHold += Number(w.onHold) || 0;
    r.quotesValue += Number(w.quotesValue) || 0;
    r.jobsValue += (Number(w.inProgressValue) || 0) + (Number(w.onHoldValue) || 0);
  });

  const list = ams.map((am) => {
    const r = rows[am];
    const reqs = out ? (out[am] || []) : null;
    const map = reqs ? daysOut(reqs, weeks.thisWeek.concat(weeks.nextWeek)) : null;
    const outThis = map ? sumOut(map, weeks.thisWeek) : null;
    const outNext = map ? sumOut(map, weeks.nextWeek) : null;
    // Days still to come this week, not the whole week: on a Thursday,
    // "room this week" is Thursday and Friday.
    const left = weeks.thisWeek.filter((d) => d >= weeks.today);
    const outLeft = map ? sumOut(map, left) : 0;
    const inDays = Math.max(0, left.length - outLeft);
    return {
      am,
      quotes: r.quotes,
      quotesValue: hasValues ? Math.round(r.quotesValue) : null,
      jobs: r.jobs,
      onHold: r.onHold,
      jobsValue: hasValues ? Math.round(r.jobsValue) : null,
      outThisWeek: outThis,
      outNextWeek: outNext,
      outDays: map ? Object.keys(map).sort().map((d) => ({ date: d, ...map[d] })) : null,
      daysInLeft: map ? inDays : null,
      // Jobs per day still in the office this week. Out every remaining day
      // means no room at all, shown as Infinity so they sort last.
      load: map ? (inDays > 0 ? r.jobs / inDays : Infinity) : null,
    };
  });

  // Most room first. Without time off to go on, fewest open jobs first.
  list.sort((a, b) => {
    const la = a.load == null ? a.jobs : a.load;
    const lb = b.load == null ? b.jobs : b.load;
    return la - lb || a.jobs - b.jobs || a.quotes - b.quotes || a.am.localeCompare(b.am);
  });
  return { rows: list, weeks, hasValues, outKnown: !!out, unassigned };
}

/** "Out Thu, Fri (pending)" style summary for one person's days. */
export function outLabel(outDays, days) {
  if (!Array.isArray(outDays)) return "";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hit = outDays.filter((d) => (days || []).indexOf(d.date) !== -1);
  if (!hit.length) return "";
  return hit.map((d) => names[weekday(d.date)] + (d.amount < 1 ? " (part)" : "") + (d.pending ? " (pending)" : "")).join(", ");
}
