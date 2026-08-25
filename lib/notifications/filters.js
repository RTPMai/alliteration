// lib/notifications/filters.js — notification filtering, as pure functions.
//
// Ryan's ask, Aug 25 2026: "a way to filter notifications." The list had two
// tabs and a Show-completed checkbox and nothing else, which is fine at
// twenty items and useless at four hundred.
//
// This lives in lib/ rather than inside apps/notifications.js so the rules
// are real functions a test can call with a made-up notification and check
// the answer, instead of a test grepping the app file for the word "filter"
// and proving nothing. Same lesson as the route-imports file: matching the
// letters is not the same as running the code.
//
// Everything here is pure. No fetch, no KV, no date "now" read from inside a
// comparison — the caller passes today in, so a test can ask what "overdue"
// means on a specific morning without mocking the clock.
//
// ESM, imported by the browser (apps/notifications.js). Do NOT convert to
// module.exports.

// ---- Filter vocabularies (single source of truth for the pickers) --------

export const DUE_FILTERS = [
  { value: "any", label: "Any due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due within 7 days" },
  { value: "none", label: "No due date" },
];

export const STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Completed" },
  { value: "all", label: "Open and completed" },
];

export const DUE_VALUES = DUE_FILTERS.map((d) => d.value);
export const STATUS_VALUES = STATUS_FILTERS.map((s) => s.value);

// The defaults ARE the unfiltered view: status "open" because an inbox is a
// list of what is left to do, not an archive. activeFilterCount() measures
// distance from this object, so anything added here must also be considered
// there.
export const EMPTY_FILTERS = {
  q: "",
  appId: "",
  type: "",
  due: "any",
  status: "open",
  person: "",
};

// ---- Dates ---------------------------------------------------------------
// dueDate is stored as a plain "YYYY-MM-DD" day, never a timestamp, so day
// comparisons are string comparisons and no timezone gets a vote. The only
// arithmetic needed is "seven days from that day", which goes through UTC so
// a daylight-saving boundary cannot produce a 23-hour day and lose one.

export function todayLocalISO(now) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function addDays(isoDay, days) {
  const parts = String(isoDay || "").split("-");
  if (parts.length !== 3) return "";
  const t = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(t)) return "";
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

// ---- Normalizing ---------------------------------------------------------

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Coerce anything (a saved blob, a query string, a half-built object) into a
 * complete filter object. An unknown due or status value falls back to the
 * default rather than filtering everything away, because a filter nobody
 * asked for that silently empties the screen reads as "the app is broken."
 */
export function normalizeFilters(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const due = str(r.due);
  const status = str(r.status);
  return {
    q: str(r.q).slice(0, 200),
    appId: str(r.appId),
    type: str(r.type),
    due: DUE_VALUES.includes(due) ? due : EMPTY_FILTERS.due,
    status: STATUS_VALUES.includes(status) ? status : EMPTY_FILTERS.status,
    person: str(r.person).toLowerCase(),
  };
}

/**
 * How many filters are actually doing something. Drives the "Clear filters"
 * button and the count line, so the answer to "why am I seeing three of
 * forty" is on screen instead of being something you have to remember.
 */
export function activeFilterCount(raw) {
  const f = normalizeFilters(raw);
  let n = 0;
  if (f.q) n++;
  if (f.appId) n++;
  if (f.type) n++;
  if (f.person) n++;
  if (f.due !== EMPTY_FILTERS.due) n++;
  if (f.status !== EMPTY_FILTERS.status) n++;
  return n;
}

// ---- Matching ------------------------------------------------------------

function haystack(n) {
  const link = n.link && (n.link.label || n.link.id) ? String(n.link.label || n.link.id) : "";
  return [
    n.title, link,
    n.assignedToName, n.assignedTo,
    n.createdByName, n.createdBy,
  ].map((v) => String(v == null ? "" : v)).join(" ").toLowerCase();
}

function matchesDue(n, due, today) {
  if (due === "any") return true;
  const d = n.dueDate ? String(n.dueDate) : "";
  if (due === "none") return !d;
  if (!d) return false;
  if (due === "overdue") return d < today;
  if (due === "today") return d === today;
  // "week" deliberately includes overdue and today: the question behind it is
  // "what needs attention in the next week", and something that was due
  // Monday still needs attention this week.
  if (due === "week") return d <= addDays(today, 7);
  return true;
}

/**
 * Does one notification survive the filters? `today` is a "YYYY-MM-DD" day
 * supplied by the caller.
 *
 * Text search covers the title, the linked record's label, and both people's
 * names, because "hannah" and "Prairie Trail" are both things somebody types
 * into a search box expecting the same list back.
 */
export function matchesFilters(n, raw, today) {
  if (!n || typeof n !== "object") return false;
  const f = normalizeFilters(raw);
  const day = str(today) || todayLocalISO();

  if (f.status !== "all" && (n.status || "open") !== f.status) return false;
  if (f.appId && !(Array.isArray(n.appIds) && n.appIds.includes(f.appId))) return false;
  if (f.type && !(Array.isArray(n.types) && n.types.includes(f.type))) return false;
  if (f.person && String(n.assignedTo || "").toLowerCase() !== f.person) return false;
  if (!matchesDue(n, f.due, day)) return false;
  if (f.q && !haystack(n).includes(f.q.toLowerCase())) return false;
  return true;
}

/**
 * Filter and order a list. Open items come first, then the nearest due date,
 * then newest — a dated item is a promise to somebody and outranks an
 * undated one no matter which was typed first.
 */
export function applyFilters(list, raw, opts) {
  const o = opts || {};
  const day = str(o.today) || todayLocalISO();
  const src = Array.isArray(list) ? list : [];
  return src
    .filter((n) => matchesFilters(n, raw, day))
    .sort((a, b) => {
      const ad = (a.status || "open") === "done" ? 1 : 0;
      const bd = (b.status || "open") === "done" ? 1 : 0;
      if (ad !== bd) return ad - bd;
      const adue = a.dueDate || "9999-12-31";
      const bdue = b.dueDate || "9999-12-31";
      if (adue !== bdue) return adue < bdue ? -1 : 1;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
}

// ---- Team scoping (Ryan's ask, Aug 25 2026) ------------------------------
// "My team" is a THIRD tab beside "Assigned to me" and "I assigned": what is
// on my people's plates. It exposes nothing new — a team-visibility
// notification is already readable by everyone signed in, which is the point
// of a shared hand-off list — so this is a lens over data the person can
// already see, not a permission.
//
// Membership comes from CrewCore, resolved server-side (api/notifications.js
// ?team=1), because the org chart belongs in the HR app and not in a second
// copy that drifts.

export const TEAM_SCOPES = ["reports", "all", "none"];

/**
 * Which notifications belong on the team tab. Excludes the viewer's own
 * items on purpose: "Assigned to me" already answers that question, and a
 * manager scanning for what is stuck on somebody else does not want their
 * own list mixed in.
 */
export function teamPool(list, members, me) {
  const set = new Set(
    (Array.isArray(members) ? members : [])
      .map((m) => String((m && m.username) || m || "").toLowerCase())
      .filter(Boolean)
  );
  const mine = String(me || "").toLowerCase();
  set.delete(mine);
  if (!set.size) return [];
  return (Array.isArray(list) ? list : [])
    .filter((n) => set.has(String(n.assignedTo || "").toLowerCase()));
}
