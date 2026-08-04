// api/crewcore/handbook.js — the Employee Handbook, read-only.
//
// GET -> the full handbook content. No scope split: anyone who can open
//        CrewCore (admin or self-serve "employee" role) can read the whole
//        handbook — there's no sensitive figure in it beyond the stipend
//        dollar amounts, which are already public shop policy (posted on
//        the internal Wix site before this), not per-employee pay data.
//
// The content itself lives in lib/crewcore/handbook-content.js as static
// data (see that file's header for why it's not KV-backed). This route
// exists mainly so the front end goes through the seam like everything
// else, and so the shape can change later (e.g. versioning, KV-backed
// edits) without the app needing to change.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { HANDBOOK_SECTIONS, HANDBOOK_UPDATED } from "../../lib/crewcore/handbook-content.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method === "GET") {
      return res.status(200).json({ sections: HANDBOOK_SECTIONS, updated: HANDBOOK_UPDATED });
    }

    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/handbook route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
