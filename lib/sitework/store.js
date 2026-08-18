// PUT IN: lib/sitework/store.js  (REPLACES the current one)
// (delete these two banner lines after you check the path)

// lib/sitework/store.js — Sticky Notes Upstash access layer.
//
// Same conventions as lib/notifications/store.js and lib/errorengine/store.js:
// pipeline writes, defensive triple-unwrap, a JSON-array index kept under one
// key rather than a Redis SET. Writes ONLY under the sitework_data: prefix.
//
// ESM. Do NOT convert to module.exports.

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

export async function listNoteIds() {
  const raw = await kvGet(keys.index());
  const ids = raw ? unwrap(raw) : [];
  return Array.isArray(ids) ? ids : [];
}

export async function getNote(id) {
  const raw = await kvGet(keys.record(id));
  return raw ? unwrap(raw) : null;
}

export async function saveNote(record) {
  const ids = await listNoteIds();
  if (!ids.includes(record.id)) ids.push(record.id);
  await kvPipeline([
    ["SET", keys.record(record.id), JSON.stringify(record)],
    ["SET", keys.index(), JSON.stringify(ids)],
  ]);
  return record;
}

export async function updateNote(id, patch) {
  const existing = await getNote(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id };
  await kvPipeline([["SET", keys.record(id), JSON.stringify(merged)]]);
  return merged;
}

export async function deleteNote(id) {
  const ids = await listNoteIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await kvPipeline([
    ["DEL", keys.record(id)],
    ["SET", keys.index(), JSON.stringify(next)],
  ]);
  return true;
}

export async function nextNoteId() {
  const [res] = await kvPipeline([["INCR", keys.counter()]]);
  const n = res && res.result;
  return `S-${String(n).padStart(4, "0")}`;
}

// One pipeline round-trip regardless of how many notes exist. Sorted by board
// position first, then newest, so a note that has never been dragged still
// lands somewhere sensible rather than at a random spot.
export async function listNotes() {
  const ids = await listNoteIds();
  if (!ids.length) return [];
  const cmds = ids.map((id) => ["GET", keys.record(id)]);
  const results = await kvPipeline(cmds);
  return results
    .map((r) => (r && r.result ? unwrap(r.result) : null))
    .filter(Boolean)
    .sort((a, b) => {
      const ao = Number.isFinite(a.order) ? a.order : 0;
      const bo = Number.isFinite(b.order) ? b.order : 0;
      if (ao !== bo) return ao - bo;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
}
