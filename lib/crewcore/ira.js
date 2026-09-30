// PUT IN: lib/crewcore/ira.js
// lib/crewcore/ira.js: the SIMPLE IRA sign-up rules, in one place.
//
// Sep 30 2026, Ryan's call: "Election + packet status". An employee reads
// the plan info, downloads the packet, and picks enroll or decline plus how
// much comes out of each paycheck. Ryan marks the packet returned once he
// has it. The packet itself (a PDF on Google Drive) is where the real
// paperwork lives.
//
// WHAT IS NOT STORED, ON PURPOSE: no Social Security number, no date of
// birth, no bank details, no beneficiary names. None of it, anywhere. Those
// stay on the paper packet that goes to Ryan. This file only knows a choice
// (enrolled or declined), an amount, an optional start date, and whether
// the packet came back.
//
// WHO SEES IT: the employee themself and CrewCore admins. Never another
// non-admin, and never through the generic employee endpoints (see
// stripAdminFields in schema.js and api/crewcore/ira.js).
//
// Pure functions, no imports, so the screen (apps/crewcore.js), the route
// (api/crewcore/ira.js) and the tests all run the same rules and use the
// same words.
//
// ESM. Do NOT convert to module.exports.

/** "undecided" is never stored; it is what an absent `ira` object means. */
export const IRA_STATUSES = ["undecided", "enrolled", "declined"];

/** What an employee can actually pick. */
export const IRA_CHOICES = ["enrolled", "declined"];

/** Percent of pay, or a flat dollar amount taken from each paycheck. */
export const IRA_CONTRIBUTION_TYPES = ["percent", "dollars"];

export const IRA_STATUS_LABELS = {
  undecided: "Not chosen yet",
  enrolled: "Enrolled",
  declined: "Declined",
};

/** How many past elections and packet marks are kept on the record. */
export const IRA_HISTORY_CAP = 20;

export const DEFAULT_IRA_PACKET_URL = "https://drive.google.com/file/d/1fZgSNxNAu6olZY_hBTylukYvphN8ZoCP/view";
export const DEFAULT_IRA_MATCH_PERCENT = 3;

/**
 * The plan explainer, in short plain sentences. Paraphrased from P&M's own
 * page about the plan. The match comes from Settings so a change there
 * shows up here without a deploy.
 */
export function iraPlanInfo(matchPercent = DEFAULT_IRA_MATCH_PERCENT) {
  const m = fmtNumber(Number.isFinite(Number(matchPercent)) ? Number(matchPercent) : DEFAULT_IRA_MATCH_PERCENT);
  return [
    "A SIMPLE IRA is a retirement savings account offered by small businesses.",
    "You can put part of each paycheck in. That lowers your taxable income now.",
    `P&M matches what you put in, up to ${m}% of your pay.`,
    "The money is not taxed until it comes out, usually in retirement.",
    "Taking money out before age 59 and a half can mean penalties, and they are steeper in your first two years in the plan.",
    "To sign up, fill out the IRA packet and give it to Ryan.",
  ];
}

/* ---- helpers ------------------------------------------------------------ */

function fmtNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function fmtDollars(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Turns "3", "3%", "$50", "1,200.50" into a number, or NaN. */
function toNumber(raw) {
  if (typeof raw === "number") return raw;
  const s = String(raw == null ? "" : raw).replace(/[$,%\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return Number(s);
}

/** At most two decimal places. */
function twoPlaces(n) {
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

function blank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The status an employee record is in. Absent means undecided. */
export function iraStatus(ira) {
  const s = ira && ira.status;
  return s === "enrolled" || s === "declined" ? s : "undecided";
}

/* ---- validation --------------------------------------------------------- */

/**
 * Checks one election as typed.
 *
 * Input: { status, percent?, dollars?, start_date? }
 *   status      "enrolled" or "declined", required
 *   percent     percent of pay, more than 0 and at most 100, two decimals
 *   dollars     flat amount per paycheck, more than 0, cents
 *   start_date  optional, YYYY-MM-DD
 *
 * Enrolled needs exactly one of percent or dollars. Declined carries no
 * amount and no start date; anything sent with it is ignored rather than
 * refused, so flipping the toggle on screen cannot trap somebody.
 *
 * Returns { ok, errors, value }. value is only set when ok.
 */
export function validateIraElection(input) {
  const b = input && typeof input === "object" ? input : {};
  const errors = [];
  const status = String(b.status || "").trim().toLowerCase();

  if (!IRA_CHOICES.includes(status)) {
    errors.push("Pick enroll or decline.");
    return { ok: false, errors };
  }

  if (status === "declined") {
    return {
      ok: true, errors: [],
      value: { status: "declined", contribution_type: null, contribution: null, start_date: null },
    };
  }

  const hasPct = !blank(b.percent);
  const hasUsd = !blank(b.dollars);
  let contribution_type = null;
  let contribution = null;

  if (hasPct && hasUsd) {
    errors.push("Pick a percent of pay or a dollar amount, not both.");
  } else if (!hasPct && !hasUsd) {
    errors.push("Say how much to put in from each paycheck.");
  } else if (hasPct) {
    const p = toNumber(b.percent);
    if (!Number.isFinite(p)) errors.push("The percent has to be a number.");
    else if (p <= 0) errors.push("The percent has to be more than 0.");
    else if (p > 100) errors.push("The percent can't be more than 100.");
    else if (!twoPlaces(p)) errors.push("The percent can have at most two decimal places.");
    else { contribution_type = "percent"; contribution = Math.round(p * 100) / 100; }
  } else {
    const d = toNumber(b.dollars);
    if (!Number.isFinite(d)) errors.push("The dollar amount has to be a number.");
    else if (d <= 0) errors.push("The dollar amount has to be more than 0.");
    else if (!twoPlaces(d)) errors.push("The dollar amount can only go to the cent.");
    else { contribution_type = "dollars"; contribution = Math.round(d * 100) / 100; }
  }

  let start_date = null;
  if (!blank(b.start_date)) {
    const s = String(b.start_date).trim();
    if (!isRealDate(s)) errors.push("The start date has to be a real date (YYYY-MM-DD).");
    else start_date = s;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value: { status: "enrolled", contribution_type, contribution, start_date } };
}

/* ---- applying changes --------------------------------------------------- */

/** True when a validated value differs from what is already on file. */
export function electionChanged(current, value) {
  const c = current || {};
  return iraStatus(c) !== value.status
    || (c.contribution_type || null) !== (value.contribution_type || null)
    || (c.contribution == null ? null : Number(c.contribution)) !== (value.contribution == null ? null : Number(value.contribution))
    || (c.start_date || null) !== (value.start_date || null);
}

function pushHistory(list, entry) {
  const out = (Array.isArray(list) ? list : []).concat([entry]);
  return out.slice(-IRA_HISTORY_CAP);
}

/**
 * The new `ira` object after an election. Does not save anything.
 *
 * Same choice as before: returned unchanged, no history line, so pressing
 * Save twice does not look like two decisions (and does not ping the
 * approvers twice).
 *
 * PACKET AFTER A CHANGE. Payroll needs paperwork for a change, not just for
 * the first sign-up. So if Ryan already had a packet and the choice then
 * changes, packet_returned stays true (he does still have the old one) and
 * changed_after_packet turns on. The sign-up sheet counts that person as a
 * packet to collect again, and marking the packet returned clears it.
 */
export function applyElection(employee, value, { by, now } = {}) {
  const current = (employee && employee.ira) || null;
  if (current && !electionChanged(current, value)) return { ...current };

  const at = now || new Date().toISOString();
  const who = String(by || "").toLowerCase() || null;
  const hadPacket = !!(current && current.packet_returned);
  const verb = current && iraStatus(current) !== "undecided" ? "Changed to " : "";

  return {
    status: value.status,
    contribution_type: value.contribution_type || null,
    contribution: value.contribution == null ? null : value.contribution,
    start_date: value.start_date || null,
    elected_at: at,
    elected_by: who,
    packet_returned: hadPacket,
    packet_at: current ? current.packet_at || null : null,
    packet_by: current ? current.packet_by || null : null,
    changed_after_packet: hadPacket ? true : !!(current && current.changed_after_packet),
    history: pushHistory(current && current.history, { at, by: who, what: verb + iraLabel(value) }),
  };
}

/**
 * Mark the packet returned or not. ADMIN ONLY: the route checks that before
 * it calls this, and the generic employee update cannot reach `ira` at all.
 * Marking it returned also clears changed_after_packet, because the new
 * paperwork is now in hand.
 */
export function markPacket(employee, returned, { by, now } = {}) {
  const current = (employee && employee.ira) || {};
  const at = now || new Date().toISOString();
  const who = String(by || "").toLowerCase() || null;
  const yes = returned === true;
  return {
    ...current,
    packet_returned: yes,
    packet_at: yes ? at : null,
    packet_by: yes ? who : null,
    changed_after_packet: false,
    history: pushHistory(current.history, { at, by: who, what: yes ? "Packet marked returned" : "Packet marked not returned" }),
  };
}

/* ---- words the screen and tests share ----------------------------------- */

/** "3% of each paycheck", "$50.00 per paycheck", or "". */
export function contributionLabel(ira) {
  if (!ira || iraStatus(ira) !== "enrolled" || ira.contribution == null) return "";
  if (ira.contribution_type === "percent") return fmtNumber(Number(ira.contribution)) + "% of each paycheck";
  if (ira.contribution_type === "dollars") return fmtDollars(ira.contribution) + " per paycheck";
  return "";
}

/** "Enrolled, 3% of each paycheck", "Declined", "Not chosen yet". */
export function iraLabel(ira) {
  const s = iraStatus(ira);
  const amt = contributionLabel(ira);
  return IRA_STATUS_LABELS[s] + (amt ? ", " + amt : "");
}

/**
 * Does Ryan still need paperwork from this person? Enrolled with no packet
 * back yet, or any change made after the packet came back.
 */
export function packetOutstanding(ira) {
  if (!ira) return false;
  if (ira.changed_after_packet) return true;
  return iraStatus(ira) === "enrolled" && !ira.packet_returned;
}

/** One line about the packet, for the employee and the admin alike. */
export function packetLabel(ira) {
  const s = iraStatus(ira);
  if (ira && ira.changed_after_packet) return "Choice changed after the packet came in. A new packet may be needed.";
  if (s === "enrolled") return ira.packet_returned ? "Packet turned in." : "Packet not turned in yet.";
  if (s === "declined") return "No packet needed.";
  return "";
}

/**
 * The notification approvers get. Deliberately says NOTHING about the
 * person or their choice: notifications are visible to everyone signed in
 * (team visibility), and whether a coworker enrolled or declined a
 * retirement plan is theirs to share, not the shop's. The name and the
 * choice live on the IRA sign-up sheet, which only CrewCore admins can open.
 * `name` and `changed` are still accepted so callers need not change, and
 * are used only to decide whether a packet is involved.
 */
export function iraNoticeText(name, ira, { changed = false } = {}) {
  const s = iraStatus(ira);
  const packet = s === "enrolled" || !!(ira && ira.changed_after_packet);
  const title = "IRA sign-up: a choice to review" + (packet ? ", packet to collect" : "");
  const detail = "Someone " + (changed ? "changed" : "made") + " their IRA choice. " +
    "Open CrewCore, then the IRA sign-up card on the Dashboard, to see who" +
    (packet ? " and mark their packet returned once you have it." : ".");
  return { title: title.slice(0, 200), detail };
}

/* ---- the admin sign-up sheet ------------------------------------------- */

/**
 * Counts and one row per current employee. Terminated people are left out.
 * Undecided is anybody with no choice on file.
 */
export function iraSummary(employees) {
  const rows = (Array.isArray(employees) ? employees : [])
    .filter((e) => e && e.status !== "terminated")
    .map((e) => {
      const ira = e.ira || null;
      const status = iraStatus(ira);
      const last = [ira && ira.elected_at, ira && ira.packet_at].filter(Boolean).sort().pop() || null;
      return {
        id: e.id,
        name: e.name || "",
        department: e.department || "",
        status,
        status_label: IRA_STATUS_LABELS[status],
        contribution_type: ira ? ira.contribution_type || null : null,
        contribution: ira && ira.contribution != null ? ira.contribution : null,
        contribution_label: contributionLabel(ira),
        start_date: ira ? ira.start_date || null : null,
        packet_returned: !!(ira && ira.packet_returned),
        changed_after_packet: !!(ira && ira.changed_after_packet),
        packet_outstanding: packetOutstanding(ira),
        last_changed: last,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const counts = { total: rows.length, enrolled: 0, declined: 0, undecided: 0, packet_outstanding: 0 };
  rows.forEach((r) => {
    counts[r.status] += 1;
    if (r.packet_outstanding) counts.packet_outstanding += 1;
  });
  return { counts, rows };
}

/** The sign-up sheet as CSV text, so the export and the tests agree. */
export function iraSummaryCsv(summary) {
  const cell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [["Name", "Department", "IRA", "Contribution", "Start date", "Packet returned", "Packet to collect", "Last changed"].map(cell).join(",")];
  ((summary && summary.rows) || []).forEach((r) => {
    lines.push([
      r.name, r.department, r.status_label, r.contribution_label, r.start_date || "",
      r.packet_returned ? "Yes" : "No", r.packet_outstanding ? "Yes" : "No",
      r.last_changed ? String(r.last_changed).slice(0, 10) : "",
    ].map(cell).join(","));
  });
  return lines.join("\n");
}
