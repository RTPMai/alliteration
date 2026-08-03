// lib/traveltrack/store.js — TravelTrack's Upstash access layer.
//
// Fresh data, fresh instance layout: unlike ErrorEngine or BackBone this app
// has no legacy double-encoded writes to defend against, so it rides
// lib/kv.js's plain getRaw/setRaw directly instead of reimplementing a
// pipeline client. Everything lives under the traveltrack_data: prefix
// (see lib/traveltrack/schema.js), which keeps it clear of every other app's
// keys in the shared Upstash instance.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { keys, nextId, defaultOrgSettings, defaultAccountSettings } from "./schema.js";

// ---- Trips ---------------------------------------------------------------

export async function listTripIds() {
  const ids = await getRaw(keys.tripIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getTrip(id) {
  return getRaw(keys.trip(id));
}

export async function listTrips() {
  const ids = await listTripIds();
  const rows = await Promise.all(ids.map((id) => getTrip(id)));
  return rows.filter(Boolean).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
}

export async function saveTrip(record) {
  const ids = await listTripIds();
  if (!record.id) record.id = nextId("TR", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.tripIndex(), ids);
  }
  await setRaw(keys.trip(record.id), record);
  return record;
}

export async function updateTrip(id, patch) {
  const existing = await getTrip(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
  await setRaw(keys.trip(id), merged);
  return merged;
}

export async function deleteTrip(id) {
  const ids = await listTripIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.tripIndex(), next);
  await setRaw(keys.trip(id), null);
  return true;
}

// ---- Expenses --------------------------------------------------------------

export async function listExpenseIds() {
  const ids = await getRaw(keys.expenseIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getExpense(id) {
  return getRaw(keys.expense(id));
}

export async function listExpenses() {
  const ids = await listExpenseIds();
  const rows = await Promise.all(ids.map((id) => getExpense(id)));
  return rows.filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export async function saveExpense(record) {
  const ids = await listExpenseIds();
  if (!record.id) record.id = nextId("EX", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.expenseIndex(), ids);
  }
  await setRaw(keys.expense(record.id), record);
  return record;
}

export async function updateExpense(id, patch) {
  const existing = await getExpense(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
  await setRaw(keys.expense(id), merged);
  return merged;
}

export async function deleteExpense(id) {
  const ids = await listExpenseIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.expenseIndex(), next);
  await setRaw(keys.expense(id), null);
  return true;
}

// ---- Loyalty accounts (Redeem Miles) ---------------------------------------

export async function listLoyaltyIds() {
  const ids = await getRaw(keys.loyaltyIndex());
  return Array.isArray(ids) ? ids : [];
}

export async function getLoyaltyAccount(id) {
  return getRaw(keys.loyalty(id));
}

export async function listLoyaltyAccounts() {
  const ids = await listLoyaltyIds();
  const rows = await Promise.all(ids.map((id) => getLoyaltyAccount(id)));
  return rows.filter(Boolean).sort((a, b) => String(a.program_name).localeCompare(String(b.program_name)));
}

export async function saveLoyaltyAccount(record) {
  const ids = await listLoyaltyIds();
  if (!record.id) record.id = nextId("LY", ids);
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await setRaw(keys.loyaltyIndex(), ids);
  }
  if (!Array.isArray(record.redemptions)) record.redemptions = [];
  await setRaw(keys.loyalty(record.id), record);
  return record;
}

export async function updateLoyaltyAccount(id, patch) {
  const existing = await getLoyaltyAccount(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: existing.id, redemptions: existing.redemptions || [] };
  await setRaw(keys.loyalty(id), merged);
  return merged;
}

export async function addRedemption(id, redemption) {
  const existing = await getLoyaltyAccount(id);
  if (!existing) return null;
  const list = Array.isArray(existing.redemptions) ? existing.redemptions.slice() : [];
  const rid = "R" + (list.length + 1);
  const entry = { id: rid, date: new Date().toISOString().slice(0, 10), ...redemption };
  list.push(entry);
  const balance = Math.max(0, Number(existing.balance || 0) - Number(entry.amount_redeemed || 0));
  const merged = { ...existing, redemptions: list, balance };
  await setRaw(keys.loyalty(id), merged);
  return merged;
}

export async function deleteLoyaltyAccount(id) {
  const ids = await listLoyaltyIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return false;
  await setRaw(keys.loyaltyIndex(), next);
  await setRaw(keys.loyalty(id), null);
  return true;
}

// ---- Settings ------------------------------------------------------------

export async function getOrgSettings() {
  const raw = await getRaw(keys.orgSettings());
  return raw ? { ...defaultOrgSettings(), ...raw } : defaultOrgSettings();
}

export async function saveOrgSettings(patch, by) {
  const current = await getOrgSettings();
  const merged = { ...current, ...patch, updated_by: by, updated_at: new Date().toISOString() };
  await setRaw(keys.orgSettings(), merged);
  return merged;
}

export async function getAccountSettings(username) {
  const raw = await getRaw(keys.accountSettings(username));
  return raw ? { ...defaultAccountSettings(username), ...raw } : defaultAccountSettings(username);
}

export async function saveAccountSettings(username, patch) {
  const current = await getAccountSettings(username);
  const merged = { ...current, ...patch, username: current.username, updated_at: new Date().toISOString() };
  await setRaw(keys.accountSettings(username), merged);
  return merged;
}
