// lib/promopro/vendors.js — vendor records for PromoPro.
//
// A vendor carries the two things the pipeline needs to reason about time:
// leadDays (how long from confirmed order to goods on our dock) and
// stageWaitDays (how long each individual step normally takes with THIS
// vendor). A supplier who confirms same day and one who takes four days are
// not both "late on day two", so the clock has to be per vendor rather than
// one global setting.
//
// ESM. Do NOT convert to module.exports.

import { STAGE_KEYS } from "./schema.js";

/** Sensible starting point for a new vendor, overridable per vendor. */
export const DEFAULT_STAGE_WAITS = {
  submitted: 2,     // they should acknowledge the PO
  confirmed: 3,     // then send a proof
  art_sent: 3,      // we approve, or they revise
  art_approved: 2,  // payment goes out
  paid: 5,          // into production and shipped
  shipped: 7,       // in transit
};

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function str(v, max) {
  return isNonEmptyString(v) ? v.trim().slice(0, max || 200) : "";
}

// Deliberately permissive. This validates that a field LOOKS like an address
// so a typo gets caught at entry, not that the mailbox exists.
function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

export function validateVendor(body, existing) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const base = existing || {};

  const name = b.name !== undefined ? str(b.name, 200) : base.name;
  if (!name) errors.push("vendor name is required");

  let email = b.email !== undefined ? str(b.email, 200) : base.email;
  if (email && !looksLikeEmail(email)) errors.push("email does not look like an address");

  let ccEmail = b.ccEmail !== undefined ? str(b.ccEmail, 200) : base.ccEmail;
  if (ccEmail && !looksLikeEmail(ccEmail)) errors.push("cc email does not look like an address");

  let leadDays = base.leadDays === undefined ? 10 : base.leadDays;
  if (b.leadDays !== undefined) {
    const n = Number(b.leadDays);
    if (!Number.isFinite(n) || n < 0) errors.push("lead days must be zero or more");
    else leadDays = Math.round(n);
  }

  // Only known stage keys are accepted, so a typo cannot create a wait
  // setting that silently never applies to anything.
  const stageWaitDays = { ...DEFAULT_STAGE_WAITS, ...(base.stageWaitDays || {}) };
  if (b.stageWaitDays && typeof b.stageWaitDays === "object") {
    Object.keys(b.stageWaitDays).forEach((k) => {
      if (!STAGE_KEYS.includes(k)) {
        errors.push(`unknown stage "${k}"`);
        return;
      }
      const n = Number(b.stageWaitDays[k]);
      if (!Number.isFinite(n) || n < 0) errors.push(`wait days for ${k} must be zero or more`);
      else stageWaitDays[k] = Math.round(n);
    });
  }

  if (errors.length) return { ok: false, errors, vendor: null };

  return {
    ok: true,
    errors: [],
    vendor: {
      id: base.id || null,   // stamped by the route on create
      name,
      email: email || "",
      ccEmail: ccEmail || "",
      terms: b.terms !== undefined ? str(b.terms, 200) : (base.terms || ""),
      leadDays,
      stageWaitDays,
      // Some suppliers will not start production until they are paid. The
      // pipeline treats payment as blocking for these, so a PO sitting at
      // "art approved" with no payment is flagged rather than looking calm.
      prepay: b.prepay !== undefined ? b.prepay === true : base.prepay === true,
      notes: b.notes !== undefined ? str(b.notes, 2000) : (base.notes || ""),
      active: b.active !== undefined ? b.active !== false : base.active !== false,
    },
  };
}
