// lib/concontrol/responses.js — everything people send us, kept as sent.
//
// FOUR STREAMS, ONE SCREEN. Sponsor inquiries, speaker proposals, survey
// responses and notify signups are four different forms on the event site and
// four different kinds of answer, and until now two of them became records,
// one became a spreadsheet tab nobody opened, and one sat in a shifted column
// with the header eaten.
//
// A RESPONSE IS NOT A PLAN. The first version of this turned the survey
// straight into session ideas, which put twenty-six rows on the program that
// nobody had agreed to. What people asked for and what we decided to teach are
// two different lists, and collapsing them means you can never again ask "what
// did they actually say". Promoting a topic to a session idea is now one click
// on the row, done on purpose.
//
// THE QUESTION CATALOG IS THE SCREEN. Every question declares its kind here,
// and the view is generated from that, so a question added to the form next
// year renders correctly without anybody editing a template. It is the same
// reason MarketMachine generates Definitions from the metric catalog.
//
// ESM. Do NOT convert to module.exports.

import { isoDate } from "./schema.js";

export const RESPONSE_KINDS = ["survey", "signup"];

/**
 * How each survey answer behaves.
 *
 *   choice   one option from a list          -> counted, biggest first
 *   multi    several options, pipe separated -> counted per option
 *   text     free writing                    -> listed, never counted
 *   contact  who sent it                     -> shown on the row, never counted
 *
 * `label` is the question as a person would ask it, not the column name. The
 * column names came from a form builder and read like variables.
 */
export const SURVEY_QUESTIONS = [
  { key: "name", label: "Name", kind: "contact" },
  { key: "company", label: "Shop", kind: "contact" },
  { key: "email", label: "Email", kind: "contact" },
  { key: "city_state", label: "Where they are", kind: "contact" },

  { key: "role", label: "Their role", kind: "choice" },
  { key: "headcount", label: "Shop size", kind: "choice" },
  { key: "methods", label: "What they do", kind: "multi" },
  { key: "past_attendee", label: "Been before", kind: "choice" },

  { key: "topics", label: "Topics they picked", kind: "multi", headline: true },
  { key: "must_have_session", label: "The one they would not miss", kind: "choice", headline: true },
  { key: "learning_format", label: "How they want to learn", kind: "multi", headline: true },
  { key: "two_track", label: "Two tracks", kind: "choice" },
  { key: "recordings", label: "Recordings", kind: "choice" },

  { key: "price", label: "What they would pay", kind: "choice" },
  { key: "likelihood", label: "Coming in 2027", kind: "choice" },
  { key: "drive_distance", label: "How far they would travel", kind: "choice" },
  { key: "dates_work", label: "Do the dates work", kind: "choice" },
  { key: "group_size", label: "How many they would bring", kind: "choice" },
  { key: "shirt_size", label: "Shirt size", kind: "choice" },
  { key: "sponsor_optin", label: "Would sponsor", kind: "choice" },

  { key: "biggest_problem", label: "Their biggest problem", kind: "text" },
  { key: "expensive_mistake", label: "Their most expensive mistake", kind: "text" },
  { key: "harder", label: "What got harder", kind: "text" },
  { key: "missing_topic", label: "What we did not ask about", kind: "text" },
  { key: "dream_speaker", label: "Who they would drive to hear", kind: "text" },
  { key: "barrier", label: "What would stop them coming", kind: "text" },
  { key: "anything_else", label: "Anything else", kind: "text" },
];

export const SURVEY_KEYS = SURVEY_QUESTIONS.map((q) => q.key);

export function questionFor(key) {
  return SURVEY_QUESTIONS.find((q) => q.key === key) || null;
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/**
 * Answers that are not answers.
 *
 * "No.", "?", "Unsure." are somebody being polite about having nothing to say.
 * Listing them as findings pads the screen with noise and makes the real
 * answers harder to see. They are still stored on the record; they are only
 * left out of the summary.
 */
const NON_ANSWERS = [
  "no", "no.", "none", "n/a", "na", "n a", "?", "??", "unsure", "unsure.",
  "nothing", "nope", "anyone!", "i don't know", "idk", "-",
];

export function isRealAnswer(value) {
  const s = str(value);
  if (!s) return false;
  if (NON_ANSWERS.includes(s.toLowerCase())) return false;
  if (/^not that i can think of/i.test(s)) return false;
  if (/^no[.,!]?$/i.test(s)) return false;
  return true;
}

/** A pipe-separated multi-select, as a form builder writes it into a sheet. */
export function splitMulti(value) {
  return str(value).split("|").map((x) => x.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * RECORDS
 * ------------------------------------------------------------------ */

export function newResponse(id, event, kind, answers, source) {
  return {
    id,
    event,
    kind: RESPONSE_KINDS.includes(kind) ? kind : "survey",
    // Stored as sent. A response is evidence, and an importer that tidies it
    // is an importer that has edited what somebody said.
    answers: answers && typeof answers === "object" ? answers : {},
    submittedAt: str(answers && answers.submitted_at) || new Date().toISOString(),
    source: str(source) || "manual",
    // Set when somebody turns one of its topics into a session idea, so the
    // screen can say which asks have been acted on.
    actedOn: [],
    createdAt: new Date().toISOString(),
    history: [],
  };
}

export function responderName(record) {
  const a = (record && record.answers) || {};
  return str(a.name) || str(a.email) || "Anonymous";
}

export function responderShop(record) {
  return str(((record && record.answers) || {}).company);
}

/* ------------------------------------------------------------------ *
 * THE SUMMARY
 * ------------------------------------------------------------------ */

/**
 * Count one question across every response.
 *
 * ALWAYS OUT OF THE NUMBER WHO ANSWERED THAT QUESTION, not the number of
 * responses. A question added halfway through a survey has fewer answers, and
 * dividing by the wrong denominator makes it look unpopular instead of late.
 */
export function tally(records, key) {
  const q = questionFor(key);
  if (!q || (q.kind !== "choice" && q.kind !== "multi")) return null;

  const counts = new Map();
  let answered = 0;

  for (const rec of records || []) {
    const raw = ((rec && rec.answers) || {})[key];
    const values = q.kind === "multi" ? splitMulti(raw) : (str(raw) ? [str(raw)] : []);
    if (!values.length) continue;
    answered += 1;
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  }

  const rows = Array.from(counts.entries())
    .map(([value, count]) => ({ value, count, share: answered ? count / answered : 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  return { key, label: q.label, kind: q.kind, answered, rows };
}

/** Every free-text answer to one question, with who said it. Noise removed. */
export function quotes(records, key) {
  const q = questionFor(key);
  if (!q || q.kind !== "text") return null;
  const rows = [];
  for (const rec of records || []) {
    const raw = ((rec && rec.answers) || {})[key];
    if (!isRealAnswer(raw)) continue;
    rows.push({ id: rec.id, who: responderName(rec), shop: responderShop(rec), text: str(raw) });
  }
  return { key, label: q.label, answered: rows.length, rows };
}

/**
 * Topic demand: picked alongside named-as-the-one, side by side.
 *
 * The two numbers disagree in useful ways and the disagreement is the finding.
 * In the FOC26 data "Burnout and the isolation of running a shop" was picked by
 * seven of nineteen and was nobody's single must-have: people want it in the
 * room and will not travel for it, which is a round table rather than a
 * session. Collapsing these into one rank would have hidden that.
 */
export function topicDemand(records) {
  const picked = tally(records, "topics");
  const must = tally(records, "must_have_session");
  if (!picked || !must) return { rows: [], respondents: (records || []).length };

  const mustBy = new Map(must.rows.map((r) => [r.value, r.count]));
  const seen = new Map(picked.rows.map((r) => [r.value, r.count]));
  // A topic named as somebody's one must-have but missing from every picks list
  // still counts. It happens, and dropping it would lose the strongest signal
  // in the survey.
  for (const value of mustBy.keys()) if (!seen.has(value)) seen.set(value, 0);

  const rows = Array.from(seen.keys()).map((topic) => ({
    topic,
    picked: seen.get(topic) || 0,
    mustHave: mustBy.get(topic) || 0,
  }));

  rows.sort((a, b) => (b.mustHave - a.mustHave) || (b.picked - a.picked) || a.topic.localeCompare(b.topic));
  return { rows, respondents: picked.answered };
}

/**
 * The whole survey, summarised in the order the catalog declares.
 *
 * Generated rather than hand-written, so next year's extra question appears on
 * the screen without anybody editing a template.
 */
export function summarise(records) {
  const rows = records || [];
  const out = { respondents: rows.length, headline: [], counts: [], text: [] };

  for (const q of SURVEY_QUESTIONS) {
    if (q.kind === "contact") continue;
    if (q.kind === "text") {
      const block = quotes(rows, q.key);
      if (block && block.answered) out.text.push(block);
      continue;
    }
    const block = tally(rows, q.key);
    if (!block || !block.answered) continue;
    (q.headline ? out.headline : out.counts).push(block);
  }

  out.topics = topicDemand(rows);
  return out;
}

/* ------------------------------------------------------------------ *
 * CSV IN
 *
 * The survey lives in a Google Sheet today. Rather than bake a copy of it into
 * the repo, where it would carry names and email addresses into git and go
 * stale the day somebody answers again, the screen takes a paste of the
 * exported CSV. That also means next year's import is the same two minutes.
 * ------------------------------------------------------------------ */

/**
 * A real CSV parser, not a split on commas.
 *
 * Every free-text answer in this survey is a sentence somebody typed, and
 * several contain commas, quotes and line breaks. Splitting on commas would
 * shift every column after the first comma in a sentence, silently, and the
 * import would look like it worked.
 */
export function parseCsv(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ",") { row.push(field); field = ""; i += 1; continue; }
    if (c === "\r") { i += 1; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }

    field += c; i += 1;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

/**
 * CSV to answer objects, keyed by the header row.
 *
 * Unknown columns are KEPT rather than dropped. A column this file has never
 * heard of is a question somebody added to the form, and throwing it away at
 * import means the answer is gone before anybody notices the question exists.
 */
export function rowsFromCsv(text) {
  const grid = parseCsv(text);
  if (grid.length < 2) return { headers: [], rows: [], unknown: [] };

  const headers = grid[0].map((h) => String(h).trim());
  const unknown = headers.filter((h) => h && !SURVEY_KEYS.includes(h) && h !== "submitted_at");

  const rows = grid.slice(1).map((line) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      obj[h] = String(line[idx] == null ? "" : line[idx]).trim();
    });
    return obj;
  });

  return { headers, rows, unknown };
}

/**
 * What makes two submissions the same one.
 *
 * Email plus submitted-at. Email alone would fold a shop that answered in 2024
 * and again in 2026 into one row, and those are two separate answers to two
 * separate surveys. Timestamp alone collides on a busy afternoon.
 */
export function responseKey(answers) {
  const a = answers || {};
  const email = str(a.email).toLowerCase();
  const at = str(a.submitted_at);
  return `${email}|${at}`;
}

/* ------------------------------------------------------------------ *
 * NOTIFY SIGNUPS
 * ------------------------------------------------------------------ */

export function newSignup(id, event, answers, source) {
  const a = answers || {};
  return {
    id,
    event,
    kind: "signup",
    answers: {
      name: str(a.name),
      email: str(a.email).toLowerCase(),
      city_state: str(a.city_state),
      submitted_at: str(a.submitted_at) || new Date().toISOString(),
    },
    submittedAt: str(a.submitted_at) || new Date().toISOString(),
    source: str(source) || "manual",
    actedOn: [],
    createdAt: new Date().toISOString(),
    history: [],
  };
}

/**
 * A signup with an email and nothing else is still a signup.
 *
 * Two of these were sitting in a shifted column of the sheet with no name and
 * no city, and the shape that refuses them is the shape that loses them. Only
 * a missing or malformed email is refusable.
 */
export function signupIsUsable(answers) {
  const email = str((answers || {}).email).toLowerCase();
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export { isoDate };
