// lib/crewcore/schema.js — CrewCore data schema (v2).
//
// CrewCore is a fresh build, not a port: there was no standalone app, only
// the P&M internal Wix site (Company Structure, Contact List, New Hire
// Onboarding) as prior art. The Wix org chart shaped the department/role
// fields below; the Contact List's 14 names seeded the roster on first
// deploy (see lib/crewcore/store.js seedFromContactList).
//
// SELF-SERVE, decided Aug 3 2026: employees log in and see their OWN record
// and their OWN review history. Hourly rate and notes stay admin/superuser
// only — the API layer (api/crewcore/*.js) is where that split is actually
// enforced, not here. This file only shapes and validates records.
//
// v2, Aug 2026: PTO REMOVED from this app. Ryan's call — PTO tracking stays
// in QuickBooks for now, not duplicated here. validatePtoRequest/
// validatePtoStatus/PTO_TYPES/PTO_STATUSES stay in this file as dead code
// (unused by any route or UI) rather than being deleted outright, in case
// that decision gets revisited. pto_days_per_year was removed from the
// employee record entirely, not just left unused, since it was never
// anything but a PTO input.
//
// v2 also adds APPAREL STIPEND TRACKING: an annual allotment per employee
// plus a spend log, not just a static number — see "Stipend spend log"
// below. Sourced from the real Employee_Handbook.docx (uploaded Aug 2026),
// not the Wix site's Handbook page, which turned out to be stale — the docx
// has no dollar figure in its Dress Code section at all; the $250/$150
// split below is Ryan's explicit call to keep the pre-existing amounts.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "crewcore_data";

export const keys = {
  employee:       (id) => `${KEY_PREFIX}:employee:${id}`,
  employeeIndex:  () => `${KEY_PREFIX}:employee_index`,
  stipendSpend:   (id) => `${KEY_PREFIX}:stipend_spend:${id}`,
  stipendIndex:   () => `${KEY_PREFIX}:stipend_index`,
  review:         (id) => `${KEY_PREFIX}:review:${id}`,
  reviewIndex:    () => `${KEY_PREFIX}:review_index`,
  settings:       () => `${KEY_PREFIX}:settings`,
};

function norm(u) {
  return String(u || "").trim().toLowerCase();
}

// ---- Enumerations (single source of truth) --------------------------------

// Departments straight off the Wix Company Structure page's org chart
// (Screen Printing, Embroidery, Sales, Art) plus Office for bookkeeping/admin
// roles that chart didn't have its own branch for.
export const DEPARTMENTS = ["Screen Printing", "Embroidery", "Sales", "Art", "Office"];

export const EMPLOYMENT_STATUSES = ["active", "on_leave", "terminated"];

// Kept for schema/back-compat only — see the v2 comment above. Nothing in
// api/crewcore/*.js or apps/crewcore.js references these anymore.
export const PTO_TYPES = ["vacation", "sick", "personal", "unpaid"];
export const PTO_STATUSES = ["pending", "approved", "denied", "cancelled"];

// Front Office vs Production, per the Handbook's Dress Code policy. Sales
// and Office are the shop's front-office-facing departments; Screen
// Printing, Embroidery, and Art are production.
const FRONT_OFFICE_DEPARTMENTS = ["Sales", "Office"];

export const DEFAULT_STIPEND_FRONT_OFFICE = 250;
export const DEFAULT_STIPEND_PRODUCTION = 150;

export function defaultStipendFor(department) {
  return FRONT_OFFICE_DEPARTMENTS.includes(department)
    ? DEFAULT_STIPEND_FRONT_OFFICE
    : DEFAULT_STIPEND_PRODUCTION;
}

export const STIPEND_CATEGORIES = ["apparel", "other"];

// ---- ID generation ---------------------------------------------------------
// Same scheme as TravelTrack: max existing numeric suffix + 1, off the index.
// Fine at this scale — worst case on a simultaneous double-submit is a
// skipped number, never a collision.
export function nextId(prefix, existingIds) {
  let max = 0;
  (existingIds || []).forEach((id) => {
    const m = /^[A-Z]+-(\d+)$/.exec(String(id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${String(max + 1).padStart(5, "0")}`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---- Employees --------------------------------------------------------------
// The employee record is the sensitive one: hourly_rate lives here.
// validateEmployee() is used for BOTH the admin-facing full edit and (with a
// narrower field allowlist enforced in the API layer, not here) the
// self-serve profile view.

export function validateEmployee(input, { partial = false, id = null } = {}) {
  const errors = [];
  const rec = {};

  const need = (field, label) => {
    if (!partial && (input[field] === undefined || input[field] === "" || input[field] == null)) {
      errors.push(`${label} is required`);
      return false;
    }
    return true;
  };

  if (need("name", "Name")) rec.name = String(input.name || "").trim();

  // Optional link to a shell login (lib/users.js username). Not every
  // employee has a login (some production staff never touch the shell), so
  // this is nullable rather than required.
  if (input.username !== undefined) {
    rec.username = input.username ? norm(input.username) : null;
  } else if (!partial) {
    rec.username = null;
  }

  // Who this person reports to: another employee's id, or null for the
  // people at the top. Added Aug 2026 for Notifications' "My team" tab,
  // which needs to know whose work a manager is responsible for.
  //
  // Deliberately NOT derived from department. Departments describe what
  // somebody does; the shop has managers whose people span more than one
  // (production covers screen printing plus shipping and receiving) and
  // departments with nobody managing them. Guessing the org chart out of
  // the department column would be wrong for most of the roster.
  //
  // Self-reference is refused here rather than left to the UI: it would
  // make somebody their own report and put their own items on their own
  // team tab, which is a loop that reads as a bug from every direction.
  if (input.reports_to !== undefined) {
    const mgr = input.reports_to ? String(input.reports_to).trim() : "";
    const self = id || input.id || null;
    if (mgr && self && mgr === String(self)) {
      errors.push("an employee cannot report to themselves");
    } else {
      rec.reports_to = mgr || null;
    }
  } else if (!partial) {
    rec.reports_to = null;
  }

  if (input.department !== undefined) {
    if (input.department && !DEPARTMENTS.includes(input.department)) {
      errors.push(`department must be one of: ${DEPARTMENTS.join(", ")}`);
    } else {
      rec.department = input.department || "Office";
    }
  } else if (!partial) {
    rec.department = "Office";
  }

  if (input.title !== undefined) rec.title = String(input.title || "").trim();
  else if (!partial) rec.title = "";

  if (need("start_date", "Start date")) rec.start_date = String(input.start_date || "");

  if (input.status !== undefined) {
    if (!EMPLOYMENT_STATUSES.includes(input.status)) {
      errors.push(`status must be one of: ${EMPLOYMENT_STATUSES.join(", ")}`);
    } else {
      rec.status = input.status;
    }
  } else if (!partial) {
    rec.status = "active";
  }

  if (input.phone !== undefined) rec.phone = String(input.phone || "").trim();
  if (input.email !== undefined) rec.email = String(input.email || "").trim();

  // Sensitive figure. Only ever set by an admin-scope caller — the API
  // route strips this from any self-serve write before it reaches here.
  if (input.hourly_rate !== undefined) {
    const r = Number(input.hourly_rate);
    if (input.hourly_rate === "" || input.hourly_rate === null) rec.hourly_rate = null;
    else if (Number.isNaN(r) || r < 0) errors.push("hourly_rate must be a non-negative number");
    else rec.hourly_rate = round2(r);
  }

  // Annual apparel stipend ALLOTMENT for this employee. Defaults follow
  // department (see defaultStipendFor) but can be overridden per person. An
  // admin editing an existing employee who doesn't touch this field keeps
  // whatever was there; only a brand-new record with no explicit value
  // falls back to the department default, applied in the store layer
  // (saveEmployee), not here, since that default needs the
  // ALREADY-VALIDATED department value to pick from.
  if (input.apparel_stipend !== undefined) {
    const s = Number(input.apparel_stipend);
    if (input.apparel_stipend === "" || input.apparel_stipend === null) rec.apparel_stipend = null;
    else if (Number.isNaN(s) || s < 0) errors.push("apparel_stipend must be a non-negative number");
    else rec.apparel_stipend = round2(s);
  }

  if (input.notes !== undefined) rec.notes = String(input.notes || "").trim();

  // Time clock opt-in, Aug 2026. Defaults ON for a new record: the kiosk
  // replaced a system everyone was already punching into, so the useful
  // default is "on the clock" and the exceptions (salaried office staff who
  // do not punch) get switched off one at a time.
  //
  // The passcode itself is NOT set through here. It arrives as a plaintext
  // clock_pin on an admin request, gets hashed in api/crewcore/employees.js,
  // and is merged in as clock_pin_hash. Keeping it out of this function
  // means no path exists where a raw passcode could be written to the
  // record by a caller who just happened to include the field.
  if (input.clock_enabled !== undefined) {
    rec.clock_enabled = input.clock_enabled !== false;
  } else if (!partial) {
    rec.clock_enabled = true;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

/**
 * Validates a handbook acknowledgment write in isolation, rather than
 * routing it through validateEmployee(partial:true). The self-serve
 * acknowledgment endpoint (api/crewcore/handbook.js POST) should only ever
 * be able to write these two fields on the caller's OWN record — keeping
 * this separate means it can't smuggle a department/rate/notes change
 * through by including extra keys in the same request body, and the admin
 * Roster form never sees or sets these fields at all.
 *
 * handbook_ack_version pins WHICH version of the handbook was agreed to
 * (HANDBOOK_UPDATED at the moment of acknowledging), so a later content
 * edit can require a fresh acknowledgment without losing the record of the
 * old one.
 */
export function validateHandbookAck(currentVersion) {
  const version = String(currentVersion || "").trim();
  if (!version) return { ok: false, errors: ["No handbook version to acknowledge"] };
  return {
    ok: true,
    patch: {
      handbook_ack_version: version,
      handbook_ack_at: new Date().toISOString(),
    },
  };
}

/**
 * Strips fields a self-serve caller must never see or set, for both reads and
 * writes. This is the enforcement boundary the comment above promises — kept
 * here as one list so a route can't forget a field the way an inline filter
 * scattered across handlers could.
 *
 * apparel_stipend is deliberately NOT in this list. An employee can see
 * their OWN allotment and spend (it's their clothing budget), just not
 * anyone else's — the API layer enforces that by scope (own record vs. all
 * records), not by hiding the field.
 */
export const ADMIN_ONLY_FIELDS = ["hourly_rate", "notes"];

/**
 * Fields nobody gets back, not even an admin reading their own record. The
 * time clock passcode hash is the only member: it is a credential, and an
 * admin has no reason to read one (they can set a new one). Separate from
 * ADMIN_ONLY_FIELDS on purpose — that list is "sensitive, scoped by role,"
 * this one is "never leaves the server."
 */
export const SECRET_FIELDS = ["clock_pin_hash"];

export function stripSecrets(record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  SECRET_FIELDS.forEach((f) => { delete out[f]; });
  // Whether a passcode EXISTS is not itself a secret, and the roster needs
  // it to show who still has to be set up on the kiosk.
  out.has_clock_pin = !!record.clock_pin_hash;
  return out;
}

export function stripAdminFields(record) {
  if (!record || typeof record !== "object") return record;
  const out = stripSecrets({ ...record });
  ADMIN_ONLY_FIELDS.forEach((f) => { delete out[f]; });
  return out;
}

// ---- Stipend spend log -----------------------------------------------------
// The allotment lives on the employee record (apparel_stipend). This is the
// log of what's actually been drawn against it — an admin logs a purchase
// (a branded jacket, a pair of work boots, whatever counts under the dress
// code policy) and the running total nets against the allotment. An
// employee can see their own log and remaining balance, never anyone
// else's; only an admin can add or remove entries.

// ---- Stipend year math ---------------------------------------------------
//
// The allotment re-ups every Jan 1, so a stipend figure only means anything
// against a stated year. This math is shared by the store, the API route and
// the screen, the same way poHealth() is shared in PromoPro, so a balance is
// never computed twice in two places and left to drift apart.

/** The calendar year an entry falls in, or null if its date is unusable. */
export function spendYear(spend) {
  const y = parseInt(String((spend && spend.date) || "").slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

/**
 * Entries scoped to a person and/or a year. A null employeeId means everyone;
 * a null year means every year. An entry with an unusable date is excluded
 * from a year filter rather than silently counted into the current one.
 */
export function spendsFor(spends, employeeId, year) {
  let rows = Array.isArray(spends) ? spends.filter(Boolean) : [];
  if (employeeId) rows = rows.filter((s) => s.employee_id === employeeId);
  if (year != null) rows = rows.filter((s) => spendYear(s) === Number(year));
  return rows;
}

/**
 * Allotment, spend and what is left for one year. `over` is reported
 * separately rather than as a negative remaining, so a screen can show
 * "nothing left" and "went $40 past it" as the two different facts they are.
 */
export function stipendBalance(allotted, spends, year) {
  const a = Number(allotted) || 0;
  const used = spendsFor(spends, null, year)
    .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  return {
    year: Number(year),
    allotted: round2(a),
    used: round2(used),
    remaining: round2(Math.max(0, a - used)),
    over: round2(Math.max(0, used - a)),
  };
}

/**
 * Years worth offering in a picker: every year that has an entry, plus the
 * current one so a fresh January is selectable before anything is logged.
 */
export function stipendYears(spends, today = new Date()) {
  const years = new Set([today.getFullYear()]);
  (Array.isArray(spends) ? spends : []).forEach((s) => {
    const y = spendYear(s);
    if (y) years.add(y);
  });
  return Array.from(years).sort((a, b) => b - a);
}

export function validateStipendSpend(input, { partial = false } = {}) {
  const errors = [];
  const rec = {};

  if (!partial && !input.employee_id) errors.push("employee_id is required");
  else if (input.employee_id !== undefined) rec.employee_id = String(input.employee_id);

  if (input.date !== undefined) rec.date = String(input.date || "");
  else if (!partial) errors.push("date is required");

  if (input.amount !== undefined) {
    const a = Number(input.amount);
    if (Number.isNaN(a) || a <= 0) errors.push("amount must be a positive number");
    else rec.amount = round2(a);
  } else if (!partial) {
    errors.push("amount is required");
  }

  if (input.category !== undefined) {
    if (!STIPEND_CATEGORIES.includes(input.category)) {
      errors.push(`category must be one of: ${STIPEND_CATEGORIES.join(", ")}`);
    } else {
      rec.category = input.category;
    }
  } else if (!partial) {
    rec.category = "apparel";
  }

  if (input.description !== undefined) rec.description = String(input.description || "").trim();
  else if (!partial) rec.description = "";

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// ---- Reviews ------------------------------------------------------------
// One-on-one review history. Written by admin/manager only; the employee it
// is about can read their own, never anyone else's, and never write one.

export function validateReview(input, { partial = false } = {}) {
  const errors = [];
  const rec = {};

  if (!partial && !input.employee_id) errors.push("employee_id is required");
  else if (input.employee_id !== undefined) rec.employee_id = String(input.employee_id);

  if (!partial && !input.review_date) errors.push("review_date is required");
  else if (input.review_date !== undefined) rec.review_date = String(input.review_date || "");

  if (input.reviewer_name !== undefined) rec.reviewer_name = String(input.reviewer_name || "").trim();
  else if (!partial) errors.push("reviewer_name is required");

  if (input.summary !== undefined) rec.summary = String(input.summary || "").trim();
  else if (!partial) rec.summary = "";

  if (input.strengths !== undefined) rec.strengths = String(input.strengths || "").trim();
  if (input.growth_areas !== undefined) rec.growth_areas = String(input.growth_areas || "").trim();
  if (input.next_review_date !== undefined) rec.next_review_date = String(input.next_review_date || "");

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// ---- Kept for schema compatibility (PTO removed from the app surface) -----
// See the v2 comment at the top of this file. Not imported by any route or
// UI file as of this version.

export function validatePtoRequest(input, { partial = false } = {}) {
  const errors = [];
  const rec = {};

  if (need_(input, "start_date", partial)) rec.start_date = String(input.start_date || "");
  if (input.end_date !== undefined) rec.end_date = String(input.end_date || "");
  else if (!partial) rec.end_date = rec.start_date;

  if (rec.start_date && rec.end_date && rec.end_date < rec.start_date) {
    errors.push("End date can't be before the start date");
  }

  if (input.type !== undefined) {
    if (!PTO_TYPES.includes(input.type)) {
      errors.push(`type must be one of: ${PTO_TYPES.join(", ")}`);
    } else {
      rec.type = input.type;
    }
  } else if (!partial) {
    rec.type = "vacation";
  }

  if (input.days !== undefined) {
    const d = Number(input.days);
    if (Number.isNaN(d) || d <= 0) errors.push("days must be a positive number");
    else rec.days = round2(d);
  } else if (!partial) {
    errors.push("days is required");
  }

  if (input.note !== undefined) rec.note = String(input.note || "").trim();

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

function need_(input, field, partial) {
  if (!partial && (input[field] === undefined || input[field] === "" || input[field] == null)) {
    return false;
  }
  return true;
}

export function validatePtoStatus(status) {
  return PTO_STATUSES.includes(status);
}

// ---- Settings ------------------------------------------------------------

export function validateSettings(input) {
  const errors = [];
  const rec = {};

  if (input.default_stipend_front_office !== undefined) {
    const v = Number(input.default_stipend_front_office);
    if (Number.isNaN(v) || v < 0) errors.push("default_stipend_front_office must be a non-negative number");
    else rec.default_stipend_front_office = round2(v);
  }

  if (input.default_stipend_production !== undefined) {
    const v = Number(input.default_stipend_production);
    if (Number.isNaN(v) || v < 0) errors.push("default_stipend_production must be a non-negative number");
    else rec.default_stipend_production = round2(v);
  }

  if (input.self_serve_enabled !== undefined) {
    rec.self_serve_enabled = input.self_serve_enabled !== false;
  }

  // ---- Time clock, Aug 2026 ----------------------------------------------

  // Master switch for the public kiosk. Off means api/crewcore/clock.js
  // stops answering entirely — the one lever that shuts the public surface
  // without a deploy.
  if (input.clock_enabled !== undefined) {
    rec.clock_enabled = input.clock_enabled !== false;
  }

  // 0 = Sunday. Which day the pay week starts on drives every total on the
  // Time Clock screen, so it is a setting rather than a constant.
  if (input.week_start_day !== undefined) {
    const d = Number(input.week_start_day);
    if (!Number.isInteger(d) || d < 0 || d > 6) errors.push("week_start_day must be 0 (Sunday) through 6 (Saturday)");
    else rec.week_start_day = d;
  }

  if (input.overtime_after_hours !== undefined) {
    const v = Number(input.overtime_after_hours);
    if (Number.isNaN(v) || v < 0) errors.push("overtime_after_hours must be a non-negative number");
    else rec.overtime_after_hours = v;
  }

  // Rounding applied to TOTALS on the reporting side only. Stored punch
  // times are never rounded — see roundHours() in lib/crewcore/timeclock.js
  // for why that split matters. 0 means exact.
  if (input.clock_round_minutes !== undefined) {
    const v = Number(input.clock_round_minutes);
    if (![0, 5, 6, 10, 15].includes(v)) errors.push("clock_round_minutes must be 0, 5, 6, 10, or 15");
    else rec.clock_round_minutes = v;
  }

  // Optional shared word appended to the kiosk URL. Empty means the kiosk
  // page is reachable by anyone with the link, which is the default because
  // the passcode is the real gate and a token in a bookmark on a shop
  // tablet is not much of a secret. Setting one keeps the employee name
  // list off the open internet for anyone who guesses the URL.
  if (input.clock_kiosk_token !== undefined) {
    rec.clock_kiosk_token = String(input.clock_kiosk_token || "").trim().slice(0, 60);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: rec };
}

export function defaultSettings() {
  return {
    default_stipend_front_office: DEFAULT_STIPEND_FRONT_OFFICE,
    default_stipend_production: DEFAULT_STIPEND_PRODUCTION,
    // Master switch, checked alongside per-role access. Off would fall back
    // employees to "no self-serve view, admin enters everything" without a
    // deploy — matches the "configurable over hardcoded" rule.
    self_serve_enabled: true,

    // Time clock. On by default because it shipped as a replacement for a
    // system the shop was already using, not as an optional extra.
    clock_enabled: true,
    week_start_day: 0,          // Sunday
    overtime_after_hours: 40,
    clock_round_minutes: 0,     // exact, no rounding
    clock_kiosk_token: "",
  };
}
