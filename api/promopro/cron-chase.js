// api/promopro/cron-chase.js — the daily "who has gone quiet" run.
//
// Called by Vercel cron once a morning. Also callable by a signed-in
// superuser with ?dry=1 to see what it WOULD do without writing anything,
// which is how to check it is sane before trusting it.
//
// WHAT IT DOES
// Works out which open purchase orders are amber or red, then brings the
// Notifications list in step: one open item per late PO, assigned to that
// PO's account manager, updated in place when it gets worse, and closed
// automatically when the order recovers or lands. See lib/promopro/chase.js
// for why it is one-per-PO rather than one-per-morning.
//
// AUTH. Same fail-closed pattern as api/printavo-sync.js: a Vercel cron
// header (CRON_SECRET) or a signed-in superuser session. safeEqual treats an
// unset secret as a non-match, never as a pass, which is the undefined !==
// undefined trap this codebase has been bitten by before.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { getSession, safeEqual } from "../../lib/session.js";
import { isAdminSession } from "../../lib/promopro/access.js";
import { listPos, getVendors, getSettings } from "../../lib/promopro/store.js";
import { chaseList, reconcileChases, digestText, CHASE_SOURCE } from "../../lib/promopro/chase.js";
import {
  listNotifications, saveNotification, updateNotification, nextNotificationId,
} from "../../lib/notifications/store.js";
import { resendConfigured, sendOne } from "../../lib/mailme/resend-client.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const cronSecret = process.env.CRON_SECRET;
  const viaCron = !!cronSecret && safeEqual(req.headers["authorization"], "Bearer " + cronSecret);

  const sess = getSession(req);
  const viaAdmin = sess ? await isAdminSession(sess) : false;

  if (!viaCron && !viaAdmin) return res.status(401).json({ error: "Unauthorized" });

  const dry = String((req.query && req.query.dry) || "") === "1";

  try {
    const [pos, vendors, settings] = await Promise.all([listPos(), getVendors(), getSettings()]);
    const chases = chaseList(pos, vendors, settings);

    // Only our own items. Somebody else's hand-off about a purchase order is
    // not ours to close.
    const all = await listNotifications();
    const ours = all.filter((n) => n && n.source === CHASE_SOURCE);

    const plan = reconcileChases(chases, ours);

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, late: chases.length, chases, plan, digest: digestText(chases),
      });
    }

    const now = new Date().toISOString();

    for (const c of plan.creates) {
      // An unassigned PO still raises an item; it goes to whoever the
      // settings name as the fallback, or stays unassigned and visible to
      // the team rather than vanishing.
      const id = await nextNotificationId();
      await saveNotification({
        id,
        title: c.title,
        types: ["need"],
        appIds: ["promopro"],
        assignedTo: c.assignedTo || "",
        dueDate: null,
        link: null,
        visibility: "team",
        status: "open",
        createdBy: "promopro",
        createdAt: now,
        // Our marker and back-pointer. api/notifications.js passes unknown
        // fields through, and reconcileChases() keys off chasePoId.
        source: CHASE_SOURCE,
        chasePoId: c.poId,
      });
    }

    for (const u of plan.updates) {
      await updateNotification(u.id, { title: u.title, assignedTo: u.assignedTo });
    }

    for (const c of plan.closes) {
      // Closed, not deleted. The trail of "this was late and then it was
      // not" is worth keeping.
      await updateNotification(c.id, { status: "done", doneAt: now, doneBy: "promopro" });
    }

    const emailed = await maybeEmail(settings, chases);

    return res.status(200).json({
      ok: true,
      late: chases.length,
      created: plan.creates.length,
      updated: plan.updates.length,
      closed: plan.closes.length,
      emailed,
    });
  } catch (e) {
    console.error("promopro/cron-chase error:", e);
    return res.status(500).json({ error: e.message });
  }
}

/**
 * The optional digest. Off unless somebody has been named in Settings, and
 * silent on a clean morning: a daily "nothing is wrong" email is the one
 * that trains people to filter the whole thread away.
 */
async function maybeEmail(settings, chases) {
  const to = Array.isArray(settings && settings.chaseDigestTo) ? settings.chaseDigestTo : [];
  if (!to.length || !chases.length) return false;
  if (!resendConfigured()) return false;

  const from = settings.fromAddress || process.env.PROMOPRO_FROM || "";
  if (!from) return false;

  try {
    await sendOne({
      from: `${settings.brandName || "PromoPro"} <${from}>`,
      to,
      subject: `${chases.length} purchase order${chases.length === 1 ? "" : "s"} need chasing`,
      text: digestText(chases),
    });
    return true;
  } catch (e) {
    // A failed digest must never fail the run. The notifications are the
    // real delivery; the email is a convenience on top.
    console.error("[promopro] chase digest failed:", e && e.message);
    return false;
  }
}
