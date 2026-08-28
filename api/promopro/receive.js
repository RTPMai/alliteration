// api/promopro/receive.js — book goods in against a purchase order.
//
// POST { poId, entries: [{ index, qty }], date, note }
//
// WHY THIS IS ITS OWN ROUTE RATHER THAN A FIELD ON PATCH
// Receiving is the one edit where what somebody types is a record of a
// physical event, not a correction of a field. "24 arrived on the 11th" has
// to survive somebody later fixing a description, and it has to be additive:
// two deliveries are two entries, not one number overwritten twice. Running
// it through the generic PATCH would make it a whole-line replacement, which
// is how the second delivery quietly erases the first.
//
// The stage date is derived, never typed here. applyReceipt() sets
// receivedAt only when the last piece lands, and clears it if a correction
// takes the count back below the ordered quantity, so "received" on the
// pipeline and the counts on the lines can never disagree.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getSettings } from "../../lib/promopro/store.js";
import { applyReceipt, receiptSummary, closedPatch } from "../../lib/promopro/schema.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const settings = await getSettings();
    if (!(await canEditSession(sess, settings))) {
      return res.status(403).json({ error: "Read-only access" });
    }

    const body = parseBody(req);
    const poId = String(body.poId || "");
    if (!poId) return res.status(400).json({ error: "poId is required" });

    const po = await getPo(poId);
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    const who = String(sess.username || "").toLowerCase();
    const result = applyReceipt(po, body.entries, {
      by: who,
      date: body.date,
      note: body.note,
    });

    if (result.errors.length) {
      return res.status(400).json({ error: result.errors.join("; "), errors: result.errors });
    }

    const receipts = Array.isArray(po.receipts) ? po.receipts.slice() : [];
    receipts.push(result.receipt);

    const summary = receiptSummary({ ...po, lines: result.lines });
    const history = Array.isArray(po.history) ? po.history.slice() : [];
    history.push({
      at: result.receipt.at,
      by: who,
      what: summary.complete
        ? `received in full (${summary.received} of ${summary.ordered})`
        : `received ${result.receipt.lines.reduce((a, l) => a + l.qty, 0)}, ${summary.outstanding} still outstanding`,
    });

    const patch = {
      lines: result.lines,
      receipts,
      receivedAt: result.receivedAt,
      history,
    };

    // Booking in the last of a delivery can be the step that finishes the
    // order, so closed is worked out here too rather than waiting for
    // somebody to open the order and touch a date.
    Object.assign(patch, closedPatch({ ...po, ...patch }));

    const saved = await updatePo(poId, patch);

    return res.status(200).json({ ok: true, po: saved, summary });
  } catch (e) {
    console.error("promopro/receive route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
