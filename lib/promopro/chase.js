// lib/promopro/chase.js — deciding which purchase orders need chasing, and
// who hears about it.
//
// THE GAP THIS CLOSES
// PromoPro computed a health colour and a silence clock from day one, and
// both only existed while somebody had the app open. A vendor going quiet
// for eight days looked exactly like a vendor who replied yesterday to
// anybody who did not happen to be looking at the Pipeline that morning,
// which is the failure the app was built to end. The clock has to reach a
// person.
//
// WHY NOTIFICATIONS RATHER THAN EMAIL
// The shell already has an assigned to-do list with a badge in the header
// and a per-person view. A second, PromoPro-shaped inbox would be a second
// place to check and the second place is the one that stops being checked.
// An email digest is available on top, off by default, for whoever wants it.
//
// THE RULE THAT KEEPS THIS FROM BECOMING NOISE
// ONE open notification per purchase order, updated in place, never a new
// one each morning. A daily re-post is how alerting gets muted, and a muted
// alert is worse than none because everybody believes it is still working.
// When the PO recovers, the notification is closed automatically rather than
// left for somebody to tidy up.
//
// ESM. Do NOT convert to module.exports.

import { poHealth, currentStage, receiptSummary, withSettingDefaults } from "./schema.js";

// The tag that ties a notification back to the PO that raised it. Not a
// `link` (LINK_TYPES has no purchase-order member and adding one would touch
// the notifications schema for every app), so it rides in the title and in
// this marker field, which api/notifications.js passes through untouched.
export const CHASE_SOURCE = "promopro-chase";

/**
 * Which POs need chasing right now, and what to say about each.
 *
 * Returns [{ poId, poNumber, level, assignedTo, title }]. Pure: no reads, no
 * writes, so the whole decision is testable without a database.
 */
export function chaseList(pos, vendors, settings, today) {
  const s = withSettingDefaults(settings);
  const now = today || new Date().toISOString().slice(0, 10);
  const byId = new Map((Array.isArray(vendors) ? vendors : []).map((v) => [v.id, v]));
  const out = [];

  (Array.isArray(pos) ? pos : []).forEach((po) => {
    const stage = currentStage(po);
    if (stage === "closed" || stage === "cancelled") return;

    const vendor = byId.get(po.vendorId) || null;
    const health = poHealth(po, vendor, now, { chaseAfterDays: s.chaseAfterDays });
    if (health.level !== "amber" && health.level !== "red") return;

    // A PO nobody owns cannot be chased by anybody, which is exactly the
    // situation validateNew() refuses to create. If one exists from before
    // that rule, it is reported rather than skipped: an unassigned late
    // order is a worse problem than a late one, not a lesser one.
    const assignedTo = String(po.accountManager || "").toLowerCase();

    const who = vendor ? vendor.name : "an unknown vendor";
    const reasons = health.reasons.length ? health.reasons.join(", ") : "needs attention";

    const recv = receiptSummary(po);
    const shortNote = recv.partial ? `, ${recv.outstanding} still outstanding` : "";

    out.push({
      poId: po.id,
      poNumber: po.poNumber || "draft",
      level: health.level,
      stage,
      assignedTo,
      vendorName: who,
      title: `${po.poNumber || "Draft PO"} at ${who}: ${reasons}${shortNote}`,
    });
  });

  // Worst first, so a digest that gets skimmed is skimmed in the right order.
  return out.sort((a, b) => {
    if (a.level !== b.level) return a.level === "red" ? -1 : 1;
    return String(a.poNumber).localeCompare(String(b.poNumber));
  });
}

/**
 * Work out the writes needed to bring the notification list in step with the
 * chase list. Also pure: the cron does the reading and writing.
 *
 * `existing` is every notification currently carrying our source marker.
 *
 *   create  — a PO that has gone amber or red with nothing open on it
 *   update  — the title or the assignee changed (it got worse, or the AM
 *             changed hands). Updated in place so the badge does not
 *             re-fire every morning for the same order.
 *   close   — the PO recovered, was received or was cancelled
 */
export function reconcileChases(chases, existing) {
  const wanted = new Map((Array.isArray(chases) ? chases : []).map((c) => [c.poId, c]));
  const open = (Array.isArray(existing) ? existing : []).filter((n) => n.status !== "done");

  const seen = new Set();
  const updates = [];
  const closes = [];

  open.forEach((n) => {
    const poId = n.chasePoId;
    const want = wanted.get(poId);
    if (!want) {
      closes.push({ id: n.id, poId });
      return;
    }
    seen.add(poId);
    if (n.title !== want.title || n.assignedTo !== want.assignedTo) {
      updates.push({ id: n.id, title: want.title, assignedTo: want.assignedTo, chasePoId: poId });
    }
  });

  const creates = [...wanted.values()].filter((c) => !seen.has(c.poId));

  return { creates, updates, closes };
}

/** The plain-text digest, for the optional daily email. */
export function digestText(chases) {
  if (!chases.length) return "Nothing is overdue this morning.";
  const red = chases.filter((c) => c.level === "red");
  const amber = chases.filter((c) => c.level === "amber");
  const out = [];
  if (red.length) {
    out.push(`Badly overdue (${red.length}):`);
    red.forEach((c) => out.push(`  ${c.title}`));
    out.push("");
  }
  if (amber.length) {
    out.push(`Getting late (${amber.length}):`);
    amber.forEach((c) => out.push(`  ${c.title}`));
  }
  return out.join("\n").trim();
}
