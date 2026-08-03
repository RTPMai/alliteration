// lib/traveltrack/schema.js — TravelTrack data schema (v1).
//
// TravelTrack runs on Base44 in the standalone world. There is no api/ to
// point at, so this is a REBUILD, not a port: the shapes below come from
// what the Base44 app's page list implies (Trips, Expenses, Redeem Miles,
// Reports, Org Settings, Account Settings), not from any inherited file.
//
// Everyone with the app grants their own trips and expenses (data_scope
// "own" in lib/users.js — the "am" role has this today). Admin/manager
// (data_scope "all") see the whole team's, approve/reject/reimburse
// expenses, and edit Org Settings. Scoping is enforced in the API layer,
// not here — this file only shapes and validates records.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "traveltrack_data";

export const keys = {
  trip:            (id) => `${KEY_PREFIX}:trip:${id}`,
  tripIndex:       () => `${KEY_PREFIX}:trip_index`,
  expense:         (id) => `${KEY_PREFIX}:expense:${id}`,
  expenseIndex:    () => `${KEY_PREFIX}:expense_index`,
  orgSettings:     () => `${KEY_PREFIX}:org_settings`,
  accountSettings: (username) => `${KEY_PREFIX}:account_settings:${norm(username)}`,
};

function norm(u) {
  return String(u || "").trim().toLowerCase();
}

// ---- Enumerations (single source of truth) ----

// Ryan's status set, matching how the shop actually talks about a trip:
// it starts as a maybe, gets committed to, then either happened or didn't.
// "cancelled" is distinct from "did_not_attend" — the event was called off
// vs. we chose not to go.
export const TRIP_STATUSES = ["potential", "confirmed", "attended", "did_not_attend", "cancelled"];

// The first build used planned/in_progress/completed. Existing records (and
// the import mappers) still carry those, so normalize on read/write rather
// than migrating the stored data — an old value must never fail validation
// and strand a record as uneditable.
const LEGACY_TRIP_STATUS = {
  planned: "potential",
  in_progress: "confirmed",
  completed: "attended",
};

export function normalizeTripStatus(status) {
  const s = String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (TRIP_STATUSES.includes(s)) return s;
  if (LEGACY_TRIP_STATUS[s]) return LEGACY_TRIP_STATUS[s];
  return null;
}

export const TRIP_PURPOSES = [
  "Client visit", "Trade show", "Sales call", "Training/conference",
  "Vendor visit", "Other",
];

export const EXPENSE_CATEGORIES = [
  "Airfare", "Lodging", "Meals", "Mileage", "Rental Car",
  "Parking & Tolls", "Rideshare/Taxi", "Registration/Fees", "Other",
];

// A category the mileage rate applies to, so the form and the API agree on
// when "miles x rate" governs the amount instead of a typed dollar figure.
export const MILEAGE_CATEGORY = "Mileage";

export const PAYMENT_METHODS = ["company_card", "personal_reimburse"];

export const EXPENSE_STATUSES = ["pending", "approved", "rejected", "reimbursed"];

// Default IRS-style business mileage rate. Configurable in Org Settings —
// never hardcoded into a form or a calculation past this seed value.
export const DEFAULT_MILEAGE_RATE = 0.67;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---- ID generation -----------------------------------------------------
// No atomic INCR here (this store rides lib/kv.js's plain GET/SET, not a
// pipeline). Scale is a handful of employees logging trips, so "max existing
// numeric suffix + 1" from the index is safe enough — a genuine simultaneous
// double-submit is a non-event: worst case is a skipped number, never a
// collision, because the suffix search always looks at the freshly-read index.
export function nextId(prefix, existingIds) {
  let max = 0;
  (existingIds || []).forEach((id) => {
    const m = /^[A-Z]+-(\d+)$/.exec(String(id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${String(max + 1).padStart(5, "0")}`;
}

// ---- Trips ---------------------------------------------------------------

export function validateTrip(input, { partial = false } = {}) {
  const errors = [];
  const rec = {};

  const need = (field, label) => {
    if (!partial && (input[field] === undefined || input[field] === "" || input[field] == null)) {
      errors.push(`${label} is required`);
      return false;
    }
    return true;
  };

  if (need("title", "Title")) rec.title = String(input.title || "").trim();
  if (input.destination !== undefined) rec.destination = String(input.destination || "").trim();
  else if (!partial) errors.push("Destination is required");

  if (input.purpose !== undefined) {
    if (input.purpose && !TRIP_PURPOSES.includes(input.purpose)) {
      errors.push(`purpose must be one of: ${TRIP_PURPOSES.join(", ")}`);
    } else {
      rec.purpose = input.purpose || "Other";
    }
  } else if (!partial) {
    rec.purpose = "Other";
  }

  if (need("start_date", "Start date")) rec.start_date = String(input.start_date || "");
  if (input.end_date !== undefined) rec.end_date = String(input.end_date || "");
  else if (!partial) rec.end_date = rec.start_date;

  if (rec.start_date && rec.end_date && rec.end_date < rec.start_date) {
    errors.push("End date can't be before the start date");
  }

  if (input.status !== undefined) {
    const s = normalizeTripStatus(input.status);
    if (!s) {
      errors.push(`status must be one of: ${TRIP_STATUSES.join(", ")}`);
    } else {
      rec.status = s;
    }
  } else if (!partial) {
    rec.status = "potential";
  }

  // Team members on the trip. Stored as a plain array of display names —
  // the shop's trips include people who may not have shell logins (and the
  // standalone export carried names, not usernames), so this deliberately
  // does NOT require a user record to exist. trip.traveler stays the single
  // owning username for permission checks; attendees is who actually went.
  if (input.attendees !== undefined) {
    let list = input.attendees;
    if (typeof list === "string") list = list.split(/[;,]/);
    if (!Array.isArray(list)) {
      errors.push("attendees must be a list of names");
    } else {
      const names = list.map((n) => String(n || "").trim()).filter(Boolean);
      // De-duplicate case-insensitively, keeping first-seen spelling.
      const seen = new Set();
      rec.attendees = names.filter((n) => {
        const k = n.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  } else if (!partial) {
    rec.attendees = [];
  }

  if (input.notes !== undefined) rec.notes = String(input.notes || "").trim();

  // Dollar credit from redeemed loyalty miles applied against this trip's
  // spend (mirrors the standalone app's per-trip "Miles Redeemed" figure,
  // shown netted against Total Spent as "Net Cost"). Not linked to a
  // specific lib/traveltrack loyalty account — just a manual dollar credit.
  if (input.miles_value !== undefined) {
    const v = Number(input.miles_value);
    if (input.miles_value === "" || input.miles_value === null) rec.miles_value = 0;
    else if (Number.isNaN(v) || v < 0) errors.push("miles_value must be a non-negative number");
    else rec.miles_value = Math.round(v * 100) / 100;
  } else if (!partial) {
    rec.miles_value = 0;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// ---- Expenses --------------------------------------------------------------
// mileageRate is passed in from Org Settings so amount = miles x rate is
// computed here, in one place, rather than trusted from the client for
// Mileage-category expenses. A typed amount always wins for every other
// category.

export function validateExpense(input, { partial = false, mileageRate = DEFAULT_MILEAGE_RATE } = {}) {
  const errors = [];
  const rec = {};

  if (input.trip_id !== undefined) rec.trip_id = input.trip_id ? String(input.trip_id) : null;

  if (input.date !== undefined) rec.date = String(input.date || "");
  else if (!partial) errors.push("Date is required");

  if (input.category !== undefined) {
    if (!EXPENSE_CATEGORIES.includes(input.category)) {
      errors.push(`category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`);
    } else {
      rec.category = input.category;
    }
  } else if (!partial) {
    errors.push("Category is required");
  }

  const category = rec.category !== undefined ? rec.category : input._existingCategory;

  if (category === MILEAGE_CATEGORY) {
    const miles = Number(input.miles);
    if (input.miles !== undefined) {
      if (Number.isNaN(miles) || miles < 0) errors.push("miles must be a non-negative number");
      else {
        rec.miles = miles;
        rec.amount = round2(miles * mileageRate);
      }
    } else if (!partial) {
      errors.push("Miles is required for a mileage expense");
    }
  } else if (input.amount !== undefined) {
    const amount = Number(input.amount);
    if (Number.isNaN(amount) || amount < 0) errors.push("amount must be a non-negative number");
    else rec.amount = round2(amount);
    // A record that switches OFF Mileage should drop any stale miles figure.
    if (category !== undefined) rec.miles = null;
  } else if (!partial) {
    errors.push("Amount is required");
  }

  if (input.description !== undefined) rec.description = String(input.description || "").trim();
  else if (!partial) rec.description = "";

  if (input.payment_method !== undefined) {
    if (!PAYMENT_METHODS.includes(input.payment_method)) {
      errors.push(`payment_method must be one of: ${PAYMENT_METHODS.join(", ")}`);
    } else {
      rec.payment_method = input.payment_method;
    }
  } else if (!partial) {
    rec.payment_method = "personal_reimburse";
  }

  if (input.notes !== undefined) rec.notes = String(input.notes || "").trim();

  // Uploaded receipt image, stored in Vercel Blob (api/traveltrack/receipt.js
  // does the upload and returns the URL). Kept as a plain URL string so the
  // expense record stays small; an empty string clears it.
  if (input.receipt_url !== undefined) {
    const u = String(input.receipt_url || "").trim();
    if (u && !/^https?:\/\//i.test(u)) errors.push("receipt_url must be an http(s) URL");
    else rec.receipt_url = u;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// Status transitions an approver may make. Anyone can create a "pending"
// expense; only the STATUS field itself is gated by role in the API layer.
export function validateStatus(status) {
  return EXPENSE_STATUSES.includes(status);
}

// ---- Redeem Miles ---------------------------------------------------------
// Not a loyalty-account entity — Ryan's org tracks this the way the
// standalone app did: a single running dollar total PER TRIP ("Amount Paid
// So Far" there; trip.miles_value here), incremented each time someone logs
// a redemption. No accounts, no balances, no program numbers.
//
// The standalone kept only the cumulative total with no per-redemption
// history. This rebuild keeps a lightweight log (date/amount/note/who)
// alongside that same running total, so nothing is lost if a history view
// is wanted later — but every display surface (trip card, dashboard, CSV)
// only ever shows the cumulative total, matching the original behavior.

export function validateMilesRedemption(input) {
  const errors = [];
  const rec = {};

  const amount = Number(input.amount);
  if (Number.isNaN(amount) || amount <= 0) errors.push("amount must be a positive number");
  else rec.amount = round2(amount);

  if (input.note !== undefined) rec.note = String(input.note || "").trim();

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

// ---- Org settings ------------------------------------------------------

export function validateOrgSettings(input) {
  const errors = [];
  const rec = {};

  if (input.mileage_rate !== undefined) {
    const r = Number(input.mileage_rate);
    if (Number.isNaN(r) || r < 0) errors.push("mileage_rate must be a non-negative number");
    else rec.mileage_rate = round2(r);
  }

  if (input.per_diem_rate !== undefined) {
    const r = Number(input.per_diem_rate);
    if (Number.isNaN(r) || r < 0) errors.push("per_diem_rate must be a non-negative number");
    else rec.per_diem_rate = round2(r);
  }

  if (input.approval_threshold !== undefined) {
    const r = Number(input.approval_threshold);
    if (Number.isNaN(r) || r < 0) errors.push("approval_threshold must be a non-negative number");
    else rec.approval_threshold = round2(r);
  }

  if (input.policy_notes !== undefined) rec.policy_notes = String(input.policy_notes || "").trim();

  // Customizable per org — some shops call this "Points", "Rewards", etc.
  // Defaults to "Miles / Rewards", matching the standalone's default.
  if (input.redemption_label !== undefined) {
    const label = String(input.redemption_label || "").trim();
    rec.redemption_label = label || "Miles / Rewards";
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: rec };
}

export function defaultOrgSettings() {
  return {
    mileage_rate: DEFAULT_MILEAGE_RATE,
    per_diem_rate: 0,
    approval_threshold: 500,
    policy_notes: "",
    redemption_label: "Miles / Rewards",
  };
}

// ---- Account (personal) settings ---------------------------------------

export function validateAccountSettings(input) {
  const errors = [];
  const rec = {};

  if (input.home_airport !== undefined) {
    rec.home_airport = String(input.home_airport || "").trim().toUpperCase().slice(0, 4);
  }
  if (input.default_payment_method !== undefined) {
    if (input.default_payment_method && !PAYMENT_METHODS.includes(input.default_payment_method)) {
      errors.push(`default_payment_method must be one of: ${PAYMENT_METHODS.join(", ")}`);
    } else {
      rec.default_payment_method = input.default_payment_method || "personal_reimburse";
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: rec };
}

export function defaultAccountSettings(username) {
  return {
    username: norm(username),
    home_airport: "",
    default_payment_method: "personal_reimburse",
  };
}
