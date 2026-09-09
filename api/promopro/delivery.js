// PUT IN: api/promopro/delivery.js
// api/promopro/delivery.js — did the purchase order email actually land?
//
// GET ?poId=<id>   the delivery state of the LAST email sent for that order
//
// WHY A PULL AND NOT A WEBHOOK. MailMe learns the same facts from a Resend
// webhook, and that is right for MailMe: it aggregates thousands of sends
// into counts that nobody inspects one at a time, so the events have to be
// caught as they happen or they are gone. PromoPro asks about ONE order, at
// the moment somebody has that order open. A pull costs one call exactly when
// the answer is wanted, and needs no second webhook route, no second shared
// secret to rotate, and no endpoint to configure in Resend.
//
// WHAT THIS IS REALLY FOR. A bounced purchase order sits in Submitted going
// redder every day and looks exactly like a vendor ignoring us. It is not the
// same thing: one means chase the rep, the other means nothing ever arrived.
// Opens are a nice-to-have on top and are deliberately hedged, because open
// tracking fires on image pre-fetch as readily as on a human reading it.
//
// ACCESS. Read, so it matches the rest of the app's read rule: anyone who can
// open PromoPro can see where an order sits without having to ask. This
// exposes no more than the PO screen already does.
//
// The route lives in api/promopro/ as a FOLDER, never a flat file, per the
// Vercel route-conflict rule at the top of pos.js.

import { requireAuth } from "../../lib/session.js";
import { getPo } from "../../lib/promopro/store.js";
import { deliveryAsk, deliveryState } from "../../lib/promopro/schema.js";
import { getEmailStatus } from "../../lib/mailme/resend-client.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const sess = requireAuth(req, res);
  if (!sess) return;

  const poId = (req.query && req.query.poId) || "";
  if (!poId) return res.status(400).json({ error: "poId is required" });

  try {
    const po = await getPo(String(poId));
    if (!po) return res.status(404).json({ error: "Not found" });

    // Answered 200 with a reason rather than an error. "There is nothing to
    // look up" is a normal state of a purchase order, not a failure, and a
    // red error box on an outsourced job would be nonsense.
    const ask = deliveryAsk(po);
    if (!ask.ask) {
      return res.status(200).json({ ok: true, checked: false, why: ask.why, status: null });
    }

    const result = await getEmailStatus(po.lastMessageId);
    if (!result.ok) {
      return res.status(200).json({ ok: true, checked: false, why: result.error, status: null });
    }

    const state = deliveryState(result.status);
    return res.status(200).json({
      ok: true,
      checked: true,
      status: state,
      // The raw string as well as our reading of it, so a state we have no
      // wording for can still be diagnosed from the screen rather than from
      // the logs.
      raw: result.status,
      sentAt: po.lastSentAt || "",
      sentTo: po.sentTo || "",
    });
  } catch (e) {
    console.error("promopro/delivery route error:", e);
    return res.status(500).json({ error: e.message || "Could not check delivery." });
  }
}
