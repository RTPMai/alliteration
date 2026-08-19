// PUT IN: lib/reorder-settings.js
// lib/reorder-settings.js — reorder timing, owned by BackBone.
//
// WHY THIS IS NOT IN MAILME. "When is a customer late to reorder" is a fact
// about the customer relationship, not about email. BackBone is where the
// roster, the order history and the account manager live, so it is where the
// thresholds belong. MailMe reads them to build audiences; it does not own
// them. Anything else that wants to reason about buying cadence (a Capacity
// view, a follow-up agent, a dashboard card) reads the same values from here
// instead of growing its own copy.
//
// THRESHOLDS ARE MULTIPLES, NOT DAYS. Each one is a multiple of that
// customer's OWN median gap between orders. A school ordering twice a year is
// not late at day 90; a contractor ordering fortnightly very much is. A fixed
// day count cannot express both, which is the whole reason this shape exists.
//
// MIGRATION WITHOUT A MIGRATION. These values used to live inside MailMe's
// settings blob under `reorder`. getReorderSettings() takes an optional
// legacy object and falls back to it when the shared key has never been
// written. So the values Ryan already has keep applying from day one, with no
// copy step and nothing to run. The first save from BackBone writes the
// shared key and the fallback stops mattering.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "./kv.js";

const KEY = "backbone_reorder_settings";

// Same numbers the MailMe defaults carried, so nothing shifts underfoot on
// the day this ships. minGapDays is a floor against noise: two orders placed
// the same week give a median gap of days, which would mark a customer
// overdue almost immediately.
export const REORDER_DEFAULTS = Object.freeze({
  dueAt: 1.0,        // at their normal gap
  overdueAt: 1.5,    // half again past it
  lapsedAt: 3.0,     // three times their gap: probably lost, not late
  minOrders: 3,      // fewer orders than this and the median is not a pattern
  minGapDays: 7,     // ignore medians shorter than this as noise
});

// Number(null) and Number("") are both 0, which is finite and therefore
// sneaks past a naive isFinite check. A blank field would then store a zero
// threshold and mark nobody due, with nothing on screen to explain it.
const num = (v, fallback) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};

/**
 * Merge a partial/absent stored value onto the defaults. Kept separate from
 * the read so tests can exercise the shape without KV, and so a stored blob
 * missing a field added later still comes back complete.
 */
export function mergeReorder(stored, legacy) {
  const base = { ...REORDER_DEFAULTS, ...(legacy && typeof legacy === "object" ? legacy : {}) };
  const s = stored && typeof stored === "object" ? stored : {};
  return {
    dueAt: num(s.dueAt, base.dueAt),
    overdueAt: num(s.overdueAt, base.overdueAt),
    lapsedAt: num(s.lapsedAt, base.lapsedAt),
    minOrders: num(s.minOrders, base.minOrders),
    minGapDays: num(s.minGapDays, base.minGapDays),
  };
}

/**
 * Thresholds must increase. Due before overdue before lapsed is not a style
 * preference: reorderStatus() tests them in order and returns the first
 * match, so an out-of-order set silently makes a state unreachable rather
 * than erroring. Rejected at the door instead.
 */
export function validateReorder(r) {
  if (!(r.dueAt > 0 && r.overdueAt > 0 && r.lapsedAt > 0)) {
    return "Every threshold has to be greater than zero";
  }
  if (!(r.dueAt <= r.overdueAt && r.overdueAt <= r.lapsedAt)) {
    return "Thresholds must increase: due at or before overdue, overdue at or before lapsed";
  }
  if (!(r.minOrders >= 1)) return "Minimum orders has to be at least 1";
  if (!(r.minGapDays >= 0)) return "Minimum gap cannot be negative";
  return null;
}

/**
 * Read the shared thresholds.
 *
 * `legacy` is MailMe's old inline reorder block. It is used ONLY when this
 * key has never been written, so an existing install keeps its tuned numbers
 * instead of snapping back to defaults the moment this ships. Reading never
 * writes: a GET that quietly seeds a key turns a read outage into a data
 * change, and it would also fight a legitimate reset to defaults.
 *
 * Fails soft. If KV is unreachable the caller gets defaults rather than an
 * exception, because reorder timing decorates a contact row. A storage blip
 * should not take the whole Audience screen down over a pill that says "Due".
 */
export async function getReorderSettings(legacy) {
  let stored = null;
  try {
    stored = await getRaw(KEY);
  } catch (e) {
    stored = null;
  }
  return mergeReorder(stored, legacy);
}

/** Write the shared thresholds. Returns { ok, settings } or { ok:false, error }. */
export async function saveReorderSettings(patch) {
  const current = await getReorderSettings();
  const next = mergeReorder({ ...current, ...(patch || {}) });
  const error = validateReorder(next);
  if (error) return { ok: false, error };
  await setRaw(KEY, next);
  return { ok: true, settings: next };
}

export const REORDER_KEY = KEY;
