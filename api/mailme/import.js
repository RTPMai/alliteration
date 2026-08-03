// api/mailme/import.js — cold-outreach contact import.
//
// POST { csv, commit?, tags?, batchLabel? }
//
// TWO-PHASE ON PURPOSE. The default is a DRY RUN: it parses, classifies and
// returns exactly what would happen, importing nothing. Only commit:true
// writes. An import is the one bulk action here that is hard to eyeball
// afterwards, so the preview is not optional politeness — it is the check
// that stops 800 mis-mapped rows entering the list.
//
// Every rejected row is returned with a reason. Rows are never silently
// dropped: an import of 1,000 quietly becoming 640 is how a list develops
// holes nobody can explain later.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe, canEditMailMe } from "../../lib/mailme/access.js";
import { parseProspectCsv, classifyRows, domainBreakdown } from "../../lib/mailme/import.js";
import { knownEmails, addProspects, deleteProspectBatch } from "../../lib/mailme/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Guardrail against a paste that would blow the request or the KV value size.
const MAX_ROWS = 5000;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;
  if (!(await requireMailMe(sess, res))) return;
  if (!(await canEditMailMe(sess))) {
    return res.status(403).json({ error: "Your role is read-only in MailMe" });
  }

  try {
    // Undo a batch. Kept on this route because "undo the import" belongs with
    // "do the import" rather than buried in the contacts route.
    if (req.method === "DELETE") {
      const batchId = (req.query && req.query.batch) || parseBody(req).batchId;
      if (!batchId) return res.status(400).json({ error: "Missing batch id" });
      const removed = await deleteProspectBatch(batchId);
      return res.status(200).json({ ok: true, removed, batchId });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req);
    const csv = body.csv;
    if (!csv || !String(csv).trim()) {
      return res.status(400).json({ error: "No CSV content supplied" });
    }

    const { rows, headers, unmapped, errors } = parseProspectCsv(csv);
    if (errors.length) {
      return res.status(400).json({ error: errors[0], headers, unmapped });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({
        error: `That file has ${rows.length} rows; the limit is ${MAX_ROWS} per import. Split it and import in batches.`,
      });
    }

    const known = await knownEmails();
    const classified = classifyRows(rows, known);

    // Tags applied to the whole batch — how a cold list gets segmented on the
    // way in ("trade-show-2026", "school-districts") rather than one by one.
    const tags = Array.isArray(body.tags)
      ? [...new Set(body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
      : [];

    const summary = {
      parsed: rows.length,
      importable: classified.new.length,
      duplicate: classified.duplicate.length,
      existingClients: classified.existing.length,
      suppressed: classified.suppressed.length,
      invalid: classified.invalid.length,
      headers,
      unmappedColumns: unmapped,
      topDomains: domainBreakdown(classified.new),
      tags,
    };

    // ---- dry run (default) ----
    if (!body.commit) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        summary,
        // Capped: the preview needs to be reviewable, not exhaustive.
        preview: classified.new.slice(0, 25),
        rejected: {
          duplicate: classified.duplicate.slice(0, 25),
          existingClients: classified.existing.slice(0, 25),
          suppressed: classified.suppressed.slice(0, 25),
          invalid: classified.invalid.slice(0, 25),
        },
      });
    }

    // ---- commit ----
    if (!classified.new.length) {
      return res.status(400).json({ error: "Nothing importable in that file", summary });
    }

    const batchId = "BATCH-" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const rowsWithTags = classified.new.map((r) => ({ ...r, tags }));
    const { added } = await addProspects(rowsWithTags, sess, batchId);

    return res.status(201).json({
      ok: true,
      dryRun: false,
      imported: added.length,
      batchId,
      batchLabel: body.batchLabel ? String(body.batchLabel).trim() : null,
      summary,
    });
  } catch (e) {
    console.error("mailme import route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
