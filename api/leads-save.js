// api/leads-save.js — write the leads list.
//
// THE WRITE IS CHECKED. An earlier version never inspected the storage
// response: a failed write returned { ok: true } and the browser believed the
// leads were saved when they were not. Silent data loss is the worst failure
// mode here, because nobody re-enters what they think is already stored.

import { requireAuth } from "../lib/session.js";
import { KEYS, kvSet, isConfigured } from "../lib/backbone-store.js";
import { assignLeadNumbers, isArchived } from "../lib/backbone/archive.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const { leads } = body;
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: "Expected { leads: [...] }" });
  }

  // AN ARCHIVED LEAD MUST SAY WHY. Checked here and not only on the screen,
  // because the screen is one of several ways a lead can reach this route and
  // a blank reason is the exact outcome the fixed list exists to prevent.
  //
  // Membership of the CURRENT list is deliberately not re-checked. A reason
  // retired from the list months after the fact would otherwise make every
  // later save of that lead fail, which would turn a settings edit into an
  // outage. The list is enforced at the moment of archiving; from then on the
  // record simply has to carry a reason.
  const unexplained = leads.filter((l) => isArchived(l) && !String(l.archive_reason || "").trim());
  if (unexplained.length) {
    return res.status(400).json({
      error: `${unexplained.length} archived lead(s) have no reason. Archiving requires one.`,
    });
  }

  // NUMBERS ARE ISSUED HERE, NEVER IN THE BROWSER. Two people with the pipeline
  // open would each compute the same "next" number and the second save would
  // quietly take the first one's. The server sees the whole list at once.
  const numbered = assignLeadNumbers(leads);

  try {
    // kvSet throws on a non-2xx, so a failed write cannot be reported as success.
    await kvSet(KEYS.leads, { leads: numbered.leads, savedAt: new Date().toISOString() });
    // The count, not the list. The first save after this ships numbers every
    // lead in the pipeline at once, and echoing a few thousand records back
    // just to deliver a field each would be a needlessly large response. The
    // browser reloads instead when `numbered` is not zero.
    return res.status(200).json({
      ok: true,
      count: numbered.leads.length,
      numbered: numbered.assigned,
    });
  } catch (e) {
    console.error("leads-save error:", e);
    return res.status(500).json({ error: e.message });
  }
}
