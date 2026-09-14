// api/concontrol/seed.js — one-time imports, admin only.
//
// POST { what: "sponsors" }     FOC26's sponsors as FOC27 prospects
// POST { what: "undo-survey" }  remove what the earlier survey seeding created
//
// WHAT IS NOT HERE ANY MORE. The survey and the dream-speaker names used to be
// imported from here, straight into Sessions and Speakers. That was wrong twice
// over: it put twenty-six session ideas on a program nobody had agreed to, and
// it filed answers to a survey question as speaker records. Both are RESPONSES.
// They live in the Responses screen now, and a topic becomes a session idea
// when somebody presses the button on its row.
//
// "undo-survey" exists because that mistake is already in the live data.
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
import { FOC26_SPONSORS } from "../../lib/concontrol/foc26-survey.js";
import { undoSurveySeed } from "../../lib/concontrol/undo-seed.js";
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

    if (what === "undo-survey") {
      return res.status(200).json({ ok: true, ...(await undoSurveySeed(event)) });
    }

    if (what === "sponsors") {
      const rows = Array.isArray(b.rows) ? b.rows : FOC26_SPONSORS;
      return res.status(200).json({ ok: true, ...(await seedSponsors(rows, event, sess.username)) });
    }

    return res.status(400).json({ error: `Nothing to import called "${what}"` });
  } catch (e) {
    console.error("concontrol seed route error:", e);
    return res.status(500).json({ error: e.message || "Import failed" });
  }
}
