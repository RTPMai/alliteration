// PUT IN: lib/backbone/archive.js
// lib/backbone/archive.js — archiving for leads and clients, and lead numbering.
//
// WHY ARCHIVE IS A FLAG AND NOT A STATUS.
// A lead's exit states are Reach Back Out, Won and Lost. Archive is a different
// question: it is "stop showing me this", and it has to answer for CLIENTS too,
// which have no lead status at all. If archiving overwrote the status, restoring
// would have to guess where the lead came from. As a flag beside the status, the
// status and its history survive untouched and a restore puts the lead back
// exactly where it was standing.
//
// WHY THE REASON IS REQUIRED AND COMES FROM A LIST.
// Free text answers "why is this gone" with twelve spellings of the same four
// reasons, which cannot be counted or filtered. The list is stored, not compiled
// in, so it is a Settings edit rather than a deploy. Removing a reason from the
// list NEVER rewrites records already archived under it: the reason is copied
// onto the record at archive time, so history stays readable after the list
// changes.
//
// WHY CLIENT ARCHIVES LIVE IN THEIR OWN RECORD.
// The client roster is rebuilt from Printavo by the sync. A flag written onto a
// synced row is erased by the next reconcile. So client archives are stored
// separately and folded in WHEN THE ROSTER IS READ, the same pattern merges
// already use in lib/backbone-merge.js, for the same reason.

/**
 * Seeded reasons. These are a starting point, not the law: the live list lives
 * in storage and is edited in BackBone Settings.
 */
export const DEFAULT_ARCHIVE_REASONS = [
  "Disqualified",
  "Not a fit",
  "No response after Death Call",
  "Went with another supplier",
  "Out of business or closed",
  "Duplicate record",
  "Bad or fake inquiry",
  "Too small to pursue",
];

/** The reason applied when a research run disqualifies a lead by itself. */
export const DISQUALIFIED_REASON = "Disqualified";

/**
 * Clean a stored reason list: trim, drop empties, drop duplicates (case
 * insensitively), keep the order given. An empty result falls back to the
 * defaults rather than to nothing, because a list of zero reasons would make
 * archiving impossible and look like a bug rather than a setting.
 */
export function normalizeReasons(list) {
  if (!Array.isArray(list)) return DEFAULT_ARCHIVE_REASONS.slice();
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = String(raw == null ? "" : raw).trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.length ? out : DEFAULT_ARCHIVE_REASONS.slice();
}

/**
 * Is this reason one the list allows? Compared case insensitively and returns
 * the LIST's spelling, so records archived from different screens agree on
 * capitalisation and group together when counted.
 *
 * Returns null when the reason is missing or not on the list. Callers treat
 * null as a refusal; there is no "other" bucket by design.
 */
export function resolveReason(reason, reasons) {
  const want = String(reason == null ? "" : reason).trim().toLowerCase();
  if (!want) return null;
  const allowed = normalizeReasons(reasons);
  for (const r of allowed) {
    if (r.toLowerCase() === want) return r;
  }
  return null;
}

/** Is the record archived? One reader, so no screen invents its own test. */
export function isArchived(rec) {
  return !!(rec && rec.archived_at);
}

/**
 * Stamp a record as archived. Returns a NEW object; the caller decides what to
 * do with it. Refuses a reason that is not on the list by throwing, because a
 * silent archive with a blank reason is exactly the outcome the fixed list
 * exists to prevent.
 *
 * `note` is optional free text ON TOP OF the reason, never instead of it.
 */
export function archiveRecord(rec, { reason, reasons, by, at, note } = {}) {
  const resolved = resolveReason(reason, reasons);
  if (!resolved) {
    throw new Error("An archive reason from the list is required.");
  }
  const stamp = {
    archived_at: at || new Date().toISOString(),
    archive_reason: resolved,
    archived_by: String(by || "").trim() || "unknown",
  };
  const noteText = String(note == null ? "" : note).trim();
  if (noteText) stamp.archive_note = noteText;
  const next = Object.assign({}, rec, stamp);
  next.archive_history = (Array.isArray(rec && rec.archive_history) ? rec.archive_history : [])
    .concat([{ action: "archived", at: stamp.archived_at, by: stamp.archived_by, reason: resolved }]);
  return next;
}

/**
 * Un-archive. The stamp fields are cleared so every "is it archived" test is the
 * one test above, but the history entry stays: a record archived and restored
 * three times is a fact worth being able to see, and wiping the trail on restore
 * would hide it.
 */
export function restoreRecord(rec, { by, at } = {}) {
  const next = Object.assign({}, rec);
  const when = at || new Date().toISOString();
  delete next.archived_at;
  delete next.archive_reason;
  delete next.archived_by;
  delete next.archive_note;
  next.archive_history = (Array.isArray(rec && rec.archive_history) ? rec.archive_history : [])
    .concat([{ action: "restored", at: when, by: String(by || "").trim() || "unknown" }]);
  return next;
}

/**
 * Split a list into what the working screens show and what the Archived Manager
 * shows. One function so the two lists can never overlap or lose a record
 * between them, which is what happens when each screen writes its own filter.
 */
export function partitionArchived(rows) {
  const live = [];
  const archived = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    (isArchived(r) ? archived : live).push(r);
  }
  return { live, archived };
}

/* ------------------------------------------------------------------ *
 * LEAD NUMBERS
 *
 * lead_id is a random string and always has been. It is unique and it is
 * useless out loud: nobody reads "lead_ma3k2x9f8b" down the phone. lead_no is
 * the human handle, in the same shape as EE-00001 and the PO numbers, so a
 * lead can be named in a hand-off, a notification or a conversation.
 *
 * Numbers are assigned SERVER SIDE, on save, never in the browser. Two people
 * with the pipeline open would otherwise both compute the same "next" number
 * and the second save would quietly overwrite the first.
 * ------------------------------------------------------------------ */

export const LEAD_NO_PREFIX = "L-";

/** Format a counter value as a lead number. */
export function formatLeadNo(n) {
  return LEAD_NO_PREFIX + String(n).padStart(5, "0");
}

/** Read the numeric part back out, or null if this is not a lead number. */
export function parseLeadNo(v) {
  const m = /^L-(\d+)$/.exec(String(v == null ? "" : v).trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The highest number already handed out in this list. 0 when there are none. */
export function highestLeadNo(leads) {
  let max = 0;
  for (const l of Array.isArray(leads) ? leads : []) {
    const n = parseLeadNo(l && l.lead_no);
    if (n && n > max) max = n;
  }
  return max;
}

/**
 * Give every lead without a number one, oldest first, and hand back a new array.
 *
 * OLDEST FIRST MATTERS. The backfill runs once over leads that have existed for
 * months, and numbering them in whatever order the array happens to sit in would
 * make L-00001 an arbitrary record. Sorted by created_at, the numbers read as
 * the order the leads actually arrived.
 *
 * A number already on a lead is never reissued or renumbered, including a
 * duplicate: renumbering would break every reference to the old number, and a
 * duplicate that stays visible gets noticed and fixed. Duplicates are reported
 * rather than repaired.
 */
export function assignLeadNumbers(leads) {
  const list = Array.isArray(leads) ? leads.slice() : [];
  let next = highestLeadNo(list) + 1;

  const missing = [];
  for (let i = 0; i < list.length; i++) {
    if (parseLeadNo(list[i] && list[i].lead_no) === null) missing.push(i);
  }
  if (!missing.length) return { leads: list, assigned: 0 };

  missing.sort((a, b) => {
    const ta = new Date((list[a] && list[a].created_at) || 0).getTime() || 0;
    const tb = new Date((list[b] && list[b].created_at) || 0).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return a - b;
  });

  for (const i of missing) {
    list[i] = Object.assign({}, list[i], { lead_no: formatLeadNo(next) });
    next += 1;
  }
  return { leads: list, assigned: missing.length };
}

/** Numbers handed to more than one lead. Should always be empty; worth seeing. */
export function duplicateLeadNos(leads) {
  const counts = new Map();
  for (const l of Array.isArray(leads) ? leads : []) {
    const n = l && l.lead_no;
    if (parseLeadNo(n) === null) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const dupes = [];
  for (const [no, c] of counts) if (c > 1) dupes.push(no);
  return dupes.sort();
}

/* ------------------------------------------------------------------ *
 * CLIENT ARCHIVES
 *
 * Stored as a map of customer id -> stamp, folded onto the roster on read.
 * ------------------------------------------------------------------ */

/** A stored client-archive blob, in whatever shape, read as a plain map. */
export function readClientArchiveMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const src = (raw.clients && typeof raw.clients === "object") ? raw.clients : raw;
  const out = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === "object" && v.archived_at) out[String(k)] = v;
  }
  return out;
}

/**
 * Fold client archive stamps onto roster rows. Rows are copied, never mutated,
 * and a stamp for an id that is no longer in the roster is simply ignored: a
 * customer deleted in Printavo should not resurrect as an empty archived row.
 *
 * `idKeys` is the list of fields a roster row might carry its id under, because
 * the roster has been through more than one sync shape.
 */
export function applyClientArchive(rows, archiveMap, idKeys = ["customer_id", "id", "printavo_id"]) {
  const map = readClientArchiveMap(archiveMap);
  if (!Object.keys(map).length) return Array.isArray(rows) ? rows.slice() : [];
  return (Array.isArray(rows) ? rows : []).map((row) => {
    for (const k of idKeys) {
      const id = row && row[k];
      if (id != null && map[String(id)]) return Object.assign({}, row, map[String(id)]);
    }
    return row;
  });
}
