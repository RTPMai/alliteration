// lib/giving.js — donation requests: storage, and the Jotform mapping.
//
// GivingGauge had no backend. Its six requests were hardcoded in the source, so
// this is built from scratch rather than copied across like ShopStock's was.
//
// THE MAPPING IS THE HARD PART. The scoring engine wants specific fields, and
// the Jotform asks for most but not all of them. Three groups:
//
//   1. DIRECT     — the form asks it, we store it.
//   2. DERIVED    — the form asks something close and we parse it (piece count
//                   from free text, city/state from an address).
//   3. UNKNOWN    — the form cannot collect it. Left unclassified so a HUMAN
//                   decides. The engine treats an unclassified mission as
//                   general civic benefit and says so in its reason text, so
//                   nothing silently invents a score.
//
// The rule throughout: when a value is uncertain, record that it is uncertain.
// A wrong guess on isPolitical or isReligious auto-declines a real request, and
// nobody would know why.

import { getRaw, setRaw } from "./kv.js";

const PREFIX = "alliteration:giving:";
const INDEX = PREFIX + "index";
const REQ = (id) => PREFIX + "req:" + id;

/* ------------------------------------------------------------------ *
 * FIELD MAPPING
 *
 * Jotform posts answers keyed by the question label (with rawRequest as a
 * fallback). Labels drift when someone edits the form, so each engine field
 * lists SEVERAL candidate labels and we take the first that matches.
 * ------------------------------------------------------------------ */

const FIELD_ALIASES = {
  orgName:        ["organization name", "organisation name", "organization"],
  isCustomer:     ["are you a current p&m apparel customer?", "current customer", "are you a current p&m apparel customer"],
  eventName:      ["event name"],
  eventType:      ["type of event"],
  eventDate:      ["date of event", "event date"],
  taxStatus:      ["tax status"],
  ein:            ["ein / tax id number", "ein", "tax id number"],
  contactName:    ["contact name"],
  phone:          ["phone number", "phone"],
  email:          ["email"],
  address:        ["address"],
  yearsActive:    ["years event has been active", "years active"],
  attendance:     ["estimated event attendance", "event attendance", "attendance"],
  description:    ["description of event", "event description"],
  merchandise:    ["merchandise type requested", "merchandise type"],
  pieceCountRaw:  ["how many pieces are you requesting?", "how many pieces are you requesting"],
  merchUse:       ["how will merchandise be used?", "how will merchandise be used"],
  purchaseRaw:    ["will you be purchasing any apparel for this event?", "will you be purchasing any apparel for this event"],
  whyRaw:         ["describe why you feel p&m apparel should honor your request"],
  logoRequired:   ["if p&m apparel will be recognized for this donation, will a logo be required?", "will a logo be required"],
  logoFormat:     ["format for logo"],
  additional:     ["additional information about your request"]
};

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

/** Find an answer by any of its candidate labels. */
function pick(answers, key) {
  const wanted = FIELD_ALIASES[key] || [];
  for (const [label, value] of Object.entries(answers)) {
    if (wanted.includes(norm(label))) return value;
  }
  return null;
}

/**
 * Jotform's payload shape varies by how the webhook is configured. Flatten the
 * common ones into { label: answer }.
 */
export function flattenJotform(body) {
  const out = {};

  // Shape 1: { rawRequest: "{...}" } or an already-parsed object.
  let raw = body.rawRequest;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (e) { raw = null; }
  }

  // Shape 2: { pretty: "Question:Answer, Question:Answer" }. Lossy — commas
  // inside answers break it — so it is only a fallback.
  if (typeof body.pretty === "string" && !raw) {
    body.pretty.split(/,\s*(?=[^,:]+:)/).forEach((pair) => {
      const i = pair.indexOf(":");
      if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });
  }

  // Shape 3: the API's { answers: { "3": { text, answer } } }.
  const answers = body.answers || (raw && raw.answers) || null;
  if (answers && typeof answers === "object") {
    Object.values(answers).forEach((a) => {
      if (!a || !a.text) return;
      let v = a.prettyFormat || a.answer;
      if (v && typeof v === "object") {
        // Address and name fields arrive as objects.
        v = Object.values(v).filter(Boolean).join(", ");
      }
      out[a.text] = v == null ? "" : String(v);
    });
  }

  // Shape 4: flat q3_organizationName style keys.
  if (raw && typeof raw === "object" && !answers) {
    Object.entries(raw).forEach(([k, v]) => {
      const label = k.replace(/^q\d+_/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
      if (v && typeof v === "object") v = Object.values(v).filter(Boolean).join(", ");
      out[label] = v == null ? "" : String(v);
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * DERIVED VALUES
 * ------------------------------------------------------------------ */

/**
 * Piece count from free text. The form asks an open question, so real answers
 * look like "8-10 but grateful for anything" or "a dozen or so".
 *
 * Takes the FIRST number, which in a range is the low end — the conservative
 * read of what they are asking for. Returns null when there is no number at
 * all, which the engine treats as "no piece count given" rather than zero.
 */
export function parsePieceCount(text) {
  if (text == null) return { value: null, uncertain: true, raw: "" };
  const s = String(text);
  const m = s.match(/\d+/);
  if (!m) return { value: null, uncertain: true, raw: s };

  const value = parseInt(m[0], 10);

  // A range ("8-10") or a hedge means the number is soft. A plain unit word
  // ("50 pieces", "24 shirts") does NOT: the count is exact, so flagging it
  // would train people to ignore the review list.
  const hedged = /[-–—]|\bto\b|about|around|approx|or so|at least|up to|grateful|anything|flexible|ish|maybe/i.test(s);
  const leftover = s.replace(/\d+/g, "")
                    .replace(/\b(pieces?|pcs?|shirts?|tees?|t-shirts?|hats?|caps?|hoodies?|sweatshirts?|bags?|items?|units?|total|each)\b/gi, "")
                    .replace(/[^a-z]/gi, "")
                    .trim();
  const uncertain = hedged || leftover.length > 3;
  return { value, uncertain, raw: s };
}

/**
 * Purchase intent. The engine wants "specific" | "vague" | "no" | null.
 * Deliberately conservative: anything unclear returns null so it reads as
 * "not answered" rather than a wrong guess in either direction.
 */
export function parsePurchaseIntent(text) {
  if (text == null || String(text).trim() === "") return { value: null, uncertain: true, raw: "" };
  const s = String(text);
  const t = norm(s);

  if (/^(no|none|nope|n\/a|not at this time)\b/.test(t) || /\bnot specifically\b|\bno plans\b|\bwill not\b/.test(t)) {
    return { value: "no", uncertain: false, raw: s };
  }
  // A quantity or a named garment reads as a real, specific plan.
  if (/\b\d+\s*(pieces?|shirts?|tees?|hats?|hoodies?|bags?)\b/.test(t) ||
      /\b(yes|yep|definitely|planning to)\b.*\b(order|purchase|buy)\b/.test(t)) {
    return { value: "specific", uncertain: false, raw: s };
  }
  if (/^(yes|maybe|possibly|likely|we might|potentially)\b/.test(t)) {
    return { value: "vague", uncertain: false, raw: s };
  }
  return { value: null, uncertain: true, raw: s };
}

/** City and state from a one-line address. */
export function parseAddress(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return { city: "", state: "", zip: "", raw: "" };

  const zipM = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipM ? zipM[1] : "";
  const stateM = s.match(/\b([A-Z]{2})\b(?=[\s,]*\d{5}|\s*$)/);
  const state = stateM ? stateM[1] : "";

  // City is the comma-separated part just before the state.
  let city = "";
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (state) {
    const idx = parts.findIndex((p) => p === state || p.startsWith(state + " "));
    if (idx > 0) city = parts[idx - 1];
  }
  if (!city && parts.length >= 2) city = parts[parts.length - 2];

  return { city, state, zip, raw: s };
}

function parseYesNo(text) {
  const t = norm(text);
  if (!t) return null;
  if (/^y(es)?\b/.test(t)) return true;
  if (/^n(o)?\b/.test(t)) return false;
  return null;
}

function parseNumber(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/** ISO date from Jotform's various formats. */
function parseDate(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * BUILD A REQUEST
 * ------------------------------------------------------------------ */

/**
 * Turn a Jotform submission into the shape the engine expects.
 *
 * Anything the form cannot answer is left UNSET, not guessed. Each uncertain
 * value is recorded in `needsReview` so the app can show what a human still has
 * to confirm, rather than presenting an invented score as fact.
 */
export function buildRequest(submission, meta = {}) {
  const a = flattenJotform(submission);
  const needsReview = [];

  const pieces = parsePieceCount(pick(a, "pieceCountRaw"));
  if (pieces.uncertain && pieces.raw) {
    needsReview.push({
      field: "pieceCount",
      why: pieces.value == null
        ? 'No number in "' + pieces.raw + '"'
        : 'Read ' + pieces.value + ' from "' + pieces.raw + '"'
    });
  }

  const intent = parsePurchaseIntent(pick(a, "purchaseRaw"));
  if (intent.uncertain && intent.raw) {
    needsReview.push({ field: "purchaseIntent", why: 'Unclear from "' + intent.raw + '"' });
  }

  const addr = parseAddress(pick(a, "address"));
  if (!addr.city || !addr.state) {
    needsReview.push({ field: "location", why: 'Could not read city/state from "' + addr.raw + '"' });
  }

  const eventDate = parseDate(pick(a, "eventDate"));
  if (!eventDate) {
    needsReview.push({ field: "eventDate", why: "No usable event date. Lead time cannot be scored." });
  }

  // NOT INFERRED, on purpose. orgType, missionFit, isReligious and isPolitical
  // are judgment calls, and two of them are hard disqualifiers. A keyword match
  // on "church" or "campaign" that gets it wrong would auto-decline a real
  // request with no trace of why. A human classifies these in the app.
  needsReview.push({
    field: "classification",
    why: "Mission fit and org type need a human. Until then the engine scores mission as general civic benefit."
  });

  const taxRaw = norm(pick(a, "taxStatus"));
  const taxStatus = taxRaw.includes("exempt") ? "exempt"
                  : taxRaw.includes("business") ? "business"
                  : null;

  return {
    id: meta.id || ("REQ-" + Date.now().toString(36).toUpperCase()),
    submittedAt: meta.submittedAt || new Date().toISOString(),
    source: meta.source || "jotform",
    jotformId: meta.jotformId || null,
    status: "pending",

    request: {
      orgName:     pick(a, "orgName") || "(no name given)",
      eventName:   pick(a, "eventName") || "",
      eventType:   pick(a, "eventType") || "",
      eventDate:   eventDate,
      city:        addr.city,
      state:       addr.state,
      zip:         addr.zip,
      taxStatus:   taxStatus,
      ein:         pick(a, "ein") || "",
      contactName: pick(a, "contactName") || "",
      phone:       pick(a, "phone") || "",
      email:       pick(a, "email") || "",
      description: pick(a, "description") || "",
      merchandise: pick(a, "merchandise") || "",
      pieceCount:  pieces.value,
      purchaseIntent: intent.value,
      attendance:  parseNumber(pick(a, "attendance")),
      yearsActive: parseNumber(pick(a, "yearsActive")),
      logoRequired: parseYesNo(pick(a, "logoRequired")),
      selfReportedCustomer: parseYesNo(pick(a, "isCustomer")),

      // Left unset until a human classifies. The engine handles absent values.
      orgType:     null,
      missionFit:  null,
      isReligious: null,
      isPolitical: null,

      // Extra prose the engine does not score but a reviewer wants to read.
      merchUse:    pick(a, "merchUse") || "",
      rationale:   pick(a, "whyRaw") || "",
      additional:  pick(a, "additional") || "",
      logoFormat:  pick(a, "logoFormat") || ""
    },

    // Filled in later from Apparelytics. `found:false` scores relationship and
    // spend at zero, which is correct for an unmatched org.
    account: { found: false },

    needsReview,
    raw: submission
  };
}

/* ------------------------------------------------------------------ *
 * STORAGE
 * ------------------------------------------------------------------ */

async function readIndex() {
  const idx = await getRaw(INDEX);
  return Array.isArray(idx) ? idx : [];
}

export async function listRequests() {
  const ids = await readIndex();
  const rows = await Promise.all(ids.map((id) => getRaw(REQ(id)).catch(() => null)));
  return rows
    .filter(Boolean)
    .sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
}

export async function getRequest(id) {
  return getRaw(REQ(id));
}

export async function saveRequest(row) {
  await setRaw(REQ(row.id), row);
  const ids = await readIndex();
  if (!ids.includes(row.id)) {
    ids.unshift(row.id);
    await setRaw(INDEX, ids);
  }
  return row;
}

/** True when this Jotform submission was already stored. */
export async function alreadyHave(jotformId) {
  if (!jotformId) return false;
  const ids = await readIndex();
  const rows = await Promise.all(ids.map((id) => getRaw(REQ(id)).catch(() => null)));
  return rows.some((r) => r && String(r.jotformId) === String(jotformId));
}

/** Merge a patch (a decision, or a human classification) into a request. */
export async function updateRequest(id, patch) {
  const row = await getRequest(id);
  if (!row) throw new Error("Request " + id + " not found");

  if (patch.request) Object.assign(row.request, patch.request);
  if (patch.account) Object.assign(row.account, patch.account);
  if (patch.status) row.status = patch.status;
  if (patch.decidedBy !== undefined) row.decidedBy = patch.decidedBy;
  if (patch.note !== undefined) row.note = patch.note;
  if (patch.override !== undefined) row.override = patch.override;

  // Once someone classifies the request, that review item is answered.
  if (patch.request && patch.request.missionFit) {
    row.needsReview = (row.needsReview || []).filter((n) => n.field !== "classification");
  }

  row.updatedAt = new Date().toISOString();
  await setRaw(REQ(id), row);
  return row;
}
