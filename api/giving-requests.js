// PUT IN: api/giving-requests.js (REPLACES the current one)
// api/giving-requests.js — read and update donation requests.
//
//   GET    /api/giving-requests            list (what the app loads)
//   GET    /api/giving-requests?id=REQ-1   one request
//   PATCH  /api/giving-requests?id=REQ-1   record a decision or a classification
//   POST   /api/giving-requests?action=backfill
//                                          pull existing Jotform submissions
//   POST   /api/giving-requests?action=manual
//                                          a request typed in by hand
//
// Everything here requires a signed-in session. The public webhook lives in
// api/giving-intake.js and can only create.
//
// WHO MAY DO WHAT, Sep 2026. Three gates, all answered by
// lib/giving-access.js, which apps/givinggauge.js asks the same questions so
// a hidden button and a refused request always agree:
//
//   read            anyone who can open the app
//   add / correct   can_edit (typing in a request, recording what it cost,
//                   fixing a classification, attaching an account)
//   approve/decline the per-role can_decide_giving switch in Settings
//   import/rematch  an all-data role that can edit, or the Admin flag
//
// This replaces `sess.role !== "admin" && sess.role !== "manager"`, which
// matched two role names literally and so refused every role created in
// Settings, and it puts a gate on deciding, which had none at all.

import { requireAuth } from "../lib/session.js";
import { getUser, getRole } from "../lib/users.js";
import { givingAddVerdict, givingDecideVerdict, givingManageVerdict } from "../lib/giving-access.js";
import { listRequests, getRequest, updateRequest, buildRequest, buildManualRequest, saveRequest, alreadyHave, attachAccount, repairRequest } from "../lib/giving.js";
import { isConfigured } from "../lib/kv.js";
import { applyClassification } from "../lib/giving-classify.js";
import { summarise } from "../lib/giving-summary.js";

const JOTFORM_API = "https://api.jotform.com";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  // Resolved once per request. A session can carry a role but no username
  // (see lib/promopro/access.js for how that bit an admin), so the role is
  // read off the account when there is one and off the session when there is
  // not, which is what every working gate in the shell does.
  const account = sess.username ? await getUser(sess.username) : null;
  const callerRole = await getRole(account ? account.role : sess.role);
  const mayAdd = givingAddVerdict(account, callerRole);
  const mayDecide = givingDecideVerdict(account, callerRole);
  const mayManage = givingManageVerdict(account, callerRole);

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const id = (req.query && req.query.id) || body.id || null;
  const action = (req.query && req.query.action) || body.action || "";

  try {
    if (req.method === "GET") {
      // Spend rollups: by month, by year, all time, and per client against
      // what that client spends with us. Must be checked before the id and
      // list branches, both of which return.
      if (action === "summary") {
        const rows = await listRequests();
        return res.status(200).json(summarise(rows, {
          measure: (req.query && req.query.measure) || "cost",
          basis: (req.query && req.query.basis) || "lifetime"
        }));
      }

      if (id) {
        const row = await getRequest(id);
        if (!row) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(row);
      }
      const requests = await listRequests();
      return res.status(200).json({ requests });
    }

    // Re-run roster matching over requests already in the queue. Everything
    // stored before auto-matching existed came in as "Not a customer", and
    // re-importing will not fix them: the endpoint skips submissions it
    // already has, by design. This is the one-click repair for that backlog.
    if (req.method === "POST" && action === "rematch") {
      // Rewrites every stored request in one press. Same gate as the import.
      if (!mayManage.allowed) {
        return res.status(403).json({ error: "Re-matching every request is an admin action. " + mayManage.why + "." });
      }
      const rows = await listRequests();
      let matched = 0, already = 0, unmatched = 0, repaired = 0;
      const recovered = {};

      for (const row of rows) {
        let dirty = false;

        // Re-derive location, date and the rest from the stored payload. Rows
        // saved before a mapping fix keep the old parse until this runs.
        const out = repairRequest(row);
        if (out.changed.length) {
          dirty = true;
          repaired++;
          out.changed.forEach((f) => { recovered[f] = (recovered[f] || 0) + 1; });
        }

        if (row.account && row.account.found) {
          already++;
        } else {
          await attachAccount(row);
          if (row.account && row.account.found) { matched++; dirty = true; }
          else unmatched++;
        }

        if (dirty) await saveRequest(row);
      }

      return res.status(200).json({
        ok: true, matched, already, unmatched, repaired,
        recovered, total: rows.length
      });
    }

    // A request that never came through the Jotform: a phone call, a walk-in,
    // or a donation from before the form existed that belongs on the books.
    // It runs through the same builder, the same roster match and the same
    // classifier as an imported one, so it is scored on identical terms.
    if (req.method === "POST" && action === "manual") {
      if (!mayAdd.allowed) {
        return res.status(403).json({ error: "Adding a request needs edit rights. " + mayAdd.why + "." });
      }

      const row = buildManualRequest(body.request || body, {
        submittedAt: body.submittedAt || undefined,
        enteredBy: sess.name || sess.username
      });

      await attachAccount(row);
      applyClassification(row);

      // Optionally decided on the way in. Somebody entering a donation from
      // last spring already knows the answer, and making them save it twice is
      // how half of them end up sitting in the queue as pending forever.
      const decision = body.decision || {};
      // Approving on the way in is still a decision. Somebody who may add a
      // request but not judge one cannot get around the gate by ticking
      // "already decided" on the entry form.
      if ((decision.status === "approved" || decision.status === "declined") && !mayDecide.allowed) {
        return res.status(403).json({
          error: "That request can be added, but not already approved or declined. " + mayDecide.why + "."
        });
      }
      if (decision.status === "approved" || decision.status === "declined") {
        row.status = decision.status;
        row.decidedBy = sess.name || sess.username;
        row.decidedAt = decision.decidedAt || new Date().toISOString();
        // Entered after the fact and marked as such, so an override on a
        // backdated record is not read as somebody ignoring the engine today.
        row.override = true;
        if (decision.note) row.note = String(decision.note);
      }

      await saveRequest(row);

      // Spend goes through updateRequest so the money parsing, the recordedBy
      // stamp and the fulfilled-date default all live in one place.
      const spend = body.fulfillment || {};
      const hasSpend = spend.retailValue !== undefined || spend.cost !== undefined ||
                       spend.notes !== undefined || spend.fulfilledAt !== undefined;
      if (hasSpend && row.status === "approved") {
        const saved = await updateRequest(row.id, {
          fulfillment: Object.assign({}, spend, { recordedBy: sess.name || sess.username })
        });
        return res.status(200).json({ ok: true, request: saved });
      }

      return res.status(200).json({ ok: true, request: row });
    }

    if (req.method === "POST" && action === "backfill") {
      // Writing a batch of records is an admin action.
      if (!mayManage.allowed) {
        return res.status(403).json({ error: "Importing from Jotform is an admin action. " + mayManage.why + "." });
      }
      return await backfill(req, res, body);
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      if (!id) return res.status(400).json({ error: "id is required" });

      // A decision and a correction arrive down the same route, so they are
      // separated here rather than by method. Everything that is not a status
      // change is ordinary record-keeping and needs edit rights; the status
      // itself is the one thing that needs the decide switch.
      if (body.status && !mayDecide.allowed) {
        return res.status(403).json({ error: "Approving and declining is off for your role. " + mayDecide.why + "." });
      }
      const editing = body.note !== undefined || body.request || body.account ||
                      body.fulfillment || body.override !== undefined;
      if (editing && !mayAdd.allowed) {
        return res.status(403).json({ error: "Changing a request needs edit rights. " + mayAdd.why + "." });
      }

      const patch = {};
      if (body.status)   patch.status = body.status;
      if (body.note !== undefined) patch.note = body.note;
      if (body.request)  patch.request = body.request;   // human classification
      if (body.account)  patch.account = body.account;
      if (body.override !== undefined) patch.override = body.override;

      // Recorded spend. Stamped with who entered it, from the session.
      if (body.fulfillment) {
        patch.fulfillment = Object.assign({}, body.fulfillment, {
          recordedBy: sess.name || sess.username
        });
      }

      // Stamp WHO decided from the session, never from the payload — otherwise
      // the audit trail is whatever the client claimed.
      if (body.status) patch.decidedBy = sess.name || sess.username;

      const row = await updateRequest(id, patch);
      return res.status(200).json({ ok: true, request: row });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("giving-requests error:", e);
    const isClient = /not found|required/i.test(e.message);
    return res.status(isClient ? 400 : 500).json({ error: e.message });
  }
}

/* ------------------------------------------------------------------ *
 * BACKFILL
 *
 * One-time pull of submissions already sitting in Jotform. Safe to run more
 * than once: anything already stored is skipped by submission id.
 * ------------------------------------------------------------------ */

async function backfill(req, res, body) {
  const apiKey = process.env.JOTFORM_API_KEY;
  const formId = process.env.JOTFORM_FORM_ID;

  if (!apiKey || !formId) {
    return res.status(503).json({
      error: "Backfill needs JOTFORM_API_KEY and JOTFORM_FORM_ID in the environment."
    });
  }

  // Default to the start of this calendar year. Older submissions are for
  // events that already happened; they would all disqualify on lead time and
  // bury the live queue.
  const since = body.since || new Date().getFullYear() + "-01-01";

  const url = JOTFORM_API + "/form/" + encodeURIComponent(formId) +
              "/submissions?apiKey=" + encodeURIComponent(apiKey) +
              "&limit=1000&orderby=created_at";

  let payload;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    try { payload = JSON.parse(text); }
    catch (e) { throw new Error("Jotform returned a non-JSON response (HTTP " + r.status + ")"); }
    if (!r.ok) {
      throw new Error("Jotform API error " + r.status + ": " + (payload.message || text.slice(0, 120)));
    }
  } catch (e) {
    return res.status(502).json({ error: "Could not reach Jotform: " + e.message });
  }

  const subs = Array.isArray(payload.content) ? payload.content : [];

  const result = { found: subs.length, imported: 0, skipped: 0, tooOld: 0, failed: 0, errors: [] };

  for (const sub of subs) {
    try {
      const created = String(sub.created_at || "").slice(0, 10);
      if (created && created < since) { result.tooOld++; continue; }

      if (await alreadyHave(sub.id)) { result.skipped++; continue; }

      const row = buildRequest(sub, {
        jotformId: sub.id,
        source: "jotform-backfill",
        submittedAt: sub.created_at
          ? new Date(sub.created_at).toISOString()
          : new Date().toISOString()
      });

      await attachAccount(row);
      applyClassification(row);
      await saveRequest(row);
      result.imported++;
    } catch (e) {
      result.failed++;
      // Keep going. One malformed submission should not abort the whole import.
      if (result.errors.length < 5) result.errors.push({ id: sub.id, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, since, ...result });
}
