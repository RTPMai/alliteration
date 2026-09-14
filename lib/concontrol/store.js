// lib/concontrol/store.js — ConControl Upstash access layer.
//
// Same conventions as lib/sitework/store.js and lib/errorengine/store.js:
// pipeline writes, defensive triple-unwrap, a JSON-array index under one key
// rather than a Redis SET. Writes ONLY under the concontrol_data: prefix.
//
// lib/ never imports from api/.
//
// ESM. Do NOT convert to module.exports.

import { keys, SEED_TIERS, DEFAULT_EVENT } from "./schema.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfig() {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error("Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  }
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
    try { data = JSON.parse(data); } catch (e) { break; }
    attempts++;
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * SPONSORS
 * ------------------------------------------------------------------ */

export async function listSponsorIds() {
  const raw = await kvGet(keys.index());
  const ids = raw ? unwrap(raw) : [];
  return Array.isArray(ids) ? ids : [];
}

export async function getSponsor(id) {
  const raw = await kvGet(keys.sponsor(id));
  return raw ? unwrap(raw) : null;
}

/**
 * One pipeline round trip regardless of how many sponsors exist, then sorted
 * newest first. Sorting here rather than in the screen means the list, an
 * export and a future digest all agree on the order.
 */
export async function listSponsors(event) {
  const ids = await listSponsorIds();
  if (!ids.length) return [];
  const results = await kvPipeline(ids.map((id) => ["GET", keys.sponsor(id)]));
  const all = results
    .map((r) => (r && r.result ? unwrap(r.result) : null))
    .filter(Boolean);
  const scoped = event ? all.filter((s) => (s.event || DEFAULT_EVENT) === event) : all;
  return scoped.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function saveSponsor(record) {
  const ids = await listSponsorIds();
  if (!ids.includes(record.id)) ids.push(record.id);
  await kvPipeline([
    ["SET", keys.sponsor(record.id), JSON.stringify(record)],
    ["SET", keys.index(), JSON.stringify(ids)],
  ]);
  return record;
}

/**
 * Merge, never replace. `id`, `createdAt` and `createdBy` are pinned so a
 * patch cannot rewrite who made the record or when.
 */
export async function updateSponsor(id, patch) {
  const existing = await getSponsor(id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
    updatedAt: new Date().toISOString(),
  };
  await kvPipeline([["SET", keys.sponsor(id), JSON.stringify(merged)]]);
  return merged;
}

export async function deleteSponsor(id) {
  const ids = await listSponsorIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await kvPipeline([
    ["DEL", keys.sponsor(id)],
    ["SET", keys.index(), JSON.stringify(next)],
  ]);
  return true;
}

export async function nextSponsorId() {
  const [res] = await kvPipeline([["INCR", keys.counter()]]);
  const n = res && res.result;
  return `SP-${String(n).padStart(4, "0")}`;
}

/**
 * Has this company already been entered for this event?
 *
 * Used by the PUBLIC inquiry route so a sponsor filling the form twice does
 * not become two records somebody has to notice and merge. Compared on a
 * loose key (lowercased, punctuation and Inc/LLC dropped) because "Smith
 * Bros." and "Smith Bros LLC" are one company arriving twice.
 */
export function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|co|corp|company|ltd)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function findByCompany(name, event) {
  const key = companyKey(name);
  if (!key) return null;
  const list = await listSponsors(event);
  return list.find((s) => companyKey(s.company) === key) || null;
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 *
 * Tiers and the current event code. A tier lineup changes between events, so
 * it is stored rather than compiled in. Seeded on first read so the app works
 * the day it deploys with no setup step.
 * ------------------------------------------------------------------ */

export async function getSettings() {
  const raw = await kvGet(keys.settings());
  const saved = raw ? unwrap(raw) : null;
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    event: typeof s.event === "string" && s.event ? s.event : DEFAULT_EVENT,
    tiers: Array.isArray(s.tiers) && s.tiers.length ? s.tiers : SEED_TIERS,
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  await kvPipeline([["SET", keys.settings(), JSON.stringify(next)]]);
  return next;
}
