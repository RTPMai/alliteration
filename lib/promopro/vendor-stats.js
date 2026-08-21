// lib/promopro/vendor-stats.js — how a vendor has actually performed.
//
// WHY THIS IS SEPARATE FROM THE HAND-SET RATING
// A vendor record carries a 1 to 5 that somebody typed. This file carries
// what the purchase orders themselves say. They answer different questions
// and they are allowed to disagree: a supplier who is always three days late
// but always fixes their own mistakes may still be worth a 5, and the point
// of showing both is that the disagreement is visible instead of being
// averaged into one number that means nothing.
//
// THE RULE THIS FILE FOLLOWS: A THIN RECORD REPORTS AS THIN, NOT AS GOOD.
// Two orders is not a track record. Every figure here carries the count it
// was computed from, and the overall score is null until there is enough
// history to mean anything. A vendor scored 100 out of 100 on one lucky order
// is worse than no score, because somebody will make a buying decision on it.
//
// ESM. Do NOT convert to module.exports.

import { currentStage, CANCELLED } from "./schema.js";

// Below this many completed orders, no overall score is offered at all.
export const MIN_ORDERS_FOR_SCORE = 3;

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(String(fromIso).slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(String(toIso).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function mean(list) {
  if (!list.length) return null;
  const sum = list.reduce((a, b) => a + b, 0);
  return Math.round((sum / list.length) * 10) / 10;
}

/**
 * The performance record for ONE vendor, from the purchase orders raised
 * against them.
 *
 * Every measure is opt-in on the data being there. A PO that was never
 * submitted cannot say anything about response time, and it is left out
 * rather than counted as instant.
 */
export function vendorStats(vendor, pos) {
  const mine = (Array.isArray(pos) ? pos : []).filter((p) => p && p.vendorId === (vendor && vendor.id));

  const responseDays = [];   // submitted -> confirmed
  const deliveryDays = [];   // submitted -> received
  const lateAgainstLead = []; // 1 when received later than the quoted lead time
  let completed = 0;
  let cancelled = 0;
  let open = 0;

  mine.forEach((po) => {
    const stage = currentStage(po);
    if (stage === CANCELLED) { cancelled += 1; return; }

    const done = stage === "received" || stage === "closed";
    if (done) completed += 1; else open += 1;

    const resp = daysBetween(po.submittedAt, po.confirmedAt);
    if (resp !== null && resp >= 0) responseDays.push(resp);

    const del = daysBetween(po.submittedAt, po.receivedAt);
    if (del !== null && del >= 0) {
      deliveryDays.push(del);
      const promised = Number(vendor && vendor.leadDays);
      // Only judge lateness where a lead time was actually set. A vendor with
      // no lead time on file has not promised anything, so nothing can be
      // late against it.
      if (Number.isFinite(promised) && promised > 0) {
        lateAgainstLead.push(del > promised ? 1 : 0);
      }
    }
  });

  const onTimeSample = lateAgainstLead.length;
  const onTimeRate = onTimeSample
    ? Math.round(((onTimeSample - lateAgainstLead.reduce((a, b) => a + b, 0)) / onTimeSample) * 100)
    : null;

  const stats = {
    vendorId: vendor && vendor.id,
    orders: mine.length,
    completed,
    open,
    cancelled,
    avgResponseDays: mean(responseDays),
    responseSample: responseDays.length,
    avgDeliveryDays: mean(deliveryDays),
    deliverySample: deliveryDays.length,
    onTimeRate,
    onTimeSample,
    spend: Math.round(mine.reduce((acc, p) => acc + poSpend(p), 0) * 100) / 100,
  };

  stats.score = scoreFrom(stats, vendor);
  stats.scoreBasis = stats.score === null
    ? `not enough finished orders yet (${completed} of ${MIN_ORDERS_FOR_SCORE})`
    : "";

  return stats;
}

function poSpend(po) {
  const lines = Array.isArray(po && po.lines) ? po.lines : [];
  return lines.reduce((acc, l) => acc + ((Number(l.qty) || 0) * (Number(l.unitCost) || 0)), 0);
}

/**
 * One 0 to 100 number, or null when the history is too thin to carry one.
 *
 * Two parts only, both of which come from dates somebody actually recorded:
 * did the goods land inside the quoted lead time, and how fast did they
 * answer. No weighting on spend or order count, because a big vendor being
 * late is not more forgivable than a small one being late.
 */
export function scoreFrom(stats, vendor) {
  if (!stats || stats.completed < MIN_ORDERS_FOR_SCORE) return null;

  const parts = [];

  if (stats.onTimeRate !== null) parts.push({ value: stats.onTimeRate, weight: 2 });

  if (stats.avgResponseDays !== null) {
    // A reply inside the chase window scores full marks; twice the window
    // scores zero. Uses the vendor's own override where they have one, so a
    // supplier we already know is slow is judged against what we expect of
    // them rather than against the shop default.
    const window = Number(vendor && vendor.responseDays) > 0 ? Number(vendor.responseDays) : 3;
    const ratio = stats.avgResponseDays / window;
    const pts = Math.max(0, Math.min(100, Math.round((2 - ratio) * 100)));
    parts.push({ value: pts, weight: 1 });
  }

  if (!parts.length) return null;

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const weighted = parts.reduce((a, p) => a + p.value * p.weight, 0);
  return Math.round(weighted / totalWeight);
}

/** Attach a stats block to every vendor, for the vendors route. */
export function withStats(vendors, pos) {
  return (Array.isArray(vendors) ? vendors : []).map((v) => ({ ...v, stats: vendorStats(v, pos) }));
}

/**
 * The banner text for a blacklisted vendor, in one place so the create form,
 * the send route and the vendor list all say the same thing.
 */
export function blacklistWarning(vendor) {
  if (!vendor || vendor.blacklisted !== true) return "";
  const reason = String(vendor.blacklistReason || "").trim();
  return `${vendor.name} is blacklisted.` + (reason ? ` Reason: ${reason}` : "");
}
