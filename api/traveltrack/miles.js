// api/traveltrack/miles.js — Redeem Miles.
//
// Not a loyalty-account entity. Ryan's org tracks this per-trip, the way
// the standalone app did: pick a trip, log a USD amount (+ optional note),
// and it adds to that trip's running total (trip.miles_value) rather than
// any separate account/program record. No account numbers, no balances,
// no connected programs — internal tracking only.
//
// POST { trip_id, amount, note } -> increments trip.miles_value and appends
// a lightweight log entry (date/amount/note/who) to trip.miles_log for an
// audit trail. Every display surface (trip card, dashboard, CSV) only ever
// shows the cumulative total — same behavior as the original app.
//
// Permission: the trip's owner, or a data_scope "all" + can_edit user (the
// same rule trips.js uses for editing a trip — redeeming miles against a
// trip is treated as an edit to that trip, not a separate permission).
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateMilesRedemption } from "../../lib/traveltrack/schema.js";
import { getTrip, addMilesRedemption } from "../../lib/traveltrack/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const user = sess.username ? await getUser(sess.username) : null;
    const role = await getRole(user ? user.role : sess.role);
    const scope = (role && role.data_scope) || "all";
    const canEdit = role ? !!role.can_edit : true;
    const name = (user && user.name) || sess.name || sess.username;

    const body = parseBody(req);
    if (!body.trip_id) return res.status(400).json({ error: "Missing trip_id" });

    const trip = await getTrip(body.trip_id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });

    const isOwner = String(trip.traveler || "").toLowerCase() === String(sess.username || "").toLowerCase();
    if (!isOwner && !(scope === "all" && canEdit)) {
      return res.status(403).json({ error: "Not allowed to redeem miles against this trip" });
    }

    const { ok, errors, record } = validateMilesRedemption(body);
    if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

    const updated = await addMilesRedemption(body.trip_id, record, { username: sess.username, name });
    return res.status(200).json({ ok: true, trip: updated });
  } catch (e) {
    console.error("traveltrack/miles route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
