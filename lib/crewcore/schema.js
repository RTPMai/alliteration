// lib/crewcore/schema.js — CrewCore data schema (v1).
//
// CrewCore is a fresh build, not a port: there was no standalone app, only
// the P&M internal Wix site (Company Structure, Contact List, New Hire
// Onboarding) as prior art. The Wix org chart shaped the department/role
// fields below; the Contact List's 14 names seeded the roster on first
// deploy (see lib/crewcore/store.js seedFromContactList).
//
// SELF-SERVE, decided Aug 3 2026: employees log in and see their OWN record,
// their OWN PTO balance/requests, and their OWN review history. Hourly rate,
// stipend, and other employees' anything stay admin/superuser only — the API
// layer (api/crewcore/*.js) is where that split is actually enforced, not
// here. This file only shapes and validates records.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "crewcore_data";

export const keys = {
  employee:       (id) => `${KEY_PREFIX}:employee:${id}`,
  employeeIndex:  () => `${KEY_PREFIX}:employee_index`,
  ptoRequest:     (id) => `${KEY_PREFIX}:pto_request:${id}`,
  ptoIndex:       () => `${KEY_PREFIX}:pto_index`,
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

export const PTO_TYPES = ["vacation", "sick", "personal", "unpaid"];

export const PTO_STATUSES = ["pending", "approved", "denied", "cancelled"];

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
// The employee record is the sensitive one: hourly_rate and stipend live
// here. validateEmployee() is used for BOTH the admin-facing full edit and
// (with a narrower field allowlist enforced in the API layer, not here) the
// self-serve profile view, which never even receives these fields from the
// server in the first place — see api/crewcore/employees.js selfView().

export function validateEmployee(input, { partial = false } = {}) {
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

  // Sensitive figures. Only ever set by an admin-scope caller — the API
  // route strips these from any self-serve write before it reaches here.
  if (input.hourly_rate !== undefined) {
    const r = Number(input.hourly_rate);
    if (input.hourly_rate === "" || input.hourly_rate === null) rec.hourly_rate = null;
    else if (Number.isNaN(r) || r < 0) errors.push("hourly_rate must be a non-negative number");
    else rec.hourly_rate = round2(r);
  }

  if (input.apparel_stipend !== undefined) {
    const s = Number(input.apparel_stipend);
    if (input.apparel_stipend === "" || input.apparel_stipend === null) rec.apparel_stipend = 0;
    else if (Number.isNaN(s) || s < 0) errors.push("apparel_stipend must be a non-negative number");
    else rec.apparel_stipend = round2(s);
  } else if (!partial) {
    rec.apparel_stipend = 0;
  }

  // Annual PTO allotment in days, used to seed a year's balance. Configurable
  // per employee rather than one shop-wide number, since tenure and role vary
  // (matches the "configurable over hardcoded" rule from the other apps).
  if (input.pto_days_per_year !== undefined) {
    const d = Number(input.pto_days_per_year);
    if (input.pto_days_per_year === "" || input.pto_days_per_year === null) rec.pto_days_per_year = 0;
    else if (Number.isNaN(d) || d < 0) errors.push("pto_days_per_year must be a non-negative number");
    else rec.pto_days_per_year = round2(d);
  } else if (!partial) {
    rec.pto_days_per_year = 0;
  }

  if (input.notes !== undefined) rec.notes = String(input.notes || "").trim();

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

/**
 * Strips fields a self-serve caller must never see or set, for both reads and
 * writes. This is the enforcement boundary the comment above promises — kept
 * here as one list so a route can't forget a field the way an inline filter
 * scattered across handlers could.
 */
export const ADMIN_ONLY_FIELDS = ["hourly_rate", "apparel_stipend", "notes"];

export function stripAdminFields(record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  ADMIN_ONLY_FIELDS.forEach((f) => { delete out[f]; });
  return out;
}

// ---- PTO requests -----------------------------------------------------------

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

// ---- Settings ------------------------------------------------------------

export function validateSettings(input) {
  const errors = [];
  const rec = {};

  if (input.default_pto_days !== undefined) {
    const d = Number(input.default_pto_days);
    if (Number.isNaN(d) || d < 0) errors.push("default_pto_days must be a non-negative number");
    else rec.default_pto_days = round2(d);
  }

  if (input.self_serve_enabled !== undefined) {
    rec.self_serve_enabled = input.self_serve_enabled !== false;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: rec };
}

export function defaultSettings() {
  return {
    default_pto_days: 10,
    // Master switch, checked alongside per-role access. Off would fall back
    // employees to "no self-serve view, admin enters everything" without a
    // deploy — matches the "configurable over hardcoded" rule.
    self_serve_enabled: true,
  };
}
