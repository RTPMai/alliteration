// PUT IN: lib/crewcore/sample-pdf.js
//
// lib/crewcore/sample-pdf.js — read SanMar's offer PDF and suggest the two
// style lists.
//
// WHAT THIS IS FOR
// Twice a year SanMar sends an offer sheet: a few pages listing the New
// Arrivals styles at 50% off and the ones at 25% off. Typing 138 style
// numbers off that sheet by hand is the job this removes.
//
// IT FILLS THE FORM. IT NEVER IMPORTS.
// A reader turning NF0A8JEV into NF0A8IEV would otherwise put a garment
// nobody chose in front of the whole team, and the first anyone would know is
// a box arriving. So the result lands in the two boxes for a human to read,
// and the existing Import button is still what starts the import. Four
// seconds of reading removes that whole class of problem.
//
// Everything here is pure. No fetch, no storage, no environment. The route
// does the network call and hands the reply text to parseExtraction().
//
// ESM. lib/ never imports from api/.

// Vercel refuses a request body over 4.5 MB whatever the handler says, and
// base64 adds a third on top of the file's real size. 3 MB of PDF is about
// 4.1 MB on the wire, which fits with room for the JSON around it. Every
// SanMar offer sheet seen so far is well under 1 MB.
export const MAX_PDF_BYTES = 3 * 1024 * 1024;

// A style number is letters, digits and hyphens, and it always carries at
// least one digit. "PC61", "DT6105", "NF0A8JEV", "K500LS" pass. A heading
// like "FLEECE" does not, which is the point: the reader hands back whatever
// it saw and this is the sieve.
const STYLE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/**
 * Decode the first n bytes of a base64 string without decoding all of it.
 * Buffer in the serverless runtime, atob elsewhere, empty string if neither.
 */
function headBytes(b64, n) {
  const chunk = String(b64 || "").slice(0, Math.ceil(n / 3) * 4);
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(chunk, "base64").toString("latin1").slice(0, n);
    }
    if (typeof atob === "function") return atob(chunk).slice(0, n);
  } catch (e) {
    return "";
  }
  return "";
}

/**
 * Strip a data URL wrapper if there is one and hand back the raw base64.
 */
export function stripDataUrl(input) {
  const s = String(input || "").trim();
  const m = /^data:([^;,]*)(;base64)?,/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

/**
 * Byte length of a base64 payload, without materialising it.
 */
export function base64Bytes(b64) {
  const s = String(b64 || "").replace(/\s+/g, "");
  if (!s) return 0;
  const pad = (s.endsWith("==") ? 2 : 0) || (s.endsWith("=") ? 1 : 0);
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * Is this really a PDF?
 *
 * Judged on the file's own first five bytes, not on the name it arrived
 * under. Somebody renaming a spreadsheet to .pdf should be told before a
 * paid API call, not after.
 */
export function looksLikePdf(b64) {
  return headBytes(stripDataUrl(b64), 5) === "%PDF-";
}

/**
 * Everything that has to be true before the file is worth sending anywhere.
 * Returns null when it is fine, or a sentence explaining what is wrong.
 */
export function rejectReason(b64) {
  const raw = stripDataUrl(b64);
  if (!raw) return "No file arrived. Attach the SanMar offer PDF and try again.";
  if (!looksLikePdf(raw)) {
    return "That file is not a PDF. Save the offer sheet as a PDF, or paste the style numbers into the boxes instead.";
  }
  const bytes = base64Bytes(raw);
  if (bytes > MAX_PDF_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return `That PDF is ${mb} MB and the limit is 3 MB. Send just the pages with the style lists on them, or paste the style numbers into the boxes instead.`;
  }
  return null;
}

/**
 * The instruction sent alongside the PDF.
 *
 * Two things it is deliberately told: put anything it is unsure about in its
 * own bucket rather than guessing a tier, and never invent a style. An empty
 * list that says so is useful. A confident wrong list is not.
 */
export function buildPrompt() {
  return [
    "This is SanMar's discounted sample offer sheet for a seasonal New Arrivals drop.",
    "Styles are offered at two discount tiers, usually under headings like \"50% off\" and \"25% off\".",
    "",
    "Return ONLY a JSON object, no prose and no markdown fences, with these keys:",
    '  "fifty": an array of the style numbers offered at 50% off',
    '  "twentyfive": an array of the style numbers offered at 25% off',
    '  "unsure": an array of style numbers you found but could not confidently place under a tier',
    '  "note": one short sentence about anything odd, or "" if there was nothing',
    "",
    "Rules:",
    "- A style number is the short product code, like PC61, DT6105, NF0A8JEV or K500LS. Not the product name.",
    "- Copy each style number exactly as printed. Do not correct, expand or tidy it.",
    "- If you cannot tell which tier a style sits under, put it in \"unsure\". Do not guess.",
    "- Never invent a style number. If a page is unreadable, return what you could read and say so in \"note\".",
    "- Do not put the same style in more than one list.",
    "Return the JSON object and nothing else.",
  ].join("\n");
}

function cleanStyle(value) {
  return String(value == null ? "" : value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function collect(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((entry) => {
    const style = cleanStyle(entry);
    if (!style || !STYLE_RE.test(style) || !/[0-9]/.test(style)) return;
    if (seen.has(style)) return;
    seen.add(style);
    out.push(style);
  });
  return out;
}

/**
 * Turn the reader's reply into two lists worth showing.
 *
 * Returns { ok, error, fifty, twentyfive, unsure, note, conflicts }.
 *
 * A style claimed at both tiers is moved into "unsure" with its name shown,
 * NOT resolved by whichever list was read second. The whole point of a
 * two-tier sheet is that the tier decides the price, so a coin flip here
 * would quietly put the wrong number on somebody's stipend.
 */
export function parseExtraction(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  if (!cleaned) {
    return { ok: false, error: "The reader sent nothing back. Paste the style numbers into the boxes instead." };
  }

  let raw;
  try {
    raw = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: "The reader's answer was not readable. Paste the style numbers into the boxes instead." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "The reader's answer was not readable. Paste the style numbers into the boxes instead." };
  }

  const fifty = collect(raw.fifty);
  const twentyfive = collect(raw.twentyfive);
  const unsure = collect(raw.unsure);

  // Both tiers claiming one style is a real disagreement, so neither list
  // keeps it. It goes to unsure by name and a person decides.
  const inFifty = new Set(fifty);
  const conflicts = twentyfive.filter((s) => inFifty.has(s));
  const conflicted = new Set(conflicts);

  const finalFifty = fifty.filter((s) => !conflicted.has(s));
  const finalTwentyFive = twentyfive.filter((s) => !conflicted.has(s));

  const unsureAll = [];
  const seenUnsure = new Set();
  unsure.concat(conflicts).forEach((s) => {
    if (seenUnsure.has(s)) return;
    seenUnsure.add(s);
    unsureAll.push(s);
  });

  if (!finalFifty.length && !finalTwentyFive.length && !unsureAll.length) {
    return {
      ok: false,
      error: "No style numbers were found in that PDF. Check it is the offer sheet with the style lists on it, or paste them into the boxes instead.",
    };
  }

  return {
    ok: true,
    error: null,
    fifty: finalFifty,
    twentyfive: finalTwentyFive,
    unsure: unsureAll,
    conflicts,
    note: String(raw.note || "").trim().slice(0, 300),
  };
}

/**
 * The sentence under the button. Says what was found, spells out anything
 * unsure, and never claims the job is finished.
 */
export function extractionSummary(result) {
  if (!result || !result.ok) return (result && result.error) || "Nothing was read.";
  const bits = [
    `${result.fifty.length} at 50%`,
    `${result.twentyfive.length} at 25%`,
  ];
  let line = `Read ${bits.join(", ")}.`;
  if (result.conflicts && result.conflicts.length) {
    line += ` ${result.conflicts.join(", ")} appeared under both tiers, so ${result.conflicts.length === 1 ? "it is" : "they are"} not in either box.`;
  }
  const onlyUnsure = (result.unsure || []).filter(
    (s) => !(result.conflicts || []).includes(s)
  );
  if (onlyUnsure.length) {
    line += ` Not sure where these belong: ${onlyUnsure.join(", ")}.`;
  }
  if (result.note) line += ` ${result.note}`;
  return `${line} Check both boxes before importing.`;
}
