// PUT IN: lib/crewcore/pto-store.js
// lib/crewcore/pto-store.js: storage for time off.
//
// Same getRaw/setRaw pattern as lib/crewcore/store.js, same crewcore_data:
// prefix, its own file so the PTO keys sit in one place. The arithmetic
// lives in lib/crewcore/pto.js; nothing here computes a balance.
//
// Three things are stored:
//   requests     one record each, plus an index
//   adjustments  one record each, plus an index
//   policy       one document, versioned by year inside (see pto.js)
//
// The starting balance is NOT here. It lives on the employee record as
// pto_opening, because it is a fact about that person, set once.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { KEY_PREFIX, nextId } from "./schema.js";
import { cleanPolicyDoc } from "./pto.js";

export const ptoKeys = {
  request:     (id) => `${KEY_PREFIX}:pto_request:${id}`,
  requestIndex: () => `${KEY_PREFIX}:pto_request_index`,
  adjust:      (id) => `${KEY_PREFIX}:pto_adjust:${id}`,
  adjustIndex:  () => `${KEY_PREFIX}:pto_adjust_index`,
  policy:       () => `${KEY_PREFIX}:pto_policy`,
};

async function listIds(key) {
  const ids = await getRaw(key);
  return Array.isArray(ids) ? ids : [];
}

// ---- Requests ---------------------------------------------------------------

export async function listRequests() {
  const ids = await listIds(ptoKeys.requestIndex());
  const rows = await Promise.all(ids.map((id) => getRaw(ptoKeys.request(id))));
  return rows.filter(Boolean)
    .sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")));
}

export async function getRequest(id) {
  return getRaw(ptoKeys.request(id));
}

export async function saveRequest(record) {
  const ids = await listIds(ptoKeys.requestIndex());
  if (!record.id) record.id = nextId("PTO", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(ptoKeys.requestIndex(), ids);
  }
  await setRaw(ptoKeys.request(record.id), record);
  return record;
}

// ---- Adjustments ------------------------------------------------------------

export async function listAdjustments() {
  const ids = await listIds(ptoKeys.adjustIndex());
  const rows = await Promise.all(ids.map((id) => getRaw(ptoKeys.adjust(id))));
  return rows.filter(Boolean)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export async function getAdjustment(id) {
  return getRaw(ptoKeys.adjust(id));
}

export async function saveAdjustment(record) {
  const ids = await listIds(ptoKeys.adjustIndex());
  if (!record.id) record.id = nextId("ADJ", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(ptoKeys.adjustIndex(), ids);
  }
  await setRaw(ptoKeys.adjust(record.id), record);
  return record;
}

export async function deleteAdjustment(id) {
  const ids = await listIds(ptoKeys.adjustIndex());
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(ptoKeys.adjustIndex(), next);
  await setRaw(ptoKeys.adjust(id), null);
  return true;
}

// ---- Policy -----------------------------------------------------------------

/**
 * The first read ever writes the document down, pinning start_year to the
 * year time off tracking began. Without that, an unsaved policy would read
 * start_year as "this year" forever, and on Jan 1 every balance would forget
 * the year before it, carryover included.
 */
export async function getPolicyDoc() {
  const raw = await getRaw(ptoKeys.policy());
  if (raw) return cleanPolicyDoc(raw);
  const fresh = cleanPolicyDoc(null);
  await setRaw(ptoKeys.policy(), fresh);
  return fresh;
}

export async function savePolicyDoc(doc) {
  const clean = cleanPolicyDoc(doc);
  await setRaw(ptoKeys.policy(), clean);
  return clean;
}
