// PUT IN: lib/sitework/schema.js
// lib/sitework/schema.js — StickySituations schema (Site Work section, Aug 18 2026).
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

// Labels live here and not in the panel so the board, the dropdown and a
// copied note all call a size the same thing.
export const SIZE_LABELS = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  unknown: "No idea",
};

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

/**
 * One note as plain text, for copying out of the board.
 *
 * Lives here rather than in apps/stickies.js so the tests can call it for
 * real instead of reading the panel's source, same reasoning as poHealth() in
 * PromoPro. The app tag is passed IN because the app name lives in
 * js/registry.js, which is browser code this file must never import.
 *
 * Shape: the note, a blank line, the detail, a blank line, then the tail that
 * says which app, how big, whether it is done, and the id. The id is there
 * because it is what makes a pasted note findable again on the board.
 *
 * A size the schema does not recognise is dropped rather than printed raw.
 * validateNew() will not store one, so seeing it here means something is
 * wrong, and a stray value in copied text reads as a real label.
 */
export function noteText(note, appName) {
  const n = note && typeof note === "object" ? note : {};

  const size = str(n.size);
  const tail = [
    str(appName) || null,
    size && size !== "unknown" ? (SIZE_LABELS[size] || null) : null,
    str(n.status) === "done" ? "Done" : null,
    str(n.id) || null,
  ].filter(Boolean).join(" \u00b7 ");

  return [str(n.title), str(n.detail), tail].filter(Boolean).join("\n\n");
}

/** Several notes as one block, separated so each is still readable. */
export function boardText(notes, appNameFor) {
  const rows = Array.isArray(notes) ? notes : [];
  const name = typeof appNameFor === "function" ? appNameFor : () => "";
  return rows.map((n) => noteText(n, name(n))).join("\n\n----\n\n");
}

/* ------------------------------------------------------------------ *
 * WHO TOUCHED IT
 *
 * Every note has carried createdBy since the app was built, stamped
 * server-side from the session so the browser cannot claim to be somebody
 * else. Nothing ever showed it, which was fine while Site Work was one
 * person's list. Once a role could be granted the board (Sep 2026), "who put
 * this here" and "who closed it" became real questions.
 * ------------------------------------------------------------------ */

/**
 * Who may delete a note: the person who wrote it, or an admin. Same rule as
 * CrewCore kudos, and for the same reason. A board several people can reach
 * should not let one of them quietly clear another's work, but an admin still
 * has to be able to tidy up after somebody who has left.
 *
 * A NOTE WITH NO AUTHOR IS ADMIN-ONLY. Every note written by this app has one,
 * so a missing author means a record from somewhere we do not know about.
 * Treating unknown as "anyone may delete it" would make forging deletion
 * rights as easy as writing a note without the field.
 */
export function canDeleteNote(note, user) {
  const u = user && typeof user === "object" ? user : {};
  if (u.superuser === true) return true;
  const author = str(note && note.createdBy).toLowerCase();
  if (!author) return false;
  const me = str(u.username).toLowerCase();
  return !!me && me === author;
}

/**
 * The line under a card: who added it, and who last changed it if that is
 * somebody else.
 *
 * "Edited by" is deliberately omitted when the editor IS the author. A card
 * reading "Added by Ryan · edited by Ryan" spends a line saying nothing, and
 * on a board of twenty notes that is twenty lines of nothing.
 *
 * nameFor turns a username into a display name. When it cannot, the username
 * is shown as-is rather than a blank: a real handle somebody recognises beats
 * an empty space, and beats guessing.
 */
export function noteByline(note, nameFor) {
  const n = note && typeof note === "object" ? note : {};
  const show = typeof nameFor === "function"
    ? (u) => str(nameFor(u)) || str(u)
    : (u) => str(u);

  const author = str(n.createdBy);
  const editor = str(n.updatedBy);
  const closer = str(n.doneBy);

  const parts = [];
  if (author) parts.push({ label: "Added by", who: show(author) });
  if (editor && editor.toLowerCase() !== author.toLowerCase()) {
    parts.push({ label: "edited by", who: show(editor) });
  }
  // Who ticked it off is the most useful of the three on a build board, so it
  // is shown even when that is the same person who wrote it.
  if (str(n.status) === "done" && closer) {
    parts.push({ label: "done by", who: show(closer) });
  }
  return parts;
}
