// api/promopro/vendors.js — the vendor list and its per-vendor timing.
//
// GET is open to anyone who can open the app: every PO screen needs vendor
// names and lead times to show a due date or a health colour, so gating the
// read would just break the dashboard for AMs.
//
// WRITES ARE SPLIT, changed Aug 2026.
//
// CREATE is open to anyone who can raise a purchase order. Adding "SanMar,
// orders@sanmar.com" while you are mid-order is data entry, and forcing a
// trip to another tab to do it is how people either give up or pick the
// wrong vendor because it was already in the list. The quick-add form on the
// order screen posts here.
//
// CHANGE and REMOVE stay admin/superuser, the same gate WebsiteWidget's
// Manage Sites uses and for the same reason: editing a lead time changes
// what counts as late for the whole team, and the blacklist is a warning
// other people rely on. Neither is a personal preference.

import { requireAuth } from "../../lib/session.js";
import { isAdminSession, canEditSession } from "../../lib/promopro/access.js";
import { validateVendor, blacklistJustSet } from "../../lib/promopro/vendors.js";
import { withStats } from "../../lib/promopro/vendor-stats.js";
import { getVendors, saveVendors, listPos } from "../../lib/promopro/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function newId() {
  return `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const isAdmin = await isAdminSession(sess);

    if (req.method === "GET") {
      // Stats are computed from the purchase orders on every read rather
      // than stored on the vendor. A stored figure would be a second copy of
      // something the POs already say, and it would be wrong the moment a
      // date got corrected. See lib/promopro/vendor-stats.js.
      const [vendors, pos] = await Promise.all([getVendors(), listPos()]);
      return res.status(200).json({ vendors: withStats(vendors, pos) });
    }

    if (req.method === "POST") {
      if (!(await canEditSession(sess))) {
        return res.status(403).json({ error: "You do not have access to raise purchase orders, so you cannot add a vendor." });
      }
      const body = parseBody(req);
      const check = validateVendor(body, null);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      const vendors = await getVendors();
      const vendor = { ...check.vendor, id: newId() };
      // Blacklisting is an admin act even at creation. Otherwise the quick-add
      // form becomes a way to put a warning in front of the whole team.
      if (vendor.blacklisted && !isAdmin) {
        vendor.blacklisted = false;
        vendor.blacklistReason = "";
      }
      if (vendor.blacklisted) {
        vendor.blacklistedAt = new Date().toISOString();
        vendor.blacklistedBy = String(sess.username || "").toLowerCase();
      }
      vendors.push(vendor);
      await saveVendors(vendors);
      return res.status(200).json({ ok: true, vendor, vendors });
    }

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = body.id;
      if (!id) return res.status(400).json({ error: "id is required" });

      const vendors = await getVendors();
      const i = vendors.findIndex((v) => v.id === id);
      if (i === -1) return res.status(404).json({ error: "Not found" });

      const check = validateVendor(body, vendors[i]);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      const next = { ...check.vendor, id };
      // Who blacklisted a vendor and when is the part that stops the flag
      // becoming folklore. Only stamped on the transition, so an unrelated
      // edit does not reset the original date.
      if (blacklistJustSet(vendors[i], next)) {
        next.blacklistedAt = new Date().toISOString();
        next.blacklistedBy = String(sess.username || "").toLowerCase();
      }
      vendors[i] = next;
      await saveVendors(vendors);
      return res.status(200).json({ ok: true, vendor: vendors[i], vendors });
    }

    if (req.method === "DELETE") {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: "id is required" });

      // A vendor with POs against it is deactivated, never removed. Deleting
      // it would leave those POs pointing at a vendor that no longer exists,
      // and the health maths would silently fall back to zero lead time,
      // which reads as "on schedule" instead of "unknown".
      const pos = await listPos();
      const inUse = pos.some((p) => p.vendorId === id);

      const vendors = await getVendors();
      const i = vendors.findIndex((v) => v.id === id);
      if (i === -1) return res.status(404).json({ error: "Not found" });

      if (inUse) {
        vendors[i] = { ...vendors[i], active: false };
        await saveVendors(vendors);
        return res.status(200).json({ ok: true, deactivated: true, vendors });
      }

      vendors.splice(i, 1);
      await saveVendors(vendors);
      return res.status(200).json({ ok: true, deactivated: false, vendors });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/vendors route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
