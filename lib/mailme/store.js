// lib/mailme/store.js — MailMe's Upstash access layer.
//
// Mirrors lib/errorengine/store.js's KV conventions exactly (same shared
// Upstash instance, GET /get + POST /pipeline, same defensive unwrap for
// double-encoded / chunked historic values).
//
// SHARED INSTANCE. MailMe writes ONLY under the mailme_data: prefix. It reads
// backbone_data READ-ONLY and NEVER writes it — the rule ErrorEngine follows.
//
// TWO CONTACT SOURCES:
//   client   — the BackBone roster, resolved live, never stored here.
//   prospect — imported cold-outreach records, stored here in full because
//              nothing else in the shell knows about them.
// Both are normalized to ONE contact shape by resolveContacts(), so lists,
// sorting and campaigns never branch on where a contact came from.
//
// ESM. Do NOT convert to module.exports.

import {
  keys, SUPPRESSED_STATUSES, newCampaignDraft, normalizeEmail,
  resolveList, aggregateEvents,
} from "./schema.js";

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
  if (typeof data === "object" && data && data["0"] !== undefined && data.synced === undefined) {
    const rebuilt = Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => data[k])
      .join("");
    try { data = JSON.parse(rebuilt); } catch (e) { /* leave as-is */ }
  }
  return data;
}

async function readObject(key) {
  const raw = await kvGet(key);
  const data = raw ? unwrap(raw) : null;
  return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
}

async function readArray(key) {
  const raw = await kvGet(key);
  const data = raw ? unwrap(raw) : null;
  return Array.isArray(data) ? data : [];
}

async function writeKey(key, value) {
  await kvPipeline([["SET", key, JSON.stringify(value)]]);
  return value;
}

// ---- BackBone reader (READ-ONLY) -------------------------------------------

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
// overrides the Printavo-synced primary_contact, matching how BackBone's own
// customer detail panel displays and placeholders this field.
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

// ---- Suppression (by email address, source-independent) --------------------
//
// THE COMPLIANCE BACKSTOP. Keyed by raw email, not by contact id, so an
// opt-out survives the contact record being deleted and re-imported under a
// new id. Every send path and every import consults this.

export async function getSuppression() {
  return readObject(keys.suppressionList());
}

export async function suppressEmail(email, entry) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const all = await getSuppression();
  all[e] = {
    status: (entry && entry.status) || "unsubscribed",
    reason: (entry && entry.reason) || null,
    at: new Date().toISOString(),
    by: (entry && entry.by) || null,
  };
  await writeKey(keys.suppressionList(), all);
  return all[e];
}

export async function unsuppressEmail(email) {
  const e = normalizeEmail(email);
  const all = await getSuppression();
  if (!all[e]) return false;
  // Bounces and complaints are NOT hand-clearable: a hard bounce means the
  // mailbox does not exist, and a complaint means they marked it spam.
  // Resuming either is how a sending domain gets blocked.
  if (all[e].status === "bounced" || all[e].status === "complained") return false;
  delete all[e];
  await writeKey(keys.suppressionList(), all);
  return true;
}

// ---- Roster contact overrides ---------------------------------------------

export async function getContactOverrides() {
  return readObject(keys.contactOverrides());
}

// ---- Prospects -------------------------------------------------------------

export async function getProspects() {
  return readObject(keys.prospects());
}

export async function nextProspectIds(count) {
  // One INCR for the whole batch: importing 800 rows must not be 800 round
  // trips. INCRBY returns the LAST id in the reserved block.
  const [res] = await kvPipeline([["INCRBY", keys.prospectCounter(), String(count)]]);
  const end = Number(res && res.result);
  const start = end - count + 1;
  const ids = [];
  for (let n = start; n <= end; n++) ids.push(`PR-${String(n).padStart(5, "0")}`);
  return ids;
}

/** Insert importable rows as prospects. Caller has already classified them. */
export async function addProspects(rows, session, batchId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { added: [], batchId };

  const all = await getProspects();
  const ids = await nextProspectIds(list.length);
  const now = new Date().toISOString();
  const added = [];

  list.forEach((r, i) => {
    const rec = {
      prospect_id: ids[i],
      email: normalizeEmail(r.email),
      company_name: r.company_name || "",
      contact_name: r.contact_name || "",
      title: r.title || "",
      phone: r.phone || "",
      city: r.city || "",
      state: r.state || "",
      tags: Array.isArray(r.tags) ? r.tags : [],
      importedAt: now,
      importedBy: (session && session.username) || null,
      importBatch: batchId || null,
    };
    all[rec.prospect_id] = rec;
    added.push(rec);
  });

  await writeKey(keys.prospects(), all);
  return { added, batchId };
}

/** Undo one import batch. An import is the easiest thing to get wrong in
 *  bulk, so it must be reversible as a unit rather than row by row. */
export async function deleteProspectBatch(batchId) {
  const all = await getProspects();
  const ids = Object.keys(all).filter((id) => all[id] && all[id].importBatch === batchId);
  ids.forEach((id) => { delete all[id]; });
  await writeKey(keys.prospects(), all);
  return ids.length;
}

export async function updateProspect(id, patch) {
  const all = await getProspects();
  const rec = all[id];
  if (!rec) return null;
  const next = { ...rec, ...patch, prospect_id: rec.prospect_id, email: rec.email };
  all[id] = next;
  await writeKey(keys.prospects(), all);
  return next;
}

export async function deleteProspect(id) {
  const all = await getProspects();
  if (!all[id]) return false;
  delete all[id];
  await writeKey(keys.prospects(), all);
  return true;
}

// ---- Unified contact resolution --------------------------------------------

/**
 * Every mailable contact, both sources, in ONE normalized shape.
 *
 * Suppression is applied here as the authoritative status: whatever a contact
 * record says, an address on the suppression list reads as suppressed. That
 * means there is no code path anywhere above this function that can see an
 * opted-out address as mailable.
 *
 * `id` is the stable cross-source identifier used by lists and events:
 * "client:<customer_id>" or "prospect:<prospect_id>". Prefixed so a roster
 * customer_id can never collide with a prospect id.
 */
export async function resolveContacts() {
  const [{ synced, enrichment }, overrides, prospects, suppression] = await Promise.all([
    getBackboneData(),
    getContactOverrides(),
    getProspects(),
    getSuppression(),
  ]);

  const contacts = [];
  let withoutEmail = 0;

  // --- client contacts, from the roster ---
  for (const c of synced) {
    const cid = String(c.customer_id);
    const enr = enrichment[cid] || {};
    const email = resolveEmail(c, enr);
    if (!email) { withoutEmail++; continue; }

    const ov = overrides[cid] || {};
    const sup = suppression[normalizeEmail(email)];

    contacts.push({
      id: `client:${cid}`,
      source: "client",
      customer_id: cid,
      company_name: c.company_name || c.companyName || c.customer || `#${cid}`,
      contact_name: resolveName(c, enr),
      title: (c.primary_contact && c.primary_contact.title) || "",
      email,
      phone: (c.primary_contact && c.primary_contact.phone) || "",
      city: enr.city || "",
      state: enr.state || "",
      status: (sup && sup.status) || ov.status || "subscribed",
      reason: (sup && sup.reason) || ov.reason || null,
      tags: Array.isArray(ov.tags) ? ov.tags : [],
      updatedAt: ov.updatedAt || null,
    });
  }

  // --- prospect contacts, imported ---
  for (const id of Object.keys(prospects)) {
    const p = prospects[id];
    if (!p || !p.email) continue;
    const sup = suppression[normalizeEmail(p.email)];

    contacts.push({
      id: `prospect:${p.prospect_id}`,
      source: "prospect",
      prospect_id: p.prospect_id,
      company_name: p.company_name || "",
      contact_name: p.contact_name || "",
      title: p.title || "",
      email: p.email,
      phone: p.phone || "",
      city: p.city || "",
      state: p.state || "",
      status: (sup && sup.status) || p.status || "subscribed",
      reason: (sup && sup.reason) || p.reason || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      importedAt: p.importedAt || null,
      importBatch: p.importBatch || null,
      updatedAt: p.importedAt || null,
    });
  }

  return {
    contacts,
    customersWithoutEmail: withoutEmail,
    totalRosterSize: synced.length,
    prospectCount: contacts.filter((c) => c.source === "prospect").length,
    clientCount: contacts.filter((c) => c.source === "client").length,
  };
}

/** Emails already known, for import dedupe. */
export async function knownEmails() {
  const { contacts } = await resolveContacts();
  const suppression = await getSuppression();
  return {
    clientEmails: contacts.filter((c) => c.source === "client").map((c) => normalizeEmail(c.email)),
    prospectEmails: contacts.filter((c) => c.source === "prospect").map((c) => normalizeEmail(c.email)),
    suppressedEmails: Object.keys(suppression),
  };
}

/**
 * Change a contact's subscribe state, whichever source it belongs to.
 *
 * Unsubscribes ALWAYS write the email-level suppression list as well as the
 * per-contact record, so the opt-out survives the record being deleted.
 */
export async function setContactStatus(contactId, patch, session) {
  const id = String(contactId);
  const [source, localId] = id.includes(":") ? id.split(":") : ["client", id];

  const { contacts } = await resolveContacts();
  const contact = contacts.find((c) => c.id === id);
  if (!contact) return { ok: false, reason: "not_found" };

  if (patch.status !== undefined) {
    if (patch.status === "subscribed") {
      const cleared = await unsuppressEmail(contact.email);
      if (!cleared) {
        return { ok: false, reason: "provider_set" };
      }
    } else {
      await suppressEmail(contact.email, {
        status: patch.status,
        reason: patch.reason,
        by: (session && session.username) || null,
      });
    }
  }

  // Tags live on the contact record, not the suppression list.
  if (patch.tags !== undefined) {
    if (source === "prospect") {
      await updateProspect(localId, { tags: patch.tags });
    } else {
      const all = await getContactOverrides();
      const existing = all[localId] || {};
      const next = {
        ...existing,
        tags: patch.tags,
        updatedAt: new Date().toISOString(),
        updatedBy: (session && session.username) || existing.updatedBy,
      };
      if (!next.tags.length && !next.status && !next.reason) delete all[localId];
      else all[localId] = next;
      await writeKey(keys.contactOverrides(), all);
    }
  }

  return { ok: true };
}

// ---- Lists -----------------------------------------------------------------

export async function listLists() {
  const all = await readArray(keys.lists());
  return all.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getList(id) {
  const all = await listLists();
  return all.find((l) => l.id === id) || null;
}

export async function createList(patch, session) {
  const all = await readArray(keys.lists());
  const [res] = await kvPipeline([["INCR", keys.listCounter()]]);
  const now = new Date().toISOString();
  const rec = {
    id: `LS-${String(res && res.result).padStart(5, "0")}`,
    name: patch.name,
    kind: patch.kind || "dynamic",
    members: patch.members || [],
    rule: patch.rule || null,
    createdAt: now,
    createdBy: (session && session.username) || null,
    updatedAt: now,
  };
  all.push(rec);
  await writeKey(keys.lists(), all);
  return rec;
}

export async function updateList(id, patch) {
  const all = await readArray(keys.lists());
  const idx = all.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch, id, updatedAt: new Date().toISOString() };
  await writeKey(keys.lists(), all);
  return all[idx];
}

export async function deleteList(id) {
  const all = await readArray(keys.lists());
  const next = all.filter((l) => l.id !== id);
  if (next.length === all.length) return false;
  await writeKey(keys.lists(), next);
  return true;
}

/** A list's membership, resolved against live contacts. */
export async function membersOf(list) {
  const { contacts } = await resolveContacts();
  return resolveList(list, contacts);
}

// ---- Campaigns -------------------------------------------------------------

export async function listCampaigns() {
  const all = await readArray(keys.campaigns());
  return all.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getCampaign(id) {
  const all = await listCampaigns();
  return all.find((c) => c.id === id) || null;
}

export async function createCampaign(patch, session) {
  const all = await readArray(keys.campaigns());
  const [res] = await kvPipeline([["INCR", keys.campaignCounter()]]);
  const draft = newCampaignDraft(patch, session);
  draft.id = `MM-${String(res && res.result).padStart(5, "0")}`;
  all.push(draft);
  await writeKey(keys.campaigns(), all);
  return draft;
}

export async function updateCampaign(id, patch) {
  const all = await readArray(keys.campaigns());
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  if (all[idx].status !== "draft") return { ok: false, reason: "locked" };
  all[idx] = { ...all[idx], ...patch, id, updatedAt: new Date().toISOString() };
  await writeKey(keys.campaigns(), all);
  return { ok: true, campaign: all[idx] };
}

export async function deleteCampaign(id) {
  const all = await readArray(keys.campaigns());
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  if (all[idx].status !== "draft") return { ok: false, reason: "locked" };
  all.splice(idx, 1);
  await writeKey(keys.campaigns(), all);
  return { ok: true };
}

// ---- Events / results ------------------------------------------------------

export async function getCampaignEvents(campaignId) {
  return readArray(keys.campaignEvents(campaignId));
}

/** Append normalized tracking events. Written only by the webhook receiver. */
export async function appendCampaignEvents(campaignId, events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return 0;
  const all = await getCampaignEvents(campaignId);
  all.push(...list);
  await writeKey(keys.campaignEvents(campaignId), all);
  return list.length;
}

/**
 * A campaign's results. Stats are ALWAYS recomputed from raw events rather
 * than read from the campaign record: a stored counter that drifts from its
 * events is a number nobody can audit, and the events are the source of truth.
 */
export async function campaignResults(campaignId, recipientCount) {
  const events = await getCampaignEvents(campaignId);
  return aggregateEvents(events, recipientCount);
}

export { SUPPRESSED_STATUSES };
