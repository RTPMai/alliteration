// api/mailme/unsubscribe.js — the public opt-out endpoint.
//
// PUBLIC BY DESIGN. This is reachable without a session, and it must be:
// the person clicking it is a customer or prospect reading their email, not
// a P&M staff member with a login. CAN-SPAM requires a working opt-out in
// every commercial message, and an opt-out behind a login is not one.
//
// It is NOT unauthenticated in the loose sense. Every request must carry a
// valid HMAC token tied to one contact id and signed with SESSION_SECRET, so:
//   - the URL never contains an email address
//   - nobody can unsubscribe somebody else by editing the link
//   - a token cannot be forged without the secret
//
// GET  ?t=<token>            -> confirm who this is (company name only, never
//                               the full address) so the page can say who it
//                               is about without leaking anything.
// POST { token, reason }     -> record the opt-out.
//
// Tokens do NOT expire. CAN-SPAM requires opt-outs to keep working for at
// least 30 days after a send, and a dead link in an old email is exactly what
// produces spam complaints. The only thing a token can do is STOP mail, so a
// permanent one errs on the safe side.
//
// ESM handler.

import { resolveContacts, suppressEmail, getSettings } from "../../lib/mailme/store.js";
import { makeToken, readToken } from "../../lib/mailme/unsub-token.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Re-exported so nothing that previously imported makeToken/readToken from
// this file needs to change. The real implementation lives in
// lib/mailme/unsub-token.js, a pure lib module the send path also uses.
export { makeToken, readToken };

// Shown on the page so someone knows which company the opt-out is for,
// WITHOUT echoing the email address back. Echoing it would turn the link into
// an address-disclosure tool for anyone who intercepted it.
function describe(contact) {
  if (!contact) return null;
  return { company_name: contact.company_name || "", source: contact.source };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = (req.query && req.query.t) || parseBody(req).token;
    if (!token) return res.status(400).json({ error: "Missing token" });

    const contactId = readToken(token);
    if (!contactId) {
      // Deliberately vague: distinguishing "bad signature" from "unknown
      // contact" would help someone probing for valid ids.
      return res.status(400).json({ error: "This unsubscribe link is not valid." });
    }

    const { contacts } = await resolveContacts();
    const contact = contacts.find((c) => c.id === contactId);

    if (req.method === "GET") {
      if (!contact) return res.status(404).json({ error: "This unsubscribe link is not valid." });
      const settings = await getSettings();
      return res.status(200).json({
        ok: true,
        contact: describe(contact),
        alreadyUnsubscribed: contact.status === "unsubscribed",
        companyName: settings.companyName || "",
      });
    }

    if (req.method === "POST") {
      if (!contact) return res.status(404).json({ error: "This unsubscribe link is not valid." });

      const reason = String(parseBody(req).reason || "").trim().slice(0, 500);

      // Suppression is keyed by EMAIL, so this opt-out survives the contact
      // record being deleted and re-imported later.
      await suppressEmail(contact.email, {
        status: "unsubscribed",
        reason: reason || "No reason given",
        by: "self-service",
      });

      return res.status(200).json({ ok: true, unsubscribed: true });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme unsubscribe error:", e);
    // Never leak internals to a public page.
    return res.status(500).json({ error: "Something went wrong. Please reply to the email instead." });
  }
}
