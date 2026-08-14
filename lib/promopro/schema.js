// lib/promopro/schema.js — PromoPro schema.
//
// PromoPro owns the purchase order end to end: it builds the PO from a
// Printavo quote/invoice (or from nothing, for a manual web order), emails it
// to the vendor, and then tracks where that order sits until the goods are
// received.
//
// PO NUMBERING (Ryan's format, Aug 2026): year, Printavo invoice number,
// then an imprint/sequence suffix when a job has more than one PO.
//   26-66601      single PO on invoice 66601
//   26-66601-1    first of several on invoice 66601
//   26-66601-2    second
// A manual web order has no Printavo invoice, so it uses an M-sequence in the
// middle slot (26-M014) which makes it obvious at a glance that no Printavo
// job sits behind it. See buildPoNumber().
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "promopro_data";

export const keys = {
  record: (id) => `${KEY_PREFIX}:po:${id}`,
  index: () => `${KEY_PREFIX}:index`,
  manualCounter: (year) => `${KEY_PREFIX}:manualseq:${year}`,
  vendors: () => `${KEY_PREFIX}:vendors`,
  settings: () => `${KEY_PREFIX}:settings`,
};

/* ------------------------------------------------------------------ *
 * STAGES
 *
 * Ordered. Each stage names the date field that records when it was
 * reached, so "what stage is this" and "when did that happen" are never
 * two separate things that can disagree. A stage is reached when its date
 * is set, and currentStage() derives the stage from the dates rather than
 * storing a stage string that can drift out of sync with them.
 *
 * `owner` says who is expected to act. "us" stages are chase-able by us;
 * "vendor" stages mean we are waiting on them, which is what the overdue
 * alerts are really for.
 * ------------------------------------------------------------------ */
export const STAGES = [
  { key: "draft",       label: "Draft",        dateField: null,            owner: "us" },
  { key: "submitted",   label: "Submitted",    dateField: "submittedAt",   owner: "vendor" },
  { key: "confirmed",   label: "Confirmed",    dateField: "confirmedAt",   owner: "vendor" },
  { key: "art_sent",    label: "Art sent",     dateField: "artSentAt",     owner: "vendor" },
  { key: "art_approved",label: "Art approved", dateField: "artApprovedAt", owner: "us" },
  { key: "paid",        label: "Paid",         dateField: "paymentSentAt", owner: "us" },
  { key: "shipped",     label: "Shipped",      dateField: "shippedAt",     owner: "vendor" },
  { key: "received",    label: "Received",     dateField: "receivedAt",    owner: "us" },
  { key: "closed",      label: "Closed",       dateField: "closedAt",      owner: "us" },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);

// Every date field a PO carries, in stage order. Used by validation and by
// the front end to render the date trail without hardcoding the list twice.
export const DATE_FIELDS = STAGES.map((s) => s.dateField).filter(Boolean);

export const STAGE_BY_DATE_FIELD = STAGES.reduce((acc, s) => {
  if (s.dateField) acc[s.dateField] = s;
  return acc;
}, {});

// A PO that is cancelled leaves the pipeline entirely rather than sitting in
// whatever stage it died in. Kept separate from STAGES so it can never be
// "reached" by setting a date.
export const CANCELLED = "cancelled";

/**
 * The stage a PO is actually in, derived from its dates. Walks backwards so
 * the LAST milestone with a date wins: a PO that got a ship date before
 * anyone recorded the payment is shipped, not paid. Real life skips steps
 * and back-fills them, so the stage must not depend on them arriving in
 * order.
 */
export function currentStage(po) {
  if (!po) return "draft";
  if (po.cancelledAt) return CANCELLED;
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const s = STAGES[i];
    if (s.dateField && po[s.dateField]) return s.key;
  }
  return "draft";
}

/* ------------------------------------------------------------------ *
 * PO NUMBERING
 * ------------------------------------------------------------------ */

/** Two-digit year, matching the 26- prefix Ryan already uses. */
export function yearPrefix(date) {
  const d = date ? new Date(date) : new Date();
  const y = isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  return String(y).slice(-2);
}

/**
 * Build a PO number.
 *
 *   buildPoNumber({ year:"26", invoiceNumber:"66601", seq:1, total:1 })
 *     -> "26-66601"
 *   buildPoNumber({ year:"26", invoiceNumber:"66601", seq:2, total:2 })
 *     -> "26-66601-2"
 *
 * The suffix is omitted only when this is the ONLY PO on the job. As soon as
 * a second one exists the first is renumbered to -1 by the store, because
 * "26-66601" and "26-66601-2" sitting side by side reads like a missing
 * document. See store.js assignPoNumbers().
 */
export function buildPoNumber({ year, invoiceNumber, manualSeq, seq, total }) {
  const y = year || yearPrefix();
  const middle = invoiceNumber
    ? String(invoiceNumber).trim()
    : `M${String(manualSeq || 1).padStart(3, "0")}`;
  const base = `${y}-${middle}`;
  if (!total || total <= 1) return base;
  return `${base}-${seq || 1}`;
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function str(v, max) {
  return isNonEmptyString(v) ? v.trim().slice(0, max || 200) : "";
}

/** Money, stored as a number. Rejects NaN rather than silently writing null. */
function money(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/** A YYYY-MM-DD date, or null. Returns NaN for a value that will not parse. */
export function isoDate(v) {
  if (v === "" || v === null || v === undefined) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return NaN;
  return d.toISOString().slice(0, 10);
}

/**
 * Line items. Kept deliberately loose on the description (vendors describe
 * the same blank six different ways) and strict on the numbers, since the
 * numbers are what goes on a document a vendor will invoice against.
 */
export function validateLines(raw) {
  const errors = [];
  const lines = [];
  if (!Array.isArray(raw)) return { errors: ["lines must be a list"], lines: [] };

  raw.forEach((r, i) => {
    const row = r && typeof r === "object" ? r : {};
    const description = str(row.description, 300);
    if (!description) {
      errors.push(`line ${i + 1}: description is required`);
      return;
    }
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`line ${i + 1}: quantity must be a positive number`);
      return;
    }
    const unitCost = money(row.unitCost);
    if (Number.isNaN(unitCost)) {
      errors.push(`line ${i + 1}: unit cost is not a number`);
      return;
    }
    lines.push({
      description,
      qty,
      unitCost: unitCost === null ? 0 : unitCost,
      // Free text. Sizes and colors arrive from Printavo as one blob more
      // often than as structured fields, so this is not parsed.
      detail: str(row.detail, 300),
      imprint: str(row.imprint, 200),
      // Carried through from Printavo so a line can be traced back to the
      // quote it came from. Null on manual lines.
      printavoLineId: str(row.printavoLineId, 100) || null,
    });
  });

  return { errors, lines };
}

/** Extended cost of one line, and the PO total. One place, so they agree. */
export function lineTotal(line) {
  const qty = Number(line && line.qty) || 0;
  const unit = Number(line && line.unitCost) || 0;
  return Math.round(qty * unit * 100) / 100;
}

export function poTotal(po) {
  const lines = (po && Array.isArray(po.lines)) ? po.lines : [];
  const sum = lines.reduce((acc, l) => acc + lineTotal(l), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Validate a NEW purchase order.
 *
 * The route layer stamps id, poNumber, createdBy and createdAt: a hand-crafted
 * POST must not be able to choose its own PO number or forge who raised it.
 */
export function validateNew(body, knownVendorIds) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};

  const vendorId = str(b.vendorId, 100);
  if (!vendorId) errors.push("vendor is required");
  else if (Array.isArray(knownVendorIds) && !knownVendorIds.includes(vendorId)) {
    errors.push("vendor must be one on the vendor list");
  }

  const { errors: lineErrors, lines } = validateLines(b.lines);
  errors.push(...lineErrors);
  if (!lines.length) errors.push("at least one line is required");

  // Printavo link. Optional: a manual web order has none. When present, the
  // invoice number is what drives the PO number, so it has to be clean.
  let printavo = null;
  if (b.printavo && typeof b.printavo === "object") {
    const invoiceNumber = str(b.printavo.invoiceNumber, 40);
    if (invoiceNumber) {
      printavo = {
        invoiceNumber,
        id: str(b.printavo.id, 100) || null,
        customerName: str(b.printavo.customerName, 200),
        dueDate: null,
      };
      const due = isoDate(b.printavo.dueDate);
      if (Number.isNaN(due)) errors.push("printavo.dueDate is not a valid date");
      else printavo.dueDate = due;
    }
  }

  const neededBy = isoDate(b.neededBy);
  if (Number.isNaN(neededBy)) errors.push("neededBy is not a valid date");

  if (errors.length) return { ok: false, errors, record: null };

  return {
    ok: true,
    errors: [],
    record: {
      vendorId,
      lines,
      printavo,
      neededBy,
      notes: str(b.notes, 2000),
      shipTo: str(b.shipTo, 500),
      // Who on our side owns chasing this. Defaults to the creator at the
      // route layer when not supplied.
      owner: str(b.owner, 100).toLowerCase() || null,
    },
  };
}

/**
 * Validate a PATCH. Dates are the interesting part: advancing a PO through
 * the pipeline IS setting a date, so these are ordinary field writes rather
 * than a separate "advance stage" verb. That keeps back-filling a date you
 * forgot on Tuesday from being a different operation than recording one now.
 */
export function validatePatch(body, knownVendorIds) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const patch = {};

  if (b.vendorId !== undefined) {
    const vendorId = str(b.vendorId, 100);
    if (!vendorId) errors.push("vendor cannot be blank");
    else if (Array.isArray(knownVendorIds) && !knownVendorIds.includes(vendorId)) {
      errors.push("vendor must be one on the vendor list");
    } else patch.vendorId = vendorId;
  }

  if (b.lines !== undefined) {
    const { errors: lineErrors, lines } = validateLines(b.lines);
    errors.push(...lineErrors);
    if (!lineErrors.length && !lines.length) errors.push("at least one line is required");
    else if (!lineErrors.length) patch.lines = lines;
  }

  DATE_FIELDS.concat(["neededBy", "cancelledAt"]).forEach((f) => {
    if (b[f] === undefined) return;
    const d = isoDate(b[f]);
    if (Number.isNaN(d)) errors.push(`${f} is not a valid date`);
    else patch[f] = d;
  });

  if (b.trackingNumber !== undefined) patch.trackingNumber = str(b.trackingNumber, 200);
  if (b.carrier !== undefined) patch.carrier = str(b.carrier, 100);
  if (b.notes !== undefined) patch.notes = str(b.notes, 2000);
  if (b.shipTo !== undefined) patch.shipTo = str(b.shipTo, 500);
  if (b.owner !== undefined) patch.owner = str(b.owner, 100).toLowerCase();

  if (errors.length) return { ok: false, errors, patch: {} };
  return { ok: true, errors: [], patch };
}

/* ------------------------------------------------------------------ *
 * DUE-DATE MATH
 *
 * The whole point of the app: knowing a PO is late BEFORE the customer
 * calls. Two different questions, deliberately kept apart.
 * ------------------------------------------------------------------ */

/** Days between two YYYY-MM-DD dates. Positive means b is after a. */
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round((db - da) / 86400000);
}

export function addDays(date, days) {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * When this PO has to be ORDERED by to make the job's due date.
 *
 * Printavo due date, minus the vendor's production/ship lead time, minus a
 * decorating buffer when the goods come back here to be printed. Blanks that
 * we decorate need slack on this end; finished goods drop-shipped to the
 * customer do not, which is why the buffer is per-PO rather than global.
 */
export function orderByDate(po, vendor) {
  const due = (po && po.neededBy) || (po && po.printavo && po.printavo.dueDate) || null;
  if (!due) return null;
  const lead = Number(vendor && vendor.leadDays) || 0;
  const buffer = Number(po && po.decorateBufferDays) || 0;
  return addDays(due, -(lead + buffer));
}

/**
 * Health of a PO right now: ok, amber, red, or done.
 *
 * Two independent clocks, and the worse one wins:
 *
 *   1. STAGE CLOCK. How long it has sat in its current stage against what
 *      this vendor normally takes. Catches a vendor going quiet.
 *   2. DELIVERY CLOCK. Whether the remaining lead time still fits before the
 *      job is due. Catches a PO that is moving along fine but was raised too
 *      late to ever land on time.
 *
 * A PO can be perfectly on schedule stage-wise and still be doomed, which is
 * exactly the failure the email-only process never surfaces.
 */
export function poHealth(po, vendor, today) {
  const now = today || new Date().toISOString().slice(0, 10);
  const stage = currentStage(po);

  if (stage === CANCELLED) return { level: "done", stage, reasons: [] };
  if (stage === "received" || stage === "closed") return { level: "done", stage, reasons: [] };

  const reasons = [];
  let level = "ok";
  const worse = (a, b) => (a === "red" || b === "red" ? "red" : (a === "amber" || b === "amber" ? "amber" : "ok"));

  // --- stage clock ---
  const stageDef = STAGES.find((s) => s.key === stage);
  const enteredAt = stageDef && stageDef.dateField ? po[stageDef.dateField] : (po && po.createdAt ? String(po.createdAt).slice(0, 10) : null);
  const waits = (vendor && vendor.stageWaitDays) || {};
  const allowed = Number(waits[stage]);
  if (enteredAt && Number.isFinite(allowed) && allowed > 0) {
    const waited = daysBetween(enteredAt, now);
    if (waited !== null && waited > allowed * 2) {
      level = worse(level, "red");
      reasons.push(`${waited} days in ${stageDef ? stageDef.label : stage}, expected ${allowed}`);
    } else if (waited !== null && waited > allowed) {
      level = worse(level, "amber");
      reasons.push(`${waited} days in ${stageDef ? stageDef.label : stage}, expected ${allowed}`);
    }
  }

  // --- delivery clock ---
  const orderBy = orderByDate(po, vendor);
  if (orderBy && stage === "draft") {
    const slack = daysBetween(now, orderBy);
    if (slack !== null && slack < 0) {
      level = worse(level, "red");
      reasons.push(`should have been ordered ${Math.abs(slack)} days ago`);
    } else if (slack !== null && slack <= 2) {
      level = worse(level, "amber");
      reasons.push(`order by ${orderBy}`);
    }
  }

  const due = (po && po.neededBy) || (po && po.printavo && po.printavo.dueDate) || null;
  if (due && stage !== "draft") {
    const daysLeft = daysBetween(now, due);
    const lead = Number(vendor && vendor.leadDays) || 0;
    if (daysLeft !== null && daysLeft < 0) {
      level = worse(level, "red");
      reasons.push(`job was due ${Math.abs(daysLeft)} days ago`);
    } else if (daysLeft !== null && daysLeft < lead && stage !== "shipped") {
      level = worse(level, "red");
      reasons.push(`${daysLeft} days to due date, vendor needs ${lead}`);
    }
  }

  return { level, stage, reasons };
}
