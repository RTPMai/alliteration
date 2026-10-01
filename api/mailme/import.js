// api/mailme/import.js — cold-outreach contact import.
//
// POST { csv, commit?, tags?, batchLabel?, listName? }
//
// listName (Oct 1 2026): the list this upload is for. The preview reports the
// list before and after; the commit imports the new people AND puts everyone
// on the list in this one request. It used to be a second step run in the
// browser, which could act on stale list data and left the list at 7.
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
import {
  parseProspectCsv, classifyRows, domainBreakdown, listAdditions,
  findListByName, planListAdd, peopleCount,
} from "../../lib/mailme/import.js";
import {
  knownEmails, addProspects, deleteProspectBatch, resolveContacts,
  listLists, createList, updateList,
} from "../../lib/mailme/store.js";
import { resolveList } from "../../lib/mailme/schema.js";

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

    // Rows already known to MailMe that can go on the named list as they are.
    // See listAdditions() in lib/mailme/import.js.
    const { contacts } = await resolveContacts();
    const additions = listAdditions(classified, contacts);

    const summary = {
      parsed: rows.length,
      addableToList: additions.emails.length,
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

    const listName = body.listName ? String(body.listName).trim() : "";
    const lists = listName ? await listLists() : [];
    const target = listName ? findListByName(lists, listName) : null;
    const memberIdsOf = (l) => (l ? resolveList(l, contacts).map((c) => String(c.id)) : []);

    // ---- dry run (default) ----
    if (!body.commit) {
      let listPlan = null;
      if (listName) {
        const current = memberIdsOf(target);
        const plan = planListAdd(target, additions.ids, current, listName);
        const before = peopleCount(current, contacts);
        const adding = peopleCount(plan.addingIds, contacts);
        listPlan = {
          name: target ? target.name : listName,
          exists: !!target,
          kind: target ? target.kind : "static",
          before,
          addingExisting: adding,
          alreadyOn: peopleCount(plan.alreadyIds, contacts),
          addingNew: classified.new.length,
          after: before + adding + classified.new.length,
        };
      }
      return res.status(200).json({
        ok: true,
        dryRun: true,
        summary,
        listPlan,
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
    // `addExisting` without a listName is the older client: it puts the
    // returned ids on the list itself. Kept so a cached page still works
    // for the one deploy where both exist.
    const addExisting = !!body.addExisting || !!listName;
    const current = memberIdsOf(target);
    const knownToAdd = listName
      ? planListAdd(target, additions.ids, current, listName).addingIds
      : additions.ids;

    if (!classified.new.length && !(addExisting && knownToAdd.length)) {
      const error = listName && additions.ids.length
        ? `Everyone in that file is already on "${target ? target.name : listName}". Nothing to add.`
        : "Nothing importable in that file";
      return res.status(400).json({ error, summary });
    }

    let batchId = null;
    let added = [];
    if (classified.new.length) {
      batchId = "BATCH-" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
      const rowsWithTags = classified.new.map((r) => ({ ...r, tags }));
      ({ added } = await addProspects(rowsWithTags, sess, batchId));
    }

    // The list, in the same request. A failure here is reported on its own,
    // because the people above ARE imported and must not be imported twice.
    let list = null;
    let listError = null;
    if (listName) {
      try {
        const newIds = added.map((r) => `prospect:${r.prospect_id}`);
        const plan = planListAdd(target, additions.ids.concat(newIds), current, listName);
        const saved = plan.action === "create"
          ? await createList(plan.patch, sess)
          : await updateList(target.id, plan.patch);
        const after = await resolveContacts();
        const members = resolveList(saved, after.contacts);
        list = {
          id: saved.id,
          name: saved.name,
          created: plan.action === "create",
          added: peopleCount(plan.addingIds, after.contacts),
          alreadyOn: peopleCount(plan.alreadyIds, after.contacts),
          memberCount: peopleCount(members.map((m) => String(m.id)), after.contacts),
        };
      } catch (e) {
        console.error("mailme import list step failed:", e);
        listError = e.message || "the list could not be updated";
      }
    }

    return res.status(201).json({
      ok: true,
      dryRun: false,
      imported: added.length,
      list,
      listError,
      // Older client only: existing contacts for it to put on the list.
      listMemberIds: (!listName && addExisting) ? additions.ids : [],
      addedToList: (!listName && addExisting) ? additions.emails.length : 0,
      batchId,
      batchLabel: body.batchLabel ? String(body.batchLabel).trim() : null,
      summary,
    });
  } catch (e) {
    console.error("mailme import route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
