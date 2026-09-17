// PUT IN: api/reviews/cron.js
// api/reviews/cron.js: the scheduled run. Find newly picked up and shipped
// orders in Printavo, then send whatever has waited long enough.
//
// Called by Vercel cron only (see vercel.json). No session: Vercel sends
// "Authorization: Bearer <CRON_SECRET>", checked with safeEqual, and a
// missing CRON_SECRET refuses everything rather than letting anyone in.
//
// The two halves fail separately. A Printavo outage still lets yesterday's
// queue go out, and a Resend outage still lets today's pickups get queued.

import { safeEqual } from "../../lib/session.js";
import { realDeps } from "../../lib/reviews/deps.js";
import { detect, sendDue } from "../../lib/reviews/engine.js";

export const config = { maxDuration: 60 };

function authorizedCron(req) {
  const cronSecret = process.env.CRON_SECRET;
  return !!cronSecret && safeEqual(req.headers["authorization"] || "", "Bearer " + cronSecret);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!authorizedCron(req)) return res.status(401).json({ error: "Unauthorized" });

  const deps = realDeps();
  const started = Date.now();
  const out = { ok: true };

  try {
    const settings = await deps.store.getSettings();
    try {
      out.check = await detect(deps, { settings, now: Date.now(), deadline: started + 40000 });
    } catch (e) {
      out.ok = false;
      out.check = { at: new Date().toISOString(), error: (e && e.message) || String(e) };
      try { await deps.store.patchState({ lastCheck: out.check }); } catch (e2) { /* reported below anyway */ }
    }
    try {
      out.send = await sendDue(deps, { settings, now: Date.now() });
    } catch (e) {
      out.ok = false;
      out.send = { at: new Date().toISOString(), error: (e && e.message) || String(e) };
      try { await deps.store.patchState({ lastSend: out.send }); } catch (e2) { /* reported below anyway */ }
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || String(e) });
  }
}
