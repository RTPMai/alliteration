// api/traveltrack/trips.js — trip CRUD, scoped to who may see what.
//
// GET    -> list trips (own, or everyone's for data_scope "all"), or ?id= for one.
// POST   -> create a trip. traveler defaults to the caller; only a data_scope
//           "all" user may create one for someone else.
// PATCH  -> edit a trip. Owner or a data_scope "all" user may edit.
// DELETE -> owner or a data_scope "all" + can_edit user.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateTrip } from "../../lib/traveltrack/schema.js";
import { listTrips, getTrip, saveTrip, updateTrip, deleteTrip } from "../../lib/traveltrack/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    scope: (role && role.data_scope) || "all",
    canEdit: role ? !!role.can_edit : true,
    name: (user && user.name) || sess.name || sess.username,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { scope, canEdit, name } = await callerScope(sess);
    const mine = String(sess.username || "").trim().toLowerCase();

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        const trip = await getTrip(id);
        if (!trip) return res.status(404).json({ error: "Trip not found" });
        if (scope !== "all" && String(trip.traveler || "").toLowerCase() !== mine) {
          return res.status(403).json({ error: "Not your trip" });
        }
        return res.status(200).json({ trip });
      }
      let trips = await listTrips();
      if (scope !== "all") {
        trips = trips.filter((t) => String(t.traveler || "").toLowerCase() === mine);
      }
      return res.status(200).json({ trips });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateTrip(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // Attribution: the caller owns the trip unless they have team-wide
      // visibility AND explicitly named someone else.
      let traveler = sess.username;
      let travelerName = name;
      if (scope === "all" && body.traveler) {
        traveler = body.traveler;
        travelerName = body.traveler_name || body.traveler;
      }

      record.traveler = traveler;
      record.traveler_name = travelerName;
      record.created_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const trip = await saveTrip(record);
      return res.status(201).json({ ok: true, trip });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing trip id" });

      const existing = await getTrip(id);
      if (!existing) return res.status(404).json({ error: "Trip not found" });

      const isOwner = String(existing.traveler || "").toLowerCase() === mine;
      if (!isOwner && !(scope === "all" && canEdit)) {
        return res.status(403).json({ error: "Not allowed to edit this trip" });
      }

      const { ok, errors, record } = validateTrip(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const trip = await updateTrip(id, record);
      return res.status(200).json({ ok: true, trip });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing trip id" });

      const existing = await getTrip(id);
      if (!existing) return res.status(404).json({ error: "Trip not found" });

      const isOwner = String(existing.traveler || "").toLowerCase() === mine;
      if (!isOwner && !(scope === "all" && canEdit)) {
        return res.status(403).json({ error: "Not allowed to delete this trip" });
      }

      await deleteTrip(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("traveltrack/trips route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
