// PUT IN: lib/today/build.js
/**
 * Today: what needs this person, from every app, on one screen.
 *
 * Sep 24 2026. Replaces the All apps grid as the landing screen (Ryan's call,
 * Sep 23). Two kinds of thing show up here:
 *
 *   ASSIGNED   work somebody handed this person: an open notification, a
 *              MarketMachine step with their name on it, a time off request
 *              waiting on them as an approver.
 *   OWNED      things that are theirs by role and are going wrong without
 *              anyone assigning them: an AM's own purchase orders going red,
 *              an AM's own inquiries sitting past their clock.
 *
 * WHY THIS FILE HOLDS NO NETWORK CODE. The screen (apps/today.js) asks each
 * app's EXISTING endpoint for its data and hands the answer here. Nothing new
 * is exposed: every endpoint still applies its own access rules, so Today can
 * never show somebody a record their own app would have refused them. The
 * alternative, one server route reading every store, would have needed a
 * second copy of every app's permission rules, and a second copy is exactly
 * how the CrewCore trap happened.
 *
 * Every builder returns plain items of one shape, so the screen only knows
 * how to draw one thing:
 *
 *   { id, source, app, title, detail, due, bucket, route: { app, view, param },
 *     notificationId? }
 *
 * `bucket` is where it sits on the screen: late, today, week, open. Sorting
 * and grouping live here too, so they can be tested with real calls.
 */

import { isWaiting, linkRoute } from "../notifications/schema.js";
import { poHealth, isOpenPo, stageLabel } from "../promopro/schema.js";
import { ownsPo } from "../promopro/move-own.js";
import {
  normalizeInquiryStatus, isActive, isStalled, reachBackDue, daysInStage,
} from "../backbone/inquiries.js";
import { isArchived } from "../backbone/archive.js";

export const BUCKETS = [
  { key: "late",  label: "Late" },
  { key: "today", label: "Today" },
  { key: "week",  label: "This week" },
  { key: "open",  label: "Also on your plate" },
];
export const BUCKET_KEYS = BUCKETS.map((b) => b.key);

/* ------------------------------------------------------------------ *
 * DATES
 * ------------------------------------------------------------------ */

function addDays(isoDay, n) {
  const d = new Date(String(isoDay) + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Where a due date puts something. No date is "open", not "today": an undated
 * item is still yours, but calling it urgent is how the Today list stops
 * being believed.
 */
export function bucketFor(due, today) {
  if (!due) return "open";
  const d = String(due).slice(0, 10);
  if (d < today) return "late";
  if (d === today) return "today";
  const week = addDays(today, 7);
  if (week && d <= week) return "week";
  return "open";
}

/* ------------------------------------------------------------------ *
 * NAMES
 *
 * BackBone records an inquiry's account manager by display name
 * ("Alexis Davis"), not by login. Same rule BackBone's own "My leads" button
 * uses: an exact match, else one name containing the other, so "Alexis" the
 * login name still finds "Alexis Davis". Two letters or fewer never matches
 * by containment, or "Al" would claim everybody's work.
 * ------------------------------------------------------------------ */

export function namesMatch(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 3 || y.length < 3) return false;
  return x.includes(y) || y.includes(x);
}

/* ------------------------------------------------------------------ *
 * NOTIFICATIONS: open, assigned to me, not a reminder still asleep.
 * ------------------------------------------------------------------ */

export function notificationItems(list, me, today) {
  const who = String(me || "").toLowerCase();
  return (Array.isArray(list) ? list : [])
    .filter((n) => n && (n.status || "open") === "open")
    .filter((n) => String(n.assignedTo || "").toLowerCase() === who)
    .filter((n) => !isWaiting(n, today))
    .map((n) => {
      const link = n.link && n.link.type && n.link.id ? linkRoute(n.link.type) : null;
      const from = n.createdBy && String(n.createdBy).toLowerCase() !== who
        ? "From " + (n.createdByName || n.createdBy)
        : "";
      return {
        id: "n:" + n.id,
        source: "notifications",
        app: link ? link.app : "notifications",
        title: n.title || "Untitled task",
        detail: [from, n.link && n.link.label ? n.link.label : ""].filter(Boolean).join(" · "),
        due: n.dueDate || null,
        bucket: bucketFor(n.dueDate, today),
        route: link
          ? { app: link.app, view: link.view, param: String(n.link.id) }
          : { app: "notifications", view: "inbox", param: null },
        notificationId: n.id,
      };
    });
}

/* ------------------------------------------------------------------ *
 * PROMOPRO: my open orders that are red or amber.
 *
 * "Mine" is ownsPo(), the same function the purchase-order route uses to let
 * an AM move their own order along, so Today and PromoPro agree on whose
 * order it is. Health is poHealth() with the shop's own chase setting, so
 * the colour here is the colour on the pipeline.
 *
 * Red is late. Amber is today: it is the "chase them now" colour.
 * ------------------------------------------------------------------ */

export function poItems(pos, vendors, settings, today) {
  const s = settings || {};
  const meId = s.me && s.me.id ? s.me.id : "";
  const username = s.meUsername || "";
  const vendorById = new Map((Array.isArray(vendors) ? vendors : []).map((v) => [v.id, v]));
  const opts = { chaseAfterDays: s.chaseAfterDays };

  const mine = [];
  let shopRed = 0;
  (Array.isArray(pos) ? pos : []).forEach((po) => {
    if (!po || !isOpenPo(po)) return;
    const vendor = vendorById.get(po.vendorId);
    const h = poHealth(po, vendor, today, opts);
    if (h.level === "red") shopRed++;
    if (h.level !== "red" && h.level !== "amber") return;
    if (!ownsPo(po, meId, username)) return;
    const customer = (po.printavo && (po.printavo.companyName || po.printavo.customerName)) || "";
    mine.push({
      id: "po:" + po.id,
      source: "promopro",
      app: "promopro",
      title: (po.poNumber || "Draft PO") + (vendor && vendor.name ? " · " + vendor.name : ""),
      detail: [customer, stageLabel(h.stage, po), h.reasons[0] || ""].filter(Boolean).join(" · "),
      due: po.neededBy || (po.printavo && po.printavo.dueDate) || null,
      bucket: h.level === "red" ? "late" : "today",
      level: h.level,
      route: { app: "promopro", view: "orders", param: String(po.id) },
    });
  });
  return { mine, shopRed };
}

/* ------------------------------------------------------------------ *
 * BACKBONE: my inquiries past their stage clock, or parked and now due.
 *
 * Only an inquiry with an account manager written on it counts as mine. The
 * industry-lane guess BackBone shows as a suggestion is not an assignment,
 * and putting guessed work on somebody's Today is how they learn to ignore it.
 * ------------------------------------------------------------------ */

export function inquiryItems(leads, myName, now) {
  const at = now || Date.now();
  const out = [];
  (Array.isArray(leads) ? leads : []).forEach((l) => {
    if (!l || isArchived(l)) return;
    if (!namesMatch(l.account_manager, myName)) return;
    const status = normalizeInquiryStatus(l.status);
    const company = l.company_name || l.company || "Inquiry";
    let bucket = null; let detail = "";
    if (isActive(l) && isStalled(l, at)) {
      bucket = "late";
      const d = daysInStage(l, at);
      detail = status + " for " + d + " day" + (d === 1 ? "" : "s");
    } else if (reachBackDue(l, at)) {
      bucket = "today";
      detail = "Time to reach back out";
    }
    if (!bucket) return;
    out.push({
      id: "inq:" + (l.lead_id || l.id),
      source: "backbone",
      app: "backbone",
      title: company,
      detail,
      due: null,
      bucket,
      route: { app: "backbone", view: "inquiries", param: String(l.lead_id || l.id) },
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * CREWCORE: time off requests waiting on me as an approver.
 *
 * Only when the time off route says this caller IS an approver. Being a
 * CrewCore admin is not the same thing, and the route already tells us which.
 * A request whose first day has already arrived is late: somebody is out, or
 * about to be, without an answer.
 * ------------------------------------------------------------------ */

export function timeoffItems(data, today) {
  const d = data || {};
  if (!d.me || d.me.is_approver !== true) return [];
  return (Array.isArray(d.requests) ? d.requests : [])
    .filter((r) => r && r.status === "pending")
    .map((r) => {
      const range = r.end_date && r.end_date !== r.start_date
        ? r.start_date + " to " + r.end_date
        : (r.start_date || "");
      return {
        id: "pto:" + r.id,
        source: "timeoff",
        app: "crewcore",
        title: "Time off: " + (r.employee_name || "someone"),
        detail: [range, "waiting on your answer"].filter(Boolean).join(" · "),
        due: r.start_date || null,
        bucket: r.start_date && r.start_date <= today ? "late" : "today",
        route: { app: "crewcore", view: "timeoff", param: String(r.id) },
      };
    });
}

/* ------------------------------------------------------------------ *
 * MARKETMACHINE: my campaign steps.
 *
 * Steps still waiting on somebody else's step are left off, the same call My
 * tasks makes: telling a person to do something they cannot start yet is how
 * a list stops being believed.
 * ------------------------------------------------------------------ */

export function taskItems(tasks, today) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && !t.waitingOn)
    .map((t) => ({
      id: "mm:" + t.campaignId + ":" + t.key,
      source: "marketmachine",
      app: "marketmachine",
      title: t.label,
      detail: t.campaignName + (t.blocked ? " · blocked: " + t.blocked : ""),
      due: t.due || null,
      bucket: t.overdue ? "late" : bucketFor(t.due, today),
      route: { app: "marketmachine", view: "tasks", param: null },
    }));
}

/* ------------------------------------------------------------------ *
 * CONCONTROL: open social decisions and posts that slipped.
 *
 * The route already worked these out (socialBlockers); this only reshapes
 * them. Shown to the Admin flag only: the decisions are Ryan's by the
 * handoff, and so is social posting.
 * ------------------------------------------------------------------ */

export function socialItems(blockers, today) {
  return (Array.isArray(blockers) ? blockers : []).map((b) => {
    if (b.kind === "decision") {
      return {
        id: "cc-dec:" + b.id,
        source: "concontrol",
        app: "concontrol",
        title: "Decide: " + b.question,
        detail: "Flyover Con social plan",
        due: b.needed_by || null,
        bucket: bucketFor(b.needed_by, today),
        route: { app: "concontrol", view: "social", param: null },
      };
    }
    const what = b.kind === "post-overdue" ? "Not marked posted"
      : b.kind === "post-no-copy" ? "Still needs copy"
      : "Waiting on " + ((b.on && b.on[0]) || "something");
    return {
      id: "cc-post:" + b.id,
      source: "concontrol",
      app: "concontrol",
      title: b.title || "Social post",
      detail: what,
      due: b.date || null,
      bucket: b.kind === "post-overdue" ? "late" : bucketFor(b.date, today),
      route: { app: "concontrol", view: "social", param: null },
    };
  });
}

/* ------------------------------------------------------------------ *
 * GROUPING
 * ------------------------------------------------------------------ */

/**
 * One record, one row. A notification linked to an inquiry and that same
 * inquiry sitting past its clock are one piece of work, and listing it twice
 * makes the list look longer than the day is. The notification wins: it has
 * the Done button and says who asked. It takes the more urgent of the two
 * buckets, so a stalled inquiry behind an undated notification still reads
 * as late.
 */
export function dedupeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const key = (it) => (it.route && it.route.param ? it.route.app + "|" + it.route.param : null);
  const rank = (b) => { const i = BUCKET_KEYS.indexOf(b); return i < 0 ? BUCKET_KEYS.length : i; };
  const byRecord = new Map();
  list.forEach((it) => { if (it.notificationId && key(it)) byRecord.set(key(it), it); });
  const out = [];
  list.forEach((it) => {
    const k = key(it);
    const n = k ? byRecord.get(k) : null;
    if (n && n !== it) {
      if (rank(it.bucket) < rank(n.bucket)) n.bucket = it.bucket;
      return;
    }
    out.push(it);
  });
  return out;
}

/** Items grouped into the four buckets, soonest due first inside each. */
export function groupItems(items) {
  const groups = Object.fromEntries(BUCKET_KEYS.map((k) => [k, []]));
  (Array.isArray(items) ? items : []).forEach((it) => {
    const k = BUCKET_KEYS.includes(it.bucket) ? it.bucket : "open";
    groups[k].push(it);
  });
  BUCKET_KEYS.forEach((k) => {
    groups[k].sort((a, b) => {
      const ad = a.due || "9999-99-99";
      const bd = b.due || "9999-99-99";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.title).localeCompare(String(b.title));
    });
  });
  return groups;
}

/** The greeting line. Shop time, so a 7am login in Iowa says morning. */
export function greetingFor(hour) {
  const h = Number(hour);
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** First name for the greeting. */
export function firstName(name, username) {
  const n = String(name || "").trim();
  if (n) return n.split(/\s+/)[0];
  const u = String(username || "").trim();
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
}
