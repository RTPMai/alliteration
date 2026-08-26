// api/crewcore/reviews.js — one-on-one review history.
//
// GET    -> admin (superuser or the admin role): every review (optionally
//           ?employee_id=). Everyone else: just their own history, read
//           only. Nobody self-serve ever sees another employee's reviews.
// POST/PATCH/DELETE -> admin-scope only. An employee can read their reviews
//           but never write one, including about themselves.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { validateReview, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import {
  listReviews, getReview, saveReview, updateReview, deleteReview, getEmployeeByUsername,
} from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return { isAdmin: isCrewCoreAdmin({
    superuser: user && user.superuser,
    roleName: user ? user.role : sess.role,
  }) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { isAdmin } = await callerScope(sess);

    if (req.method === "GET") {
      if (isAdmin) {
        const empId = req.query && req.query.employee_id;
        let reviews = await listReviews();
        if (empId) reviews = reviews.filter((r) => r.employee_id === empId);
        return res.status(200).json({ reviews });
      }

      const own = await getEmployeeByUsername(sess.username);
      if (!own) return res.status(200).json({ reviews: [] });
      const all = await listReviews();
      const mine = all.filter((r) => r.employee_id === own.id);
      return res.status(200).json({ reviews: mine });
    }

    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateReview(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      record.created_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      const review = await saveReview(record);
      return res.status(201).json({ ok: true, review });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing review id" });

      const existing = await getReview(id);
      if (!existing) return res.status(404).json({ error: "Review not found" });

      const { ok, errors, record } = validateReview(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const review = await updateReview(id, record);
      return res.status(200).json({ ok: true, review });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing review id" });
      const existing = await getReview(id);
      if (!existing) return res.status(404).json({ error: "Review not found" });
      await deleteReview(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/reviews route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
