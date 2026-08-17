// api/promopro/print.js — the purchase order as a printable page.
//
// GET ?id=<poId>  ->  a standalone HTML page with a Print button.
//
// Serves HTML, not JSON, because it is opened in a tab rather than fetched.
// The browser's own print dialog turns it into a PDF, which is why there is
// no PDF library in this repo: it would be a second dependency doing a job
// the browser already does, and it would need its own layout kept in step
// with the emailed copy. Same renderer feeds both, so they cannot drift.
//
// Requires a session. A PO carries our costs, which is not something to serve
// on a guessable URL.

import { requireAuth } from "../../lib/session.js";
import { getPo, getVendors, getSettings } from "../../lib/promopro/store.js";
import { withSettingDefaults } from "../../lib/promopro/schema.js";
import { renderPrintPage } from "../../lib/promopro/document.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: "id is required" });

    const po = await getPo(String(id));
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    const [vendors, storedSettings] = await Promise.all([getVendors(), getSettings()]);
    const settings = withSettingDefaults(storedSettings);
    const vendor = vendors.find((v) => v.id === po.vendorId) || null;

    const html = renderPrintPage(po, vendor, {
      brand: {
        name: settings.brandName || "P&M Apparel",
        address: settings.defaultShipTo || "",
        phone: settings.brandPhone || "",
      },
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    console.error("promopro/print route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
