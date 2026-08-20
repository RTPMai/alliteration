// api/mailme/contacts.js — the unified contact list.
//
// GET   -> { contacts, counts, tags }. Both sources in one normalized shape:
//          "client" contacts resolved live from the BackBone roster, and
//          "prospect" contacts imported for cold outreach. Filter with
//          ?source=client|prospect, ?status=, ?sort=, ?dir=, ?q=.
// PATCH -> change one contact's subscribe status and/or tags.
//          body = { id, status?, tags?, reason? }   id is "client:123" or "prospect:PR-00042"
// DELETE -> remove a PROSPECT only. Client contacts belong to BackBone.
//
// POST  -> find-or-create a single contact by email, for the "add to list"
//          box. body = { email, contact_name?, company_name?, tags? }
//          If the address already belongs to a contact (client, lead, giving
//          or prospect) that contact is returned untouched. If not, a
//          prospect is created.
//
//          This is the ONLY create path besides api/mailme/import.js, and it
//          deliberately repeats import's two guards rather than skipping
//          them: the address is matched against every existing contact so a
//          duplicate is never made, and a suppressed address is refused
//          outright. Bulk creation still belongs to import.js.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import {
  resolveContacts, setContactStatus, deleteProspect, addProspects, getSuppression,
} from "../../lib/mailme/store.js";
import {
  SUBSCRIPTION_STATUSES, SUPPRESSED_STATUSES, sortContacts, CONTACT_SOURCES,
  CONTACT_DETAIL_FIELDS, validateContactDetailPatch, normalizeEmail,
} from "../../lib/mailme/schema.js";

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
      const q = req.query || {};
      const resolved = await resolveContacts();
      let contacts = resolved.contacts;

      if (q.source) contacts = contacts.filter((c) => c.source === q.source);
      if (q.status) {
        if (q.status === "mailable") {
          contacts = contacts.filter((c) => !SUPPRESSED_STATUSES.includes(c.status));
        } else {
          contacts = contacts.filter((c) => c.status === q.status);
        }
      }
      if (q.tag) {
        const want = String(q.tag).trim().toLowerCase();
        contacts = contacts.filter((c) => (c.tags || []).some((t) => String(t).toLowerCase() === want));
      }
      if (q.q) {
        const needle = String(q.q).trim().toLowerCase();
        contacts = contacts.filter((c) =>
          [c.company_name, c.contact_name, c.email, c.title, (c.tags || []).join(" ")]
            .filter(Boolean).join(" ").toLowerCase().includes(needle));
      }

      // Sorting happens SERVER-side so a filtered page and a full page order
      // identically, and so the client cannot drift from the canonical rule.
      contacts = sortContacts(contacts, q.sort, q.dir);

      const all = resolved.contacts;
      const tagSet = new Set();
      all.forEach((c) => (c.tags || []).forEach((t) => tagSet.add(t)));

      const countBy = (pred) => all.filter(pred).length;

      return res.status(200).json({
        contacts,
        counts: {
          total: all.length,
          shown: contacts.length,
          // Derived from CONTACT_SOURCES rather than listed by hand. The
          // hand-written version shipped with only client and prospect, so
          // Leads and Giving read 0 in the UI while their rows loaded fine
          // underneath — a count that disagreed with its own table. Adding a
          // source now cannot silently miss its counter.
          ...Object.fromEntries(
            CONTACT_SOURCES.map((src) => [src, countBy((c) => c.source === src)])
          ),
          mailable: countBy((c) => !SUPPRESSED_STATUSES.includes(c.status)),
          unsubscribed: countBy((c) => c.status === "unsubscribed"),
          bounced: countBy((c) => c.status === "bounced"),
          complained: countBy((c) => c.status === "complained"),
          customersWithoutEmail: resolved.customersWithoutEmail,
          totalRosterSize: resolved.totalRosterSize,
        },
        tags: [...tagSet].sort(),
      });
    }

    if (!(await canEditMailMe(sess))) {
      return res.status(403).json({ error: "Your role is read-only in MailMe" });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const email = normalizeEmail(body.email);
      if (!email) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }

      // Already known? Hand back the existing record rather than making a
      // second one. This is what makes the same box work for "add my
      // existing client" and "add somebody new".
      const { contacts } = await resolveContacts();
      const existing = contacts.find((c) => normalizeEmail(c.email) === email);
      if (existing) {
        return res.status(200).json({ ok: true, created: false, contact: existing });
      }

      // An opt-out survives the contact record being deleted, so a brand new
      // record for a suppressed address would otherwise quietly resurrect
      // someone who asked not to be emailed.
      const suppression = await getSuppression();
      if (suppression[email]) {
        const entry = suppression[email];
        return res.status(409).json({
          error: `${email} opted out${entry.at ? " on " + String(entry.at).slice(0, 10) : ""} and cannot be added.`,
          reason: "suppressed",
        });
      }

      const tags = Array.isArray(body.tags)
        ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];

      // Title/phone/city/state are accepted on create, not just on a later
      // PATCH. Adding someone by hand and then having to reopen them to fill
      // in a phone number is two steps for one job.
      const { added } = await addProspects([{
        email,
        contact_name: String(body.contact_name || "").trim(),
        company_name: String(body.company_name || "").trim(),
        title: String(body.title || "").trim(),
        phone: String(body.phone || "").trim(),
        city: String(body.city || "").trim(),
        state: String(body.state || "").trim(),
        tags,
      }], sess, null);

      if (!added || !added.length) {
        return res.status(500).json({ error: "Could not create the contact." });
      }

      const { contacts: refreshed } = await resolveContacts();
      const created = refreshed.find((c) => String(c.id) === `prospect:${added[0].prospect_id}`);
      return res.status(201).json({ ok: true, created: true, contact: created });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!id) return res.status(400).json({ error: "Missing contact id" });

      const patch = {};

      if (body.status !== undefined) {
        const s = String(body.status);
        if (!SUBSCRIPTION_STATUSES.includes(s)) {
          return res.status(400).json({ error: `Unknown status: ${s}` });
        }
        // Bounce and complaint are FACTS reported by the sending provider,
        // not opinions set by hand. Setting them manually corrupts
        // deliverability reporting; clearing them resumes mailing an address
        // that hard bounced or reported the mail as spam.
        if (s === "bounced" || s === "complained") {
          return res.status(400).json({
            error: "Bounce and complaint states are set by the mail provider, not by hand",
          });
        }
        patch.status = s;
      }

      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) return res.status(400).json({ error: "tags must be an array" });
        patch.tags = [...new Set(
          body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        )].sort();
      }

      if (body.reason !== undefined) patch.reason = String(body.reason).trim() || null;

      // ---- detail fields (company/name/title/phone/city/state) ----
      //
      // Allowed on ANY source now, not just prospects. For a prospect this
      // edits MailMe's own record directly; for client/lead/giving it writes
      // a MailMe-local correction layered on top of what BackBone/GivingGauge
      // resolved (see setContactStatus in store.js) — the owning app's real
      // record is never touched, so this can't drift from or fight with a
      // future sync from there.
      const hasFieldEdits = CONTACT_DETAIL_FIELDS.some((f) => body[f] !== undefined);
      if (hasFieldEdits) {
        const { ok, errors, patch: detailPatch } = validateContactDetailPatch(body);
        if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
        Object.assign(patch, detailPatch);
      }

      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update" });

      const result = await setContactStatus(id, patch, sess);
      if (!result.ok) {
        if (result.reason === "not_found") return res.status(404).json({ error: "Contact not found" });
        if (result.reason === "provider_set") {
          return res.status(409).json({
            error: "This address bounced or reported spam. It cannot be resubscribed by hand.",
          });
        }
        return res.status(400).json({ error: "Could not update contact" });
      }
      return res.status(200).json({ ok: true, id: String(id) });
    }

    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || parseBody(req).id || "");
      if (!id) return res.status(400).json({ error: "Missing contact id" });
      if (!id.startsWith("prospect:")) {
        return res.status(400).json({
          error: "Only prospects can be deleted here. Client contacts belong to the BackBone roster.",
        });
      }
      // NOTE: deleting a prospect does NOT clear their suppression entry.
      // That is the point of keeping suppression keyed by email — deleting
      // and re-importing must never resurrect an opt-out.
      const removed = await deleteProspect(id.slice("prospect:".length));
      if (!removed) return res.status(404).json({ error: "Prospect not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("mailme contacts route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
