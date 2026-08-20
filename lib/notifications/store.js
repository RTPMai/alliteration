// lib/notifications/store.js — Notifications Upstash access layer.
//
// Same conventions as lib/errorengine/store.js: pipeline writes, defensive
// triple-unwrap, a JSON-array index kept under one key rather than a Redis
// SET. Writes ONLY under the notifications_data: prefix.
//
// ESM. Do NOT convert to module.exports.
//
// ------------------------------------------------------------------------
// THE INDEX CARRIES SUMMARIES, NOT BARE IDS (Aug 2026)
//
// It used to be ["N-00001", "N-00002", ...]. Producing the header bell's
// unread count therefore meant reading EVERY record and filtering in
// JavaScript afterwards: one command per notification, per poll, per open
// browser tab, forever, growing every time anyone created a notification.
// That single path was the largest consumer of the Upstash command budget.
//
// The index now holds one small object per notification:
//
//   { id, assignedTo, createdBy, status, visibility }
//
// which is exactly the field set the count question asks about, so the bell
// is answered by ONE command no matter how many notifications exist.
//
// THIS IS A SECOND COPY OF FIVE FACTS, and two copies of one fact drift.
// Three things keep it honest:
//
//   1. Every write goes through writeRecord() below. There is no path that
//      writes a record without writing its summary in the SAME pipeline.
//      That is why updateNotification() now touches the index when it did
//      not before: status and assignedTo both live in the summary, and a
//      "mark done" that only wrote the record would leave a permanently
//      wrong count.
//   2. The record stays the source of truth. The summary is derived from
//      it by summaryOf(), never edited directly, and never read for
//      anything the full list view renders.
//   3. rebuildIndex() regenerates the whole index from the records. It is
//      what upgrades a legacy id-only index on first read, and it is the
//      repair path if the two ever do fall out of step.
// ------------------------------------------------------------------------

import { keys } from "./schema.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfig() {
  if (!KV_URL || !KV_TOKEN) throw new Error("Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
}

async function kvGet(key) {
  assertConfig();
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

async function kvPipeline(commands) {
  assertConfig();
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Redis pipeline failed: ${r.status}`);
  return r.json();
}

function unwrap(raw) {
  let data = raw;
  let attempts = 0;
  while (typeof data === "string" && attempts < 3) {
    try {
      data = JSON.parse(data);
    } catch (e) {
      break;
    }
    attempts++;
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * SUMMARIES
 * ------------------------------------------------------------------ */

/**
 * The five fields the index carries, derived from a record.
 *
 * Defaults match what the rest of the app assumes when a field is absent:
 * a record with no visibility is team-visible (see api/notifications.js's
 * hidden()), and a record with no status is open. Deriving them here rather
 * than at each call site means the index and the filters cannot disagree
 * about what a missing field means.
 */
export function summaryOf(record) {
  if (!record || !record.id) return null;
  return {
    id: record.id,
    assignedTo: String(record.assignedTo || "").toLowerCase(),
    createdBy: String(record.createdBy || "").toLowerCase(),
    status: record.status || "open",
    visibility: record.visibility || "team",
  };
}

function isSummary(entry) {
  return !!entry && typeof entry === "object" && typeof entry.id === "string";
}

/** Raw index contents. May be legacy strings, summaries, or a mix. */
async function readIndexRaw() {
  const raw = await kvGet(keys.index());
  const list = raw ? unwrap(raw) : [];
  return Array.isArray(list) ? list : [];
}

/**
 * Rebuild the index from the records themselves.
 *
 * Costs one command per notification, so it is NOT a routine path. It runs
 * once when a legacy id-only index is first read (the migration), and it is
 * available as the repair path if a record and its summary ever disagree.
 *
 * An id in the index whose record has gone missing is dropped rather than
 * carried as a null, which also makes this the cleanup for any orphan a
 * half-completed delete could leave behind.
 */
export async function rebuildIndex() {
  const entries = await readIndexRaw();
  const ids = entries.map((e) => (isSummary(e) ? e.id : e)).filter((x) => typeof x === "string" && x);
  if (!ids.length) {
    await kvPipeline([["SET", keys.index(), JSON.stringify([])]]);
    return [];
  }

  const results = await kvPipeline(ids.map((id) => ["GET", keys.record(id)]));
  const summaries = results
    .map((r) => (r && r.result ? summaryOf(unwrap(r.result)) : null))
    .filter(Boolean);

  await kvPipeline([["SET", keys.index(), JSON.stringify(summaries)]]);
  return summaries;
}

/**
 * Every notification's summary. ONE command in the normal case.
 *
 * If any entry is still a legacy bare id, the whole index is rebuilt from
 * the records once and written back, so the expensive read happens on a
 * single request after deploy rather than on every poll forever.
 */
export async function listNotificationSummaries() {
  const entries = await readIndexRaw();
  if (!entries.length) return [];
  if (entries.every(isSummary)) return entries;
  return rebuildIndex();
}

/** Ids only. Kept so existing callers do not care about the index shape. */
export async function listNotificationIds() {
  const summaries = await listNotificationSummaries();
  return summaries.map((s) => s.id);
}

/* ------------------------------------------------------------------ *
 * READS
 * ------------------------------------------------------------------ */

export async function getNotification(id) {
  const raw = await kvGet(keys.record(id));
  return raw ? unwrap(raw) : null;
}

// One pipeline round-trip regardless of how many notifications exist, same
// pattern as ErrorEngine's listErrors(). Still one COMMAND per record
// though, which is why the bell must not come through here.
export async function listNotifications() {
  const ids = await listNotificationIds();
  if (!ids.length) return [];
  const cmds = ids.map((id) => ["GET", keys.record(id)]);
  const results = await kvPipeline(cmds);
  return results
    .map((r) => (r && r.result ? unwrap(r.result) : null))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/* ------------------------------------------------------------------ *
 * WRITES
 *
 * Record and summary always move together, in one pipeline. Nothing below
 * writes keys.record() except writeRecord().
 * ------------------------------------------------------------------ */

async function writeRecord(record, summaries) {
  const next = summaries.filter((s) => s.id !== record.id);
  next.push(summaryOf(record));
  await kvPipeline([
    ["SET", keys.record(record.id), JSON.stringify(record)],
    ["SET", keys.index(), JSON.stringify(next)],
  ]);
  return record;
}

export async function saveNotification(record) {
  const summaries = await listNotificationSummaries();
  return writeRecord(record, summaries);
}

/**
 * Patch a record and keep its summary in step.
 *
 * The index write is the part that is easy to forget: this function used to
 * write the record alone, which was correct when the index was bare ids and
 * is silently wrong now. "Mark done" and "reassign" both change fields the
 * count is computed from.
 */
export async function updateNotification(id, patch) {
  const existing = await getNotification(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id };
  const summaries = await listNotificationSummaries();
  await writeRecord(merged, summaries);
  return merged;
}

export async function deleteNotification(id) {
  const summaries = await listNotificationSummaries();
  const next = summaries.filter((s) => s.id !== id);
  if (next.length === summaries.length) return false;
  await kvPipeline([
    ["DEL", keys.record(id)],
    ["SET", keys.index(), JSON.stringify(next)],
  ]);
  return true;
}

export async function nextNotificationId() {
  const [res] = await kvPipeline([["INCR", keys.counter()]]);
  const n = res && res.result;
  return `N-${String(n).padStart(5, "0")}`;
}

/* ------------------------------------------------------------------ *
 * THE COUNT
 * ------------------------------------------------------------------ */

/**
 * Fields the index can answer a filter on. Anything outside this set (an
 * app tag, a type tag) needs the full records, so api/notifications.js
 * falls back to the slow path rather than quietly returning a wrong number.
 */
export const INDEX_FILTERABLE = ["assignedTo", "createdBy", "status", "visibility"];

export function canCountFromIndex(filters) {
  const given = Object.keys(filters || {}).filter((k) => filters[k] != null && filters[k] !== "");
  return given.every((k) => INDEX_FILTERABLE.includes(k));
}

/**
 * How many notifications match, without reading a single record.
 *
 * `me` is the caller, used for the same private-visibility rule the list
 * path applies: a private item belongs to whoever created it and is
 * invisible to everyone else, admins included.
 */
export function countSummaries(summaries, filters, me) {
  const who = String(me || "").toLowerCase();
  const f = filters || {};
  return summaries.filter((s) => {
    if (s.visibility === "private" && s.createdBy !== who) return false;
    if (f.assignedTo && s.assignedTo !== String(f.assignedTo).toLowerCase()) return false;
    if (f.createdBy && s.createdBy !== String(f.createdBy).toLowerCase()) return false;
    if (f.status && s.status !== f.status) return false;
    if (f.visibility && s.visibility !== f.visibility) return false;
    return true;
  }).length;
}
