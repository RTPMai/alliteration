// PUT IN: lib/notifications/schema.js (new)
// (this banner line is for verification only, delete it after checking the path)

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

  if (errors.length) return { ok: false, errors, record: null };

  return {
    ok: true,
    errors: [],
    record: { title, types, appIds: appTags, assignedTo, dueDate },
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

  if (b.dueDate !== undefined) {
    if (b.dueDate === null || b.dueDate === "") {
      patch.dueDate = null;
    } else {
      const d = new Date(b.dueDate);
      if (isNaN(d.getTime())) errors.push("dueDate is not a valid date");
      else patch.dueDate = d.toISOString().slice(0, 10);
    }
  }

  if (errors.length) return { ok: false, errors, patch: {} };
  return { ok: true, errors: [], patch };
}
