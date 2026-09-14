// api/concontrol/settings.js — the event, its levels, its categories.
//
// GET   -> current settings (any signed-in user; the screens need the tier
//          names and categories to draw their dropdowns)
// PATCH -> admin only. This is where the tier lineup, the spend categories,
//          the commitment deadline and the budget live, and every one of them
//          changes what the whole team sees.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { money, isoDate } from "../../lib/concontrol/schema.js";
import { getSettings, saveSettings } from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function str(v) { return typeof v === "string" ? v.trim() : ""; }

/**
 * Tiers in, cleaned. `slots` null means unlimited; a number caps it.
 *
 * A tier with no name is dropped rather than saved blank: an unnamed level in
 * the dropdown is a level somebody will pick by accident.
 */
function cleanTiers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const name = str(t && t.name);
    if (!name) continue;
    const slots = t && (t.slots === null || t.slots === "") ? null : Number(t && t.slots);
    out.push({
      name: name.slice(0, 60),
      amount: money(t && t.amount),
      slots: Number.isFinite(slots) && slots >= 0 ? Math.round(slots) : null,
    });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (req.method === "GET") {
      const perms = await permsFor(sess.username);
      const admin = !!(perms && (perms.superuser === true || perms.role === "admin"));
      return res.status(200).json({ settings: await getSettings(), canEdit: admin });
    }

    if (req.method === "PATCH") {
      const perms = await permsFor(sess.username);
      const admin = !!(perms && (perms.superuser === true || perms.role === "admin"));
      if (!admin) {
        return res.status(403).json({
          error: "Event settings are admin only: the levels and categories change what everyone sees.",
        });
      }

      const b = parseBody(req);
      const patch = {};
      const errors = [];

      if ("event" in b) {
        const e = str(b.event);
        if (!e) errors.push("The event code cannot be empty");
        else patch.event = e.slice(0, 20);
      }
      if ("eventName" in b) patch.eventName = str(b.eventName).slice(0, 120);

      for (const key of ["eventDate", "commitBy"]) {
        if (key in b) {
          if (b[key] === null || b[key] === "") patch[key] = "";
          else {
            const d = isoDate(b[key]);
            if (!d) errors.push(`${key} must be YYYY-MM-DD`);
            else patch[key] = d;
          }
        }
      }

      if ("budget" in b) {
        if (b.budget === null || b.budget === "") patch.budget = null;
        else {
          const amt = money(b.budget);
          if (amt === null) errors.push("Budget is not a number");
          else patch.budget = amt;
        }
      }

      if ("tiers" in b) {
        const tiers = cleanTiers(b.tiers);
        if (!tiers) errors.push("Tiers must be a list");
        else if (!tiers.length) errors.push("Keep at least one level");
        else patch.tiers = tiers;
      }

      if ("categories" in b) {
        if (!Array.isArray(b.categories)) errors.push("Categories must be a list");
        else {
          const cats = b.categories.map((c) => str(c).slice(0, 60)).filter(Boolean);
          if (!cats.length) errors.push("Keep at least one category");
          else patch.categories = Array.from(new Set(cats));
        }
      }

      for (const key of ["inquiryNotifyTo", "speakNotifyTo"]) {
        if (key in b) patch[key] = str(b[key]).toLowerCase().slice(0, 120);
      }

      if (errors.length) return res.status(400).json({ error: errors.join("; ") });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const settings = await saveSettings(patch);
      return res.status(200).json({ ok: true, settings });
    }

    res.setHeader("Allow", "GET, PATCH, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol settings route error:", e);
    return res.status(500).json({ error: e.message || "Settings request failed" });
  }
}
