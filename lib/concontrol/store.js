// PUT IN: lib/concontrol/store.js
// lib/concontrol/store.js — ConControl Upstash access layer.
//
// Same conventions as lib/sitework/store.js and lib/errorengine/store.js:
// pipeline writes, defensive triple-unwrap, a JSON-array index kept under one
// key rather than a Redis SET. Writes ONLY under the concontrol_data: prefix.
//
// FOUR COLLECTIONS, ONE SHAPE. Sponsors, ledger entries, sessions and speakers
// are all "a record with an id, in an index, scoped to an event". Written out
// four times they would be four copies of the same twelve lines, and the merge
// rule would drift in one of them. collection() is the single copy.
//
// lib/ never imports from api/.
//
// ESM. Do NOT convert to module.exports.

import { keys, SEED_TIERS, SEED_CATEGORIES, DEFAULT_EVENT } from "./schema.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfig() {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error("Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  }
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
 * THE COLLECTION FACTORY
 * ------------------------------------------------------------------ */

function collection(kind, prefix, sort) {
  const k = keys.of(kind);

  async function listIds() {
    const raw = await kvGet(k.index());
    const ids = raw ? unwrap(raw) : [];
    return Array.isArray(ids) ? ids : [];
  }

  async function get(id) {
    const raw = await kvGet(k.record(id));
    return raw ? unwrap(raw) : null;
  }

  // One pipeline round trip regardless of how many records exist.
  async function list(event) {
    const ids = await listIds();
    if (!ids.length) return [];
    const results = await kvPipeline(ids.map((id) => ["GET", k.record(id)]));
    const all = results
      .map((r) => (r && r.result ? unwrap(r.result) : null))
      .filter(Boolean);
    const scoped = event ? all.filter((r) => (r.event || DEFAULT_EVENT) === event) : all;
    return sort ? scoped.slice().sort(sort) : scoped;
  }

  async function save(record) {
    const ids = await listIds();
    if (!ids.includes(record.id)) ids.push(record.id);
    await kvPipeline([
      ["SET", k.record(record.id), JSON.stringify(record)],
      ["SET", k.index(), JSON.stringify(ids)],
    ]);
    return record;
  }

  /**
   * Merge, never replace. `id`, `createdAt` and `createdBy` are pinned so a
   * patch cannot rewrite who made the record or when. `history` is APPENDED to
   * rather than overwritten: the trail is the one field a caller must not be
   * able to shorten, and a patch carrying its own shorter history array is
   * exactly how that would happen.
   */
  /**
   * Many records in one round trip, one index write. A plan load is 87 posts
   * and nine decisions; saving them one at a time is two round trips each and
   * a cold serverless start away from a timeout.
   */
  async function saveMany(records) {
    if (!records || !records.length) return [];
    const ids = await listIds();
    const cmds = [];
    for (const r of records) {
      if (!ids.includes(r.id)) ids.push(r.id);
      cmds.push(["SET", k.record(r.id), JSON.stringify(r)]);
    }
    cmds.push(["SET", k.index(), JSON.stringify(ids)]);
    await kvPipeline(cmds);
    return records;
  }

  async function update(id, patch, historyEntry) {
    const existing = await get(id);
    if (!existing) return null;
    const history = Array.isArray(existing.history) ? existing.history.slice() : [];
    if (historyEntry) history.push(historyEntry);
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      history,
      updatedAt: new Date().toISOString(),
    };
    await kvPipeline([["SET", k.record(id), JSON.stringify(merged)]]);
    return merged;
  }

  async function remove(id) {
    const ids = await listIds();
    const next = ids.filter((x) => x !== id);
    if (next.length === ids.length) return false;
    await kvPipeline([
      ["DEL", k.record(id)],
      ["SET", k.index(), JSON.stringify(next)],
    ]);
    return true;
  }

  async function nextId() {
    const [res] = await kvPipeline([["INCR", k.counter()]]);
    const n = res && res.result;
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  return { listIds, get, list, save, saveMany, update, remove, nextId };
}

const newestFirst = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
const byDateThenNewest = (a, b) => {
  const d = String(b.date || "").localeCompare(String(a.date || ""));
  return d !== 0 ? d : newestFirst(a, b);
};
// Sessions read as a grid, so they sort the way the day runs rather than the
// order somebody typed them in.
const bySlot = (a, b) => {
  const d = (a.day || 0) - (b.day || 0);
  if (d !== 0) return d;
  const s = String(a.start || "").localeCompare(String(b.start || ""));
  if (s !== 0) return s;
  return String(a.track || "").localeCompare(String(b.track || ""));
};
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

const sponsors = collection("sponsor", "SP", newestFirst);
const entries = collection("entry", "LE", byDateThenNewest);
const sessions = collection("session", "SE", bySlot);
const speakers = collection("speaker", "SK", byName);
// Responses and signups sort by when they were SENT, not when they were
// imported. A bulk import gives nineteen records the same createdAt, which
// would put them in whatever order the index happened to hold.
const bySubmitted = (a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || ""));
const responses = collection("response", "RS", bySubmitted);
const signups = collection("signup", "NS", bySubmitted);

/* ------------------------------------------------------------------ *
 * SPONSORS
 * ------------------------------------------------------------------ */

export const listSponsorIds = sponsors.listIds;
export const getSponsor = sponsors.get;
export const listSponsors = sponsors.list;
export const saveSponsor = sponsors.save;
export const updateSponsor = sponsors.update;
export const deleteSponsor = sponsors.remove;
export const nextSponsorId = sponsors.nextId;

/**
 * Has this company already been entered for this event?
 *
 * Used by the PUBLIC inquiry route so a sponsor filling the form twice does
 * not become two records somebody has to notice and merge. Compared on a loose
 * key (lowercased, punctuation and Inc/LLC dropped) because "Smith Bros." and
 * "Smith Bros LLC" are one company arriving twice.
 */
export function companyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|co|corp|company|ltd)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function findByCompany(name, event) {
  const key = companyKey(name);
  if (!key) return null;
  const list = await listSponsors(event);
  return list.find((s) => companyKey(s.company) === key) || null;
}

/* ------------------------------------------------------------------ *
 * LEDGER, SESSIONS, SPEAKERS
 * ------------------------------------------------------------------ */

export const getEntry = entries.get;
export const listEntries = entries.list;
export const saveEntry = entries.save;
export const updateEntry = entries.update;
export const deleteEntry = entries.remove;
export const nextEntryId = entries.nextId;

export const getSession = sessions.get;
export const listSessions = sessions.list;
export const saveSession = sessions.save;
export const updateSession = sessions.update;
export const deleteSession = sessions.remove;
export const nextSessionId = sessions.nextId;

export const getSpeaker = speakers.get;
export const listSpeakers = speakers.list;
export const saveSpeaker = speakers.save;
export const updateSpeaker = speakers.update;
export const deleteSpeaker = speakers.remove;
export const nextSpeakerId = speakers.nextId;

export const getResponse = responses.get;
export const listResponses = responses.list;
export const saveResponse = responses.save;
export const updateResponse = responses.update;
export const deleteResponse = responses.remove;
export const nextResponseId = responses.nextId;

export const getSignup = signups.get;
export const listSignups = signups.list;
export const saveSignup = signups.save;
export const updateSignup = signups.update;
export const deleteSignup = signups.remove;
export const nextSignupId = signups.nextId;

/* ------------------------------------------------------------------ *
 * SOCIAL PLAN
 *
 * Posts keep the id the plan gave them (FOC27-SOC-001), so a reload finds
 * the post it made last time. Decisions are keyed event plus the plan's key,
 * because "price" will be a decision again next year. The rest of the plan
 * (goals, rules, which conditions have been met) is one record per event.
 * ------------------------------------------------------------------ */

const byPostDate = (a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.id).localeCompare(String(b.id));
const byNeeded = (a, b) => String(a.needed_by || "9999").localeCompare(String(b.needed_by || "9999"));
const posts = collection("post", "PO", byPostDate);
const decisions = collection("decision", "DE", byNeeded);

export const getPost = posts.get;
export const listPosts = posts.list;
export const savePosts = posts.saveMany;
export const updatePost = posts.update;
export const deletePost = posts.remove;

export const getDecision = decisions.get;
export const listDecisions = decisions.list;
export const saveDecisions = decisions.saveMany;
export const updateDecision = decisions.update;

const socialKey = (event) => `${keys.of("social").record(event || DEFAULT_EVENT)}`;

export async function getSocialMeta(event) {
  const raw = await kvGet(socialKey(event));
  const m = raw ? unwrap(raw) : null;
  return m && typeof m === "object" ? m : null;
}

export async function saveSocialMeta(event, meta) {
  await kvPipeline([["SET", socialKey(event), JSON.stringify(meta)]]);
  return meta;
}

/**
 * A speaker matched by email, so the public /speak form updates the proposal
 * it already has rather than filing a second one under the same person.
 */
export async function findSpeakerByEmail(email, event) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const list = await listSpeakers(event);
  return list.find((s) => String(s.email || "").toLowerCase() === e) || null;
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 *
 * Tiers, spend categories, the event and its dates, the commitment deadline,
 * the budget, and who gets told when something arrives from the website. All
 * stored rather than compiled in, because every one of them changes between
 * events. Seeded on first read so the app works the day it deploys with no
 * setup step.
 * ------------------------------------------------------------------ */

/**
 * Undo the literal-backslash-n damage, on read.
 *
 * The Settings textareas were briefly filled with a literal "\\n" between
 * entries instead of a newline, so pressing Save handed the whole lineup back
 * as ONE line. Five sponsor levels collapsed into a tier called
 * "Presenting, 7000, 1\\nGold, 2500, 3..." and eight spend categories became
 * one category with the escape sequences in its name.
 *
 * Splitting on read puts back what can be put back without anybody retyping.
 * It cannot recover what the 60-character field limit already cut off, so the
 * Settings screen also offers the defaults as a one-click refill.
 */
function unescapeLines(value) {
  return String(value == null ? "" : value)
    .split(/\\n|\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function repairTiers(tiers) {
  if (!Array.isArray(tiers)) return tiers;
  const out = [];
  for (const tier of tiers) {
    const parts = unescapeLines(tier && tier.name);
    if (parts.length <= 1) { out.push(tier); continue; }
    for (const part of parts) {
      const [name, amount, slots] = part.split(",").map((x) => (x || "").trim());
      if (!name) continue;
      // Blank is UNLIMITED, not zero. Number("") is 0, and a level with zero
      // places reads as sold out on a board somebody is about to sell from.
      // Same trap on the amount: 0 would read as a free level.
      const n = slots === "" || slots === undefined ? NaN : Number(slots);
      const a = amount === "" || amount === undefined ? NaN : Number(amount);
      out.push({
        name,
        amount: Number.isFinite(a) ? a : null,
        slots: Number.isFinite(n) ? n : null,
      });
    }
  }
  return out;
}

function repairCategories(cats) {
  if (!Array.isArray(cats)) return cats;
  const out = [];
  for (const cat of cats) out.push(...unescapeLines(cat));
  return Array.from(new Set(out));
}

export async function getSettings() {
  const raw = await kvGet(keys.settings());
  const saved = raw ? unwrap(raw) : null;
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    event: typeof s.event === "string" && s.event ? s.event : DEFAULT_EVENT,
    eventName: typeof s.eventName === "string" ? s.eventName : "Flyover Con 2027",
    eventDate: typeof s.eventDate === "string" ? s.eventDate : "2027-04-16",
    // The sponsor page asks for commitments by this date. A setting rather
    // than a constant because it moves every year, and it is the only reason
    // the home screen can count down to anything.
    commitBy: typeof s.commitBy === "string" ? s.commitBy : "2027-01-15",
    budget: Number.isFinite(s.budget) ? s.budget : null,
    tiers: Array.isArray(s.tiers) && s.tiers.length ? repairTiers(s.tiers) : SEED_TIERS,
    categories: Array.isArray(s.categories) && s.categories.length ? repairCategories(s.categories) : SEED_CATEGORIES,
    // Username to hand a new inquiry to. Empty means no notification is
    // raised, which the Settings screen says in words rather than leaving as
    // a silent nothing.
    inquiryNotifyTo: typeof s.inquiryNotifyTo === "string" ? s.inquiryNotifyTo : "",
    speakNotifyTo: typeof s.speakNotifyTo === "string" ? s.speakNotifyTo : "",
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  await kvPipeline([["SET", keys.settings(), JSON.stringify(next)]]);
  return next;
}
