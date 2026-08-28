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
 * RECEIVING
 *
 * A PO used to be received or not received: one date, one flag. Real
 * deliveries do not work that way. A vendor ships 120 of 144 and backorders
 * the rest, and under the old model somebody had to choose between marking
 * the whole order received (which stops the clock on 24 pieces nobody has)
 * and leaving it open (which makes 120 pieces sitting on the dock look
 * missing). Both answers are wrong and the second one is why people stop
 * updating the app.
 *
 * So receiving is now per line. `receivedQty` on each line is the running
 * total booked in, and `receipts` is the log of how it got there, because
 * "we got 120 on the 4th and 24 on the 11th" is a different fact from "we
 * have 144" and the second one cannot be reconstructed from the first.
 *
 * receivedAt, the stage date, is still the single source of "this order is
 * complete". It is set when the last piece lands and cleared if a correction
 * takes the count back below the ordered quantity, so the stage and the
 * counts can never disagree.
 * ------------------------------------------------------------------ */

/** Ordered, received and outstanding quantities across the whole PO. */
export function receiptSummary(po) {
  const lines = Array.isArray(po && po.lines) ? po.lines : [];
  let ordered = 0;
  let received = 0;
  lines.forEach((l) => {
    const q = Number(l && l.qty) || 0;
    const r = Number(l && l.receivedQty) || 0;
    ordered += q;
    // Over-receipts happen (a vendor ships an overrun). Count them for the
    // received figure but never let them create negative outstanding on
    // another line by netting off.
    received += r;
  });
  const outstanding = lines.reduce((acc, l) => {
    const q = Number(l && l.qty) || 0;
    const r = Number(l && l.receivedQty) || 0;
    return acc + Math.max(0, q - r);
  }, 0);

  return {
    ordered,
    received,
    outstanding,
    // "Complete" means no line is short. Deliberately not `received >=
    // ordered`: an overrun on one item does not cover a shortage on another.
    complete: lines.length > 0 && outstanding === 0,
    started: received > 0,
    partial: received > 0 && outstanding > 0,
    // Which lines are still short, for the screen and the chase email.
    short: lines
      .map((l, i) => ({
        index: i,
        description: l.description,
        itemNumber: l.itemNumber || "",
        ordered: Number(l.qty) || 0,
        received: Number(l.receivedQty) || 0,
        outstanding: Math.max(0, (Number(l.qty) || 0) - (Number(l.receivedQty) || 0)),
      }))
      .filter((r) => r.outstanding > 0),
  };
}

/**
 * Apply a receipt to a PO and return the fields that changed.
 *
 * `entries` is [{ index, qty }] against the PO's own line order. Quantities
 * ADD to what is already booked in rather than replacing it, because the
 * physical act being recorded is "a box arrived", not "the total is now".
 * A negative quantity is allowed and is how a miscount gets corrected.
 *
 * Returns { errors, lines, receipt, receivedAt } so the caller decides what
 * to persist. Nothing here writes.
 */
export function applyReceipt(po, entries, meta) {
  const errors = [];
  const lines = (Array.isArray(po && po.lines) ? po.lines : []).map((l) => ({ ...l }));
  if (!lines.length) return { errors: ["this purchase order has no lines to receive against"], lines: [], receipt: null };

  const list = Array.isArray(entries) ? entries : [];
  const applied = [];

  list.forEach((e) => {
    const row = e && typeof e === "object" ? e : {};
    const i = Number(row.index);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) {
      errors.push(`line ${row.index} is not on this purchase order`);
      return;
    }
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty === 0) return;   // nothing entered on that line

    const before = Number(lines[i].receivedQty) || 0;
    const after = before + Math.round(qty);
    if (after < 0) {
      errors.push(`line ${i + 1}: that correction would take the received count below zero`);
      return;
    }
    lines[i].receivedQty = after;
    applied.push({ index: i, qty: Math.round(qty), to: after });
  });

  if (errors.length) return { errors, lines: [], receipt: null };
  if (!applied.length) return { errors: ["nothing was entered to receive"], lines: [], receipt: null };

  const m = meta && typeof meta === "object" ? meta : {};
  const receipt = {
    at: m.at || new Date().toISOString(),
    by: String(m.by || "").toLowerCase(),
    date: isoDate(m.date) || String(m.at || new Date().toISOString()).slice(0, 10),
    note: typeof m.note === "string" ? m.note.trim().slice(0, 500) : "",
    lines: applied,
  };

  const summary = receiptSummary({ ...po, lines });

  return {
    errors: [],
    lines,
    receipt,
    // Set when the last piece lands, cleared when a correction reopens it.
    // Never left stale: the stage always agrees with the counts.
    receivedAt: summary.complete ? receipt.date : null,
  };
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
 *   { year:"26", invoiceNumber:"66608", imprintNumber:9 }  -> "26-66608-9"
 *   { year:"26", invoiceNumber:"66608" }                   -> "26-66608"
 *   { year:"26", manualSeq:14 }                            -> "26-M014"
 *
 * CORRECTED Aug 2026. The suffix was originally a running count of the POs
 * we had raised against a job: first one -1, second -2. That was wrong. It is
 * the IMPRINT's own number on the Printavo job, so the promo imprint on
 * invoice 66608 is 66608-9 whether it is the first PO we raise or the only
 * one. Those two rules agree by accident on a single-imprint job and disagree
 * on every other, which is exactly the kind of thing that would have been
 * found late and confused a vendor.
 *
 * A manual web order has no Printavo invoice, so it uses an M-sequence in the
 * middle slot, which makes it obvious at a glance that no Printavo job sits
 * behind it.
 */
export function buildPoNumber({ year, invoiceNumber, manualSeq, imprintNumber }) {
  const y = year || yearPrefix();
  const middle = invoiceNumber
    ? String(invoiceNumber).trim()
    : `M${String(manualSeq || 1).padStart(3, "0")}`;
  const base = `${y}-${middle}`;
  // A string, not a number: a PO covering imprints 9 and 10 is numbered
  // however the buyer says it is, and that is not for this function to
  // decide. Empty means no imprint, which is a manual order or a job with
  // no imprint detail.
  const suffix = String(imprintNumber == null ? "" : imprintNumber).trim();
  if (!suffix) return base;
  return `${base}-${suffix}`;
}

// One shop-wide number: how many days of vendor silence before we chase.
// Three working days is the point where "they are probably just busy" turns
// into "nobody has looked at this."
export const DEFAULT_CHASE_AFTER_DAYS = 3;

// Deliberately permissive. Confirms a field LOOKS like an address so a typo
// is caught at entry, not that the mailbox exists.
export function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

/**
 * A DOMAIN, not an address. `po.pmapparel.com` yes, `po@pmapparel.com` no,
 * `https://po.pmapparel.com/` no.
 *
 * This exists because the reply capture domain is the one setting whose
 * failure is completely invisible: anything wrong here means Reply-To falls
 * back to a person, every PO looks perfectly sent, and no vendor reply is
 * ever captured. One reader, used by both the settings validation and the
 * send, so the two can never disagree about what is usable.
 */
export function looksLikeDomain(v) {
  const d = String(v || "").trim().toLowerCase();
  if (!d || d.length > 253) return false;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d) && /\.[a-z]{2,}$/.test(d);
}

/**
 * Has the vendor said anything since we last emailed them?
 *
 * This is the question the whole app exists to answer, and it was being
 * recorded and never asked: inbound.js stamps lastVendorReplyAt on the order
 * and poHealth() uses it to stop the silence clock, but nothing on any screen
 * said a reply had arrived. A reply captured where nobody can see it is the
 * same failure as a reply sitting in one person's inbox.
 *
 * Later than the last send, not merely present, because a reply to the FIRST
 * send is not an answer to the one we sent this morning.
 */
export function repliedSinceSend(po) {
  const replied = po && po.lastVendorReplyAt ? String(po.lastVendorReplyAt) : "";
  if (!replied) return false;
  const sent = po && po.lastSentAt ? String(po.lastSentAt) : "";
  if (!sent) return true;
  return replied > sent;
}

/** How many replies are on this order. */
export function replyCount(po) {
  return Array.isArray(po && po.replies) ? po.replies.length : 0;
}

/**
 * Where a vendor's reply to this PO should go, and what is wrong when it
 * cannot go where it was meant to.
 *
 * Per-PO (po+<poNumber>@<capture domain>) rather than one shared inbox, so an
 * arriving reply matches an order exactly instead of being guessed at from a
 * subject line somebody edited.
 *
 * Returns { address, problem }. `problem` is set ONLY when capture is
 * switched on and still cannot be used, which is the case worth shouting
 * about: Reply-To silently becomes a person, the PO looks perfectly sent, and
 * no reply is ever captured. Nothing about that is visible from the outside,
 * which is why the send reports it and the Settings screen reads it.
 *
 * Lives here rather than in the send route so the screen, the send and the
 * tests all get their answer from one place.
 */
export function captureState(po, settings) {
  if (!settings || settings.captureReplies !== true) return { address: "", problem: "" };

  const domain = String(settings.captureDomain || "").trim().replace(/^@+/, "").toLowerCase();
  if (!domain) {
    return {
      address: "",
      problem: "Reply capture is switched on but no capture domain is set in Settings, so this " +
        "went out with a person's address on Reply-To and the vendor's reply will not be captured.",
    };
  }
  // A domain, not an address. Somebody typing po@pmapparel.com here would
  // build po+26-66608-9@po@pmapparel.com, which no reply can ever reach.
  if (!looksLikeDomain(domain)) {
    return {
      address: "",
      problem: `The capture domain in Settings ("${domain}") is not a domain name, so this went ` +
        "out with a person's address on Reply-To and the vendor's reply will not be captured. " +
        "It should read like po.pmapparel.com, with no @ and no mailbox on the front.",
    };
  }
  const number = String((po && po.poNumber) || "").trim();
  if (!number) {
    return {
      address: "",
      problem: "This order has no PO number yet, so there is nothing for a reply to match against.",
    };
  }
  return { address: `po+${number}@${domain}`, problem: "" };
}

/**
 * Parse a free-typed CC field into clean addresses. People paste comma
 * separated, semicolon separated, or one per line, and all three should work
 * rather than one being "the right way."
 */
export function parseEmailList(raw) {
  const parts = String(raw == null ? "" : raw).split(/[,;\n]/);
  const out = [];
  const seen = new Set();
  parts.forEach((p) => {
    const e = p.trim();
    if (!e) return;
    const key = e.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  });
  return out;
}

/**
 * Everyone who gets CC'd on a PO email, in order, de-duplicated.
 *
 * Three sources: the shop-wide always-CC list, the PO's account manager, and
 * the vendor's own second contact. One place so the send path, the preview,
 * and any future resend all agree on the recipient list. A CC list that
 * differs between the preview and the actual send is the kind of bug nobody
 * notices until a customer is copied on something they should not see.
 */
export function ccListFor(po, vendor, settings) {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const v = String(e || "").trim();
    if (!v || !looksLikeEmail(v)) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  (settings && Array.isArray(settings.alwaysCc) ? settings.alwaysCc : []).forEach(push);

  // The resolved list, attached by the route from CrewCore. Never the stored
  // id list: an id cannot be emailed.
  const ams = (settings && Array.isArray(settings.accountManagers)) ? settings.accountManagers : [];
  const am = ams.find((a) => a && a.id === (po && po.accountManager));
  if (am) push(am.email);

  push(vendor && vendor.ccEmail);

  return out;
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
      // The vendor's own catalogue number. Optional, because manual web
      // orders and one-off items genuinely do not have one, but it is the
      // field a supplier keys off when they read the PO, so it comes first
      // on screen.
      itemNumber: str(row.itemNumber, 100),
      qty,
      unitCost: unitCost === null ? 0 : unitCost,
      // Free text. Sizes and colors arrive from Printavo as one blob more
      // often than as structured fields, so this is not parsed.
      detail: str(row.detail, 300),
      imprint: str(row.imprint, 200),
      // Carried through from Printavo so a line can be traced back to the
      // quote it came from. Null on manual lines.
      printavoLineId: str(row.printavoLineId, 100) || null,
      // How many have physically landed. Preserved through an ordinary edit
      // rather than reset: somebody fixing a typo in a description must not
      // silently un-receive 120 pieces. Only api/promopro/receive.js moves
      // this number, via applyReceipt().
      receivedQty: Math.max(0, Math.round(Number(row.receivedQty) || 0)),
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
export function validateNew(body, knownVendorIds, knownAmIds) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};

  const vendorId = str(b.vendorId, 100);
  if (!vendorId) errors.push("vendor is required");
  else if (Array.isArray(knownVendorIds) && !knownVendorIds.includes(vendorId)) {
    errors.push("vendor must be one on the vendor list");
  }

  // Required, not optional. Every PO belongs to somebody's job, that person
  // gets copied on the vendor email, and they are who the pipeline chases
  // when it goes amber. A PO with no account manager is a PO nobody owns,
  // which is the exact failure this app exists to end.
  const accountManager = str(b.accountManager, 100);
  if (!accountManager) errors.push("account manager is required");
  else if (Array.isArray(knownAmIds) && !knownAmIds.includes(accountManager)) {
    errors.push("account manager must be one set up in Settings");
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
        // Which imprint on that job this PO covers. Drives the PO number's
        // suffix, so it is part of the Printavo link rather than a loose
        // field: it is meaningless without the invoice.
        //
        // A PO can cover more than one imprint (several promo items on one
        // job, one vendor, one order). When it does, the suffix is whatever
        // the buyer confirmed rather than something invented here: there is
        // no established convention for a two-imprint PO number and guessing
        // one would put a made-up number in front of a vendor.
        imprintNumber: str(b.printavo.imprintNumber, 40) || null,
        imprintNumbers: Array.isArray(b.printavo.imprintNumbers)
          ? b.printavo.imprintNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
          : [],
        groupIds: Array.isArray(b.printavo.groupIds)
          ? b.printavo.groupIds.map((g) => str(g, 100)).filter(Boolean)
          : [],
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
      accountManager,
      lines,
      printavo,
      neededBy,
      notes: str(b.notes, 2000),
      shipTo: str(b.shipTo, 500),
      // Snapshotted onto the PO at creation rather than read from Settings
      // at display time. A PO is a document that was sent to an outside
      // party; changing the shop default later must not silently rewrite
      // what a vendor was actually told last month.
      shippingInstructions: str(b.shippingInstructions, 500),
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
export function validatePatch(body, knownVendorIds, knownAmIds) {
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

  if (b.accountManager !== undefined) {
    const am = str(b.accountManager, 100);
    // Cannot be cleared once set: required on create means required forever,
    // or a PO could quietly lose its owner on an unrelated edit.
    if (!am) errors.push("account manager cannot be blank");
    else if (Array.isArray(knownAmIds) && !knownAmIds.includes(am)) {
      errors.push("account manager must be one set up in Settings");
    } else patch.accountManager = am;
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
  if (b.shippingInstructions !== undefined) patch.shippingInstructions = str(b.shippingInstructions, 500);
  if (b.owner !== undefined) patch.owner = str(b.owner, 100).toLowerCase();

  if (errors.length) return { ok: false, errors, patch: {} };
  return { ok: true, errors: [], patch };
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */

// The shop address. Public information, safe to keep in source.
// The UPS account number is NOT here on purpose: this repository is public,
// so anything that could be used to bill freight to P&M lives in Settings,
// which is stored in the database. See shippingInstructions.
export const DEFAULT_SHIP_TO = "1100 South 5th St, Polk City, IA 50226";

export const DEFAULT_SETTINGS = {
  chaseAfterDays: DEFAULT_CHASE_AFTER_DAYS,
  defaultShipTo: DEFAULT_SHIP_TO,
  shippingInstructions: "",
  alwaysCc: [],
  // Who the PO comes FROM, and who a vendor reaches when they hit Reply.
  // The QuickBooks version sent from quickbooks@notification.intuit.com,
  // which no vendor can usefully reply to.
  fromAddress: "",
  replyTo: "",
  brandName: "P&M Apparel",
  brandPhone: "",
  // Employee IDS only. Names and addresses are resolved from the CrewCore
  // roster at read time so they can never drift out of date here. See
  // lib/promopro/account-managers.js.
  accountManagerIds: [],
  // WHICH ROLES CAN RAISE AND EDIT A PURCHASE ORDER.
  //
  // Empty means "anybody the shell already trusts to edit", which is what
  // this app did before the list existed and is what keeps an upgrade from
  // locking everyone out on deploy. Once an admin names roles here, only
  // those roles can write, and superusers always can regardless.
  //
  // Kept here rather than as a new flag on the role itself because the
  // question is "who buys", which is a PromoPro decision an admin should be
  // able to change without touching the shell's permission model. Reading
  // stays open to everyone: the whole point of the app is that an AM can see
  // where an order stands without asking.
  editRoles: [],
  // Which Printavo line-item categories count as promo, so a lookup shows
  // the imprints worth raising a PO for instead of the whole job.
  promoCategories: [],
  // Who, if anyone, gets the morning digest of overdue orders on top of
  // their Notifications. Empty means nobody, which is the default: the
  // notifications are the real delivery and a second channel is opt-in.
  chaseDigestTo: [],
  // How long a vendor's artwork link stays good. See
  // lib/promopro/art-token.js.
  artLinkDays: 90,
  // The mark printed on the purchase order and shown in the emailed copy.
  // A path on our own domain by default. It is a setting rather than a
  // hardcoded path because P&M runs three businesses: a PO going out as
  // Flyover Con should not carry the P&M mark, and swapping it should be a
  // Settings change, not a deploy.
  logoUrl: "/assets/brand/pm-apparel-logo.png",
  // Vendor reply capture. OFF until the MX record and the Resend inbound
  // address actually exist, because switching Reply-To to an address that
  // does not receive mail loses vendor replies outright.
  captureReplies: false,
  captureDomain: "",
  // Where a reply lands when it cannot be matched to a PO, or when the
  // order's account manager has no address.
  replyFallbackTo: "",
};

/**
 * Fill in missing settings without discarding anything else.
 *
 * The spread matters. This used to build a fresh object from the four known
 * keys, which silently deleted every field the ROUTE attaches on its way out:
 * the CrewCore candidate list, the roster counts, the usingDefaults flag. The
 * server sent a correct payload, the browser ran it through here on arrival,
 * and the account-manager picker was empty by the time anything rendered.
 *
 * A normalizer's job is to supply what is absent, not to decide what is
 * allowed through. Anything the caller already has, it keeps.
 */
export function withSettingDefaults(s) {
  const src = s && typeof s === "object" ? s : {};
  return {
    ...src,
    chaseAfterDays: Number.isFinite(Number(src.chaseAfterDays)) && Number(src.chaseAfterDays) > 0
      ? Math.round(Number(src.chaseAfterDays))
      : DEFAULT_CHASE_AFTER_DAYS,
    alwaysCc: Array.isArray(src.alwaysCc) ? src.alwaysCc : [],
    defaultShipTo: typeof src.defaultShipTo === "string" ? src.defaultShipTo : DEFAULT_SHIP_TO,
    fromAddress: typeof src.fromAddress === "string" ? src.fromAddress : "",
    replyTo: typeof src.replyTo === "string" ? src.replyTo : "",
    brandName: typeof src.brandName === "string" && src.brandName ? src.brandName : "P&M Apparel",
    brandPhone: typeof src.brandPhone === "string" ? src.brandPhone : "",
    shippingInstructions: typeof src.shippingInstructions === "string" ? src.shippingInstructions : "",
    accountManagerIds: Array.isArray(src.accountManagerIds) ? src.accountManagerIds.map(String) : [],
    promoCategories: Array.isArray(src.promoCategories) ? src.promoCategories.map(String) : [],
    // Empty is meaningful: it means the shell's own edit permission decides,
    // which is the behaviour every existing install already has.
    editRoles: Array.isArray(src.editRoles) ? src.editRoles.map((r) => String(r).toLowerCase()) : [],
    chaseDigestTo: Array.isArray(src.chaseDigestTo) ? src.chaseDigestTo : [],
    captureReplies: src.captureReplies === true,
    captureDomain: typeof src.captureDomain === "string" ? src.captureDomain : "",
    replyFallbackTo: typeof src.replyFallbackTo === "string" ? src.replyFallbackTo : "",
    artLinkDays: Number.isFinite(Number(src.artLinkDays)) && Number(src.artLinkDays) > 0
      ? Math.round(Number(src.artLinkDays))
      : 90,
    // Empty string is a real choice, meaning "no logo", so only an ABSENT
    // value falls back to the default mark.
    logoUrl: typeof src.logoUrl === "string" ? src.logoUrl : "/assets/brand/pm-apparel-logo.png",
    // Filled in by the route from the CrewCore roster. Never stored.
    accountManagers: Array.isArray(src.accountManagers) ? src.accountManagers : [],
  };
}

/**
 * Validate a settings patch.
 *
 * Account managers are a short explicit list of name and address rather than
 * being derived from shell accounts, because shell accounts carry no email
 * and deriving firstname@pmapparel.com would invent inboxes. An address that
 * bounces on a PO is a vendor who never got copied, silently.
 */
export function validateSettings(body, current) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const patch = {};
  // What is already saved. Passed in so a patch can be judged on what the
  // settings will BE, not only on what this one request happens to mention:
  // switching capture on in a request that says nothing about the domain
  // used to sail through with the domain still empty.
  const now = current && typeof current === "object" ? current : {};

  if (b.chaseAfterDays !== undefined) {
    const n = Number(b.chaseAfterDays);
    if (!Number.isFinite(n) || n <= 0) errors.push("chase after days must be at least 1");
    else patch.chaseAfterDays = Math.round(n);
  }

  if (b.alwaysCc !== undefined) {
    const list = Array.isArray(b.alwaysCc) ? b.alwaysCc : parseEmailList(b.alwaysCc);
    const bad = list.filter((e) => !looksLikeEmail(e));
    if (bad.length) errors.push("these do not look like addresses: " + bad.join(", "));
    else patch.alwaysCc = list;
  }

  if (b.defaultShipTo !== undefined) {
    patch.defaultShipTo = str(b.defaultShipTo, 500);
  }

  ["fromAddress", "replyTo"].forEach((f) => {
    if (b[f] === undefined) return;
    const v = str(b[f], 200);
    if (v && !looksLikeEmail(v)) errors.push(`${f} does not look like an address`);
    else patch[f] = v;
  });

  if (b.brandName !== undefined) patch.brandName = str(b.brandName, 120);
  if (b.brandPhone !== undefined) patch.brandPhone = str(b.brandPhone, 60);

  if (b.captureReplies !== undefined) patch.captureReplies = b.captureReplies === true;
  if (b.captureDomain !== undefined) patch.captureDomain = str(b.captureDomain, 200).replace(/^@+/, "");
  if (b.replyFallbackTo !== undefined) {
    const v = str(b.replyFallbackTo, 200);
    if (v && !looksLikeEmail(v)) errors.push("the fallback reply address does not look like an address");
    else patch.replyFallbackTo = v;
  }

  // Turning capture on without somewhere for the mail to land would point
  // every vendor's Reply at nothing. Judged on the EFFECTIVE setting, the one
  // that will be in force after this save, because the failure mode here is
  // invisible: Reply-To quietly falls back to a person, the PO looks sent and
  // fine, and no reply ever reaches inbound.
  const wantsCapture = b.captureReplies !== undefined
    ? b.captureReplies === true
    : now.captureReplies === true;
  const effectiveDomain = String(
    (b.captureDomain !== undefined ? patch.captureDomain : now.captureDomain) || ""
  ).trim().toLowerCase();

  if (wantsCapture) {
    if (!effectiveDomain) {
      errors.push("set the capture domain before switching reply capture on");
    } else if (!looksLikeDomain(effectiveDomain)) {
      // "po@pmapparel.com" here builds po+26-66608-9@po@pmapparel.com, which
      // is not an address any reply can reach.
      errors.push(
        `the capture domain does not look like a domain name: "${effectiveDomain}". ` +
        "It should read like po.pmapparel.com, with no @ and no mailbox on the front"
      );
    }
  }

  if (b.chaseDigestTo !== undefined) {
    const list = Array.isArray(b.chaseDigestTo) ? b.chaseDigestTo : parseEmailList(b.chaseDigestTo);
    const bad = list.filter((e) => !looksLikeEmail(e));
    if (bad.length) errors.push("these do not look like addresses: " + bad.join(", "));
    else patch.chaseDigestTo = list;
  }

  if (b.logoUrl !== undefined) {
    const v = str(b.logoUrl, 500);
    // Ours or nothing. An off-site image in an outgoing email is a tracking
    // pixel somebody else controls, and a link that can rot without us
    // noticing.
    if (v && !/^\/[^/]/.test(v) && !/^https:\/\//.test(v)) {
      errors.push("the logo must be a path on this site, like /assets/brand/your-logo.png, or a full https address");
    } else patch.logoUrl = v;
  }

  if (b.artLinkDays !== undefined) {
    const n = Number(b.artLinkDays);
    if (!Number.isFinite(n) || n < 1) errors.push("artwork links must last at least a day");
    else patch.artLinkDays = Math.min(3650, Math.round(n));
  }

  if (b.editRoles !== undefined) {
    if (!Array.isArray(b.editRoles)) errors.push("edit roles must be a list");
    else {
      const seen = new Set();
      patch.editRoles = [];
      b.editRoles.forEach((raw) => {
        const r = str(raw, 60).toLowerCase();
        if (!r || seen.has(r)) return;
        seen.add(r);
        patch.editRoles.push(r);
      });
    }
  }

  if (b.shippingInstructions !== undefined) {
    // Free text printed on every PO. Typically the freight account to bill.
    // Stored, never committed to source, because the repo is public.
    patch.shippingInstructions = str(b.shippingInstructions, 500);
  }

  if (b.promoCategories !== undefined) {
    if (!Array.isArray(b.promoCategories)) errors.push("promo categories must be a list");
    else {
      const seen = new Set();
      patch.promoCategories = [];
      b.promoCategories.forEach((raw) => {
        const c = str(raw, 200);
        const key = c.toLowerCase();
        if (!c || seen.has(key)) return;
        seen.add(key);
        patch.promoCategories.push(c);
      });
    }
  }

  if (b.accountManagerIds !== undefined) {
    if (!Array.isArray(b.accountManagerIds)) errors.push("account managers must be a list of employee ids");
    else {
      const seen = new Set();
      const out = [];
      b.accountManagerIds.forEach((raw) => {
        const id = str(raw, 100);
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push(id);
      });
      patch.accountManagerIds = out;
    }
  }

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
 *   1. SILENCE CLOCK. How long we have been waiting on the VENDOR with no
 *      movement. Catches a supplier going quiet.
 *   2. DELIVERY CLOCK. Whether the remaining lead time still fits before the
 *      job is due. Catches a PO that is moving along fine but was raised too
 *      late to ever land on time.
 *
 * A PO can be perfectly on schedule step-wise and still be doomed, which is
 * exactly the failure the email-only process never surfaces.
 *
 * WHY THE SILENCE CLOCK IS ONE NUMBER AND NOT SIX (simplified Aug 14 2026):
 * this originally held a per-vendor wait for every stage. That was six
 * unknowable numbers per vendor, and two of them ("art approved", "paid")
 * are stages where WE are the holdup, so a vendor setting could never have
 * described them. Guessed numbers produce false ambers, false ambers train
 * people to ignore the colour, and then the alerting is dead. So: one
 * shop-wide "chase after N days of vendor silence", one optional per-vendor
 * override for the genuinely slow ones, and stages we own do not raise a
 * vendor alarm at all. Our own overdue steps belong in Notifications, which
 * already exists, not in a colour that blames the supplier.
 */
export function poHealth(po, vendor, today, opts) {
  const now = today || new Date().toISOString().slice(0, 10);
  const stage = currentStage(po);

  if (stage === CANCELLED) return { level: "done", stage, reasons: [] };
  if (stage === "received" || stage === "closed") return { level: "done", stage, reasons: [] };

  const reasons = [];
  let level = "ok";
  const worse = (a, b) => (a === "red" || b === "red" ? "red" : (a === "amber" || b === "amber" ? "amber" : "ok"));

  // --- silence clock: only where we are waiting on THEM ---
  const stageDef = STAGES.find((s) => s.key === stage);
  if (stageDef && stageDef.owner === "vendor") {
    const fallback = Number(opts && opts.chaseAfterDays);
    const allowed = Number(vendor && vendor.responseDays)
      || (Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_CHASE_AFTER_DAYS);
    // The clock runs from whichever is LATER: entering the stage, or the
    // last time the vendor actually said something. A supplier who replied
    // yesterday is not silent, even if they have been sitting in Submitted
    // for three weeks, and colouring them red for it is how the colour stops
    // meaning anything. Set by api/promopro/inbound.js when reply capture is
    // on; absent everywhere else, which is the behaviour this had before.
    const stageDate = stageDef.dateField
      ? po[stageDef.dateField]
      : (po && po.createdAt ? String(po.createdAt).slice(0, 10) : null);
    const repliedAt = po && po.lastVendorReplyAt ? String(po.lastVendorReplyAt).slice(0, 10) : null;
    const enteredAt = (repliedAt && stageDate && repliedAt > stageDate) ? repliedAt : (stageDate || repliedAt);
    if (enteredAt && allowed > 0) {
      const waited = daysBetween(enteredAt, now);
      if (waited !== null && waited > allowed * 2) {
        level = worse(level, "red");
        reasons.push(`no word for ${waited} days`);
      } else if (waited !== null && waited > allowed) {
        level = worse(level, "amber");
        reasons.push(`no word for ${waited} days`);
      }
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
