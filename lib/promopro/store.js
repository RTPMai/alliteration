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
 * Work out the PO numbers for every PO on the same job, and return the ones
 * that need writing.
 *
 * The suffix rule means numbering is not a property of a PO on its own: the
 * first PO on invoice 66601 is "26-66601" while it is the only one, and
 * becomes "26-66601-1" the moment a second is raised. So adding a PO can
 * renumber its siblings. Sequence order is creation order, which is stable
 * and matches how the imprints were actually ordered.
 */
export function assignPoNumbers(siblings) {
  const ordered = siblings
    .slice()
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const total = ordered.length;
  return ordered.map((po, i) => ({
    ...po,
    poNumber: buildPoNumber({
      year: po.year || yearPrefix(po.createdAt),
      invoiceNumber: po.printavo && po.printavo.invoiceNumber,
      manualSeq: po.manualSeq,
      seq: i + 1,
      total,
    }),
  }));
}

/** Every PO sharing a job key, which is the invoice number or the manual seq. */
export function jobKeyOf(po) {
  if (po && po.printavo && po.printavo.invoiceNumber) {
    return `${po.year || yearPrefix(po.createdAt)}-${po.printavo.invoiceNumber}`;
  }
  return `${po.year || yearPrefix(po.createdAt)}-M${String(po.manualSeq || 1).padStart(3, "0")}`;
}

/**
 * Save a new PO and renumber its siblings in the same write, so the index
 * and every affected record move together rather than leaving a window where
 * two POs claim the same number.
 */
export async function savePo(record) {
  const ids = await listPoIds();
  const all = ids.length
    ? (await kvPipeline(ids.map((id) => ["GET", keys.record(id)])))
        .map((r) => (r && r.result ? unwrap(r.result) : null))
        .filter(Boolean)
    : [];

  const key = jobKeyOf(record);
  const siblings = all.filter((p) => jobKeyOf(p) === key && p.id !== record.id);
  const numbered = assignPoNumbers(siblings.concat([record]));

  const cmds = numbered.map((p) => ["SET", keys.record(p.id), JSON.stringify(p)]);
  if (!ids.includes(record.id)) ids.push(record.id);
  cmds.push(["SET", keys.index(), JSON.stringify(ids)]);
  await kvPipeline(cmds);

  return numbered.find((p) => p.id === record.id) || record;
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
