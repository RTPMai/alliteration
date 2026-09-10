// PUT IN: lib/notifications/schema.js
// lib/notifications/schema.js — Notifications schema (v2, Aug 6 2026).
//
// v2 changes from the original: appId and type were single-select; Ryan
// asked for the same multi-select toggle-button picker Settings uses for a
// role's apps (see apps/settings.js .app-toggle), applied to BOTH the app
// tag and the type tag, so a notification can be tagged with more than one
// app and more than one type. The free-text notes field is gone — title
// only.
//
// Shell-level to-do/assignment list. Stored in the shared Upstash instance
// under the notifications_data: prefix, same conventions as
// lib/errorengine/store.js (SET/pipeline, defensive unwrap, INCR-based ids).
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "notifications_data";

export const keys = {
  record: (id) => `${KEY_PREFIX}:note:${id}`,
  index: () => `${KEY_PREFIX}:index`,
  counter: () => `${KEY_PREFIX}:counter`,
};

// ---- Type tags (single source of truth) --------------------------------
export const TYPES = [
  { value: "task", label: "Task" },
  { value: "need", label: "Need" },
  { value: "handoff", label: "Hand Off" },
];
export const TYPE_VALUES = TYPES.map((t) => t.value);

export const STATUSES = ["open", "done"];

// ---- Visibility (Ryan's ask, Aug 18 2026) -------------------------------
// "team" is every notification that has ever existed: visible to everyone
// signed in, which is the whole point of a shared hand-off list.
// "private" is a personal scratch item — a half-formed idea off a post-it
// note, not an assignment. Only its creator can see, edit or delete it, and
// api/notifications.js forces a private item to be assigned to its creator
// so there is no way to hand someone work they are not allowed to read.
// Default is "team": an unmarked notification behaves exactly as before.
export const VISIBILITIES = ["team", "private"];
export const DEFAULT_VISIBILITY = "team";

// ---- Record link (Ryan's ask, Aug 2026; extended Sep 2026) --------------
// A notification can point at the specific record it's about. Started with
// BackBone (inquiry/lead/client); extended to TravelTrack expenses and
// GivingGauge donation decisions the same way, since both have the same
// "a decision happened, the person waiting on it should hear about it"
// shape as a lead handoff. PromoPro purchase orders and StickySituations
// notes joined in Sep 2026. Optional — plenty of notifications ("restock the
// coffee") have nothing to link to.
export const LINK_TYPES = [
  "inquiry", "lead", "client", "expense", "donation", "po", "sticky",
];
export const LINK_TYPE_LABELS = {
  inquiry: "Inquiry", lead: "Lead", client: "Client",
  expense: "Expense", donation: "Donation",
  po: "Purchase Order", sticky: "Sticky",
};

// Which app each kind of record belongs to. This is what lets the picker follow
// the app tag you already chose (Ryan's ask, Sep 2026): tag PromoPro and the
// only thing offered to link is a purchase order, because "which app" and
// "which record" were two separate questions asking the same thing.
//
// Adding a new linkable record kind is this table, a label above, a search
// branch in api/notifications.js, and a route in apps/notifications.js. Four
// lines, deliberately, so the next app is cheap.
export const LINK_TYPE_APP = {
  inquiry: "backbone", lead: "backbone", client: "backbone",
  expense: "traveltrack", donation: "givinggauge",
  po: "promopro", sticky: "stickies",
};

// The manual "Link to a record" picker on the create/edit form only offers
// what it can actually search for (api/notifications.js's ?linkSearch=).
// Expense and donation links only ever get attached automatically, by
// TravelTrack/GivingGauge themselves, at the moment the id is already known
// — there's no "search expenses by company name" the way there is for
// leads/inquiries/clients, so building a picker for them isn't worth it
// unless that need actually comes up.
// "lead" is deliberately NOT pickable any more. Inbox and Leads merged in Sep
// 2026, so offering both words made somebody choose between two names for one
// screen. The TYPE survives for the notifications already on file.
//
// Being pickable is not permission. Every branch of searchLinkable() answers
// for itself who is allowed to search it — the sticky board is the sharp case,
// since it is not open to the whole team the way the rest of these are.
export const PICKABLE_LINK_TYPES = ["inquiry", "client", "po", "sticky"];

/**
 * The link types worth offering for a given set of app tags.
 *
 * An empty selection offers nothing rather than everything. A picker that
 * ignores the tags is the thing this replaced, and offering all of them again
 * the moment nothing is ticked would put it back for exactly the person who
 * has not decided yet.
 *
 * "general" carries no records, so tagging only General offers no link. That is
 * correct: "restock the front office coffee" has nothing to point at.
 */
export function linkTypesForApps(appIds) {
  const tags = Array.isArray(appIds) ? appIds : [];
  return PICKABLE_LINK_TYPES.filter((t) => tags.includes(LINK_TYPE_APP[t]));
}

/**
 * The app a stored link opens into, or "" for a type this build does not know.
 * Callers use it to decide whether to show the chip at all: a link into an app
 * somebody cannot open is a button that only ever produces a refusal.
 */
export function appForLinkType(type) {
  return LINK_TYPE_APP[type] || "";
}

// "general" lets a notification carry an app tag without pointing at one of
// the nine registered apps — e.g. "restock the front office coffee." The
// app picker always offers it alongside the real app ids passed in from the
// caller (api/notifications.js), so this file stays free of any import from
// js/registry.js (server code must not import browser code).
export const GENERAL_APP = "general";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Normalizes and de-duplicates a picker array against an allowlist.
function pickMany(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  raw.forEach((v) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && (!Array.isArray(allowed) || allowed.includes(s))) set.add(s);
  });
  return [...set];
}

/**
 * Validate a NEW notification. appIds is the list of valid app tags (the
 * registry's app ids plus "general"), passed in by the caller so this file
 * has no dependency on js/registry.js.
 *
 * Returns { ok, errors, record } — record holds only the user-supplied
 * fields; the route layer stamps id/createdBy/createdAt/status itself so a
 * hand-crafted POST can't forge attribution or resurrect a done item as open
 * under a fake id.
 */
export function validateNew(body, appIds, assignableUsernames) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};

  const title = isNonEmptyString(b.title) ? b.title.trim().slice(0, 200) : "";
  if (!title) errors.push("title is required");

  const types = pickMany(b.types, TYPE_VALUES);
  if (!types.length) errors.push("select at least one type (Task, Need, Hand Off)");

  const appTags = pickMany(b.appIds, appIds);
  if (!appTags.length) errors.push("select at least one app (or General)");

  const assignedTo = isNonEmptyString(b.assignedTo) ? b.assignedTo.trim().toLowerCase() : "";
  if (!assignedTo) errors.push("assignedTo is required");
  else if (Array.isArray(assignableUsernames) && !assignableUsernames.includes(assignedTo)) {
    errors.push("assignedTo must be a known account");
  }

  // Optional. Not validated as a real calendar date beyond "parses" — this is
  // a lightweight nudge field, not a scheduling system.
  let dueDate = null;
  if (b.dueDate) {
    const d = new Date(b.dueDate);
    if (isNaN(d.getTime())) errors.push("dueDate is not a valid date");
    else dueDate = d.toISOString().slice(0, 10);
  }

  // Optional. Absence, null, or an empty object all mean "no link" — only
  // reject if a type or id was actually supplied and doesn't check out, so
  // a caller that never mentions link.* isn't punished for it.
  let link = null;
  if (b.link && typeof b.link === "object") {
    const type = isNonEmptyString(b.link.type) ? b.link.type.trim() : "";
    const linkId = isNonEmptyString(b.link.id) ? String(b.link.id).trim().slice(0, 100) : "";
    if (type || linkId) {
      if (!LINK_TYPES.includes(type)) errors.push("link.type must be one of: " + LINK_TYPES.join(", "));
      else if (!linkId) errors.push("link.id is required when a link type is set");
      else {
        link = {
          type,
          id: linkId,
          label: isNonEmptyString(b.link.label) ? b.link.label.trim().slice(0, 200) : "",
        };
      }
    }
  }

  if (errors.length) return { ok: false, errors, record: null };

  return {
    ok: true,
    errors: [],
    record: {
      title, types, appIds: appTags, assignedTo, dueDate, link,
      visibility: b.visibility === "private" ? "private" : DEFAULT_VISIBILITY,
    },
  };
}

/**
 * Validate a PATCH. Only status, and reassignment/edits by the creator or an
 * admin, are ever accepted — see api/notifications.js for who is allowed to
 * call this at all.
 */
export function validatePatch(body, appIds, assignableUsernames) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const patch = {};

  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) errors.push("status must be one of: " + STATUSES.join(", "));
    else patch.status = b.status;
  }

  if (b.title !== undefined) {
    const title = isNonEmptyString(b.title) ? b.title.trim().slice(0, 200) : "";
    if (!title) errors.push("title cannot be blank");
    else patch.title = title;
  }

  if (b.types !== undefined) {
    const types = pickMany(b.types, TYPE_VALUES);
    if (!types.length) errors.push("select at least one type (Task, Need, Hand Off)");
    else patch.types = types;
  }

  if (b.appIds !== undefined) {
    const appTags = pickMany(b.appIds, appIds);
    if (!appTags.length) errors.push("select at least one app (or General)");
    else patch.appIds = appTags;
  }

  if (b.assignedTo !== undefined) {
    const assignedTo = isNonEmptyString(b.assignedTo) ? b.assignedTo.trim().toLowerCase() : "";
    if (!assignedTo) errors.push("assignedTo cannot be blank");
    else if (Array.isArray(assignableUsernames) && !assignableUsernames.includes(assignedTo)) {
      errors.push("assignedTo must be a known account");
    } else patch.assignedTo = assignedTo;
  }

  if (b.visibility !== undefined) {
    if (!VISIBILITIES.includes(b.visibility)) {
      errors.push("visibility must be one of: " + VISIBILITIES.join(", "));
    } else patch.visibility = b.visibility;
  }

  if (b.dueDate !== undefined) {
    if (b.dueDate === null || b.dueDate === "") {
      patch.dueDate = null;
    } else {
      const d = new Date(b.dueDate);
      if (isNaN(d.getTime())) errors.push("dueDate is not a valid date");
      else patch.dueDate = d.toISOString().slice(0, 10);
    }
  }

  // Ephemeral: never stored as its own field on the record. It exists so a
  // reassignment or a "mark done" can carry a short message — the Printavo
  // Tasks pattern Ryan described (ask a question by reassigning, the answer
  // comes back the same way) — which api/notifications.js turns into a
  // history entry rather than a persistent, always-visible field.
  if (b.message !== undefined) {
    patch.message = isNonEmptyString(b.message) ? b.message.trim().slice(0, 500) : "";
  }

  // { link: null } explicitly clears an existing link (e.g. "Remove link"
  // in the edit form). Omitting link entirely leaves whatever is already
  // on the record untouched, same convention as every other patch field.
  if (b.link !== undefined) {
    if (b.link === null) {
      patch.link = null;
    } else if (typeof b.link === "object") {
      const type = isNonEmptyString(b.link.type) ? b.link.type.trim() : "";
      const linkId = isNonEmptyString(b.link.id) ? String(b.link.id).trim().slice(0, 100) : "";
      if (!LINK_TYPES.includes(type)) errors.push("link.type must be one of: " + LINK_TYPES.join(", "));
      else if (!linkId) errors.push("link.id is required when a link type is set");
      else {
        patch.link = {
          type,
          id: linkId,
          label: isNonEmptyString(b.link.label) ? b.link.label.trim().slice(0, 200) : "",
        };
      }
    }
  }

  if (errors.length) return { ok: false, errors, patch: {} };
  return { ok: true, errors: [], patch };
}
