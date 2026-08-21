// lib/promopro/vendors.js — vendor records for PromoPro.
//
// SIMPLIFIED Aug 14 2026. This used to carry a per-stage wait time for every
// step in the pipeline: six numbers per vendor. That was wrong for three
// reasons, and it is worth writing them down so nobody adds it back.
//
//   1. Nobody knows those numbers. "Art approved to paid, 2 days" for each of
//      twenty suppliers is forty guesses, and a guessed threshold produces a
//      false amber. False ambers train people to ignore the colour, and then
//      the alerting is worse than none at all.
//   2. Half the steps are not the vendor's. Approving art and sending payment
//      are OUR holdups. No vendor setting could ever describe them, so
//      colouring them as vendor lateness pointed the finger at the wrong
//      party.
//   3. The genuinely valuable clock needs no configuration at all. Whether
//      the remaining lead time still fits before the job is due is computed
//      from real dates.
//
// So a vendor now carries two numbers, both of which somebody can actually
// answer: how long from order to our dock, and (optionally) how slow this
// particular supplier is to reply. Blank on the second means use the
// shop-wide default from Settings.
//
// ESM. Do NOT convert to module.exports.

import { looksLikeEmail } from "./schema.js";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function str(v, max) {
  return isNonEmptyString(v) ? v.trim().slice(0, max || 200) : "";
}

export function validateVendor(body, existing) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const base = existing || {};

  const name = b.name !== undefined ? str(b.name, 200) : base.name;
  if (!name) errors.push("vendor name is required");

  const email = b.email !== undefined ? str(b.email, 200) : base.email;
  if (email && !looksLikeEmail(email)) errors.push("email does not look like an address");

  const ccEmail = b.ccEmail !== undefined ? str(b.ccEmail, 200) : base.ccEmail;
  if (ccEmail && !looksLikeEmail(ccEmail)) errors.push("cc email does not look like an address");

  let leadDays = base.leadDays === undefined ? 10 : base.leadDays;
  if (b.leadDays !== undefined) {
    const n = Number(b.leadDays);
    if (!Number.isFinite(n) || n < 0) errors.push("lead days must be zero or more");
    else leadDays = Math.round(n);
  }

  // Optional override. Null means "use the shop-wide chase setting", which is
  // what almost every vendor should be. Only fill this in for a supplier who
  // is reliably slower or faster than the rest.
  let responseDays = base.responseDays === undefined ? null : base.responseDays;
  if (b.responseDays !== undefined) {
    if (b.responseDays === null || b.responseDays === "") {
      responseDays = null;
    } else {
      const n = Number(b.responseDays);
      if (!Number.isFinite(n) || n < 0) errors.push("response days must be zero or more, or blank");
      else responseDays = Math.round(n);
    }
  }

  // --- rating -------------------------------------------------------------
  // A hand-set 1 to 5, separate from the computed record in vendor-stats.js
  // on purpose. The computed figures answer "were they on time"; the rating
  // answers everything a spreadsheet cannot see, like whether the rep picks
  // up the phone and whether the boxes arrive packed properly. Null means
  // nobody has rated them, which is not the same as a bad score.
  let rating = base.rating === undefined ? null : base.rating;
  if (b.rating !== undefined) {
    if (b.rating === null || b.rating === "") {
      rating = null;
    } else {
      const n = Number(b.rating);
      if (!Number.isFinite(n) || n < 1 || n > 5) errors.push("rating must be 1 to 5, or blank");
      else rating = Math.round(n);
    }
  }

  // --- blacklist ----------------------------------------------------------
  // Deliberately NOT the same as inactive. Inactive means "we stopped using
  // them", and it hides them from the picker. Blacklisted means "there is a
  // reason nobody should order from them", and it must still be visible,
  // because the whole point is that somebody about to order from them sees
  // why not. A hidden vendor teaches nobody anything.
  const blacklisted = b.blacklisted !== undefined ? b.blacklisted === true : base.blacklisted === true;
  const blacklistReason = b.blacklistReason !== undefined
    ? str(b.blacklistReason, 500)
    : (base.blacklistReason || "");

  // A blacklist with no reason on it is the thing that gets ignored in six
  // months when nobody remembers what happened.
  if (blacklisted && !blacklistReason) {
    errors.push("say why this vendor is blacklisted, so the warning means something later");
  }

  if (errors.length) return { ok: false, errors, vendor: null };

  const wasBlacklisted = base.blacklisted === true;

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
      responseDays,
      // Some suppliers will not start production until they are paid.
      prepay: b.prepay !== undefined ? b.prepay === true : base.prepay === true,
      notes: b.notes !== undefined ? str(b.notes, 2000) : (base.notes || ""),
      active: b.active !== undefined ? b.active !== false : base.active !== false,
      rating,
      blacklisted,
      blacklistReason: blacklisted ? blacklistReason : "",
      // Stamped by the route, which is the only place that knows who is
      // signed in. Kept when the flag has not changed so the original date
      // survives an unrelated edit.
      blacklistedAt: blacklisted ? (wasBlacklisted ? (base.blacklistedAt || null) : null) : null,
      blacklistedBy: blacklisted ? (wasBlacklisted ? (base.blacklistedBy || "") : "") : "",
    },
  };
}

/**
 * Did this patch turn the blacklist ON? The route needs to know so it can
 * stamp who and when, which validation cannot do because it does not see the
 * session.
 */
export function blacklistJustSet(existing, next) {
  return (next && next.blacklisted === true) && !(existing && existing.blacklisted === true);
}
