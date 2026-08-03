// api/mailme/settings.js — MailMe configuration.
//
// GET   -> current settings plus the compliance blockers standing between you
//          and a legal send.
// PATCH -> update. Merged, not replaced, so a partial save cannot wipe the
//          postal address by omitting it.
//
// EVERYTHING CONFIGURABLE, NOTHING HARDCODED. Reorder thresholds, frequency
// caps, the cold warm-up ramp, from-name and reply-to all live here rather
// than baked into code, per the shop's standing preference.
//
// The postal address ships BLANK on purpose. It is a fact about the business
// that cannot be guessed, and CAN-SPAM requires it in every commercial
// message, so complianceBlockers() refuses to call a send legal until it is
// filled in.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import { getSettings, saveSettings } from "../../lib/mailme/store.js";
import { complianceBlockers, complianceFooter, coldDailyCap } from "../../lib/mailme/audience.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

const num = (v, fallback) => {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;
  if (!(await requireMailMe(sess, res))) return;

  try {
    if (req.method === "GET") {
      const settings = await getSettings();
      // Day 0 of the ramp when cold sending has not started yet.
      const rampDay = settings.coldStartedAt
        ? Math.floor((Date.now() - new Date(settings.coldStartedAt)) / 86400000) : 0;
      return res.status(200).json({
        settings,
        blockers: complianceBlockers(settings),
        footerPreview: complianceFooter(settings, null),
        coldCapToday: coldDailyCap(rampDay, settings.policy),
        rampDay,
      });
    }

    if (req.method === "PATCH") {
      if (!(await canEditMailMe(sess))) {
        return res.status(403).json({ error: "Your role is read-only in MailMe" });
      }
      const b = parseBody(req);
      const current = await getSettings();
      const patch = {};

      if (b.companyName !== undefined) patch.companyName = String(b.companyName).trim();
      if (b.fromName !== undefined) patch.fromName = String(b.fromName).trim();
      if (b.replyToMode !== undefined) {
        const m = String(b.replyToMode);
        if (!["account-manager", "fixed"].includes(m)) {
          return res.status(400).json({ error: "replyToMode must be account-manager or fixed" });
        }
        patch.replyToMode = m;
      }
      if (b.replyToFixed !== undefined) patch.replyToFixed = String(b.replyToFixed).trim();
      if (b.unsubscribeUrl !== undefined) patch.unsubscribeUrl = String(b.unsubscribeUrl).trim();

      if (b.postalAddress && typeof b.postalAddress === "object") {
        patch.postalAddress = {};
        ["line1", "line2", "city", "state", "postalCode"].forEach((k) => {
          if (b.postalAddress[k] !== undefined) {
            patch.postalAddress[k] = String(b.postalAddress[k]).trim();
          }
        });
      }

      if (b.policy && typeof b.policy === "object") {
        const p = b.policy;
        patch.policy = {
          minDaysBetweenEmails: Math.max(0, num(p.minDaysBetweenEmails, current.policy.minDaysBetweenEmails)),
          coldDailyCapStart: Math.max(1, num(p.coldDailyCapStart, current.policy.coldDailyCapStart)),
          coldDailyCapMax: Math.max(1, num(p.coldDailyCapMax, current.policy.coldDailyCapMax)),
          coldRampDays: Math.max(1, num(p.coldRampDays, current.policy.coldRampDays)),
          clientDailyCap: Math.max(1, num(p.clientDailyCap, current.policy.clientDailyCap)),
          skipOpenQuotes: p.skipOpenQuotes === undefined ? current.policy.skipOpenQuotes : !!p.skipOpenQuotes,
          skipInvalidVerification: p.skipInvalidVerification === undefined
            ? current.policy.skipInvalidVerification : !!p.skipInvalidVerification,
        };
        // A ramp that ends lower than it starts would shrink over time.
        if (patch.policy.coldDailyCapMax < patch.policy.coldDailyCapStart) {
          return res.status(400).json({
            error: "The cold daily cap maximum cannot be lower than its starting value",
          });
        }
      }

      if (b.reorder && typeof b.reorder === "object") {
        const r = b.reorder;
        patch.reorder = {
          dueAt: Math.max(0.1, num(r.dueAt, current.reorder.dueAt)),
          overdueAt: Math.max(0.1, num(r.overdueAt, current.reorder.overdueAt)),
          lapsedAt: Math.max(0.1, num(r.lapsedAt, current.reorder.lapsedAt)),
          minOrders: Math.max(1, num(r.minOrders, current.reorder.minOrders)),
          minGapDays: Math.max(0, num(r.minGapDays, current.reorder.minGapDays)),
        };
        // Out-of-order thresholds would make "overdue" unreachable.
        if (!(patch.reorder.dueAt <= patch.reorder.overdueAt &&
              patch.reorder.overdueAt <= patch.reorder.lapsedAt)) {
          return res.status(400).json({
            error: "Reorder thresholds must increase: due at or before overdue, overdue at or before lapsed",
          });
        }
      }

      const settings = await saveSettings(patch);
      return res.status(200).json({
        ok: true,
        settings,
        blockers: complianceBlockers(settings),
        footerPreview: complianceFooter(settings, null),
      });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme settings route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
