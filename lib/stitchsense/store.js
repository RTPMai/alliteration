//
// Same conventions as lib/sitework/store.js and lib/notifications/store.js:
// pipeline writes, defensive triple-unwrap on reads, a JSON array index under
// one key rather than a Redis SET. Writes ONLY under the stitchsense_data:
// prefix.
//
// ONE DELIBERATE DIFFERENCE FROM THE OTHER STORES
// Designs carry a thumbnail data URI, so a design record is a few kilobytes
// rather than a few hundred bytes, and the archive is thousands of designs.
// Reading every full record to render a list would be slow and pointless, so
// the design INDEX holds a summary of each design (id, name, size, stitch
// count) and the thumbnail lives only in the full record. The list views read
// the index; the game reads one full record at a time.
//
// ESM. Do NOT convert to module.exports.

import { keys } from './schema.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfig() {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  }
}

async function kvGet(key) {
  assertConfig();
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

async function kvPipeline(commands) {
  assertConfig();
  if (!commands.length) return [];
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`Redis pipeline failed: ${r.status}`);
  return r.json();
}

function unwrap(raw) {
  let data = raw;
  let attempts = 0;
  while (typeof data === 'string' && attempts < 3) {
    try { data = JSON.parse(data); } catch (e) { break; }
    attempts++;
  }
  return data;
}

async function readIndex(key) {
  const raw = await kvGet(key);
  const list = raw ? unwrap(raw) : [];
  return Array.isArray(list) ? list : [];
}

/* ------------------------------------------------------------------ *
 * IDS
 *
 * INCR rather than list-length-plus-one. Two importers running at once would
 * both read the same length and write the same id, and the second would
 * silently overwrite the first.
 * ------------------------------------------------------------------ */

async function nextId(kind, prefix, width) {
  assertConfig();
  const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(keys.counter(kind))}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) throw new Error(`Redis INCR failed: ${r.status}`);
  const j = await r.json();
  const n = Number(j.result || 0);
  return prefix + String(n).padStart(width, '0');
}

export const nextDesignId = () => nextId('design', 'SD-', 6);
export const nextEstimateId = () => nextId('estimate', 'SE-', 5);
export const nextRoundId = () => nextId('round', 'SR-', 6);

/* ------------------------------------------------------------------ *
 * DESIGNS
 * ------------------------------------------------------------------ */

/** The thumbnail is what makes a record heavy, so the index leaves it out. */
function designSummary(record) {
  return {
    id: record.id,
    name: record.name,
    jobNumber: record.jobNumber || '',
    folder: record.folder || '',
    stitches: record.stitches,
    colors: record.colors,
    w: record.w,
    h: record.h,
    coveredSqIn: record.coveredSqIn,
    fill: record.fill == null ? null : record.fill,
    hasThumb: !!record.thumb,
    character: record.character || '',
    createdAt: record.createdAt
  };
}

export async function listDesigns() {
  return readIndex(keys.designIndex());
}

export async function getDesign(id) {
  const raw = await kvGet(keys.design(id));
  return raw ? unwrap(raw) : null;
}

/**
 * Save a batch of designs in ONE pipeline call.
 *
 * The importer walks thousands of files, and one round trip per design would
 * take long enough that somebody would close the tab halfway through and leave
 * the index disagreeing with the records. Batching is not an optimisation
 * here, it is what makes the import finishable.
 */
export async function saveDesigns(records) {
  if (!records.length) return { saved: 0 };
  const index = await readIndex(keys.designIndex());
  const seen = new Set(index.map((d) => d.id));

  const cmds = [];
  for (const rec of records) {
    cmds.push(['SET', keys.design(rec.id), JSON.stringify(rec)]);
    if (!seen.has(rec.id)) {
      index.push(designSummary(rec));
      seen.add(rec.id);
    } else {
      const at = index.findIndex((d) => d.id === rec.id);
      if (at >= 0) index[at] = designSummary(rec);
    }
  }
  cmds.push(['SET', keys.designIndex(), JSON.stringify(index)]);
  await kvPipeline(cmds);
  return { saved: records.length, total: index.length };
}

export async function updateDesign(id, patch) {
  const existing = await getDesign(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id: existing.id };
  const index = await readIndex(keys.designIndex());
  const at = index.findIndex((d) => d.id === id);
  if (at >= 0) index[at] = designSummary(updated);
  await kvPipeline([
    ['SET', keys.design(id), JSON.stringify(updated)],
    ['SET', keys.designIndex(), JSON.stringify(index)]
  ]);
  return updated;
}

export async function deleteDesign(id) {
  const index = await readIndex(keys.designIndex());
  const next = index.filter((d) => d.id !== id);
  await kvPipeline([
    ['DEL', keys.design(id)],
    ['SET', keys.designIndex(), JSON.stringify(next)]
  ]);
  return { deleted: index.length !== next.length };
}

/**
 * Wipe every design and reset the counter.
 *
 * Exists because the importer will be run more than once (a decoder fix, a
 * bigger archive) and a half-replaced library is worse than an empty one.
 * Deletes in chunks: a single pipeline of several thousand DELs is what
 * ShopStock's bulk delete problem looks like.
 */
export async function clearDesigns() {
  const index = await readIndex(keys.designIndex());
  const CHUNK = 200;
  for (let i = 0; i < index.length; i += CHUNK) {
    await kvPipeline(index.slice(i, i + CHUNK).map((d) => ['DEL', keys.design(d.id)]));
  }
  await kvPipeline([
    ['SET', keys.designIndex(), JSON.stringify([])],
    ['SET', keys.counter('design'), '0']
  ]);
  return { cleared: index.length };
}

/* ------------------------------------------------------------------ *
 * ESTIMATES
 * ------------------------------------------------------------------ */

export async function listEstimates() {
  return readIndex(keys.estimateIndex());
}

export async function getEstimate(id) {
  const raw = await kvGet(keys.estimate(id));
  return raw ? unwrap(raw) : null;
}

export async function saveEstimate(record) {
  const index = await readIndex(keys.estimateIndex());
  const at = index.findIndex((e) => e.id === record.id);
  if (at >= 0) index[at] = record; else index.push(record);
  await kvPipeline([
    ['SET', keys.estimate(record.id), JSON.stringify(record)],
    ['SET', keys.estimateIndex(), JSON.stringify(index)]
  ]);
  return record;
}

export async function deleteEstimate(id) {
  const index = await readIndex(keys.estimateIndex());
  const next = index.filter((e) => e.id !== id);
  await kvPipeline([
    ['DEL', keys.estimate(id)],
    ['SET', keys.estimateIndex(), JSON.stringify(next)]
  ]);
  return { deleted: index.length !== next.length };
}

/* ------------------------------------------------------------------ *
 * ROUNDS
 * ------------------------------------------------------------------ */

export async function listRounds() {
  return readIndex(keys.roundIndex());
}

export async function saveRound(record) {
  const index = await readIndex(keys.roundIndex());
  index.push(record);
  await kvPipeline([
    ['SET', keys.round(record.id), JSON.stringify(record)],
    ['SET', keys.roundIndex(), JSON.stringify(index)]
  ]);
  return record;
}
