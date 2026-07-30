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
import { autoMatchFor } from "./customer-match.js";
import { applyClassification } from "./giving-classify.js";
import { KEYS, readKey } from "./backbone-store.js";

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
  address:        ["address", "organization address", "event address",
                   "mailing address", "event location", "location", "street address"],
  city:           ["city", "event city", "town"],
  state:          ["state", "event state"],
  county:         ["county", "event county"],
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

// Fields whose candidate labels are short common words that appear inside
// other questions. These must match a label exactly or not at all.
const EXACT_ONLY = new Set(["city", "state", "county"]);

/** Find an answer by any of its candidate labels. */
function pick(answers, key) {
  const wanted = FIELD_ALIASES[key] || [];

  // Exact label match first. This is the reliable path.
  for (const [label, value] of Object.entries(answers)) {
    if (wanted.includes(norm(label))) return value;
  }

  // EXACT ONLY for short, generic words. A composite label like "Organization
  // Address (street, city, state)" literally contains "city" and "state", so a
  // substring match on those would return the whole address blob as the city.
  if (EXACT_ONLY.has(key)) return null;

  // Fallback: a label that CONTAINS a candidate. Form labels drift ("Address"
  // becomes "Organization Address (street, city, state)") and an exact-only
  // match silently returned nothing, which read downstream as "the form did
  // not ask". Longest candidate first so "event date" beats "date".
  const byLength = [...wanted].sort((a, b) => b.length - a.length);
  for (const cand of byLength) {
    if (cand.length < 4) continue;          // too short to match safely
    for (const [label, value] of Object.entries(answers)) {
      if (norm(label).includes(cand) && String(value || "").trim()) return value;
    }
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
/**
 * County for a central Iowa town.
 *
 * The engine's Regional tier (7 of 10 region points) is gated on county, but
 * the form never asks for one, so every out-of-metro Iowa town fell through to
 * Statewide (3). Only towns in the engine's REGIONAL_COUNTIES are listed; a
 * miss returns "" and scores exactly as it did before.
 */
const CITY_COUNTY = {
  // Polk
  "des moines": "Polk", "west des moines": "Polk", "ankeny": "Polk",
  "urbandale": "Polk", "johnston": "Polk", "altoona": "Polk",
  "bondurant": "Polk", "polk city": "Polk", "grimes": "Polk",
  "pleasant hill": "Polk", "mitchellville": "Polk", "runnells": "Polk",
  "clive": "Polk", "windsor heights": "Polk", "elkhart": "Polk",
  "alleman": "Polk", "sheldahl": "Polk",
  // Dallas
  "waukee": "Dallas", "adel": "Dallas", "perry": "Dallas", "dallas center": "Dallas",
  "van meter": "Dallas", "woodward": "Dallas", "de soto": "Dallas",
  "granger": "Dallas",
  "minburn": "Dallas", "redfield": "Dallas", "linden": "Dallas",
  // Story
  "ames": "Story", "nevada": "Story", "story city": "Story", "huxley": "Story",
  "slater": "Story", "cambridge": "Story", "colo": "Story", "gilbert": "Story",
  "maxwell": "Story", "roland": "Story", "zearing": "Story", "collins": "Story",
  // Boone
  "boone": "Boone", "madrid": "Boone", "ogden": "Boone", "luther": "Boone",
  "pilot mound": "Boone", "beaver": "Boone",
  // Jasper
  "newton": "Jasper", "colfax": "Jasper", "prairie city": "Jasper",
  "monroe": "Jasper", "baxter": "Jasper", "sully": "Jasper", "mingo": "Jasper",
  // Marion
  "pella": "Marion", "knoxville": "Marion", "melcher dallas": "Marion",
  "bussey": "Marion", "pleasantville": "Marion",
  // Warren
  "indianola": "Warren", "norwalk": "Warren", "carlisle": "Warren",
  "martensdale": "Warren", "milo": "Warren", "new virginia": "Warren",
  "cumming": "Warren",
  // Madison
  "winterset": "Madison", "earlham": "Madison", "st marys": "Madison",
  "truro": "Madison", "macksburg": "Madison", "patterson": "Madison",
  "st charles": "Madison"
};

function countyFor(city) {
  if (!city) return "";
  const key = norm(city).replace(/[.'']/g, "").replace(/\s+/g, " ").trim();
  return CITY_COUNTY[key] || "";
}

/**
 * Parse Jotform's LABELLED address format.
 *
 * A Jotform address question does not arrive as one comma-separated line. It
 * arrives as its own sub-labelled block, HTML included:
 *
 *   Street Address: 9976 NW 119th Court<br>City: Granger<br>
 *   State / Province: IA<br>Postal / Zip Code: 50109-2501<br>
 *
 * The old parser looked for "City, ST" and found nothing, so a complete
 * address read as "No address supplied" and the region scored zero. Reading
 * the sub-labels is both simpler and more reliable than pattern matching,
 * because Jotform generates them rather than a person typing them.
 *
 * Returns null when the text carries no sub-labels, so the caller can fall
 * back to the comma-separated parser.
 */
function parseLabelledAddress(text) {
  const s = String(text == null ? "" : text);
  if (!s.trim()) return null;

  // <br>, <br/>, and the literal escaped forms Jotform sometimes sends.
  const flat = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;br\s*\/?&gt;/gi, "\n")
    .replace(/&amp;/g, "&");

  const grab = (labels) => {
    for (const label of labels) {
      const re = new RegExp(
        label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*([^\n]*)",
        "i"
      );
      const m = flat.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
    return "";
  };

  const city = grab(["City"]);
  const state = grab(["State / Province", "State/Province", "State", "Province"]);
  const zipRaw = grab(["Postal / Zip Code", "Postal/Zip Code", "Zip Code", "Postal Code", "Zip"]);

  // No sub-labels at all: this is not a Jotform address block.
  if (!city && !state && !zipRaw) return null;

  const zip = (zipRaw.match(/\d{5}/) || [""])[0];

  // "Iowa" and "IA" both appear depending on how the question is configured.
  let st = state.trim();
  if (/^iowa$/i.test(st)) st = "IA";
  if (st.length > 2) {
    const abbr = US_STATE_NAMES[st.toLowerCase()];
    if (abbr) st = abbr;
  }

  return { city: city.trim(), state: st.toUpperCase(), zip, raw: flat.trim() };
}

const US_STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL",
  georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME",
  maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
  nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY"
};

/* ------------------------------------------------------------------ *
 * LAST-RESORT SCANS
 *
 * Label-based lookup fails whenever the form is edited, and a failed lookup is
 * indistinguishable from "the form did not ask". These scan the ANSWERS rather
 * than the labels, so they keep working through a rename. They run only after
 * the label lookup comes up empty.
 * ------------------------------------------------------------------ */

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID",
  "IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE",
  "NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC"];

/** Find "Somewhere, IA 50023" or "Somewhere, Iowa" in any answer. */
function scanForLocation(answers) {
  const values = Object.values(answers || {})
    .map((v) => String(v == null ? "" : v).trim())
    .filter(Boolean);

  for (const v of values) {
    let m = v.match(/([A-Za-z][A-Za-z.'\- ]{1,40}),\s*([A-Z]{2})\b(?:\s*(\d{5}))?/);
    if (m && US_STATES.includes(m[2])) {
      return { city: m[1].trim(), state: m[2], zip: m[3] || "", raw: v };
    }
    m = v.match(/([A-Za-z][A-Za-z.'\- ]{1,40}),\s*Iowa\b/i);
    if (m) return { city: m[1].trim(), state: "IA", zip: "", raw: v };
  }

  // No "City, ST" anywhere. A bare town name we recognise is still worth
  // having, because the county lookup can place it.
  for (const v of values) {
    if (v.length > 40 || /\d/.test(v)) continue;
    if (countyFor(v)) return { city: v.trim(), state: "IA", zip: "", raw: v };
  }
  return { city: "", state: "", zip: "", raw: "" };
}

/** Find a plausible event date in any answer. Prefers the soonest future date. */
function scanForDate(answers) {
  const values = Object.values(answers || {})
    .map((v) => String(v == null ? "" : v).trim())
    .filter(Boolean);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const found = [];

  for (const v of values) {
    if (v.length > 40) continue;
    const iso = parseDate(v);
    if (!iso) continue;
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    // Events are dated within a couple of years either side; anything else is
    // a founding year or a number that happened to parse.
    const years = Math.abs(d.getFullYear() - today.getFullYear());
    if (years > 2) continue;
    found.push(iso);
  }

  if (!found.length) return null;
  const future = found.filter((iso) => new Date(iso) >= today).sort();
  return future.length ? future[0] : found.sort().pop();
}

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

  // Prefer fields the form asks for directly; fall back to parsing one address
  // blob. Either way county is derived, because the form never asks for it.
  // Jotform's own labelled address block is the most reliable source, so try
  // it first, across every answer (the question may be called anything).
  let addr = { city: "", state: "", zip: "", raw: "" };
  for (const v of Object.values(a)) {
    const parsed = parseLabelledAddress(v);
    if (parsed && parsed.city && parsed.state) { addr = parsed; break; }
  }
  if (!addr.city || !addr.state) {
    const direct = parseAddress(pick(a, "address"));
    if (direct.city && direct.state) addr = direct;
  }
  if (!addr.city || !addr.state) {
    const scanned = scanForLocation(a);
    if (scanned.city && scanned.state) addr = scanned;
  }
  const city = (pick(a, "city") || addr.city || "").trim();
  const stateRaw = (pick(a, "state") || addr.state || "").trim();
  const state = stateRaw.length > 2 && /^iowa$/i.test(stateRaw) ? "IA" : stateRaw;
  const county = (pick(a, "county") || countyFor(city) || "").replace(/\s+county$/i, "").trim();
  if (!city || !state) {
    needsReview.push({
      field: "location",
      why: addr.raw
        ? 'Could not read city/state from "' + addr.raw + '"'
        : "The form supplied no address, city or state."
    });
  }

  const eventDate = parseDate(pick(a, "eventDate")) || scanForDate(a);
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
      city:        city,
      state:       state,
      county:      county,
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


/**
 * Re-derive machine-readable fields for a request already in storage.
 *
 * Every request keeps its original Jotform payload in `raw`, so a mapping
 * improvement can be applied retroactively instead of stranding old rows on
 * the parsing rules that existed the day they arrived. Re-importing cannot do
 * this: the import skips submissions it already has, by design.
 *
 * NON-DESTRUCTIVE. Only fills fields that are currently empty. A human's
 * classification, decision, notes and any confirmed account are never touched.
 */
export function repairRequest(row) {
  if (!row || !row.raw || !row.request) return { row, changed: [] };

  const fresh = buildRequest(row.raw, {
    id: row.id,
    submittedAt: row.submittedAt,
    source: row.source,
    jotformId: row.jotformId
  });

  const changed = [];
  const isEmpty = (v) => v === null || v === undefined || v === "";

  // Derived, machine-read fields only. Nothing a human sets is listed here.
  const DERIVED = [
    "city", "state", "county", "zip", "eventDate", "pieceCount",
    "purchaseIntent", "attendance", "yearsActive", "logoRequired",
    "taxStatus", "ein", "eventName", "eventType", "merchandise",
    "description", "contactName", "phone", "email", "merchUse",
    "rationale", "additional", "logoFormat", "selfReportedCustomer"
  ];

  DERIVED.forEach((k) => {
    if (isEmpty(row.request[k]) && !isEmpty(fresh.request[k])) {
      row.request[k] = fresh.request[k];
      changed.push(k);
    }
  });

  // Suggest the fields the form cannot ask. Only fills what is still empty,
  // and never answers the two disqualifier questions in the affirmative.
  applyClassification(row);

  const classified = !isEmpty(row.request.missionFit) || !isEmpty(row.request.orgType);
  row.needsReview = fresh.needsReview.filter((n) => {
    if (n.field === "classification" && classified) return false;
    if (n.field === "location" && row.request.city && row.request.state) return false;
    if (n.field === "eventDate" && row.request.eventDate) return false;
    return true;
  });

  return { row, changed };
}

/* ------------------------------------------------------------------ *
 * ROSTER MATCHING
 * ------------------------------------------------------------------ */

/**
 * Attach the BackBone account for a request, when the name is unambiguous.
 *
 * WHY THIS RUNS AUTOMATICALLY. 55 of the 100 points (relationship, spend and
 * cadence) are unreachable while a request sits unmatched, so an existing
 * customer's request scored the same F as a stranger's until somebody clicked
 * Find on every single card. That was the bulk of the manual work.
 *
 * Only a clear winner is applied; autoMatchFor returns null when two roster
 * names are close, and the request stays unmatched for a human to resolve.
 * Failure is non-fatal: an unmatched request is the old behaviour, not a lost
 * submission, so intake must never fail because the roster was unreachable.
 */
export async function attachAccount(row) {
  try {
    if (!row || !row.request || (row.account && row.account.found)) return row;
    const data = await readKey(KEYS.data);
    if (!data || !Array.isArray(data.synced)) return row;

    const hit = autoMatchFor(row.request.orgName, data.synced, data.enrichment || {});
    if (hit) {
      row.account = hit;
      row.autoMatched = true;
    }
  } catch (e) {
    console.error("giving: auto-match skipped:", e && e.message);
  }
  return row;
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
