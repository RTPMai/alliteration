// lib/sitework/schema.js — Sticky Notes schema (Site Work section, Aug 18 2026).
//
// Site Work is NOT one of the apps and NOT part of Notifications. Notifications
// is the team's hand-off list: assigned work, inside the business. This is the
// list of what still needs doing to Alliteration ITSELF. Mixing the two put
// "fix the ShopStock session bug" next to "restock the front office coffee",
// which is why they are separate sections in the rail.
//
// A note is deliberately thin: colour, title, optional detail, an optional app
// tag, and done/not done. No assignee, no due date, no history. It is a sticky
// note. The moment one of these becomes real assigned work it belongs in
// Notifications instead, and copying it across by hand is the honest signal
// that it graduated.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "sitework_data";

export const keys = {
  record: (id) => `${KEY_PREFIX}:note:${id}`,
  index: () => `${KEY_PREFIX}:index`,
  counter: () => `${KEY_PREFIX}:counter`,
};

// Paper colours, named not hexed. The actual hex lives in css/tokens.css like
// every other colour in this repo; these are just the allowed keys.
export const COLORS = ["yellow", "green", "blue", "pink", "grey"];
export const DEFAULT_COLOR = "yellow";

export const STATUSES = ["open", "done"];

// Rough size, because "is this a ten minute fix or a week" is the only
// prioritising question that ever actually gets asked here.
export const SIZES = ["small", "medium", "large", "unknown"];
export const DEFAULT_SIZE = "unknown";

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function pickOne(raw, allowed, fallback) {
  const s = str(raw);
  return allowed.includes(s) ? s : fallback;
}

/**
 * Validate a NEW sticky note. appIds is the list of valid app tags (registry
 * ids plus "general"), passed in by the caller so this file never imports
 * js/registry.js — server code must not depend on browser code.
 *
 * Returns { ok, errors, record } holding only user-supplied fields. The route
 * stamps id/createdBy/createdAt/status/order itself.
 */
export function validateNew(body, appIds) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};

  const title = str(b.title).slice(0, 200);
  if (!title) errors.push("title is required");

  // Optional. A sticky note with nothing but a title is the normal case.
  const detail = str(b.detail).slice(0, 2000);

  // Optional and single, unlike Notifications' multi-select. A note about
  // "make the rail collapse on mobile" is not about an app at all.
  let appId = str(b.appId);
  if (appId && Array.isArray(appIds) && !appIds.includes(appId)) {
    errors.push("appId must be a known app, or left blank");
    appId = "";
  }

  if (errors.length) return { ok: false, errors, record: null };

  return {
    ok: true,
    errors: [],
    record: {
      title,
      detail,
      appId,
      color: pickOne(b.color, COLORS, DEFAULT_COLOR),
      size: pickOne(b.size, SIZES, DEFAULT_SIZE),
    },
  };
}

/** Validate a PATCH. Every field is optional; absent means unchanged. */
export function validatePatch(body, appIds) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const patch = {};

  if (b.title !== undefined) {
    const title = str(b.title).slice(0, 200);
    if (!title) errors.push("title cannot be blank");
    else patch.title = title;
  }

  if (b.detail !== undefined) patch.detail = str(b.detail).slice(0, 2000);

  if (b.appId !== undefined) {
    const appId = str(b.appId);
    if (appId && Array.isArray(appIds) && !appIds.includes(appId)) {
      errors.push("appId must be a known app, or left blank");
    } else patch.appId = appId;
  }

  if (b.color !== undefined) {
    if (!COLORS.includes(str(b.color))) errors.push("color must be one of: " + COLORS.join(", "));
    else patch.color = str(b.color);
  }

  if (b.size !== undefined) {
    if (!SIZES.includes(str(b.size))) errors.push("size must be one of: " + SIZES.join(", "));
    else patch.size = str(b.size);
  }

  if (b.status !== undefined) {
    if (!STATUSES.includes(str(b.status))) errors.push("status must be one of: " + STATUSES.join(", "));
    else patch.status = str(b.status);
  }

  // Board position. Sent as a plain number by the drag handler.
  if (b.order !== undefined) {
    const n = Number(b.order);
    if (!Number.isFinite(n)) errors.push("order must be a number");
    else patch.order = n;
  }

  if (errors.length) return { ok: false, errors, patch: {} };
  return { ok: true, errors: [], patch };
}
