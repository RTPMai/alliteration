// PUT IN: lib/promopro/move-own.js
// lib/promopro/move-own.js — account managers moving their own orders along.
//
// THE ASK, Sep 24 2026. Account managers are copied on every vendor email for
// their orders, so they are often the first to know a vendor confirmed, a
// proof got approved or a box shipped. Raising and editing purchase orders is
// kept to the buyers named in Settings, which meant an AM who could see the
// vendor's "shipped today, tracking attached" had to go and ask a buyer to
// press one button.
//
// So there is a narrower right sitting under "raise and edit": MOVE ALONG.
//
//   WHO    the account manager on the order (or its owner), and nobody else.
//          Not every AM on every order: "they're on the emails for them" is
//          the reason, and you are only on the emails for your own.
//   WHAT   the progress ticks and their dates, carrier and tracking, and
//          logging a follow-up. Things that record what the vendor did.
//   NOT    vendor, lines, prices, account manager, ship-to, notes, needed-by,
//          outsourced, cancelling, sending, artwork, reorders, deleting.
//          Anything that changes what the vendor was told, or tells them
//          something new, stays with the buyers.
//
// Pure, and importing only schema.js, so the browser and the route use the
// SAME function. The screen hiding a button and the server refusing it must
// be one decision, or somebody gets a tick that looks saved and is not.
//
// ESM. Do NOT convert to module.exports.

import { DATE_FIELDS } from "./schema.js";

// Every field a "move along" PATCH may carry. `id` is how the order is named,
// `followUp` is the log-a-call action. cancelledAt is deliberately absent
// even though it is a date: cancelling emails the vendor.
export const MOVE_FIELDS = Object.freeze(
  DATE_FIELDS.filter((f) => f !== "cancelledAt").concat(["carrier", "trackingNumber", "followUp"])
);

const ALWAYS_OK = new Set(["id"]);

/**
 * Which keys in a PATCH body fall outside "move along". Empty means the body
 * is fine. Returned as a list so the refusal can name them rather than just
 * saying no.
 */
export function outsideMove(body) {
  const b = body && typeof body === "object" ? body : {};
  const allowed = new Set(MOVE_FIELDS);
  return Object.keys(b).filter((k) => b[k] !== undefined && !ALWAYS_OK.has(k) && !allowed.has(k));
}

/**
 * Is this order the caller's own?
 *
 * `meId` is the caller's CrewCore employee id (identifyAccountManager);
 * `username` is their shell login. The account manager on the order is the
 * main match. The owner is kept as a second match because it is who the
 * pipeline chases, and on older orders it is the only link there is.
 */
export function ownsPo(po, meId, username) {
  if (!po) return false;
  const id = String(meId || "").trim();
  if (id && String(po.accountManager || "").trim() === id) return true;
  const u = String(username || "").trim().toLowerCase();
  if (u && String(po.owner || "").trim().toLowerCase() === u) return true;
  return false;
}

/**
 * CAN THIS PERSON MOVE THIS ORDER ALONG, AND WHY.
 *
 *   canEdit   the full raise-and-edit verdict (editVerdict). A buyer can do
 *             everything, so this is only ever consulted when that says no.
 *   role      the caller's resolved shell access. A read-only account stays
 *             read-only: being named on an order does not widen the shell.
 */
export function moveVerdict({ canEdit, role, po, meId, username }) {
  if (canEdit) return { allowed: true, full: true, why: "Can raise and edit purchase orders" };
  if (!role) return { allowed: false, full: false, why: "No access on the account" };
  if (role.can_edit === false) {
    return { allowed: false, full: false, why: "This account is read-only in the shell" };
  }
  if (!ownsPo(po, meId, username)) {
    return { allowed: false, full: false, why: "Only the account manager on this order can move it along" };
  }
  return { allowed: true, full: false, why: "Account manager on this order" };
}
