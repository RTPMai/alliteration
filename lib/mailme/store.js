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
  resolveList, aggregateEvents, mergeSettings,
} from "./schema.js";
import { reorderStatus, ytdRevenue } from "./audience.js";
import { listRequests } from "../giving.js";

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

// Leads are BackBone's own qualified pipeline, stored separately from the
// customer roster. Read-only, same as backbone_data.
async function getLeads() {
  const raw = await kvGet("backbone_leads");
  if (!raw) return [];
  const data = unwrap(raw);
  if (Array.isArray(data)) return data;
  return (data && Array.isArray(data.leads)) ? data.leads : [];
}

// GivingGauge requests. Every org that asked for a donation handed over a
// contact email and told P&M they run an event with apparel needs, which
// makes them a warmer audience than anything that could be bought.
//
// FIXED Aug 3: this originally read a guessed key ("givinggauge_requests"),
// which does not exist, so Giving silently showed zero. Requests actually
// live under alliteration:giving:index plus one key per request. Rather than
// re-derive that layout here (and risk drifting from it again), this calls
// GivingGauge's own listRequests(). One reader, one place to be wrong.
async function getGivingRequests() {
  try {
    const rows = await listRequests();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    // A GivingGauge outage must not take down the whole contact list.
    console.error("[mailme] giving requests unavailable:", e && e.message);
    return [];
  }
}

// Pull the best contact off a lead. Leads store qualification data with a
// key_contacts array; prefer a contact that actually has an email, since a
// name with no address cannot be emailed however senior the person is.
// The qualification agent is REQUIRED to emit a value for every field, so a
// missing email comes back as "not found" / "N/A" / "unknown" rather than
// being omitted. Those are not addresses. Without this filter MailMe would
// have created contacts whose email is literally the string "not found" and
// cheerfully counted them as mailable.
//
// Mirrors the same cleaning BackBone does on its own lead table.
const CONTACT_PLACEHOLDER_RE =
  /^(not\s*found|none|n\/?a|null|unknown|unavailable|not\s*(listed|available|provided|public|disclosed)|tbd|-{1,}|\u2014)$/i;

function cleanLeadEmail(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t || CONTACT_PLACEHOLDER_RE.test(t)) return "";
  // Extract a real address even when it arrives inside a sentence, which the
  // older contact_info free-text field routinely did.
  const m = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : "";
}

function leadContact(lead) {
  const direct = cleanLeadEmail(lead.contact_email || lead.email);
  if (direct) {
    return { email: direct, name: lead.contact_name || "", title: lead.contact_title || "" };
  }

  const qual = lead.qualification || {};
  const contacts = Array.isArray(qual.key_contacts) ? qual.key_contacts
    : Array.isArray(lead.key_contacts) ? lead.key_contacts : [];

  // Keep the person INTACT: take the name and title from whoever actually
  // owns the address, never the first name found beside a different person's
  // email. BackBone learned this one the hard way.
  for (const c of contacts) {
    if (!c) continue;
    const email = cleanLeadEmail(c.email || c.contact_info);
    if (email) {
      return { email, name: c.name || "", title: c.title || "" };
    }
  }
  return null;
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

// ---- Settings --------------------------------------------------------------

export async function getSettings() {
  return mergeSettings(await readObject(keys.settings()));
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current, ...patch,
    postalAddress: { ...current.postalAddress, ...(patch.postalAddress || {}) },
    identities: Array.isArray(patch.identities) && patch.identities.length ? patch.identities : current.identities,
    policy: { ...current.policy, ...(patch.policy || {}) },
    reorder: { ...current.reorder, ...(patch.reorder || {}) },
  };
  await writeKey(keys.settings(), next);
  return next;
}

// ---- Verification results --------------------------------------------------
// Keyed by EMAIL, not contact id, so a re-imported address keeps its result
// and is not re-billed to a verification provider.

export async function getVerification() {
  return readObject(keys.verification());
}

export async function setVerification(results) {
  const all = await getVerification();
  const now = new Date().toISOString();
  let n = 0;
  for (const [email, status] of Object.entries(results || {})) {
    const e = normalizeEmail(email);
    if (!e) continue;
    all[e] = { status, at: now };
    n++;
  }
  await writeKey(keys.verification(), all);
  return n;
}

// ---- Send history (frequency cap) ------------------------------------------

export async function getLastEmailed() {
  return readObject(keys.lastEmailed());
}

export async function recordSends(contactIds, when) {
  const all = await getLastEmailed();
  const at = when || new Date().toISOString();
  (contactIds || []).forEach((id) => { all[String(id)] = at; });
  await writeKey(keys.lastEmailed(), all);
  return all;
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
export async function resolveContacts(opts) {
  const [
    { synced, enrichment }, overrides, prospects, suppression,
    leads, giving, verification, lastEmailed, settings,
  ] = await Promise.all([
    getBackboneData(), getContactOverrides(), getProspects(), getSuppression(),
    getLeads(), getGivingRequests(), getVerification(), getLastEmailed(), getSettings(),
  ]);

  const now = (opts && opts.now) || new Date().toISOString();
  const contacts = [];
  let withoutEmail = 0;
  const seen = new Set();

  // Decorate every contact with the shared fields: suppression status,
  // verification result and send history. Done in one place so no source can
  // accidentally skip the suppression join.
  const decorate = (base, rawStatus, rawReason) => {
    const key = normalizeEmail(base.email);
    const sup = suppression[key];
    const ver = verification[key];
    return {
      ...base,
      status: (sup && sup.status) || rawStatus || "subscribed",
      reason: (sup && sup.reason) || rawReason || null,
      verification: (ver && ver.status) || "unverified",
      lastEmailedAt: lastEmailed[base.id] || null,
    };
  };

  // --- client contacts, from the roster ---
  for (const c of synced) {
    const cid = String(c.customer_id);
    const enr = enrichment[cid] || {};
    const email = resolveEmail(c, enr);
    if (!email) { withoutEmail++; continue; }
    seen.add(normalizeEmail(email));

    const ov = overrides[cid] || {};
    contacts.push(decorate({
      id: `client:${cid}`,
      source: "client",
      customer_id: cid,
      // A MailMe-local correction (ov.<field>) wins over what BackBone
      // resolved, same precedence tags/status already use. This is a
      // MailMe-only overlay — it never writes back to backbone_data, so
      // BackBone's own record is untouched; see setContactStatus.
      company_name: ov.company_name || c.company_name || c.companyName || c.customer || `#${cid}`,
      contact_name: ov.contact_name || resolveName(c, enr),
      title: ov.title || (c.primary_contact && c.primary_contact.title) || "",
      email,
      phone: ov.phone || (c.primary_contact && c.primary_contact.phone) || "",
      city: ov.city || enr.city || "",
      state: ov.state || enr.state || "",
      tags: Array.isArray(ov.tags) ? ov.tags : [],
      accountManager: enr.account_manager || "",
      // Order history, which is what makes reorder timing possible at all.
      lastOrderDate: c.last_invoice_date || null,
      orderCount: Number(c.invoice_count) || 0,
      lifetimeRevenue: Number(c.total_revenue) || 0,
      ytdRevenue: ytdRevenue(c, now),
      reorder: reorderStatus(c, { ...settings.reorder, now }),
      hasOpenQuote: !!enr.has_open_quote,
      updatedAt: ov.updatedAt || null,
    }, ov.status, ov.reason));
  }

  // --- lead contacts, from BackBone's pipeline ---
  for (const l of leads) {
    const lc = leadContact(l || {});
    if (!lc || !lc.email) continue;
    const key = normalizeEmail(lc.email);
    // A lead that has since become a customer is already in the list above;
    // showing them twice would double-count and risk two emails.
    if (seen.has(key)) continue;
    seen.add(key);

    const lid = String(l.id || l.lead_id || key);
    const lov = overrides[`lead:${lid}`] || {};
    contacts.push(decorate({
      id: `lead:${lid}`,
      source: "lead",
      lead_id: lid,
      company_name: lov.company_name || l.company_name || l.company || "",
      contact_name: lov.contact_name || lc.name,
      title: lov.title || lc.title,
      email: lc.email,
      phone: lov.phone || l.contact_phone || "",
      city: lov.city || l.city || "",
      state: lov.state || l.state || "",
      tags: Array.isArray(lov.tags) ? lov.tags : [],
      accountManager: l.owner || l.account_manager || "",
      leadStatus: l.status || "",
      updatedAt: lov.updatedAt || l.updated_at || l.created_at || null,
    }, lov.status, lov.reason));
  }

  // --- giving contacts, from donation requests ---
  for (const g of giving) {
    const req = (g && g.request) || {};
    const email = req.email;
    if (!email || !String(email).trim()) continue;
    const key = normalizeEmail(email);
    if (seen.has(key)) continue;
    seen.add(key);

    const gov = overrides[`giving:${g.id}`] || {};
    contacts.push(decorate({
      id: `giving:${g.id}`,
      source: "giving",
      giving_id: g.id,
      company_name: gov.company_name || req.orgName || "",
      contact_name: gov.contact_name || req.contactName || "",
      title: gov.title || "",
      email: String(email).trim(),
      phone: gov.phone || req.phone || "",
      city: gov.city || req.city || "",
      state: gov.state || req.state || "",
      tags: Array.isArray(gov.tags) ? gov.tags : [],
      accountManager: (g.account && g.account.owner) || "",
      givingStatus: g.status || "",
      updatedAt: gov.updatedAt || g.received || null,
    }, gov.status, gov.reason));
  }

  // --- prospect contacts, imported ---
  for (const id of Object.keys(prospects)) {
    const p = prospects[id];
    if (!p || !p.email) continue;
    seen.add(normalizeEmail(p.email));

    contacts.push(decorate({
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
      tags: Array.isArray(p.tags) ? p.tags : [],
      accountManager: "",
      importedAt: p.importedAt || null,
      importBatch: p.importBatch || null,
      updatedAt: p.importedAt || null,
    }, p.status, p.reason));
  }

  const bySource = (src) => contacts.filter((c) => c.source === src).length;

  return {
    contacts,
    customersWithoutEmail: withoutEmail,
    totalRosterSize: synced.length,
    settings,
    clientCount: bySource("client"),
    prospectCount: bySource("prospect"),
    leadCount: bySource("lead"),
    givingCount: bySource("giving"),
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

  // Detail fields (company/contact name/title/phone/city/state) that CAN be
  // hand-corrected here, same list the API route validates against.
  const DETAIL_FIELDS = ["company_name", "contact_name", "title", "phone", "city", "state"];

  // Tags and detail-field corrections both live on the contact record for a
  // prospect (MailMe's own record), or in MailMe's own overrides map for
  // everyone else (client/lead/giving) — NEVER written back to backbone_data,
  // backbone_leads, or the giving store. This is a MailMe-local correction
  // layered on top of what the owning app resolved, exactly like tags/status
  // already work; it disappears if the override is cleared, and the owning
  // app's own record is never touched.
  const detailPatch = {};
  DETAIL_FIELDS.forEach((f) => { if (patch[f] !== undefined) detailPatch[f] = patch[f]; });
  const hasDetailPatch = Object.keys(detailPatch).length > 0;

  if (patch.tags !== undefined || hasDetailPatch) {
    if (source === "prospect") {
      const prospectPatch = { ...detailPatch };
      if (patch.tags !== undefined) prospectPatch.tags = patch.tags;
      await updateProspect(localId, prospectPatch);
    } else if (source === "lead" || source === "giving") {
      // Leads and giving requests belong to other apps, so MailMe stores
      // corrections in its own overrides map under the FULL prefixed id
      // rather than writing back into backbone_leads or the giving store.
      const all = await getContactOverrides();
      const existing = all[id] || {};
      const next = {
        ...existing,
        ...detailPatch,
        updatedAt: new Date().toISOString(),
        updatedBy: (session && session.username) || existing.updatedBy,
      };
      if (patch.tags !== undefined) next.tags = patch.tags;
      const isEmpty = !(next.tags && next.tags.length) && !next.status && !next.reason &&
        !DETAIL_FIELDS.some((f) => next[f]);
      if (isEmpty) delete all[id]; else all[id] = next;
      await writeKey(keys.contactOverrides(), all);
    } else {
      const all = await getContactOverrides();
      const existing = all[localId] || {};
      const next = {
        ...existing,
        ...detailPatch,
        updatedAt: new Date().toISOString(),
        updatedBy: (session && session.username) || existing.updatedBy,
      };
      if (patch.tags !== undefined) next.tags = patch.tags;
      const isEmpty = !(next.tags && next.tags.length) && !next.status && !next.reason &&
        !DETAIL_FIELDS.some((f) => next[f]);
      if (isEmpty) delete all[localId]; else all[localId] = next;
      await writeKey(keys.contactOverrides(), all);
    }
  }

  return { ok: true };
}

// ---- Public self-service signup (event/list opt-in) ------------------------
//
// Used by public signup pages OUTSIDE the shell (e.g. flyover-con-signup.html)
// that have no session and no admin sitting there to run an import. Unlike
// the CSV import path this handles exactly one person at a time:
//   - if the email already belongs to a known contact (client, lead, giving,
//     or a previously-imported prospect), that contact is TAGGED, never
//     duplicated.
//   - otherwise a new prospect record is created, same as a one-row import.
// The target list is created lazily on the very first signup: dynamic and
// tag-matched, so every later signup lands in it automatically with no
// separate "add to list" write. Suppression is unaffected either way — a
// previously-unsubscribed email stays unsubscribed regardless of this call,
// because resolveContacts() always overlays suppression status on top of
// whatever the underlying record says.
export async function publicListSignup({ email, name, tag, listName, company, attendedBefore }) {
  const cleanEmail = normalizeEmail(email);
  const cleanName = String(name || "").trim();
  const cleanCompany = String(company || "").trim();
  // Lowercased to match the convention every other tag-writing path already
  // follows (api/mailme/import.js and api/mailme/contacts.js PATCH both
  // lowercase on the way in). Matching is case-insensitive everywhere tags
  // are compared, but storage should still be consistent so the Contacts
  // and list-rule tag chips don't show one mixed-case outlier.
  const cleanTag = String(tag || "").trim().toLowerCase();

  // attendedBefore is optional and, when present, becomes its own tag —
  // "returning attendee" or "first-time attendee" — alongside the event
  // tag. It rides the same tags array rather than a new field so it needs
  // no schema change and shows up wherever tags already show up (Contacts,
  // list rules).
  const attendanceTag = attendedBefore === true ? "returning attendee"
    : attendedBefore === false ? "first-time attendee"
    : null;

  const { contacts } = await resolveContacts();
  const existing = contacts.find((c) => normalizeEmail(c.email) === cleanEmail);

  let contactId;
  if (existing) {
    const tags = Array.isArray(existing.tags) ? existing.tags.slice() : [];
    [cleanTag, attendanceTag].filter(Boolean).forEach((t) => {
      if (!tags.some((x) => String(x).trim().toLowerCase() === t.toLowerCase())) tags.push(t);
    });
    const patch = { tags };
    // Never overwrite an existing contact's real company name with what a
    // stranger typed into a public form — only fill it in if MailMe doesn't
    // already have one on file for them.
    if (cleanCompany && !existing.company_name) patch.company_name = cleanCompany;
    await setContactStatus(existing.id, patch, null);
    contactId = existing.id;
  } else {
    const tags = [cleanTag, attendanceTag].filter(Boolean);
    const { added } = await addProspects(
      [{ email: cleanEmail, contact_name: cleanName, company_name: cleanCompany, tags }],
      null,
      null,
    );
    contactId = `prospect:${added[0].prospect_id}`;
  }

  const lists = await listLists();
  let list = lists.find((l) => String(l.name).trim().toLowerCase() === listName.trim().toLowerCase());
  if (!list) {
    list = await createList({ name: listName, kind: "dynamic", rule: { tags: [cleanTag] } }, null);
  }

  return { contactId, listId: list.id, alreadyKnown: !!existing };
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
    // Manual overrides for dynamic lists; see resolveList() in schema.js.
    extraMembers: patch.extraMembers || [],
    excludedMembers: patch.excludedMembers || [],
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

/**
 * Patch a campaign regardless of status. updateCampaign() above is the
 * user-facing edit path and deliberately refuses anything but a draft; this
 * is the SEND path's equivalent, used only by lib/mailme/send.js to move a
 * campaign through draft -> sending -> sent and persist its resumable queue.
 * Never exposed directly to an API route body.
 */
export async function applyCampaignPatch(id, patch) {
  const all = await readArray(keys.campaigns());
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
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
