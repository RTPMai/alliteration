// lib/backbone-store.js — BackBone's roster storage.
//
// Shared by api/data.js, api/save.js and the sync endpoints so the defensive
// decoding lives in ONE place. It has to be defensive: historic writes were
// double-encoded, and some were chunked across numeric keys when a payload
// outgrew a single value. Assuming one shape breaks on the older records.
//
// Keys are BackBone's originals (backbone_data, backbone_leads, ...) rather
// than the shell's "alliteration:" namespace, because the data already exists
// under those names. Renaming would orphan the live roster.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

import { foldRoster } from "./backbone-merge.js";

export const KEYS = {
  data: "backbone_data",
  leads: "backbone_leads",
  intake: "backbone_intake",
  ops: "backbone_printavo_ops",
  merges: "backbone_merges",
};

export function isConfigured() {
  return !!(KV_URL && KV_TOKEN);
}

export async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

export async function kvSet(key, value) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!r.ok) throw new Error(`Storage write failed (${r.status}) for ${key}`);
  return value;
}

/**
 * Decode a stored value.
 *
 * Two historic shapes to survive:
 *   1. Double (or triple) JSON encoding — parse until it stops being a string.
 *   2. Chunking — a large payload split across numeric keys {"0":"...","1":"..."}
 *      and reassembled in order.
 *
 * Returns null rather than throwing on malformed data: one bad record should
 * not take down the whole roster.
 */
export function unwrap(raw) {
  if (!raw) return null;
  let data = raw;
  let attempts = 0;

  while (typeof data === "string" && attempts < 3) {
    try { data = JSON.parse(data); }
    catch (e) { break; }
    attempts++;
  }

  if (data && typeof data === "object" && !Array.isArray(data) &&
      data.synced === undefined && data["0"] !== undefined) {
    try {
      data = JSON.parse(
        Object.keys(data)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => data[k])
          .join("")
      );
    } catch (e) {
      console.error("[backbone-store] chunked value did not reassemble");
      return null;
    }
  }

  return data;
}

/** Read and decode in one step. */
export async function readKey(key) {
  return unwrap(await kvGet(key));
}

/* ------------------------------------------------------------------ *
 * MERGED CLIENTS
 *
 * A customer that BackBone holds as two or three rows because Printavo issued
 * more than one id for them. The merge is stored as its own record and applied
 * WHEN THE ROSTER IS READ, so the sync never has to know about it and a merge
 * survives every future reconcile. See lib/backbone-merge.js.
 * ------------------------------------------------------------------ */

/** The stored merge groups, or an empty list. Never throws. */
export async function readMergeGroups() {
  try {
    const raw = await readKey(KEYS.merges);
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw.groups) ? raw.groups : [];
  } catch (e) {
    console.error("[backbone-store] could not read merge groups:", e && e.message);
    return [];
  }
}

/**
 * The roster with merges applied. This is what every screen should read.
 *
 * FAILS OPEN, DELIBERATELY. If the merge record is unreadable the raw roster
 * is returned rather than nothing: a client showing as two rows is a smaller
 * problem than a roster that will not load. The `mergesApplied` flag says
 * which happened, so a caller can tell the difference.
 *
 * Callers that need the UNFOLDED rows, such as the merge screen itself and
 * anything that writes the roster back, must keep using readKey(KEYS.data).
 * Writing folded data back would destroy the original records.
 */
export async function readRoster() {
  const data = await readKey(KEYS.data);
  if (!data) return null;

  const groups = await readMergeGroups();
  if (!groups.length) return { ...data, mergesApplied: 0 };

  try {
    const folded = foldRoster(data, groups);
    return {
      ...data,
      synced: folded.synced,
      enrichment: folded.enrichment,
      mergesApplied: folded.foldedGroups,
    };
  } catch (e) {
    console.error("[backbone-store] merge fold failed, serving raw roster:", e && e.message);
    return { ...data, mergesApplied: 0, mergeError: true };
  }
}
