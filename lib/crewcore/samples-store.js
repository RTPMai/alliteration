// lib/crewcore/samples-store.js — storage for SanMar sample drops.
//
// Same plain getRaw/setRaw pattern as lib/crewcore/store.js. Kept in its own
// file because the catalog is a different shape from the rest of CrewCore:
// one key per style, written once at import and read per style after that.
//
// lib/ never imports from api/.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { nextId } from "./schema.js";
import { sampleKeys } from "./samples.js";

// ---- Drops ----------------------------------------------------------------

export async function listDropIds() {
  const ids = await getRaw(sampleKeys.dropIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getDrop(id) {
  if (!id) return null;
  return getRaw(sampleKeys.drop(id));
}

export async function listDrops() {
  const ids = await listDropIds();
  const rows = await Promise.all(ids.map((id) => getDrop(id)));
  return rows
    .filter(Boolean)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export async function saveDrop(record) {
  const ids = await listDropIds();
  const rec = { ...record };
  if (!rec.id) {
    rec.id = nextId("SD", ids);
    rec.created_at = new Date().toISOString();
  }
  rec.updated_at = new Date().toISOString();
  await setRaw(sampleKeys.drop(rec.id), rec);
  if (!ids.includes(rec.id)) await setRaw(sampleKeys.dropIndex(), [...ids, rec.id]);
  return rec;
}

export async function updateDrop(id, patch) {
  const cur = await getDrop(id);
  if (!cur) return null;
  return saveDrop({ ...cur, ...patch, id });
}

/**
 * Deleting a drop leaves its style records behind on purpose. They are keyed
 * by drop id, so nothing else can read them, and a delete that has to walk
 * 138 keys can time out half way and leave the index pointing at a drop whose
 * catalog is partly gone. The orphans cost storage and nothing else.
 */
export async function deleteDrop(id) {
  const ids = await listDropIds();
  if (!ids.includes(id)) return false;
  await setRaw(sampleKeys.dropIndex(), ids.filter((x) => x !== id));
  await setRaw(sampleKeys.drop(id), null);
  return true;
}

// ---- Catalog styles -------------------------------------------------------

export async function getStyle(dropId, style) {
  if (!dropId || !style) return null;
  return getRaw(sampleKeys.style(dropId, style));
}

export async function saveStyle(dropId, record) {
  await setRaw(sampleKeys.style(dropId, record.style), record);
  return record;
}

// ---- Picks ----------------------------------------------------------------

export async function listPickIds() {
  const ids = await getRaw(sampleKeys.pickIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getPick(id) {
  if (!id) return null;
  return getRaw(sampleKeys.pick(id));
}

export async function listPicks({ dropId = null, employeeId = null } = {}) {
  const ids = await listPickIds();
  const rows = (await Promise.all(ids.map((id) => getPick(id)))).filter(Boolean);
  return rows
    .filter((p) => (dropId ? p.drop_id === dropId : true))
    .filter((p) => (employeeId ? p.employee_id === employeeId : true))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export async function savePick(record) {
  const ids = await listPickIds();
  const rec = { ...record };
  if (!rec.id) {
    rec.id = nextId("SP", ids);
    rec.created_at = new Date().toISOString();
  }
  rec.updated_at = new Date().toISOString();
  await setRaw(sampleKeys.pick(rec.id), rec);
  if (!ids.includes(rec.id)) await setRaw(sampleKeys.pickIndex(), [...ids, rec.id]);
  return rec;
}

export async function deletePick(id) {
  const ids = await listPickIds();
  if (!ids.includes(id)) return false;
  await setRaw(sampleKeys.pickIndex(), ids.filter((x) => x !== id));
  await setRaw(sampleKeys.pick(id), null);
  return true;
}
