// PUT IN: lib/backbone/referrals.js
// lib/backbone/referrals.js: who sent us whom.
//
// Sep 30 2026. Ryan's call on how far this goes: the full loop, with one
// hard line. "I do not want our client list to be public." So:
//
//   * The public inquiry form stays FREE TEXT. It already asks "How did you
//     hear about us?" and lets people type who referred them. It never gets a
//     client picker, a search box or suggestions, because any of those would
//     hand our client list to whoever loads the page.
//   * Matching the typed name to a real client happens INSIDE BackBone,
//     behind the login, by an account manager. suggestReferrers() below only
//     ever runs on the signed-in screen.
//
// THE RULES come from MarketMachine's Referral campaign (lib/marketmachine/
// catalog.js), so the two apps count the same way:
//
//   * A referral only counts once an account manager confirms it.
//   * The same referred person counts once.
//   * The year ends November 30. A referral dated in December belongs to the
//     NEXT fiscal year. Never a rolling twelve months.
//   * Referrers are ranked on distinct confirmed referred people. Revenue is
//     shown next to it and is never the tie-breaker; a tie is reported as a
//     tie.
//   * Log the referred person's own wording, and thank the referrer.
//
// Every record is stored whole in one list (see referral-store.js) rather
// than as fields on a lead or a client row. A client row is rebuilt from
// Printavo by the sync, and a lead is one of many ways a referred person
// arrives, so neither is a safe home for the count.

import { rosterMatches, normalizeCo } from "./inquiries.js";

export const REFERRAL_STATUSES = ["to_confirm", "confirmed", "not_referral"];

export const STATUS_LABELS = {
  to_confirm: "To confirm",
  confirmed: "Confirmed",
  not_referral: "Not a referral",
};

export const THANK_METHODS = ["Card", "Email", "Phone call", "Gift", "In person", "Other"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500;

function clean(v, max = 200) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanId(v) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, 64) : null;
}

function isDay(s) {
  if (!DAY.test(String(s || ""))) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

/** Today as YYYY-MM-DD in Central time, the shop's day. */
export function shopToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * The fiscal year a day belongs to, named by the year it ENDS in.
 * Dec 1 2025 through Nov 30 2026 is fiscal 2026.
 */
export function fiscalYear(day) {
  if (!isDay(day)) return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 12 ? y + 1 : y;
}

/** "Dec 1 2025 to Nov 30 2026" for fiscal 2026. */
export function fiscalRange(fy) {
  const n = Number(fy);
  if (!Number.isInteger(n)) return "";
  return "Dec 1 " + (n - 1) + " to Nov 30 " + n;
}

/**
 * The key that makes "the same referred person counts once" work. A real
 * client id wins, then the lead it came in as, then the name.
 */
export function referredKey(r) {
  if (!r) return "";
  if (r.referred_customer_id) return "c:" + r.referred_customer_id;
  if (r.referred_lead_id) return "l:" + r.referred_lead_id;
  const n = normalizeCo(r.referred_name);
  return n ? "n:" + n : "";
}

/** Who the referrer is, for grouping. A client id wins over the typed name. */
export function referrerKey(r) {
  if (!r) return "";
  if (r.referrer_customer_id) return "c:" + r.referrer_customer_id;
  const n = normalizeCo(r.referrer_name);
  return n ? "n:" + n : "";
}

/**
 * Check and tidy a new referral or an edit to one.
 * Status, confirmation and thanks are NOT set here; they have their own
 * steps below so the history says who did what.
 */
export function validateReferral(input, { partial = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const errors = [];
  const value = {};

  if (src.referred_name !== undefined || !partial) {
    value.referred_name = clean(src.referred_name);
    if (!value.referred_name) errors.push("Who was referred? Enter their name or company.");
  }
  if (src.referred_customer_id !== undefined) value.referred_customer_id = cleanId(src.referred_customer_id);
  if (src.referred_lead_id !== undefined) value.referred_lead_id = cleanId(src.referred_lead_id);

  if (src.referrer_name !== undefined) value.referrer_name = clean(src.referrer_name);
  if (src.referrer_customer_id !== undefined) value.referrer_customer_id = cleanId(src.referrer_customer_id);

  // What they actually said, kept word for word (trimmed). The catalog asks
  // for the original wording, because "my cousin at the Y" is how a match
  // gets checked later.
  if (src.said !== undefined) value.said = String(src.said == null ? "" : src.said).trim().slice(0, MAX_TEXT);
  if (src.note !== undefined) value.note = String(src.note == null ? "" : src.note).trim().slice(0, MAX_TEXT);

  if (src.referred_at !== undefined || !partial) {
    const d = src.referred_at == null || src.referred_at === "" ? null : String(src.referred_at).trim();
    if (d && !isDay(d)) errors.push("The referral date has to be a real date.");
    else if (d) value.referred_at = d;
  }

  return { ok: errors.length === 0, errors, value };
}

function stamp(rec, entry) {
  const history = Array.isArray(rec.history) ? rec.history.slice(-29) : [];
  history.push(entry);
  return history;
}

/** A brand new record from validated input. */
export function newReferral(value, { id, by, now = new Date() } = {}) {
  const at = now.toISOString();
  const rec = {
    id,
    referred_name: value.referred_name,
    referred_customer_id: value.referred_customer_id || null,
    referred_lead_id: value.referred_lead_id || null,
    referrer_name: value.referrer_name || "",
    referrer_customer_id: value.referrer_customer_id || null,
    said: value.said || "",
    note: value.note || "",
    referred_at: value.referred_at || shopToday(now),
    status: "to_confirm",
    confirmed_by: null, confirmed_at: null,
    thanked_at: null, thanked_how: null, thanked_by: null,
    created_by: by || null, created_at: at, updated_at: at,
    history: [],
  };
  rec.history = stamp(rec, { at, by: by || null, what: "logged" });
  return rec;
}

/** Apply a validated edit. Editing who referred whom sends it back to be confirmed. */
export function editReferral(rec, value, { by, now = new Date() } = {}) {
  const next = { ...rec, ...value };
  const who = (r) => referrerKey(r) + "|" + referredKey(r);
  const changedWho = who(rec) !== who(next);
  if (changedWho && rec.status === "confirmed") {
    next.status = "to_confirm";
    next.confirmed_by = null;
    next.confirmed_at = null;
  }
  next.updated_at = now.toISOString();
  next.history = stamp(rec, {
    at: next.updated_at, by: by || null,
    what: changedWho && rec.status === "confirmed" ? "edited, needs confirming again" : "edited",
  });
  return next;
}

/**
 * An account manager says yes, this is a real referral from this person.
 * A referrer is required: "confirmed, from nobody" cannot be ranked.
 */
export function confirmReferral(rec, { by, now = new Date() } = {}) {
  if (!referrerKey(rec)) {
    return { ok: false, error: "Pick or type who referred them before confirming." };
  }
  const at = now.toISOString();
  return {
    ok: true,
    record: {
      ...rec, status: "confirmed", confirmed_by: by || null, confirmed_at: at, updated_at: at,
      history: stamp(rec, { at, by: by || null, what: "confirmed" }),
    },
  };
}

export function rejectReferral(rec, { by, now = new Date() } = {}) {
  const at = now.toISOString();
  return {
    ...rec, status: "not_referral", confirmed_by: null, confirmed_at: null, updated_at: at,
    history: stamp(rec, { at, by: by || null, what: "marked not a referral" }),
  };
}

export function reopenReferral(rec, { by, now = new Date() } = {}) {
  const at = now.toISOString();
  return {
    ...rec, status: "to_confirm", confirmed_by: null, confirmed_at: null, updated_at: at,
    history: stamp(rec, { at, by: by || null, what: "reopened" }),
  };
}

/** Record that the referrer was thanked, how and when. `how: null` clears it. */
export function thankReferral(rec, { how, on, by, now = new Date() } = {}) {
  const at = now.toISOString();
  if (how == null || how === "") {
    return {
      ok: true,
      record: {
        ...rec, thanked_at: null, thanked_how: null, thanked_by: null, updated_at: at,
        history: stamp(rec, { at, by: by || null, what: "thank-you cleared" }),
      },
    };
  }
  if (THANK_METHODS.indexOf(how) === -1) return { ok: false, error: "Pick how they were thanked." };
  const day = on ? String(on).trim() : shopToday(now);
  if (!isDay(day)) return { ok: false, error: "The thank-you date has to be a real date." };
  return {
    ok: true,
    record: {
      ...rec, thanked_at: day, thanked_how: how, thanked_by: by || null, updated_at: at,
      history: stamp(rec, { at, by: by || null, what: "thanked (" + how + ")" }),
    },
  };
}

/**
 * Are two records about the same referred person? Any shared identifier is
 * enough: the same client id, the same lead, or the same name once cleaned
 * up. A referral logged from an inquiry carries the lead; the same person
 * logged later from their client record carries the client id; the name is
 * what ties those two together.
 */
export function sameReferred(a, b) {
  if (!a || !b) return false;
  if (a.referred_customer_id && b.referred_customer_id &&
      String(a.referred_customer_id) === String(b.referred_customer_id)) return true;
  if (a.referred_lead_id && b.referred_lead_id && a.referred_lead_id === b.referred_lead_id) return true;
  const x = normalizeCo(a.referred_name);
  return !!x && x === normalizeCo(b.referred_name);
}

/**
 * Is somebody already logged as referred? Returns the existing live record
 * or null. "Not a referral" records do not block a new one.
 */
export function findDuplicate(list, candidate, { ignoreId = null } = {}) {
  if (!referredKey(candidate)) return null;
  return (Array.isArray(list) ? list : []).find((r) =>
    r && r.id !== ignoreId && r.status !== "not_referral" && sameReferred(r, candidate)) || null;
}

/**
 * Likely referrers for what somebody typed, from the roster. Signed-in
 * screen only (see the top of this file). Returns [{customer_id, company_name}].
 */
export function suggestReferrers(said, roster, limit = 5) {
  const text = String(said || "").trim();
  if (!text) return [];
  return rosterMatches(text, roster, limit).map((m) => ({
    customer_id: String(m.rec.customer_id),
    company_name: m.rec.company_name || m.rec.name || "",
  }));
}

/**
 * What an account set to "own accounts only" may see. BackBone's roster
 * route (api/data.js) narrows those accounts to their own clients, and a
 * referral names clients, so the same line applies here: a referral is
 * visible when either side is one of their clients, or they logged it
 * themselves. `ownIds` null means the account sees everything.
 */
export function visibleReferrals(list, { ownIds = null, me = "" } = {}) {
  const all = Array.isArray(list) ? list : [];
  if (!ownIds) return all;
  const who = String(me || "").toLowerCase();
  return all.filter((r) => r && (
    (r.referred_customer_id && ownIds.has(String(r.referred_customer_id))) ||
    (r.referrer_customer_id && ownIds.has(String(r.referrer_customer_id))) ||
    (who && String(r.created_by || "").toLowerCase() === who)));
}

/** Referrals in a fiscal year, by the date the referral happened. */
export function referralsInYear(list, fy) {
  return (Array.isArray(list) ? list : []).filter((r) => r && fiscalYear(r.referred_at) === Number(fy));
}

/** Fiscal years that have any referral, newest first, always including this one. */
export function fiscalYears(list, now = new Date()) {
  const set = new Set([fiscalYear(shopToday(now))]);
  (Array.isArray(list) ? list : []).forEach((r) => {
    const fy = r && fiscalYear(r.referred_at);
    if (fy) set.add(fy);
  });
  return Array.from(set).sort((a, b) => b - a);
}

/**
 * The ranking for one fiscal year.
 *
 * Counts DISTINCT confirmed referred people per referrer, so logging the
 * same referral twice cannot move anybody up. Revenue and "has ordered" are
 * read off the roster for the referred client, and are context only: the
 * ranking never looks at them.
 *
 * Revenue is the referred client's LIFETIME figure from the roster. The
 * roster keeps revenue by calendar year, not by fiscal year, so a
 * "first order through November 30" window cannot be computed from it
 * honestly. The screen labels it as lifetime rather than pretending.
 *
 * @returns {{ rows: Array, tie: boolean, leader: object|null, toConfirm: number, unthanked: number }}
 */
export function rankReferrers(list, fy, roster) {
  const byId = {};
  (Array.isArray(roster) ? roster : []).forEach((c) => {
    if (c && c.customer_id != null) byId[String(c.customer_id)] = c;
  });
  const year = referralsInYear(list, fy);
  const groups = {};
  year.filter((r) => r.status === "confirmed").forEach((r) => {
    const k = referrerKey(r);
    if (!k) return;
    if (!groups[k]) {
      const c = r.referrer_customer_id ? byId[String(r.referrer_customer_id)] : null;
      groups[k] = {
        key: k,
        referrer_customer_id: r.referrer_customer_id || null,
        referrer_name: (c && c.company_name) || r.referrer_name || "Unknown",
        referred: new Set(),
        ordered: new Set(),
        revenue: 0,
        unthanked: 0,
        last: "",
      };
    }
    const g = groups[k];
    const rk = referredKey(r);
    if (!g.referred.has(rk)) {
      g.referred.add(rk);
      const rc = r.referred_customer_id ? byId[String(r.referred_customer_id)] : null;
      if (rc && Number(rc.invoice_count) > 0) {
        g.ordered.add(rk);
        g.revenue += Number(rc.total_revenue) || 0;
      }
    }
    if (!r.thanked_at) g.unthanked++;
    if (String(r.referred_at) > g.last) g.last = r.referred_at;
  });
  const rows = Object.values(groups).map((g) => ({
    key: g.key,
    referrer_customer_id: g.referrer_customer_id,
    referrer_name: g.referrer_name,
    count: g.referred.size,
    ordered: g.ordered.size,
    revenue: Math.round(g.revenue * 100) / 100,
    unthanked: g.unthanked,
    last: g.last,
  }));
  // Count, then name. Revenue is NEVER the tie-breaker.
  rows.sort((a, b) => b.count - a.count || a.referrer_name.localeCompare(b.referrer_name));
  let rank = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.count !== rows[i - 1].count) rank = i + 1;
    r.rank = rank;
  });
  const top = rows.filter((r) => r.rank === 1 && r.count > 0);
  return {
    rows,
    tie: top.length > 1,
    leader: top.length === 1 ? top[0] : null,
    toConfirm: year.filter((r) => r.status === "to_confirm").length,
    unthanked: year.filter((r) => r.status === "confirmed" && !r.thanked_at).length,
  };
}

/**
 * Does an inquiry look like a referral? The public form's "How did you hear
 * about us?" answer lands on the lead as a "Heard about us: Word of mouth,
 * <who>" line in its notes, and staff can set the source to "Referral" by
 * hand. Used to PREFILL "Log a referral", never to log one on its own: a
 * referral only counts once a person confirms it.
 *
 * @returns {{ said: string, who: string } | null}
 */
export function referralHintFromLead(lead) {
  const l = lead || {};
  const line = String(l.inquiry_notes || "").split("\n")
    .map((s) => s.trim()).find((s) => /^heard about us:/i.test(s)) || "";
  const heard = line.replace(/^heard about us:\s*/i, "");
  const looks = /word of mouth|referr|recommend/i.test(heard);
  if (!looks && l.source_type !== "Referral") return null;
  const who = looks ? heard.split(/,\s*/).slice(1).join(", ").trim() : "";
  return { said: heard, who };
}
