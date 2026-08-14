// api/promopro/printavo.js — search Printavo and pull one job's line items,
// so a PO can be filled in from the quote instead of retyped.
//
// GET ?q=<term>   search invoices by number or customer name (light shape)
// GET ?id=<id>    one invoice WITH line items (what autofill uses)
//
// Read-only against Printavo. There is no write path here on purpose: this
// route exists to copy information OUT of Printavo, and nothing in PromoPro
// should be able to change a quote.
//
// Answers 200 with configured:false when Printavo env vars are missing,
// rather than erroring, the same shape WebsiteWidget's stats route uses so
// the front end can show a setup notice instead of a broken screen.

import { requireAuth } from "../../lib/session.js";
import { isConfigured, searchInvoices, getInvoice } from "../../lib/promopro/printavo-lookup.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(200).json({
      configured: false,
      results: [],
      invoice: null,
      note: "Printavo is not configured. Set PRINTAVO_API_TOKEN and PRINTAVO_EMAIL in Vercel.",
    });
  }

  try {
    const id = req.query && req.query.id;
    if (id) {
      const invoice = await getInvoice(String(id));
      if (!invoice) return res.status(404).json({ configured: true, error: "Invoice not found" });
      return res.status(200).json({ configured: true, invoice });
    }

    const q = (req.query && req.query.q) || "";
    if (!String(q).trim()) return res.status(200).json({ configured: true, results: [] });

    const results = await searchInvoices(String(q), req.query && req.query.limit);
    return res.status(200).json({ configured: true, results });
  } catch (e) {
    console.error("promopro/printavo route error:", e);
    // A Printavo outage or a rate limit should not look like a broken app.
    // 200 with an error string lets the form say "search is unavailable, fill
    // it in manually" instead of failing shut.
    return res.status(200).json({ configured: true, results: [], invoice: null, error: e.message });
  }
}
