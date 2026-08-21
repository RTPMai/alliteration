// api/promopro/pos.js — purchase orders.
//
// GET     list, or one by ?id=
// POST    create
// PATCH   update (advancing a stage IS setting a date, so it comes through here)
// DELETE  remove, admin/superuser only
//
// The routes live in api/promopro/ as a FOLDER, never a flat
// api/promopro.js. Vercel treats a file and a same-named folder as a route
// conflict once .js is stripped, which is the trap WebsiteWidget hit in
// August when it needed a second route.
//
// ACCESS. Read is open to anyone who can open the app, because the whole
// point is that AMs can see where an order sits without asking. Write
// requires can_edit. Delete requires admin or superuser: a PO is a financial
// document sent to an outside party, so removing the record of one should
// not be a normal-day action.

import { requireAuth } from "../../lib/session.js";
import { isAdminSession, canEditSession } from "../../lib/promopro/access.js";
import { validateNew, validatePatch, yearPrefix, poTotal, currentStage, withSettingDefaults } from "../../lib/promopro/schema.js";
import { blacklistWarning } from "../../lib/promopro/vendor-stats.js";
import { listPos, getPo, savePo, updatePo, deletePo, getVendors, nextManualSeq, getSettings } from "../../lib/promopro/store.js";
import { listEmployees } from "../../lib/crewcore/store.js";
import { effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function newId() {
  return `po_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  // A CrewCore outage must not block purchase orders. It only matters when
  // nothing has been saved in Settings yet, which is the first-run case.
  async function roster() {
    try {
      return await listEmployees();
    } catch (e) {
      console.error("promopro/pos could not read the CrewCore roster:", e);
      return [];
    }
  }

  try {
    const settingsForGate = await getSettings();
    const [isAdmin, canEdit] = await Promise.all([
      isAdminSession(sess),
      canEditSession(sess, settingsForGate),
    ]);

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        const po = await getPo(String(id));
        if (!po) return res.status(404).json({ error: "Not found" });
        return res.status(200).json({ po });
      }
      const pos = await listPos();
      return res.status(200).json({ pos });
    }

    if (!canEdit) return res.status(403).json({ error: "Read-only access" });

    if (req.method === "POST") {
      const body = parseBody(req);
      const [vendors, settings, employees] = await Promise.all([getVendors(), getSettings(), roster()]);
      const amIds = effectiveAccountManagerIds(settings, employees);
      const check = validateNew(body, vendors.map((v) => v.id), amIds);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      // A blacklisted vendor is refused once, with the reason, and allowed
      // through only when the caller comes back having said yes to that
      // specific warning. Enforced HERE and not only in the browser: the
      // confirmation is the record that somebody made the decision, and a
      // check that only exists on screen is not a check.
      const chosenVendor = vendors.find((v) => v.id === check.record.vendorId) || null;
      if (chosenVendor && chosenVendor.blacklisted === true && body.confirmBlacklist !== true) {
        return res.status(409).json({
          error: blacklistWarning(chosenVendor),
          blacklisted: true,
          vendorId: chosenVendor.id,
          vendorName: chosenVendor.name,
          reason: chosenVendor.blacklistReason || "",
        });
      }

      const createdAt = new Date().toISOString();
      const year = yearPrefix(createdAt);

      // A manual order has no invoice number to build a PO number from, so it
      // draws from a per-year counter instead. Only spend a counter value on
      // orders that actually need one.
      const manualSeq = check.record.printavo ? null : await nextManualSeq(year);

      const record = {
        id: newId(),
        poNumber: null,          // stamped by savePo, which also renumbers siblings
        year,
        manualSeq,
        ...check.record,
        owner: check.record.owner || String(sess.username || "").toLowerCase(),
        createdBy: String(sess.username || "").toLowerCase(),
        createdAt,
        submittedAt: null,
        confirmedAt: null,
        artSentAt: null,
        artApprovedAt: null,
        paymentSentAt: null,
        shippedAt: null,
        receivedAt: null,
        closedAt: null,
        cancelledAt: null,
        trackingNumber: "",
        carrier: "",
        decorateBufferDays: Number(body.decorateBufferDays) || 0,
        receipts: [],
        history: [
          { at: createdAt, by: String(sess.username || "").toLowerCase(), what: "created" },
          // The override is part of the order's own record, not a log line
          // somewhere else, so the next person to open this PO can see that
          // ordering from a blacklisted vendor was a decision somebody made.
          ...(chosenVendor && chosenVendor.blacklisted === true
            ? [{
                at: createdAt,
                by: String(sess.username || "").toLowerCase(),
                what: `raised against blacklisted vendor ${chosenVendor.name}`,
              }]
            : []),
        ],
      };

      const saved = await savePo(record);
      return res.status(200).json({ ok: true, po: saved, total: poTotal(saved) });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!id) return res.status(400).json({ error: "id is required" });

      const existing = await getPo(String(id));
      if (!existing) return res.status(404).json({ error: "Not found" });

      const [vendors, settings, employees] = await Promise.all([getVendors(), getSettings(), roster()]);
      const amIds = effectiveAccountManagerIds(settings, employees);
      const check = validatePatch(body, vendors.map((v) => v.id), amIds);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      // History records the STAGE change, not every keystroke. A note edit is
      // not interesting; a PO moving from confirmed to shipped is.
      const before = currentStage(existing);
      const after = currentStage({ ...existing, ...check.patch });
      const history = Array.isArray(existing.history) ? existing.history.slice() : [];
      if (after !== before) {
        history.push({
          at: new Date().toISOString(),
          by: String(sess.username || "").toLowerCase(),
          what: `${before} to ${after}`,
        });
      }

      const saved = await updatePo(String(id), { ...check.patch, history });
      return res.status(200).json({ ok: true, po: saved, total: poTotal(saved) });
    }

    if (req.method === "DELETE") {
      if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: "id is required" });
      const gone = await deletePo(String(id));
      if (!gone) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/pos route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
