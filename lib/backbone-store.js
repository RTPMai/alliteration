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

export const KEYS = {
  data: "backbone_data",
  leads: "backbone_leads",
  intake: "backbone_intake",
  ops: "backbone_printavo_ops",
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
