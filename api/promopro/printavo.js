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
import { isConfigured, searchInvoices, getInvoice, probeTypes, probeInvoice } from "../../lib/promopro/printavo-lookup.js";
import { isAdminSession } from "../../lib/promopro/access.js";

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
    // ?id=<id>&probe=1 — read-only schema dump, admin only. Exists so the
    // item-number field and the imprint numbering can be read off this
    // account rather than guessed at. Guessing has cost real time already.
    if (req.query && req.query.probe && (req.query.id || req.query.q)) {
      if (!(await isAdminSession(sess))) return res.status(403).json({ error: "Admin access required" });

      // Accept an invoice NUMBER, not just an internal id. The hash in the
      // Printavo web URL is not the GraphQL id, which cost a round trip:
      // the probe answered "Field id with value f76a...: Not found" and told
      // us nothing about the schema question we were actually asking.
      let probeId = req.query.id ? String(req.query.id) : null;
      let resolvedFrom = null;
      if (!probeId && req.query.q) {
        const hits = await searchInvoices(String(req.query.q), 1);
        if (!hits.length) {
          return res.status(200).json({ configured: true, probe: { error: "No invoice matched " + String(req.query.q) } });
        }
        probeId = hits[0].id;
        resolvedFrom = { invoiceNumber: hits[0].invoiceNumber, customerName: hits[0].customerName };
      }

      const types = await probeTypes();
      let invoice = null;
      let query = null;
      let probeError = null;
      try {
        const r = await probeInvoice(String(probeId), types);
        invoice = r.invoice;
        query = r.query;
      } catch (e) {
        probeError = e.message;
      }
      // `types` is large and mostly noise once the invoice comes back, so it
      // is only included when the data fetch failed and the field list is
      // what would explain why.
      const body = { configured: true, probe: { resolvedFrom, invoice, query, probeError } };
      if (probeError || !invoice) body.probe.types = types;
      return res.status(200).json(body);
    }

    const id = req.query && req.query.id;
    if (id) {
      const { invoice, via, tried } = await getInvoice(String(id));
      if (!invoice) {
        // 200, not 404. The front end has to be able to TELL the user what
        // went wrong, and `tried` carries the actual Printavo messages. A
        // bare 404 here is what made clicking a search result do nothing.
        return res.status(200).json({
          configured: true,
          invoice: null,
          error: (tried[tried.length - 1] && tried[tried.length - 1].error) || "Printavo returned nothing for that order",
          tried,
        });
      }
      return res.status(200).json({ configured: true, invoice, via });
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
