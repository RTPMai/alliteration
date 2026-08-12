// api/mailme/cron-send.js — fires scheduled campaigns and continues
// multi-day sends automatically.
//
// CRON-AUTHENTICATED, same convention as api/printavo-sync.js: when
// CRON_SECRET is set, Vercel automatically attaches
// "Authorization: Bearer <CRON_SECRET>" to every cron invocation, so the
// secret never has to appear in vercel.json (which is committed to the
// repo). FAILS CLOSED — an unset or wrong secret is a 401, same as every
// other secret check in this repo.
//
// WHAT IT DOES, every tick: finds every campaign that is either
//   - status "scheduled" with scheduledAt in the past, or
//   - status "sending" with recipients still queued (a cold ramp or a
//     client list bigger than its daily cap, left over from an earlier run)
// and calls sendCampaign() for each. This is what actually fires a
// scheduled campaign at its chosen time, and what lets a multi-day cold
// ramp keep going on its own instead of needing someone to press Send again
// every morning.
//
// sendCampaign() does all the real safety work on every call regardless of
// who or what triggered it — compliance, live domain verification, and
// suppression are re-checked fresh, cron included.
//
// ESM handler. Not wrapped with requireAuth — this route has no session,
// same reasoning as the cron modes in api/printavo-sync.js.

import { safeEqual } from "../../lib/session.js";
import { listCampaigns } from "../../lib/mailme/store.js";
import { sendCampaign } from "../../lib/mailme/send.js";

function authorizedCron(req) {
  const cronSecret = process.env.CRON_SECRET;
  return !!cronSecret &&
    safeEqual(req.headers["authorization"] || "", "Bearer " + cronSecret);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!authorizedCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const all = await listCampaigns();
    const now = Date.now();
    const due = all.filter((c) =>
      (c.status === "scheduled" && c.scheduledAt && new Date(c.scheduledAt).getTime() <= now) ||
      (c.status === "sending" && c.sendState && Array.isArray(c.sendState.queue) && c.sendState.queue.length > 0)
    );

    const results = [];
    for (const c of due) {
      try {
        const r = await sendCampaign(c.id);
        results.push({ id: c.id, ...r });
      } catch (e) {
        // One campaign's provider error must not stop the rest from running.
        console.error("mailme cron-send failed for", c.id, e);
        results.push({ id: c.id, ok: false, reason: "error", detail: e.message });
      }
    }

    return res.status(200).json({ ok: true, checked: all.length, due: due.length, results });
  } catch (e) {
    console.error("mailme cron-send error:", e);
    return res.status(500).json({ error: e.message });
  }
}
