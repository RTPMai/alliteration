// api/concontrol/seed.js — one-time imports, admin only.
//
// POST { what: "survey", rows: [...] }     session ideas from the audience survey
// POST { what: "wishlist", names: [...] }  the dream-speaker answers
// POST { what: "sponsors", rows: [...] }   last year's sponsors as this year's prospects
//
// WHY A ROUTE AND NOT A SCRIPT. A script would need the Upstash credentials on
// somebody's laptop, which is a worse place for them than Vercel. This runs
// with the same storage the app already uses and needs nothing installed.
//
// ADMIN ONLY, and that is the whole access story: it writes records in bulk,
// which is exactly the thing you do not want reachable by anything else.
//
// EVERY IMPORT IS RERUNNABLE. Matching is on title, name or company, so a
// second run updates what it made rather than duplicating it, and anything
// somebody has since edited, scheduled or confirmed is left alone. Running it
// twice by accident is not a thing that should cost an afternoon.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { newSponsor, historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import { seedSessions, seedWishlist } from "../../lib/concontrol/seed-survey.js";
import {
  getSettings, findByCompany, saveSponsor, nextSponsorId,
} from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/**
 * Last year's sponsors, as this year's prospects.
 *
 * Status "inquiry" and NO committed amount, deliberately. They sponsored FOC26;
 * they have not agreed to anything for FOC27, and seeding last year's number as
 * this year's commitment would put money on the board that nobody has promised.
 */
async function seedSponsors(rows, event, who) {
  const created = [];
  const skipped = [];

  for (const row of rows || []) {
    const company = String((row && row.company) || "").trim();
    if (!company) continue;

    const hit = await findByCompany(company, event);
    if (hit) { skipped.push(company); continue; }

    const id = await nextSponsorId();
    await saveSponsor({
      ...newSponsor(id, who),
      id,
      event,
      company,
      contactName: String((row && row.contactName) || "").trim(),
      email: String((row && row.email) || "").trim().toLowerCase(),
      tier: "",
      status: "inquiry",
      notes: String((row && row.note) || "Sponsored FOC26. Not yet approached about FOC27."),
      source: "prior-year",
      history: [historyEntry("added as a prior-year sponsor", who)],
    });
    created.push(company);
  }

  return { created, skipped };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const perms = await permsFor(sess.username);
    const admin = !!(perms && (perms.superuser === true || perms.role === "admin"));
    if (!admin) return res.status(403).json({ error: "Importing is admin only." });

    const b = parseBody(req);
    const settings = await getSettings();
    const event = (b.event && String(b.event)) || settings.event || DEFAULT_EVENT;
    const what = String(b.what || "");

    if (what === "survey") {
      if (!Array.isArray(b.rows)) return res.status(400).json({ error: "rows must be a list of survey responses" });
      return res.status(200).json({ ok: true, ...(await seedSessions(b.rows, event, sess.username)) });
    }

    if (what === "wishlist") {
      if (!Array.isArray(b.names)) return res.status(400).json({ error: "names must be a list" });
      return res.status(200).json({ ok: true, ...(await seedWishlist(b.names, event, sess.username)) });
    }

    if (what === "sponsors") {
      if (!Array.isArray(b.rows)) return res.status(400).json({ error: "rows must be a list" });
      return res.status(200).json({ ok: true, ...(await seedSponsors(b.rows, event, sess.username)) });
    }

    return res.status(400).json({ error: `Nothing to import called "${what}"` });
  } catch (e) {
    console.error("concontrol seed route error:", e);
    return res.status(500).json({ error: e.message || "Import failed" });
  }
}
