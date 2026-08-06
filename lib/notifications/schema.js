// PUT IN: lib/notifications/schema.js (new)
// (this banner line is for verification only, delete it after checking the path)

// lib/notifications/schema.js — Notifications schema (v1).
//
// Shell-level to-do/assignment list. Not tied to any one app: a notification
// TAGS which app the action belongs to (or "general" for shell-wide items)
// and carries exactly one of three type tags — Task, Need, Hand Off — so the
// inbox can be scanned at a glance.
//
// Stored in the shared Upstash instance under the notifications_data: prefix,
// same conventions as lib/errorengine/store.js (SET/pipeline, defensive
// unwrap, INCR-based ids).
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "notifications_data";

export const keys = {
  record: (id) => `${KEY_PREFIX}:note:${id}`,
  index: () => `${KEY_PREFIX}:index`,
  counter: () => `${KEY_PREFIX}:counter`,
};

// ---- Type tags (single source of truth) --------------------------------
// value = stored/queried id, label = what the UI shows.
export const TYPES = [
  { value: "task", label: "Task" },
  { value: "need", label: "Need" },
  { value: "handoff", label: "Hand Off" },
];
export const TYPE_VALUES = TYPES.map((t) => t.value);

export const STATUSES = ["open", "done"];

// "general" lets a notification exist without pointing at one of the nine
// registered apps — e.g. "restock the front office coffee." The app tag
// dropdown always offers it alongside the real app ids passed in from the
// registry by the caller (api/notifications.js), so this file stays free of
// any import from js/registry.js (server code must not import browser code).
export const GENERAL_APP = "general";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
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

  const type = TYPE_VALUES.includes(b.type) ? b.type : null;
  if (!type) errors.push("type must be one of: " + TYPE_VALUES.join(", "));

  const appId = isNonEmptyString(b.appId) ? b.appId.trim() : "";
  if (!appId || (Array.isArray(appIds) && !appIds.includes(appId))) {
    errors.push("appId must be one of the registered apps, or \"general\"");
  }

  const assignedTo = isNonEmptyString(b.assignedTo) ? b.assignedTo.trim().toLowerCase() : "";
  if (!assignedTo) errors.push("assignedTo is required");
  else if (Array.isArray(assignableUsernames) && !assignableUsernames.includes(assignedTo)) {
    errors.push("assignedTo must be a known account");
  }

  const notes = isNonEmptyString(b.notes) ? b.notes.trim().slice(0, 2000) : "";

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
    record: { title, type, appId, assignedTo, notes, dueDate },
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

  if (b.type !== undefined) {
    if (!TYPE_VALUES.includes(b.type)) errors.push("type must be one of: " + TYPE_VALUES.join(", "));
    else patch.type = b.type;
  }

  if (b.appId !== undefined) {
    const appId = isNonEmptyString(b.appId) ? b.appId.trim() : "";
    if (!appId || (Array.isArray(appIds) && !appIds.includes(appId))) {
      errors.push("appId must be one of the registered apps, or \"general\"");
    } else patch.appId = appId;
  }

  if (b.assignedTo !== undefined) {
    const assignedTo = isNonEmptyString(b.assignedTo) ? b.assignedTo.trim().toLowerCase() : "";
    if (!assignedTo) errors.push("assignedTo cannot be blank");
    else if (Array.isArray(assignableUsernames) && !assignableUsernames.includes(assignedTo)) {
      errors.push("assignedTo must be a known account");
    } else patch.assignedTo = assignedTo;
  }

  if (b.notes !== undefined) {
    patch.notes = isNonEmptyString(b.notes) ? b.notes.trim().slice(0, 2000) : "";
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
