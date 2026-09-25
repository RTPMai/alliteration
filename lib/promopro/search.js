// PUT IN: lib/promopro/search.js
// lib/promopro/search.js — the search box on the Purchase Orders screen.
//
// WHY THIS IS NOT IN apps/promopro.js. A search that quietly misses is worse
// than no search: "no purchase order matches 66608" reads as "we never raised
// one", and somebody raises a second. So what gets searched, and how a term
// matches, are pure functions the tests call directly.
//
// WHAT IS SEARCHED. Everything a person might have in hand when they come
// looking: the PO number, the Printavo invoice number, the customer (company
// AND the contact, because a caller gives their own name, not their company),
// the vendor, the account manager, every line (item number, description,
// imprint, detail), tracking, carrier, ship to and notes.
//
// Names come in from the screen (vendor name, AM name) rather than ids,
// because what somebody types is what they can read.
//
// ESM. Do NOT convert to module.exports.

const clean = (v) => String(v == null ? "" : v).toLowerCase();

// Punctuation and spacing stripped, so "26 66608 9", "26-66608-9" and
// "26666089" all find the same order. People copy PO numbers out of emails,
// subject lines and packing slips, and every one of those formats them
// differently.
const compact = (v) => clean(v).replace(/[^a-z0-9]/g, "");

/**
 * Everything searchable on one purchase order, as one lowercase string.
 *
 * `names` carries the display values the screen already worked out:
 *   { customer, vendor, am }
 */
export function poSearchText(po, names) {
  const p = po && typeof po === "object" ? po : {};
  const n = names && typeof names === "object" ? names : {};
  const pv = p.printavo && typeof p.printavo === "object" ? p.printavo : {};
  const lines = Array.isArray(p.lines) ? p.lines : [];

  const parts = [
    p.poNumber,
    pv.invoiceNumber,
    n.customer, pv.companyName, pv.customerName, pv.contactName,
    n.vendor,
    n.am,
    p.trackingNumber, p.carrier,
    p.shipTo, p.notes,
  ];
  lines.forEach((l) => {
    if (!l || typeof l !== "object") return;
    parts.push(l.itemNumber, l.description, l.imprint, l.detail);
  });

  return parts
    .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
    .map(clean)
    .join(" \n ");
}

/** The words typed, lowercased, blanks dropped. */
export function searchTerms(term) {
  return clean(term).split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/**
 * Does this text match what was typed?
 *
 * EVERY word has to appear, in any order: "hy-vee polo" narrows, it does not
 * widen. Each word matches as written OR with its punctuation stripped against
 * the stripped text, which is what lets a PO number be typed any way.
 *
 * Nothing typed matches everything. An empty box is not a search.
 */
export function matchesSearch(text, term) {
  const words = searchTerms(term);
  if (!words.length) return true;
  const hay = clean(text);
  const hayCompact = compact(text);
  return words.every((w) => {
    if (hay.includes(w)) return true;
    const cw = compact(w);
    return cw !== "" && hayCompact.includes(cw);
  });
}

/** Is a search actually in effect? */
export function isSearching(term) {
  return searchTerms(term).length > 0;
}
