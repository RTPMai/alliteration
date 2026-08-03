// lib/mailme/store.js — MailMe's Upstash access layer.
//
// FRESH build. Mirrors lib/errorengine/store.js's KV conventions exactly
// (same shared Upstash instance, same GET /get + POST /pipeline calls, same
// defensive unwrap for double-encoded / chunked historic values) so a third
// app reading this file already knows the shape.
//
// SHARED INSTANCE. MailMe writes ONLY under the mailme_data: prefix. It reads
// backbone_data READ-ONLY to resolve the roster into contacts and NEVER
// writes that key — same rule ErrorEngine follows.
//
// ESM. Do NOT convert to module.exports.

import { keys, SUPPRESSED_STATUSES, newCampaignDraft } from "./schema.js";

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

// Same defensive triple-unwrap as backbone-store.js / errorengine/store.js.
function unwrap(raw) {
  let data = raw;
  let attempts = 0;
  while (typeof data === "string" && attempts < 3) {
    try { data = JSON.parse(data); } catch (e) { break; }
    attempts++;
  }
  if (typeof data === "object" && data && data["0"] !== undefined && data.synced === undefined) {
    const rebuilt = Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => data[k])
      .join("");
    try { data = JSON.parse(rebuilt); } catch (e) { /* leave as-is */ }
  }
  return data;
}

// ---- BackBone reader (READ-ONLY) -------------------------------------------
// Identical contract to lib/errorengine/store.js's getBackboneData(), kept as
// its own copy rather than a shared import: the two apps must each be free
// to evolve their read of backbone_data without coordinating a shared file.

async function getBackboneData() {
  const raw = await kvGet("backbone_data");
  if (!raw) return { synced: [], enrichment: {} };
  const data = unwrap(raw);
  return {
    synced: (data && data.synced) || [],
    enrichment: (data && data.enrichment) || {},
  };
}

// Best email for a customer: a manually-entered enrichment.contact_email
// overrides the Printavo-synced primary_contact, exactly matching how
// BackBone's own customer detail panel displays and placeholders this field
// (apps/backbone/main.js, the enrichGrid contact_email placeholder logic).
function resolveEmail(customerRow, enrichmentRow) {
  const manual = enrichmentRow && enrichmentRow.contact_email;
  if (manual && String(manual).trim()) return String(manual).trim();
  const pc = customerRow && customerRow.primary_contact;
  return (pc && pc.email) ? String(pc.email).trim() : null;
}

function resolveName(customerRow, enrichmentRow) {
  const first = enrichmentRow && enrichmentRow.contact_first_name;
  const last = enrichmentRow && enrichmentRow.contact_last_name;
  if (first || last) return [first, last].filter(Boolean).join(" ").trim();
  const pc = customerRow && customerRow.primary_contact;
  return (pc && pc.name) ? String(pc.name).trim() : "";
}

// ---- Contact overrides -------------------------------------------------

export async function getContactOverrides() {
  const raw = await kvGet(keys.contactOverrides());
  const data = raw ? unwrap(raw) : null;
  return (data && typeof data === "object") ? data : {};
}

async function setContactOverrides(all) {
  await kvPipeline([["SET", keys.contactOverrides(), JSON.stringify(all)]]);
  return all;
}

/**
 * Full contact list: every BackBone customer with a resolvable email, joined
 * against overrides. This is the join point the app stub's comment promised
 * ("contact lists ... nested near or pulling from the BackBone roster") —
 * there is no separate MailMe contact record for anyone who has no override.
 *
 * customersWithoutEmail is returned too (not merged in) so the Contacts view
 * can show an honest "no email on file" count rather than silently dropping
 * roster rows.
 */
export async function resolveContacts() {
  const [{ synced, enrichment }, overrides] = await Promise.all([
    getBackboneData(),
    getContactOverrides(),
  ]);

  const contacts = [];
  let withoutEmail = 0;

  for (const c of synced) {
    const id = String(c.customer_id);
    const enr = enrichment[id] || {};
    const email = resolveEmail(c, enr);
    if (!email) { withoutEmail++; continue; }

    const ov = overrides[id] || {};
    contacts.push({
      customer_id: id,
      company_name: c.company_name || c.companyName || c.customer || `#${id}`,
      contact_name: resolveName(c, enr),
      email,
      status: ov.status || "subscribed",
      reason: ov.reason || null,
      tags: Array.isArray(ov.tags) ? ov.tags : [],
      updatedAt: ov.updatedAt || null,
    });
  }

  contacts.sort((a, b) => a.company_name.localeCompare(b.company_name));
  return { contacts, customersWithoutEmail: withoutEmail, totalRosterSize: synced.length };
}

/**
 * Set (or clear) an override for one contact. status "subscribed" or a
 * falsy status DELETES the override row rather than storing an explicit
 * "subscribed" — re-subscribing should look identical to "never
 * unsubscribed" in storage, not leave a stale row an admin has to notice.
 */
export async function setContactOverride(customerId, patch, session) {
  const id = String(customerId);
  const all = await getContactOverrides();
  const existing = all[id] || {};

  const next = {
    ...existing,
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: (session && session.username) || existing.updatedBy,
  };

  if (patch.status !== undefined) {
    if (!patch.status || patch.status === "subscribed") {
      delete next.status;
      delete next.reason; // an unsub reason means nothing once resubscribed
    } else {
      next.status = patch.status;
    }
  }

  // Nothing worth keeping (no status, no tags, no reason) — drop the row
  // entirely so the overrides object doesn't accumulate empty entries.
  if (!next.status && !next.reason && (!next.tags || !next.tags.length)) {
    delete all[id];
  } else {
    all[id] = next;
  }

  await setContactOverrides(all);
  return all[id] || { status: "subscribed", tags: [] };
}

export { SUPPRESSED_STATUSES };

// ---- Campaigns ----------------------------------------------------------

export async function listCampaigns() {
  const raw = await kvGet(keys.campaigns());
  const data = raw ? unwrap(raw) : null;
  const list = Array.isArray(data) ? data : [];
  return list.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getCampaign(id) {
  const list = await listCampaigns();
  return list.find((c) => c.id === id) || null;
}

async function saveCampaignList(list) {
  await kvPipeline([["SET", keys.campaigns(), JSON.stringify(list)]]);
  return list;
}

export async function nextCampaignId() {
  const [res] = await kvPipeline([["INCR", keys.campaignCounter()]]);
  const n = res && res.result;
  return `MM-${String(n).padStart(5, "0")}`;
}

export async function createCampaign(patch, session) {
  const list = await listCampaigns();
  const draft = newCampaignDraft(patch, session);
  draft.id = await nextCampaignId();
  list.push(draft);
  await saveCampaignList(list);
  return draft;
}

/** Edit a draft. Sent/sending campaigns are locked — history should not be
 *  rewritable after the fact, same principle as ErrorEngine's cost recompute
 *  never trusting a client-supplied total. */
export async function updateCampaign(id, patch) {
  const list = await listCampaigns();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  if (list[idx].status !== "draft") return { ok: false, reason: "locked" };

  list[idx] = { ...list[idx], ...patch, id, updatedAt: new Date().toISOString() };
  await saveCampaignList(list);
  return { ok: true, campaign: list[idx] };
}

/** Delete a draft. Sent campaigns are never deletable — that would erase the
 *  send history a compliance question might later need. */
export async function deleteCampaign(id) {
  const list = await listCampaigns();
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  if (list[idx].status !== "draft") return { ok: false, reason: "locked" };

  list.splice(idx, 1);
  await saveCampaignList(list);
  return { ok: true };
}
