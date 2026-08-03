// api/mailme/contacts.js — MailMe's contact list, joined from the BackBone roster.
//
// GET   -> { contacts, customersWithoutEmail, totalRosterSize, tags }
//          The contact list is NOT a stored table: it is resolved live from
//          backbone_data (read-only) joined against MailMe's override rows.
//          That means a customer added in Printavo this morning is mailable
//          this afternoon with no import step, and an email corrected in
//          BackBone is corrected here too.
// PATCH -> change one contact's subscribe status and/or tags.
//          body = { customer_id, status?, tags?, reason? }
//
// There is deliberately no POST. You cannot create a contact in MailMe —
// contacts come from the roster. Adding one here would create a person
// BackBone has never heard of and quietly break the join.
//
// ROUTE NAMESPACE: /api/mailme/* rather than /api/contacts, for the same
// reason ErrorEngine's customers route moved to /api/errorengine/customers.
// BackBone owns the short names.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import { resolveContacts, setContactOverride } from "../../lib/mailme/store.js";
import { SUBSCRIPTION_STATUSES } from "../../lib/mailme/schema.js";

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
  if (!(await requireMailMe(sess, res))) return;

  try {
    if (req.method === "GET") {
      const { contacts, customersWithoutEmail, totalRosterSize } = await resolveContacts();

      // Every tag in use, so the Contacts view can offer a filter list
      // without the client having to scan and dedupe the whole roster.
      const tagSet = new Set();
      contacts.forEach((c) => c.tags.forEach((t) => tagSet.add(t)));

      return res.status(200).json({
        contacts,
        customersWithoutEmail,
        totalRosterSize,
        tags: [...tagSet].sort(),
      });
    }

    if (req.method === "PATCH") {
      if (!(await canEditMailMe(sess))) {
        return res.status(403).json({ error: "Your role is read-only in MailMe" });
      }

      const body = parseBody(req);
      const id = body.customer_id || (req.query && req.query.customer_id);
      if (!id) return res.status(400).json({ error: "Missing customer_id" });

      const patch = {};

      if (body.status !== undefined) {
        const s = String(body.status);
        if (!SUBSCRIPTION_STATUSES.includes(s)) {
          return res.status(400).json({ error: `Unknown status: ${s}` });
        }
        // "bounced" and "complained" are FACTS reported by the sending
        // provider's webhook, not opinions a person sets by hand. Letting a
        // human set them would corrupt deliverability reporting, and letting
        // a human clear them would resume mailing an address that hard
        // bounced. Only subscribed/unsubscribed are user-settable.
        if (s === "bounced" || s === "complained") {
          return res.status(400).json({
            error: "Bounce and complaint states are set by the mail provider, not by hand",
          });
        }
        patch.status = s;
      }

      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) return res.status(400).json({ error: "tags must be an array" });
        // Dedupe and trim so "VIP" and "vip " don't become two segments.
        const cleaned = [...new Set(
          body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        )].sort();
        patch.tags = cleaned;
      }

      if (body.reason !== undefined) patch.reason = String(body.reason).trim() || null;

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      const override = await setContactOverride(id, patch, sess);
      return res.status(200).json({ ok: true, customer_id: String(id), override });
    }

    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme contacts route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
