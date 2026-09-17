// PUT IN: lib/reviews/engine.js
// lib/reviews/engine.js: what the cron and the buttons actually do.
//
// Two halves, kept apart on purpose:
//
//   INTAKE   detect() turns "this order is at PICKED-UP" into a queued record.
//            It knows nothing about sending. Today its source is a Printavo
//            status check; if that ever changes (a webhook, a different sync),
//            only detect() changes and the queue does not notice.
//   SENDING  sendDue() / sendOne() take queued records to sent or skipped.
//            They know nothing about Printavo.
//
// Everything is passed in (store, gql, sender, suppression reader, clock), so
// the tests run these exact functions against fakes. The api/ routes are thin
// wrappers that supply the real ones.
//
// ESM. Do NOT convert to module.exports.

import { buildRecord, decideSkip, renderEmail, isDue, MAX_ATTEMPTS, normalizeEmail } from "./schema.js";
import { walkTriggerOrders } from "./printavo.js";

const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------------------ *
 * INTAKE
 * ------------------------------------------------------------------ */

/**
 * Queue one order unless it has been seen before. Exported on its own so a
 * future source can call it without the Printavo walk.
 *
 * `seeding` is true until the first complete check has finished. Every order
 * found then was already at its status BEFORE this app existed, which means
 * Zapier has emailed it or is about to. Those are remembered and never queued.
 */
export async function intakeOrder(deps, order, { seen, seeding, settings, now }) {
  const id = String(order.invoiceId || "");
  if (!id || seen[id]) return "seen";
  const at = iso(now);
  await deps.store.markSeen(id, at);
  seen[id] = at;
  if (seeding) return "baseline";
  const existing = await deps.store.getRecord(id);
  if (existing) return "exists";
  await deps.store.insertRecord(buildRecord(order, settings, at));
  return "queued";
}

export async function detect(deps, { settings, now, deadline }) {
  const store = deps.store;
  const state = await store.getState();
  const seen = await store.getSeen();
  const seeding = !state.seededAt;
  const tally = { queued: 0, baseline: 0 };

  const walk = await walkTriggerOrders({
    gql: deps.gql,
    statuses: settings.statuses,
    lookbackDays: settings.lookbackDays,
    cursor: state.pollCursor || null,
    now,
    deadline,
    pauseMs: deps.pauseMs,
    onPage: async (orders) => {
      for (const order of orders) {
        const r = await intakeOrder(deps, order, { seen, seeding, settings, now });
        if (tally[r] != null) tally[r]++;
      }
    },
  });

  const summary = {
    at: iso(now),
    complete: walk.complete,
    mode: walk.mode,
    pages: walk.pages,
    found: walk.found,
    queued: tally.queued,
    baseline: tally.baseline,
    matchedStatuses: walk.matchedStatuses.map((s) => s.name),
    missingStatuses: walk.missingStatuses,
    error: null,
  };
  await store.patchState({
    pollCursor: walk.complete ? null : walk.cursor,
    lastCheck: summary,
    seededAt: state.seededAt || (walk.complete ? iso(now) : null),
  });
  return summary;
}

/* ------------------------------------------------------------------ *
 * SENDING
 * ------------------------------------------------------------------ */

async function loadContext(deps, settings, now) {
  const [reviewed, lastSent, suppression] = await Promise.all([
    deps.store.getReviewed(),
    deps.store.getLastSent(),
    deps.getSuppression ? deps.getSuppression() : Promise.resolve({}),
  ]);
  return { reviewed, lastSent, suppression: suppression || {}, settings, now };
}

function note(rec, what, by, at, extra) {
  rec.history = Array.isArray(rec.history) ? rec.history : [];
  rec.history.push(Object.assign({ at, what, by: by || "system" }, extra || {}));
  if (rec.history.length > 30) rec.history = rec.history.slice(-30);
}

/**
 * Send or skip ONE record. The only place an email leaves.
 *
 * opts: { force, by, allowStatuses }
 *   force          send even if a skip rule says no. Send now asks first.
 *   allowStatuses  which statuses may be sent from. The cron sends only
 *                  queued; Send now may also revive failed, skipped, cancelled.
 *
 * Returns { outcome: "sent"|"skipped"|"failed"|"retry"|"refused"|"locked"
 *   |"needs_confirm", reason?, record? }
 */
export async function sendOne(deps, id, ctx, opts) {
  const o = opts || {};
  const store = deps.store;
  const allow = o.allowStatuses || ["queued"];
  if (!(await store.lock(id))) return { outcome: "locked", reason: "Another send for this order is already running" };
  try {
    const rec = await store.getRecord(id);
    if (!rec) { await store.dequeue(id); return { outcome: "refused", reason: "No such request" }; }
    if (!allow.includes(rec.status)) {
      if (rec.status !== "queued") await store.dequeue(id);
      return { outcome: "refused", reason: rec.status === "sent" ? "This request was already sent" : `This request is ${rec.status}`, record: rec };
    }

    const at = iso(ctx.now);
    const reason = decideSkip(rec, ctx);
    if (reason && !o.force) {
      if (o.confirmSkips) return { outcome: "needs_confirm", reason, record: rec };
      rec.status = "skipped";
      rec.skip_reason = reason;
      rec.skipped_at = at;
      note(rec, "skipped", o.by, at, { reason });
      await store.saveRecord(rec);
      await store.dequeue(id);
      return { outcome: "skipped", reason, record: rec };
    }

    const email = normalizeEmail(rec.email);
    if (!email) {
      return { outcome: "refused", reason: reason || "No usable email address", record: rec };
    }

    const msg = renderEmail(ctx.settings, rec);
    try {
      const result = await deps.send({
        from: msg.from,
        to: [email],
        subject: msg.subject,
        text: msg.text,
        reply_to: msg.replyTo || undefined,
      });
      rec.status = "sent";
      rec.sent_at = at;
      rec.message_id = (result && (result.id || (result.data && result.data.id))) || null;
      rec.skip_reason = null;
      rec.last_error = null;
      rec.subject_sent = msg.subject;
      note(rec, o.force ? "sent (override)" : "sent", o.by, at, o.force && reason ? { overrode: reason } : null);
      await store.saveRecord(rec);
      await store.dequeue(id);
      await store.setLastSent(email, at);
      ctx.lastSent[email] = at;
      return { outcome: "sent", record: rec };
    } catch (e) {
      const message = (e && e.message) || String(e);
      rec.attempts = (Number(rec.attempts) || 0) + 1;
      rec.last_error = message;
      const quota = e && (e.status === 429);
      if (rec.attempts >= MAX_ATTEMPTS && !quota) {
        rec.status = "failed";
        note(rec, "failed", o.by, at, { error: message });
        await store.saveRecord(rec);
        await store.dequeue(id);
        return { outcome: "failed", reason: message, record: rec };
      }
      // A rate limit or daily cap is not this customer's fault and does not
      // count toward giving up on them; it waits for the next run.
      if (quota) rec.attempts = Math.max(0, rec.attempts - 1);
      if (rec.status !== "queued") { rec.status = "queued"; await store.enqueue(id); }
      note(rec, "send error, will retry", o.by, at, { error: message });
      await store.saveRecord(rec);
      return { outcome: "retry", reason: message, record: rec, quota };
    }
  } finally {
    await store.unlock(id);
  }
}

export async function sendDue(deps, { settings, now }) {
  const out = { at: iso(now), enabled: !!settings.enabled, sent: 0, skipped: 0, failed: 0, retry: 0, due: 0, left: 0, errors: [] };
  if (!settings.enabled) return out;

  const ids = await deps.store.queueIds();
  const records = await deps.store.getRecords(ids);
  const due = records.filter((r) => isDue(r, now)).sort((a, b) => a.send_after.localeCompare(b.send_after));
  out.due = due.length;
  const ctx = await loadContext(deps, settings, now);
  const cap = Number(settings.maxPerRun) || 20;

  for (const rec of due) {
    if (out.sent >= cap) break;
    const r = await sendOne(deps, rec.id, ctx, { by: "schedule" });
    if (out[r.outcome] != null) out[r.outcome]++;
    if (r.outcome === "failed" || r.outcome === "retry") out.errors.push(`${rec.visual_id || rec.id}: ${r.reason}`);
    if (r.quota) break;   // the provider said stop; everyone else waits too
  }
  out.left = Math.max(0, due.length - out.sent - out.skipped - out.failed);
  await deps.store.patchState({ lastSend: out });
  return out;
}

/** Send now, from the screen. Asks before overriding a skip rule. */
export async function sendNow(deps, id, { settings, now, force, by }) {
  const ctx = await loadContext(deps, settings, now);
  return sendOne(deps, id, ctx, {
    force: !!force,
    confirmSkips: !force,
    by,
    allowStatuses: ["queued", "failed", "skipped", "cancelled"],
  });
}

export async function cancel(deps, id, { now, by }) {
  const store = deps.store;
  if (!(await store.lock(id))) return { ok: false, reason: "This request is being sent right now" };
  try {
    const rec = await store.getRecord(id);
    if (!rec) return { ok: false, reason: "No such request" };
    if (!["queued", "failed"].includes(rec.status)) return { ok: false, reason: `Cannot cancel a request that is ${rec.status}`, record: rec };
    const at = iso(now);
    rec.status = "cancelled";
    rec.cancelled_at = at;
    rec.cancelled_by = by || null;
    note(rec, "cancelled", by, at);
    await store.saveRecord(rec);
    await store.dequeue(id);
    return { ok: true, record: rec };
  } finally {
    await store.unlock(id);
  }
}

/** Undo a cancel or a skip. It goes back in line, never straight out the door. */
export async function restore(deps, id, { now, by }) {
  const store = deps.store;
  if (!(await store.lock(id))) return { ok: false, reason: "This request is being sent right now" };
  try {
    const rec = await store.getRecord(id);
    if (!rec) return { ok: false, reason: "No such request" };
    if (!["cancelled", "skipped", "failed"].includes(rec.status)) return { ok: false, reason: `Cannot restore a request that is ${rec.status}`, record: rec };
    const at = iso(now);
    rec.status = "queued";
    rec.skip_reason = null;
    rec.cancelled_at = null;
    rec.cancelled_by = null;
    rec.attempts = 0;
    rec.last_error = null;
    note(rec, "restored", by, at);
    await store.saveRecord(rec);
    await store.enqueue(id);
    return { ok: true, record: rec };
  } finally {
    await store.unlock(id);
  }
}

export async function markReviewed(deps, email, { now, by, invoiceId }) {
  const e = normalizeEmail(email);
  if (!e) return { ok: false, reason: "That is not an email address" };
  const entry = { at: iso(now), by: by || null, invoice_id: invoiceId || null };
  await deps.store.setReviewed(e, entry);
  return { ok: true, email: e, entry };
}

export async function unmarkReviewed(deps, email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: false, reason: "That is not an email address" };
  await deps.store.removeReviewed(e);
  return { ok: true, email: e };
}
