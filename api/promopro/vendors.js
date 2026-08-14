// api/promopro/vendors.js — the vendor list and its per-vendor timing.
//
// GET is open to anyone who can open the app: every PO screen needs vendor
// names and lead times to show a due date or a health colour, so gating the
// read would just break the dashboard for AMs.
//
// Writes are admin/superuser only, the same gate WebsiteWidget's Manage Sites
// uses and for the same reason: changing a vendor's lead time changes what
// counts as late for the whole team, not one person's preference.

import { requireAuth } from "../../lib/session.js";
import { isAdminSession } from "../../lib/promopro/access.js";
import { validateVendor } from "../../lib/promopro/vendors.js";
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
      const vendors = await getVendors();
      return res.status(200).json({ vendors });
    }

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "POST") {
      const body = parseBody(req);
      const check = validateVendor(body, null);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      const vendors = await getVendors();
      const vendor = { ...check.vendor, id: newId() };
      vendors.push(vendor);
      await saveVendors(vendors);
      return res.status(200).json({ ok: true, vendor, vendors });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = body.id;
      if (!id) return res.status(400).json({ error: "id is required" });

      const vendors = await getVendors();
      const i = vendors.findIndex((v) => v.id === id);
      if (i === -1) return res.status(404).json({ error: "Not found" });

      const check = validateVendor(body, vendors[i]);
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

      vendors[i] = { ...check.vendor, id };
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
