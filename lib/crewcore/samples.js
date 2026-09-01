// lib/crewcore/samples.js — SanMar sample drops: shapes, rules, export.
//
// Twice a year SanMar offers discounted samples off the New Arrivals catalog.
// The old process was everyone telling Ryan what they wanted and Ryan
// retyping it into a spreadsheet to send back. This replaces the retyping.
//
// A DROP is one season ("Fall 2026"). Its catalog is imported once from
// SanMar's feed. Everyone then makes PICKS off that catalog.
//
// A pick draws down that person's apparel stipend AT PICK TIME, not on
// receipt (Ryan, Aug 2026). That is why the remaining balance is the thing
// somebody sees while they are choosing: the moment of the decision is the
// moment the money is spoken for. Practically it also means a pick and its
// stipend entry are one action, so they cannot drift apart.
//
// Pricing lives in ./sanmar.js and is server-side only. Nothing a browser
// sends can put its own figure on a vendor sheet or on a stipend.
//
// ESM. Do NOT convert to module.exports.

import { normSize } from "./sanmar.js";

export const SAMPLES_PREFIX = "crewcore_data";

export const sampleKeys = {
  drop:        (id) => `${SAMPLES_PREFIX}:sample_drop:${id}`,
  dropIndex:   () => `${SAMPLES_PREFIX}:sample_drop_index`,
  // One key per style rather than one big catalog blob. PC61 alone returns
  // 558 rows across 62 colours; 138 styles in one value would be megabytes
  // read on every screen load. The drop carries summaries, the detail loads
  // when somebody opens a style.
  style:       (dropId, style) => `${SAMPLES_PREFIX}:sample_style:${dropId}:${String(style).toUpperCase()}`,
  pick:        (id) => `${SAMPLES_PREFIX}:sample_pick:${id}`,
  pickIndex:   () => `${SAMPLES_PREFIX}:sample_pick_index`,
};

export const DROP_STATUSES = ["open", "closed"];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function trimStr(v, max = 200) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

// ---- Drops ----------------------------------------------------------------

export function validateDrop(input, { partial = false } = {}) {
  const errors = [];
  const rec = {};

  if (input.name !== undefined) {
    const name = trimStr(input.name, 80);
    if (!name) errors.push("name is required");
    else rec.name = name;
  } else if (!partial) {
    errors.push("name is required");
  }

  if (input.due_date !== undefined) {
    const d = trimStr(input.due_date, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push("due_date must be YYYY-MM-DD");
    else rec.due_date = d;
  } else if (!partial) {
    rec.due_date = "";
  }

  if (input.notes !== undefined) rec.notes = trimStr(input.notes, 500);
  else if (!partial) rec.notes = "";

  if (input.status !== undefined) {
    if (!DROP_STATUSES.includes(input.status)) {
      errors.push(`status must be one of: ${DROP_STATUSES.join(", ")}`);
    } else {
      rec.status = input.status;
    }
  } else if (!partial) {
    rec.status = "open";
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, record: rec };
}

/** A drop that is closed takes no new picks. Reported as a reason rather than
 *  a bare false so the screen can say why the button did nothing. */
export function pickingClosed(drop) {
  if (!drop) return "That drop no longer exists.";
  if (drop.status === "closed") return `${drop.name} is closed for picks.`;
  return null;
}

// ---- Picks ----------------------------------------------------------------

/**
 * A pick, resolved against the imported catalog.
 *
 * The browser sends a style, a colour and a size. Everything else, including
 * every figure and every ordering key, is looked up here from what SanMar
 * actually said. A pick whose colour or size is not in the catalog is
 * refused, because a sheet that goes to a vendor cannot carry a garment they
 * do not sell.
 */
export function resolvePick(input, styleRecord) {
  const errors = [];
  if (!styleRecord) return { ok: false, errors: ["That style is not in this drop's catalog."] };

  const wantColor = trimStr(input.color, 80);
  const wantSize = normSize(input.size);
  if (!wantColor) errors.push("color is required");
  if (!wantSize) errors.push("size is required");
  if (errors.length) return { ok: false, errors };

  const color = styleRecord.colors.find(
    (c) => c.name.toLowerCase() === wantColor.toLowerCase() || c.code.toLowerCase() === wantColor.toLowerCase());
  if (!color) return { ok: false, errors: [`${styleRecord.style} does not come in ${wantColor}.`] };

  const size = color.sizes.find((s) => s.size === wantSize);
  if (!size) {
    return { ok: false, errors: [`${styleRecord.style} in ${color.name} does not come in ${wantSize}.`] };
  }

  if (size.price == null) {
    // A row with no usable case price is not priced at zero and quietly put
    // on somebody's stipend. It is refused and named.
    return { ok: false, errors: [`SanMar did not return a price for ${styleRecord.style} ${color.name} ${wantSize}.`] };
  }

  return {
    ok: true,
    record: {
      style: styleRecord.style,
      title: styleRecord.title,
      brand: styleRecord.brand,
      tier: styleRecord.tier,
      color: color.name,
      color_code: color.code,
      swatch: color.swatch,
      image: color.image || styleRecord.image,
      size: size.size,
      raw_size: size.raw_size,
      // Carried verbatim from the feed. See sanmar.js: the index scheme is
      // not consistent, so this pair is never recomputed.
      size_index: size.size_index,
      inventory_key: size.inventory_key,
      unique_key: size.unique_key,
      case_price: size.case_price,
      price: round2(size.price),
    },
  };
}

/**
 * The stipend entry a pick creates.
 *
 * The description is what shows in bold on the stipend log, so it names the
 * garment rather than the drop alone: a line reading "Fall 2026" three times
 * tells nobody which shirt was which.
 */
export function spendForPick(pick, drop, today = new Date()) {
  return {
    employee_id: pick.employee_id,
    date: today.toISOString().slice(0, 10),
    amount: round2(pick.price),
    category: "apparel",
    description: `${drop.name}: ${pick.style} ${pick.color} ${pick.size}`,
  };
}

// ---- The sheet that goes back to SanMar -----------------------------------

export const EXPORT_COLUMNS = [
  "Employee", "Style", "Product", "Color", "Size", "Qty", "Sample Price", "Total",
];

function csvCell(v) {
  const s = String(v == null ? "" : v);
  // A leading =, +, - or @ is executed as a formula by Excel when the file is
  // opened. Product titles are vendor-controlled text landing in a file Ryan
  // opens, so they get prefixed rather than trusted.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * The order sheet. One line per pick, grouped by person, then by style, so it
 * reads the way it gets filled: everything for one person together.
 *
 * Quantity is always 1. The same style can be picked more than once in a
 * different colour or size (Ryan: "They can get BP45 in one color and in
 * another, or in one size and another"), and those are separate garments, not
 * a quantity of two.
 */
export function buildExport(picks, nameFor) {
  const rows = [...picks].sort((a, b) => {
    const n = String(nameFor(a.employee_id) || "").localeCompare(String(nameFor(b.employee_id) || ""));
    if (n !== 0) return n;
    const s = String(a.style).localeCompare(String(b.style));
    return s !== 0 ? s : String(a.color).localeCompare(String(b.color));
  });

  const lines = [EXPORT_COLUMNS.join(",")];
  let total = 0;
  rows.forEach((p) => {
    const price = round2(p.price);
    total += price;
    lines.push([
      nameFor(p.employee_id) || "(unassigned)",
      p.style,
      p.title || "",
      p.color,
      // The size as SanMar spells it, not as we normalised it. The sheet goes
      // back to them, so it speaks their spelling.
      p.raw_size || p.size,
      1,
      price.toFixed(2),
      price.toFixed(2),
    ].map(csvCell).join(","));
  });

  return { csv: lines.join("\r\n") + "\r\n", rowCount: rows.length, total: round2(total) };
}

/** Per-person totals, for the screen and for a sanity check against the CSV. */
export function totalsByEmployee(picks) {
  const out = new Map();
  picks.forEach((p) => {
    const cur = out.get(p.employee_id) || { count: 0, total: 0 };
    cur.count += 1;
    cur.total = round2(cur.total + round2(p.price));
    out.set(p.employee_id, cur);
  });
  return out;
}
