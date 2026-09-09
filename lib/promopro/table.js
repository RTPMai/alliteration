// PUT IN: lib/promopro/table.js
// lib/promopro/table.js — sorting and per-column filtering for the Purchase
// Orders table.
//
// WHY THIS IS NOT IN apps/promopro.js. Every rule in here is a decision that
// can be quietly wrong on screen and look completely normal: an order sorted
// to the bottom is indistinguishable from an order that is not there. Sorting
// Stage alphabetically puts Confirmed before Submitted, which reads as a
// pipeline running backwards. Filtering Status by its text would offer "no
// word for 6 days" and "no word for 8 days" as two separate choices. None of
// that throws an error. It just misleads.
//
// So the rules live here as pure functions the tests call directly, and the
// screen only draws what they return.
//
// THE ROW PROJECTION. These functions never touch a purchase order. The screen
// hands over rows that already carry the DISPLAYED value for each column
// (vendor name, not vendor id; the health level, not the health object),
// because what a person sorts and filters is what they can see. Sorting by an
// id while the screen shows names is the kind of thing that looks like a bug
// in the sort when it is really a mismatch in what is being compared.
//
// ESM. Do NOT convert to module.exports.

import { STAGES, CANCELLED } from "./schema.js";

/**
 * The columns, in screen order.
 *
 * `sort` names the comparator. `filter` is whether the header offers a menu:
 * a column is filterable when its values REPEAT across orders. PO number,
 * needed-by date and total are all but unique per row, so a menu of them
 * would be a list as long as the table and would never narrow anything.
 */
export const ORDER_COLUMNS = [
  { key: "poNumber", label: "PO",        sort: "text",   filter: false },
  { key: "customer", label: "Customer",  sort: "text",   filter: true },
  { key: "product",  label: "Product",   sort: "text",   filter: true },
  { key: "vendor",   label: "Vendor",    sort: "text",   filter: true },
  { key: "am",       label: "AM",        sort: "text",   filter: true },
  { key: "stage",    label: "Stage",     sort: "stage",  filter: true },
  { key: "neededBy", label: "Needed by", sort: "date",   filter: false },
  { key: "total",    label: "Total",     sort: "number", filter: false, numeric: true },
  { key: "status",   label: "Status",    sort: "health", filter: true },
];

export const COLUMN_KEYS = ORDER_COLUMNS.map((c) => c.key);

export function columnByKey(key) {
  return ORDER_COLUMNS.find((c) => c.key === key) || null;
}

/* ------------------------------------------------------------------ *
 * ORDERING WITHIN A COLUMN
 * ------------------------------------------------------------------ */

// Pipeline order, so Stage sorts the way the work actually flows rather than
// alphabetically. Cancelled is not a step on the way to anywhere, so it sits
// past the end instead of between two real stages.
const STAGE_RANK = STAGES.reduce((acc, s, i) => { acc[s.key] = i; return acc; }, {});
STAGE_RANK[CANCELLED] = STAGES.length;

// Worst first. This is the order somebody scanning for trouble wants, and it
// matches how the pipeline already ranks its cards, so the two screens do not
// disagree about which order is in the most trouble.
const HEALTH_RANK = { red: 0, amber: 1, ok: 2, done: 3 };

function textKey(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

/**
 * Compare two rows on one column. Returns the ASCENDING order; direction is
 * applied by the caller, with one deliberate exception below.
 */
function compareOn(a, b, col) {
  const av = a[col.key];
  const bv = b[col.key];

  if (col.sort === "number") {
    return (Number(av) || 0) - (Number(bv) || 0);
  }

  if (col.sort === "stage") {
    const ar = STAGE_RANK[a.stageKey] === undefined ? STAGES.length + 1 : STAGE_RANK[a.stageKey];
    const br = STAGE_RANK[b.stageKey] === undefined ? STAGES.length + 1 : STAGE_RANK[b.stageKey];
    return ar - br;
  }

  if (col.sort === "health") {
    const ar = HEALTH_RANK[a.healthLevel] === undefined ? 9 : HEALTH_RANK[a.healthLevel];
    const br = HEALTH_RANK[b.healthLevel] === undefined ? 9 : HEALTH_RANK[b.healthLevel];
    return ar - br;
  }

  return textKey(av).localeCompare(textKey(bv));
}

/** A row with nothing in the sorted column. Kept apart, see sortRows(). */
function isBlank(row, col) {
  if (col.sort === "number") return false;      // zero is a real total
  if (col.sort === "stage" || col.sort === "health") return false;
  return textKey(row[col.key]) === "";
}

/**
 * Sort rows by a column.
 *
 * BLANKS ALWAYS SINK, in both directions. An order with no needed-by date has
 * not got the earliest due date and it has not got the latest one either; it
 * has no answer to the question being asked. Letting empties ride the reverse
 * to the top would mean pressing "Needed by" twice fills the first screen with
 * the rows that have no date on them, which is the opposite of useful.
 *
 * The sort is STABLE and always breaks ties on PO number, so two orders that
 * are equal on the sorted column keep a fixed, predictable order instead of
 * shuffling every time the list redraws.
 */
export function sortRows(rows, key, dir) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const col = columnByKey(key);
  if (!col) return list;
  const sign = dir === "desc" ? -1 : 1;

  return list.sort((a, b) => {
    const ab = isBlank(a, col);
    const bb = isBlank(b, col);
    if (ab !== bb) return ab ? 1 : -1;          // note: NOT multiplied by sign
    const c = compareOn(a, b, col) * sign;
    if (c !== 0) return c;
    return textKey(a.poNumber).localeCompare(textKey(b.poNumber));
  });
}

/** The other direction, for a header being clicked again. */
export function nextDir(currentKey, currentDir, clickedKey) {
  if (currentKey !== clickedKey) {
    // A fresh column starts in the direction that is useful FIRST. Money and
    // trouble are interesting at the top end; names are not.
    const col = columnByKey(clickedKey);
    if (col && (col.sort === "number")) return "desc";
    return "asc";
  }
  return currentDir === "asc" ? "desc" : "asc";
}

/* ------------------------------------------------------------------ *
 * FILTERING BY A COLUMN
 * ------------------------------------------------------------------ */

/**
 * What a column's menu offers: every value present, with how many rows carry
 * it, most common first.
 *
 * Built from the rows ACTUALLY IN SCOPE rather than from every order on file,
 * so the menu never offers a vendor that would produce an empty table. Nothing
 * is more confusing than a filter that says it has results and then does not.
 *
 * An empty value becomes one explicit "(none)" entry rather than being
 * dropped: "which orders have no account manager" is a real question, and it
 * is unanswerable if blanks are simply not offered.
 */
export const BLANK_LABEL = "(none)";

export function filterValues(rows, key) {
  const col = columnByKey(key);
  if (!col || !col.filter) return [];
  const counts = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    const v = valueForFilter(r, col);
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      if (a.value === BLANK_LABEL) return 1;    // blanks at the bottom
      if (b.value === BLANK_LABEL) return -1;
      if (b.count !== a.count) return b.count - a.count;
      return textKey(a.value).localeCompare(textKey(b.value));
    });
}

/**
 * Status filters on the LEVEL, not on the sentence.
 *
 * The Status column shows a reason: "no word for 6 days", "7 days to due date,
 * vendor needs 10". Those are nearly unique per row, so offering them as a
 * menu would list one choice per order and narrow nothing. What somebody
 * actually wants is "show me the late ones", which is the level behind the
 * sentence.
 */
export const HEALTH_LABELS = {
  red: "Late",
  amber: "Needs attention",
  ok: "On track",
  done: "Complete",
};

function valueForFilter(row, col) {
  if (col.key === "status") return HEALTH_LABELS[row.healthLevel] || "Unknown";
  const v = String(row[col.key] == null ? "" : row[col.key]).trim();
  return v === "" ? BLANK_LABEL : v;
}

/**
 * Apply the chosen values. `filters` is { columnKey: [values] }.
 *
 * An empty or missing list for a column means NO filter on it, not "match
 * nothing". Treating an empty selection as excluding everything is how a
 * table goes blank when somebody unticks the last box, and blank looks like
 * a failure rather than like a choice they just made.
 */
export function applyColumnFilters(rows, filters) {
  const list = Array.isArray(rows) ? rows : [];
  const f = filters && typeof filters === "object" ? filters : {};
  const active = Object.keys(f).filter((k) => Array.isArray(f[k]) && f[k].length && columnByKey(k));
  if (!active.length) return list.slice();

  return list.filter((row) =>
    // Across columns this is AND, within one column OR: "Hannah's orders at
    // PowerTek", and "either Submitted or Confirmed". That is what the two
    // controls read like, and the other combinations are not askable.
    active.every((k) => f[k].includes(valueForFilter(row, columnByKey(k))))
  );
}

/** Which columns currently narrow the table, for the chips that say so. */
export function activeFilterList(filters) {
  const f = filters && typeof filters === "object" ? filters : {};
  return COLUMN_KEYS
    .filter((k) => Array.isArray(f[k]) && f[k].length)
    .map((k) => ({ key: k, label: columnByKey(k).label, values: f[k].slice() }));
}

export function anyFilterActive(filters) {
  return activeFilterList(filters).length > 0;
}
