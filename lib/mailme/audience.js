// lib/mailme/audience.js — who is worth emailing, and who must not be.
//
// PURE. No storage, no network, no clock beyond an injected `now`. Every
// function here decides whether a real person receives a real email, so all
// of it is directly testable and none of it guesses at the current time
// implicitly (a hidden Date.now() makes "customer is 100 days overdue" a test
// that passes today and fails next month).
//
// THE POINT OF THIS FILE. Cold outreach converts at roughly 1-3%. A reorder
// nudge to an existing customer who is past their normal cadence converts far
// better, and P&M already has the data to find those people: the Printavo
// sync stores last_invoice_date and median_gap_days per customer. This turns
// that into audiences.
//
// ESM. Do NOT convert to module.exports.

// ---- Reorder timing ----------------------------------------------------

// The ONE import in this file. Duplicate detection has to normalize the
// same way suppression does, or an address could be deduped here and not
// suppressed there. schema.js is pure and imports nothing, so this adds no
// dependency chain and no cycle.
import { normalizeEmail } from "./schema.js";

export const REORDER_STATES = ["not-due", "due", "overdue", "lapsed", "unknown"];

/**
 * Default thresholds, expressed as MULTIPLES of a customer's own median gap
 * rather than fixed day counts.
 *
 * A fixed "90 days since last order" rule is wrong for almost everyone: a
 * school district ordering twice a year is not late at day 90, and a
 * contractor ordering fortnightly is very late. Scaling to each customer's
 * own rhythm is the only version that means the same thing across the roster.
 */
export const DEFAULT_REORDER = {
  dueAt: 1.0,        // at their normal gap
  overdueAt: 1.5,    // half again past it
  lapsedAt: 3.0,     // three times their gap: probably lost, not late
  minOrders: 3,      // fewer orders than this and the median is not a pattern
  minGapDays: 7,     // ignore absurdly short medians (see note below)
};

function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

export function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/**
 * Where a customer sits against their own reorder rhythm.
 *
 * Returns { state, daysSince, expectedGap, ratio, confident }.
 *
 * `confident` is false when the customer has too few orders for a median to
 * mean anything, or when their median gap is implausibly short. Both happen
 * in the real roster: several accounts show median_gap_days under 1, which
 * reflects multiple invoices raised on the same job rather than a customer
 * who genuinely orders daily. Emailing those as "overdue" every afternoon
 * would be embarrassing, so they are reported as unknown rather than due.
 */
export function reorderStatus(customer, opts) {
  const o = { ...DEFAULT_REORDER, ...(opts || {}) };
  const now = (opts && opts.now) ? new Date(opts.now) : new Date();
  const c = customer || {};

  const last = parseDate(c.last_invoice_date);
  const gap = Number(c.median_gap_days);
  const orders = Number(c.invoice_count) || 0;

  if (!last) {
    return { state: "unknown", daysSince: null, expectedGap: null, ratio: null, confident: false };
  }

  const daysSince = daysBetween(last, now);

  const usable = orders >= o.minOrders && gap > 0 && gap >= o.minGapDays;
  if (!usable) {
    return { state: "unknown", daysSince, expectedGap: gap > 0 ? gap : null, ratio: null, confident: false };
  }

  const ratio = daysSince / gap;
  let state = "not-due";
  if (ratio >= o.lapsedAt) state = "lapsed";
  else if (ratio >= o.overdueAt) state = "overdue";
  else if (ratio >= o.dueAt) state = "due";

  return {
    state,
    daysSince,
    expectedGap: Math.round(gap * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    confident: true,
  };
}

/** Revenue for the current calendar year, from the sync's per-year map. */
export function ytdRevenue(customer, now) {
  const year = String((now ? new Date(now) : new Date()).getFullYear());
  const map = (customer && customer.revenue_by_year) || {};
  return Number(map[year] || 0);
}

/**
 * Year-over-year direction at the SAME point in the year.
 *
 * Comparing this year's partial total against last year's full total always
 * shows a fall, which would flag the entire roster as declining every January.
 * Prior-year revenue is therefore prorated by how far through the year we are.
 * That is an approximation (it assumes even spread, and apparel is seasonal),
 * so it is reported as a direction, never as a precise percentage to act on.
 */
export function revenueTrend(customer, now) {
  const d = now ? new Date(now) : new Date();
  const year = d.getFullYear();
  const map = (customer && customer.revenue_by_year) || {};
  const thisYear = Number(map[String(year)] || 0);
  const lastYear = Number(map[String(year - 1)] || 0);
  if (!lastYear) return { direction: "unknown", thisYear, lastYear };

  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const fraction = Math.min(1, Math.max(0.02, daysBetween(startOfYear, d) / 365));
  const prorated = lastYear * fraction;

  const ratio = prorated > 0 ? thisYear / prorated : 0;
  const direction = ratio >= 1.15 ? "up" : ratio <= 0.85 ? "down" : "flat";
  return { direction, thisYear, lastYear, prorated: Math.round(prorated), ratio: Math.round(ratio * 100) / 100 };
}

// ---- Send eligibility --------------------------------------------------

export const DEFAULT_POLICY = {
  // Frequency cap. Nothing else stops the same person receiving three
  // campaigns in a week because they happen to match three lists.
  minDaysBetweenEmails: 14,
  // Cold sending ramp. Going from zero to hundreds of cold emails a day on a
  // new domain is itself a spam signal, so the cap climbs over weeks.
  coldDailyCapStart: 20,
  coldDailyCapMax: 200,
  coldRampDays: 30,
  clientDailyCap: 1000,
  // Skip anyone an AM is actively quoting. Cold-blasting a prospect someone
  // is mid-deal with is the kind of thing that costs the deal.
  skipOpenQuotes: true,
  // Addresses a verification pass marked undeliverable.
  skipInvalidVerification: true,
};

export const VERIFICATION_STATUSES = ["unverified", "valid", "risky", "invalid"];

/**
 * The cold-sending daily cap on a given day of the warm-up.
 *
 * Linear ramp from start to max across rampDays. Linear rather than doubling
 * because a doubling schedule spends most of its time at trivial volumes and
 * then jumps, and the jump is what gets noticed.
 */
export function coldDailyCap(dayIndex, policy) {
  const p = { ...DEFAULT_POLICY, ...(policy || {}) };
  const day = Math.max(0, Number(dayIndex) || 0);
  if (day >= p.coldRampDays) return p.coldDailyCapMax;
  const span = p.coldDailyCapMax - p.coldDailyCapStart;
  return Math.round(p.coldDailyCapStart + (span * (day / p.coldRampDays)));
}

/**
 * Can this contact be emailed right now?
 *
 * Returns { ok, reason }. Reasons are user-facing strings: the Contacts view
 * shows them, so "why is this person not in my send?" is answerable without
 * reading code.
 *
 * Suppression is NOT checked here — that happens earlier, in
 * selectRecipients, and is absolute. This layer covers the softer rules that
 * a person might reasonably want to override for a specific campaign.
 */
export function sendEligibility(contact, opts) {
  const o = opts || {};
  const p = { ...DEFAULT_POLICY, ...(o.policy || {}) };
  const now = o.now ? new Date(o.now) : new Date();
  const c = contact || {};

  if (p.skipInvalidVerification && c.verification === "invalid") {
    return { ok: false, reason: "Address failed verification" };
  }

  if (p.skipOpenQuotes && c.hasOpenQuote) {
    return { ok: false, reason: "Has an open quote; an AM is working this account" };
  }

  if (c.lastEmailedAt) {
    const last = parseDate(c.lastEmailedAt);
    if (last) {
      const days = daysBetween(last, now);
      if (days < p.minDaysBetweenEmails) {
        return {
          ok: false,
          reason: `Emailed ${days} day${days === 1 ? "" : "s"} ago; the cap is one every ${p.minDaysBetweenEmails}`,
        };
      }
    }
  }

  return { ok: true, reason: null };
}

/** Split an audience into who would be sent to and who would be held back. */
export function applyEligibility(contacts, opts) {
  const send = [];
  const held = [];
  // One MAILBOX gets one email, even when it appears on several contact
  // records. The same person legitimately shows up more than once here: a
  // roster can hold them under two companies, and a prospect import can
  // reintroduce someone who is already a client. Those are distinct
  // records with distinct history and should stay distinct, but sending
  // the same campaign to the same inbox twice reads as spam to the
  // recipient and to their mail provider.
  //
  // First record wins, and the duplicate is HELD rather than dropped, so
  // it shows up in the held list with a reason instead of vanishing from
  // the recipient count with no explanation.
  const seen = new Map();
  for (const c of contacts || []) {
    const r = sendEligibility(c, opts);
    if (!r.ok) { held.push({ ...c, heldReason: r.reason }); continue; }

    const key = normalizeEmail(c.email);
    if (key && seen.has(key)) {
      const first = seen.get(key);
      held.push({
        ...c,
        heldReason: `Same email as ${first.company_name || first.email}, which is already on this send`,
      });
      continue;
    }
    if (key) seen.set(key, c);
    send.push(c);
  }
  return { send, held };
}

// ---- Compliance --------------------------------------------------------

/**
 * What must be true before ANY commercial email can go out.
 *
 * CAN-SPAM requires a real physical postal address and a working opt-out in
 * every commercial message. These are not optional niceties, and a missing
 * postal address is the single most commonly missed requirement, so it is
 * checked as a hard blocker rather than left to memory.
 */
export function complianceBlockers(settings) {
  const s = settings || {};
  const out = [];

  const addr = s.postalAddress || {};
  const missing = ["line1", "city", "state", "postalCode"].filter((k) => !String(addr[k] || "").trim());
  if (missing.length) {
    out.push({
      field: "postalAddress",
      text: "A physical postal address is required in every commercial email by CAN-SPAM. Missing: " + missing.join(", ") + ".",
    });
  }

  if (!String(s.unsubscribeUrl || "").trim()) {
    out.push({
      field: "unsubscribeUrl",
      text: "Every commercial email needs a working unsubscribe link.",
    });
  }

  if (!String(s.fromName || "").trim()) {
    out.push({ field: "fromName", text: "A from-name is required so recipients can tell who is writing." });
  }

  return out;
}

/** The footer every commercial send must carry. */
export function complianceFooter(settings, contact) {
  const s = settings || {};
  const a = s.postalAddress || {};
  const lines = [];

  const who = s.companyName || s.fromName || "";
  const addr = [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode]
    .filter((x) => String(x || "").trim()).join(", ");

  if (who || addr) lines.push([who, addr].filter(Boolean).join(" · "));

  const token = contact && contact.unsubToken ? contact.unsubToken : "{{unsubscribe_token}}";
  const base = String(s.unsubscribeUrl || "").replace(/\/+$/, "");
  if (base) lines.push(`Unsubscribe: ${base}?t=${token}`);

  return lines.join("\n");
}

// ---- Reporting caveats -------------------------------------------------

/**
 * Whether an open rate should be trusted.
 *
 * Apple Mail Privacy Protection pre-fetches tracking images, registering an
 * "open" whether or not a human ever looked. Depending on audience mix that
 * inflates opens by roughly a third to a half, and it does NOT affect clicks.
 *
 * This exists so the UI can label open rate as indicative and lead with
 * clicks instead. Segmenting on "opened but didn't click" is specifically
 * unsafe, because a large share of those opens are machines.
 */
export const OPEN_RATE_CAVEAT =
  "Open rates are inflated by Apple Mail Privacy Protection and similar image " +
  "pre-fetching, which registers an open with no human involved. Treat opens as " +
  "indicative only, judge campaigns on clicks and replies, and never build a " +
  "segment from 'opened but did not click'.";

export function primaryMetric(stats) {
  const s = stats || {};
  // Replies beat clicks where they exist: for cold outreach a reply is the
  // only outcome that means anything. Clicks beat opens always.
  if (s.replies) return { key: "replies", label: "Replies", value: s.replies };
  if (s.uniqueClicks) return { key: "clicks", label: "Unique clicks", value: s.uniqueClicks };
  return { key: "clicks", label: "Unique clicks", value: 0 };
}
