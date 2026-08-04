// lib/crewcore/store.js — CrewCore's Upstash access layer.
//
// Fresh data, fresh layout, same pattern as lib/traveltrack/store.js: plain
// getRaw/setRaw under a crewcore_data: prefix, no pipeline client needed at
// this scale.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { keys, nextId, defaultSettings } from "./schema.js";

// ---- Employees --------------------------------------------------------------

export async function listEmployeeIds() {
  const ids = await getRaw(keys.employeeIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getEmployee(id) {
  return getRaw(keys.employee(id));
}

export async function listEmployees() {
  const ids = await listEmployeeIds();
  const rows = await Promise.all(ids.map((id) => getEmployee(id)));
  return rows.filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getEmployeeByUsername(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return null;
  const all = await listEmployees();
  return all.find((e) => String(e.username || "").toLowerCase() === u) || null;
}

export async function saveEmployee(record) {
  const ids = await listEmployeeIds();
  if (!record.id) record.id = nextId("EMP", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.employeeIndex(), ids);
  }
  await setRaw(keys.employee(record.id), record);
  return record;
}

export async function updateEmployee(id, patch) {
  const existing = await getEmployee(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
  await setRaw(keys.employee(id), merged);
  return merged;
}

export async function deleteEmployee(id) {
  const ids = await listEmployeeIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.employeeIndex(), next);
  await setRaw(keys.employee(id), null);
  return true;
}

/**
 * One-time roster seed from the P&M internal Wix site's Contact List page
 * (https://ryan7339.wixsite.com/pminternal/contact-list), pulled Aug 3 2026.
 * Names and phone numbers only — that page carries no department, title, or
 * rate data, so those start blank for an admin to fill in. Department is
 * left "Office" as a safe default rather than guessed from the Company
 * Structure org chart, since that page doesn't map every name to a role.
 *
 * Only runs if the employee index is empty, so it can never clobber real
 * data entered after deploy. Call explicitly (e.g. from a one-off admin
 * action), not automatically on every read.
 */
const CONTACT_LIST_SEED = [
  { name: "Megan Griffith", phone: "515-975-7901" },
  { name: "Ryan Toney", phone: "515-490-3940" },
  { name: "Kim Taylor", phone: "206-817-1151" },
  { name: "Margo Niemeyer", phone: "605-690-1126" },
  { name: "Jacob Whitman", phone: "616-307-7612" },
  { name: "Taylor Hitt", phone: "515-808-0234" },
  { name: "Tess Collins", phone: "515-554-6461" },
  { name: "Maggie Barbour", phone: "515-720-3881" },
  { name: "Alex Hernandez", phone: "224-343-0552" },
  { name: "Amanda Clark", phone: "402-366-9695" },
  { name: "Hannah Goodwin", phone: "515-339-1085" },
  { name: "Alexis Davis", phone: "515-868-1519" },
  { name: "Bailee Bishop", phone: "515-901-6061" },
  { name: "Quinn Taylor", phone: "515-490-2761" },
];

export async function seedFromContactList(by) {
  const existing = await listEmployeeIds();
  if (existing.length) {
    return { seeded: false, reason: "Employee roster is not empty", count: existing.length };
  }
  const now = new Date().toISOString();
  for (const person of CONTACT_LIST_SEED) {
    await saveEmployee({
      name: person.name,
      username: null,
      department: "Office",
      title: "",
      start_date: "",
      status: "active",
      phone: person.phone,
      email: "",
      hourly_rate: null,
      apparel_stipend: 0,
      pto_days_per_year: 0,
      notes: "Seeded from P&M internal site contact list. Fill in department, title, start date, and rate.",
      created_by: by || "seed",
      created_at: now,
      updated_at: now,
    });
  }
  return { seeded: true, count: CONTACT_LIST_SEED.length };
}

// ---- PTO requests -----------------------------------------------------------

export async function listPtoIds() {
  const ids = await getRaw(keys.ptoIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getPtoRequest(id) {
  return getRaw(keys.ptoRequest(id));
}

export async function listPtoRequests() {
  const ids = await listPtoIds();
  const rows = await Promise.all(ids.map((id) => getPtoRequest(id)));
  return rows.filter(Boolean).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
}

export async function savePtoRequest(record) {
  const ids = await listPtoIds();
  if (!record.id) record.id = nextId("PTO", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.ptoIndex(), ids);
  }
  await setRaw(keys.ptoRequest(record.id), record);
  return record;
}

export async function updatePtoRequest(id, patch) {
  const existing = await getPtoRequest(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
  await setRaw(keys.ptoRequest(id), merged);
  return merged;
}

export async function deletePtoRequest(id) {
  const ids = await listPtoIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.ptoIndex(), next);
  await setRaw(keys.ptoRequest(id), null);
  return true;
}

/** Approved days used so far in a calendar year, for balance math. */
export async function usedPtoDays(employeeId, year) {
  const all = await listPtoRequests();
  return all
    .filter((r) => r.employee_id === employeeId)
    .filter((r) => r.status === "approved")
    .filter((r) => String(r.start_date || "").slice(0, 4) === String(year))
    .reduce((sum, r) => sum + (Number(r.days) || 0), 0);
}

// ---- Reviews ----------------------------------------------------------------

export async function listReviewIds() {
  const ids = await getRaw(keys.reviewIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getReview(id) {
  return getRaw(keys.review(id));
}

export async function listReviews() {
  const ids = await listReviewIds();
  const rows = await Promise.all(ids.map((id) => getReview(id)));
  return rows.filter(Boolean).sort((a, b) => String(b.review_date).localeCompare(String(a.review_date)));
}

export async function saveReview(record) {
  const ids = await listReviewIds();
  if (!record.id) record.id = nextId("REV", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.reviewIndex(), ids);
  }
  await setRaw(keys.review(record.id), record);
  return record;
}

export async function updateReview(id, patch) {
  const existing = await getReview(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
  await setRaw(keys.review(id), merged);
  return merged;
}

export async function deleteReview(id) {
  const ids = await listReviewIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.reviewIndex(), next);
  await setRaw(keys.review(id), null);
  return true;
}

// ---- Settings ------------------------------------------------------------

export async function getSettings() {
  const raw = await getRaw(keys.settings());
  return raw ? { ...defaultSettings(), ...raw } : defaultSettings();
}

export async function saveSettings(patch, by) {
  const current = await getSettings();
  const merged = { ...current, ...patch, updated_by: by, updated_at: new Date().toISOString() };
  await setRaw(keys.settings(), merged);
  return merged;
}
