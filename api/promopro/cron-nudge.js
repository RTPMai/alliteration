// PUT IN: api/promopro/cron-nudge.js
// api/promopro/cron-nudge.js — the automatic follow-up to the VENDOR.
//
// Called by Vercel cron on weekday mornings. Also callable by a signed-in
// admin with ?dry=1, which reads everything, sends nothing, and reports
// exactly who would have been written to and who was held back and why. Use
// the dry run before switching this on: it is the only way to see what the
// first real run would do while it can still be stopped.
//
// SEPARATE FROM cron-chase.js ON PURPOSE. That one writes to our own
// Notifications list. This one puts mail in other companies' inboxes. Same
// clock, completely different blast radius, so they get separate switches,
// separate routes and separate failures. See lib/promopro/nudge.js for the
// rules and why each guard is there.
//
// A SEND THAT FAILS DOES NOT COUNT. The order is only stamped as reminded
// after Resend has taken the message, so a bad minute at the provider means
// tomorrow tries again rather than a vendor never hearing from us while the
// record says they did.
//
// AUTH. Same fail-closed pattern as cron-chase.js: the Vercel cron header
// (CRON_SECRET) or a signed-in admin session. safeEqual treats an unset
// secret as a non-match, never as a pass.
//
// ESM handler. Do NOT wrap the handler; call the checks inside it.

import { getSession, safeEqual } from "../../lib/session.js";
import { isAdminSession } from "../../lib/promopro/access.js";
import { listPos, getVendors, getSettings, updatePo } from "../../lib/promopro/store.js";
import { withSettingDefaults, looksLikeEmail } from "../../lib/promopro/schema.js";
import { listEmployees } from "../../lib/crewcore/store.js";
import { resolveAccountManagers, effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";
import {
  nudgeList, nudgeSettings, nudgeMessage, nudgeHistoryEntry,
} from "../../lib/promopro/nudge.js";
import { resendConfigured, sendOne, domainStatusChecked } from "../../lib/mailme/resend-client.js";

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
    const [pos, vendors, storedSettings, employees] = await Promise.all([
      listPos(), getVendors(), getSettings(), listEmployees().catch(() => []),
    ]);

    const settings = withSettingDefaults(storedSettings);
    // Resolved from the CrewCore roster, the same way the send route does it,
    // so a rebuilt CC list on an older order names real addresses rather than
    // employee ids.
    settings.accountManagers = resolveAccountManagers(
      effectiveAccountManagerIds(storedSettings, employees),
      employees
    );

    const n = nudgeSettings(settings);
    const { due, held } = nudgeList(pos, vendors, settings);

    if (!n.enabled) {
      // Not an error. Reported in words so a cron that appears to do nothing
      // can be told apart from one that is switched off.
      return res.status(200).json({
        ok: true, enabled: false, sent: 0, due: 0,
        note: "Vendor reminders are switched off in PromoPro Settings.",
      });
    }

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, enabled: true,
        from: n.fromAddress, afterDays: n.afterDays, maxRounds: n.maxRounds,
        due, held,
      });
    }

    if (!resendConfigured()) {
      return res.status(200).json({ ok: false, sent: 0, error: "RESEND_API_KEY is not set" });
    }
    if (!looksLikeEmail(n.fromAddress)) {
      return res.status(200).json({ ok: false, sent: 0, error: "No from-address is set for reminders" });
    }

    // Checked ONCE for the run rather than per order. The same live check the
    // send route makes: a domain that was verified when Settings was filled
    // in can fall out of verification months later, and what that produces is
    // reminders that never arrive while this route reports success.
    const domain = n.fromAddress.split("@")[1].trim().toLowerCase();
    const check = await domainStatusChecked(domain);
    if (check.reachable && check.found && check.status !== "verified") {
      return res.status(200).json({
        ok: false, sent: 0,
        error: `${domain} shows as "${check.status}" in Resend rather than verified, so nothing was sent`,
      });
    }
    if (check.reachable && !check.found) {
      return res.status(200).json({
        ok: false, sent: 0,
        error: `${domain} has not been added to Resend, so nothing was sent`,
      });
    }
    // Unreachable is not the same as unverified. Let it through and let
    // Resend refuse the send itself if the domain really is a problem.

    const byId = new Map(vendors.map((v) => [v.id, v]));
    const results = [];
    let sent = 0;

    for (const row of due) {
      const po = pos.find((p) => p && p.id === row.poId);
      const vendor = byId.get(po && po.vendorId) || null;
      if (!po || !vendor) continue;

      try {
        const result = await sendOne(nudgeMessage(po, vendor, settings, row.round));
        const at = new Date().toISOString();

        const nudges = Array.isArray(po.nudges) ? po.nudges.slice() : [];
        nudges.push({
          at,
          round: row.round,
          to: row.to,
          cc: row.cc,
          messageId: (result && result.id) ? String(result.id) : null,
        });

        const history = Array.isArray(po.history) ? po.history.slice() : [];
        history.push(nudgeHistoryEntry(row.round, row.to, row.cc, at));

        await updatePo(po.id, {
          nudges,
          history,
          // Reads as "chased today" on the pipeline, which is the whole point:
          // somebody about to ring this vendor can see the app already wrote
          // to them this morning.
          lastFollowUpAt: at,
        });

        sent += 1;
        results.push({ poNumber: row.poNumber, round: row.round, to: row.to, cc: row.cc, ok: true });
      } catch (e) {
        // One vendor's failure must not stop the rest of the run.
        const msg = (e && e.message) || String(e);
        console.error(`[promopro] reminder for ${row.poNumber} failed:`, msg);
        results.push({ poNumber: row.poNumber, round: row.round, ok: false, error: msg });
      }
    }

    return res.status(200).json({
      ok: true,
      enabled: true,
      due: due.length,
      sent,
      failed: results.filter((r) => !r.ok).length,
      held: held.length,
      results,
    });
  } catch (e) {
    console.error("promopro/cron-nudge error:", e);
    return res.status(500).json({ error: e.message });
  }
}
