// lib/promopro/store.js — PromoPro Upstash access layer.
//
// Same conventions as lib/notifications/store.js: pipeline writes, defensive
// triple-unwrap, a JSON-array index under one key. Writes ONLY under the
// promopro_data: prefix.
//
// ESM. Do NOT convert to module.exports.

import { keys, buildPoNumber, yearPrefix } from "./schema.js";

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
    try { data = JSON.parse(data); } catch (e) { break; }
    attempts++;
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * PURCHASE ORDERS
 * ------------------------------------------------------------------ */

export async function listPoIds() {
  const raw = await kvGet(keys.index());
  const ids = raw ? unwrap(raw) : [];
  return Array.isArray(ids) ? ids : [];
}

export async function getPo(id) {
  const raw = await kvGet(keys.record(id));
  return raw ? unwrap(raw) : null;
}

/** One pipeline round-trip regardless of how many POs exist. */
export async function listPos() {
  const ids = await listPoIds();
  if (!ids.length) return [];
  const results = await kvPipeline(ids.map((id) => ["GET", keys.record(id)]));
  return results
    .map((r) => (r && r.result ? unwrap(r.result) : null))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Next sequence number for a manual (non-Printavo) PO in a given year.
 * INCR, so two people raising a manual order at once cannot collide.
 */
export async function nextManualSeq(year) {
  const [res] = await kvPipeline([["INCR", keys.manualCounter(year)]]);
  return Number(res && res.result) || 1;
}

/**
 * The PO number for one record.
 *
 * SIMPLIFIED Aug 2026. This used to renumber every PO on a job whenever a new
 * one was added, because the suffix was a running count: adding a second PO
 * turned the first from "26-66608" into "26-66608-1". That whole mechanism
 * existed to support a rule that turned out to be wrong. The suffix is the
 * imprint's own number on the Printavo job, which is a fact about the imprint
 * and not about how many POs we have raised. So a PO's number depends only on
 * itself, siblings never move, and a number a vendor already has can never
 * change underneath them.
 */
export function numberFor(po) {
  return buildPoNumber({
    year: po.year || yearPrefix(po.createdAt),
    invoiceNumber: po.printavo && po.printavo.invoiceNumber,
    manualSeq: po.manualSeq,
    imprintNumber: po.printavo && po.printavo.imprintNumber,
  });
}

/**
 * Save a new PO.
 *
 * No sibling reads, no renumbering: see numberFor(). Two POs covering the
 * same imprint on the same job would collide, but that is a duplicate rather
 * than a numbering problem, and the pipeline shows it plainly instead of
 * hiding it behind a silent -2.
 */
export async function savePo(record) {
  const ids = await listPoIds();
  const numbered = { ...record, poNumber: numberFor(record) };

  const cmds = [["SET", keys.record(numbered.id), JSON.stringify(numbered)]];
  if (!ids.includes(numbered.id)) {
    ids.push(numbered.id);
    cmds.push(["SET", keys.index(), JSON.stringify(ids)]);
  }
  await kvPipeline(cmds);

  return numbered;
}

export async function updatePo(id, patch) {
  const existing = await getPo(id);
  if (!existing) return null;
  // id, poNumber and createdAt are never patchable: the first two are
  // assigned by the store and the third is what numbering order depends on.
  const merged = {
    ...existing,
    ...patch,
    id: existing.id,
    poNumber: existing.poNumber,
    createdAt: existing.createdAt,
  };
  await kvPipeline([["SET", keys.record(id), JSON.stringify(merged)]]);
  return merged;
}

export async function deletePo(id) {
  const ids = await listPoIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await kvPipeline([
    ["DEL", keys.record(id)],
    ["SET", keys.index(), JSON.stringify(next)],
  ]);
  return true;
}

/* ------------------------------------------------------------------ *
 * VENDORS
 *
 * A list under one key, not a record each: this is a couple of dozen rows
 * that every screen reads in full. Adding a vendor is a Settings action,
 * never a deploy, same call WebsiteWidget's sites-store makes.
 * ------------------------------------------------------------------ */

export async function getVendors() {
  const raw = await kvGet(keys.vendors());
  const list = raw ? unwrap(raw) : [];
  return Array.isArray(list) ? list : [];
}

export async function saveVendors(list) {
  await kvPipeline([["SET", keys.vendors(), JSON.stringify(list)]]);
  return list;
}

export async function getSettings() {
  const raw = await kvGet(keys.settings());
  const s = raw ? unwrap(raw) : null;
  return s && typeof s === "object" ? s : {};
}

/**
 * Shallow merge, and note the trap this pattern has already caused once in
 * MailMe: a NESTED settings object has to be merged explicitly here or a
 * partial patch wipes the keys it did not mention.
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (patch && patch.defaults) {
    next.defaults = { ...(current.defaults || {}), ...patch.defaults };
  }
  await kvPipeline([["SET", keys.settings(), JSON.stringify(next)]]);
  return next;
}
