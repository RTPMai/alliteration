// lib/help/retrieve.js — picking which knowledge docs answer a question.
//
// Ryan's ask, Aug 25 2026: a help bot people can ask how an app works, how a
// number is calculated, and where the data comes from. Explanations only. It
// never reads live business data, so there is no figure it can get wrong and
// no per-person data scope it has to re-implement.
//
// NO VECTOR DATABASE, ON PURPOSE. There are sixteen documents. Keyword
// scoring over sixteen short documents is as good as embeddings at this size,
// costs nothing, adds no service to a platform that declares one dependency,
// and unlike a similarity score it can be tested: given this question, these
// documents come back, in this order, every time.
//
// Pure functions only. No fetch, no KV, no model call. api/help.js does the
// talking; this file only decides what the model is allowed to see.
//
// ESM. Do NOT convert to module.exports.

// Words that carry no signal about WHICH app is being asked about. "How",
// "the", and "work" appear in nearly every question; scoring on them ranks
// documents by length instead of by relevance.
const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "but",
  "by", "can", "come", "comes", "could", "did", "do", "does", "doing", "for",
  "from", "get", "gets", "give", "go", "had", "has", "have", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "know", "like", "me", "mean",
  "means", "my", "no", "not", "of", "on", "one", "or", "our", "out", "over",
  "should", "show", "so", "some", "tell", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "use", "used",
  "using", "want", "was", "we", "what", "when", "where", "which", "who",
  "why", "will", "with", "work", "works", "would", "you", "your",
]);

// Below this, a document is noise rather than a weak answer. A question about
// something nobody has documented should come back as "I do not know", not as
// the least-irrelevant document delivered with confidence.
export const MIN_SCORE = 3;

// How many documents go to the model. Three is enough for a question that
// spans two apps ("does MailMe know about MarketMachine campaigns") without
// burying the real answer in context.
export const MAX_DOCS = 3;

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// Singular/plural is the difference between "how are leads scored" and "lead
// scoring" matching nothing. Crude on purpose: a stemmer would be more
// correct and much harder to reason about when a search misses.
function variants(word) {
  const out = [word];
  if (word.endsWith("ies") && word.length > 4) out.push(word.slice(0, -3) + "y");
  else if (word.endsWith("es") && word.length > 3) out.push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) out.push(word.slice(0, -1));
  else out.push(word + "s");
  return out;
}

function countIn(haystack, word) {
  let n = 0;
  variants(word).forEach((v) => {
    const re = new RegExp("\\b" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    const hits = haystack.match(re);
    if (hits) n += hits.length;
  });
  return n;
}

/**
 * Score one document against one question.
 *
 * Where a word appears matters more than how often. A document whose TITLE is
 * the word being asked about is almost certainly the right one; a document
 * that happens to say "vendor" nine times in passing is not. Body hits are
 * therefore capped, so length cannot buy relevance.
 */
export function scoreDoc(doc, question) {
  if (!doc) return 0;
  const words = tokenize(question);
  if (!words.length) return 0;

  const title = String(doc.title || "").toLowerCase();
  const appId = String(doc.app || "").toLowerCase();
  const keys = (Array.isArray(doc.keywords) ? doc.keywords : []).join(" ").toLowerCase();
  const body = String(doc.body || "").toLowerCase();

  let score = 0;
  words.forEach((w) => {
    if (countIn(title, w) || appId === w || countIn(appId, w)) score += 6;
    if (countIn(keys, w)) score += 4;
    // Capped: three mentions and thirty mentions say the same thing here.
    score += Math.min(countIn(body, w), 3);
  });
  return score;
}

/**
 * Pick the documents that go to the model.
 *
 * `allowedApps` is the list of app ids the asker can actually open. Documents
 * outside it are dropped before scoring, so nobody gets an explanation of a
 * screen they cannot reach. The general platform doc has no app of its own
 * and is always allowed.
 *
 * `currentApp` is what they had open when they clicked the help button. It
 * breaks ties, which is what makes "how is this calculated" work without
 * anybody naming the app. It is a nudge and not an override: asking about
 * StitchSense from inside BackBone still returns the StitchSense doc.
 */
export function pickDocs(docs, question, opts) {
  const o = opts || {};
  const limit = o.limit || MAX_DOCS;
  const allowed = Array.isArray(o.allowedApps) ? o.allowedApps : null;
  const current = String(o.currentApp || "").toLowerCase();

  const pool = (Array.isArray(docs) ? docs : []).filter(
    (d) => d && (!allowed || !d.app || allowed.includes(d.app))
  );

  return pool
    .map((d) => {
      const base = scoreDoc(d, question);
      // Only nudges a document that already matched something. A tie-break
      // must never promote a document the question had nothing to do with.
      const boost = base > 0 && d.app && d.app === current ? 2 : 0;
      return { doc: d, score: base + boost };
    })
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || String(a.doc.app).localeCompare(String(b.doc.app)))
    .slice(0, limit);
}

/**
 * Assemble the prompt. Everything the model is allowed to say comes from
 * here; there is no general knowledge fallback, because a plausible invented
 * explanation of how a number is calculated is the single worst thing this
 * feature could produce. Somebody would act on it.
 */
export function buildPrompt(hits, question, context) {
  const c = context || {};
  const sources = hits.map((h, i) =>
    "=== DOCUMENT " + (i + 1) + ": " + h.doc.title + " ===\n" + h.doc.body
  ).join("\n\n");

  const where = c.appName
    ? "They are currently looking at " + c.appName +
      (c.viewName ? ", on the " + c.viewName + " screen" : "") + "."
    : "";

  return {
    system:
      "You are the in-app help for Alliteration, the internal platform at P&M " +
      "Apparel, a decorated apparel shop in Polk City, Iowa. You explain how " +
      "the platform's apps work: what a screen is for, how a number is " +
      "calculated, where data comes from, and how to do a task.\n\n" +
      "RULES:\n" +
      "1. Answer ONLY from the documents provided. If they do not cover the " +
      "question, say plainly that it is not documented yet and that Ryan can " +
      "add it. Never fill a gap with a guess, however reasonable it sounds. " +
      "Somebody will act on what you say.\n" +
      "2. You have no access to live business data. You cannot look up a " +
      "figure, a customer, an order or a total. If asked for one, say so and " +
      "point at the screen that shows it.\n" +
      "3. Name the app a piece of information came from.\n" +
      "4. Be brief. Two or three short paragraphs at most, plain language, " +
      "no jargon the documents do not use. The person asking may have no " +
      "technical background.\n" +
      "5. Never use em dashes.",
    user:
      (where ? where + "\n\n" : "") +
      "QUESTION: " + String(question || "").trim() + "\n\n" +
      "DOCUMENTS YOU MAY USE:\n\n" + sources,
  };
}
