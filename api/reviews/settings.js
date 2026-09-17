// PUT IN: api/reviews/settings.js
// api/reviews/settings.js: the email text, the switch, and the checks.
//
//   GET                         settings, defaults, last check and last send
//   PUT  { ...settings }        save (judged as a whole, see validateSettings)
//   POST { action: "test", to, settings? }   one preview email, touches nothing
//   POST { action: "check" }    ask Printavo what it would find, saves nothing
//   POST { action: "run" }      do exactly what the cron does, right now
//
// Admin only, checked here on every request.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { canUseReviews, DENIED } from "../../lib/reviews/access.js";
import { realDeps, configuration } from "../../lib/reviews/deps.js";
import { validateSettings, renderEmail, normalizeEmail, DEFAULT_SETTINGS, PLACEHOLDERS } from "../../lib/reviews/schema.js";
import { walkTriggerOrders } from "../../lib/reviews/printavo.js";
import { detect, sendDue } from "../../lib/reviews/engine.js";

export const config = { maxDuration: 60 };

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const perms = await permsFor(sess.username);
    if (!canUseReviews(perms)) return res.status(403).json({ error: DENIED });

    const deps = realDeps();
    const store = deps.store;

    if (req.method === "GET") {
      const [settings, state] = await Promise.all([store.getSettings(), store.getState()]);
      return res.status(200).json({
        settings, defaults: DEFAULT_SETTINGS, placeholders: PLACEHOLDERS,
        state, configured: configuration(),
      });
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const current = await store.getSettings();
      const v = validateSettings(parseBody(req), current);
      if (!v.ok) return res.status(400).json({ error: v.errors.join(". "), errors: v.errors });
      await store.saveSettings(v.settings);
      return res.status(200).json({ ok: true, settings: v.settings });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req);

    if (body.action === "test") {
      const to = normalizeEmail(body.to);
      if (!to) return res.status(400).json({ error: "Enter an email address to send the test to" });
      // Preview what is on screen, saved or not, so the text can be checked
      // before anybody commits to it.
      const current = await store.getSettings();
      const v = validateSettings(body.settings || {}, current);
      if (!v.ok) return res.status(400).json({ error: v.errors.join(". "), errors: v.errors });
      const sample = Object.assign({ first_name: "Tony", visual_id: "54781", order_nickname: "Sample order" }, body.sample || {});
      const msg = renderEmail(v.settings, sample);
      const r = await deps.send({
        from: msg.from, to: [to], subject: "[TEST] " + msg.subject, text: msg.text,
        reply_to: msg.replyTo || undefined,
      });
      return res.status(200).json({ ok: true, to, subject: "[TEST] " + msg.subject, id: (r && r.id) || null });
    }

    if (body.action === "check") {
      const settings = await store.getSettings();
      const seen = await store.getSeen();
      const sample = [];
      let fresh = 0;
      const walk = await walkTriggerOrders({
        gql: deps.gql, statuses: settings.statuses, lookbackDays: settings.lookbackDays,
        now: Date.now(), deadline: Date.now() + 40000,
        onPage: async (orders) => {
          orders.forEach((o) => {
            if (!seen[o.invoiceId]) fresh++;
            if (sample.length < 5) sample.push({ visualId: o.visualId, nickname: o.nickname, status: o.statusName, hasEmail: !!normalizeEmail(o.email), firstName: o.firstName });
          });
        },
      });
      return res.status(200).json({
        ok: true, mode: walk.mode, complete: walk.complete, pages: walk.pages, found: walk.found,
        notYetSeen: fresh, matchedStatuses: walk.matchedStatuses.map((s) => s.name),
        missingStatuses: walk.missingStatuses, sample,
      });
    }

    if (body.action === "run") {
      const settings = await store.getSettings();
      const started = Date.now();
      const out = {};
      try { out.check = await detect(deps, { settings, now: Date.now(), deadline: started + 35000 }); }
      catch (e) {
        out.check = { at: new Date().toISOString(), error: (e && e.message) || String(e) };
        await store.patchState({ lastCheck: out.check });
      }
      try { out.send = await sendDue(deps, { settings, now: Date.now() }); }
      catch (e) {
        out.send = { at: new Date().toISOString(), error: (e && e.message) || String(e) };
        await store.patchState({ lastSend: out.send });
      }
      return res.status(200).json(Object.assign({ ok: true }, out));
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || String(e) });
  }
}
