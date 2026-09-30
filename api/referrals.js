// PUT IN: api/referrals.js
// api/referrals.js: BackBone referral tracking.
//
// GET                        -> { referrals, canEdit, canDelete }
// POST { action: "create",  ...fields }           log one
//      { action: "update",  id, ...fields }       edit one
//      { action: "confirm", id }                  an AM confirms it
//      { action: "reject",  id }                  not a referral
//      { action: "reopen",  id }                  back to "to confirm"
//      { action: "thank",   id, how, on }         record the thank-you (how: "" clears)
//      { action: "delete",  id }                  Admin only
//
// WHO: anyone who can open BackBone reads. Writing needs BackBone plus the
// account's can_edit. Deleting is the Admin flag only, the same line leads
// use: a deleted referral silently changes somebody's ranking.
//
// NOT PUBLIC. Referrals name our clients, and Ryan does not want the client
// list public (Sep 30 2026). The public inquiry form stays free text; this
// route is behind the login like every other BackBone route.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { permsFor, getUser, getAccess } from "../lib/users.js";
import { KEYS, readKey } from "../lib/backbone-store.js";
import { readReferrals, writeReferrals, nextReferralId } from "../lib/backbone/referral-store.js";
import {
  validateReferral, newReferral, editReferral, confirmReferral, rejectReferral,
  reopenReferral, thankReferral, findDuplicate, visibleReferrals,
} from "../lib/backbone/referrals.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/** What this caller may do. Exported for the tests. */
export async function referralAccess(username) {
  const perms = await permsFor(username);
  const admin = !!(perms && perms.superuser === true);
  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  const read = admin || tabs.includes("backbone");
  return {
    read,
    edit: read && (admin || perms.can_edit !== false),
    remove: admin,
  };
}

/**
 * For an account set to "own accounts only": the customer ids of their own
 * clients, worked out exactly the way api/data.js does it. null means the
 * account sees every client. Fails CLOSED: an "own" account we cannot tie
 * to an account manager gets an empty set, so it only sees what it logged.
 */
async function ownClientIds(username) {
  const access = await getAccess(username);
  if (!access || access.data_scope !== "own") return null;
  const user = await getUser(username);
  const mine = String((user && (user.am_name || user.name)) || "").trim().toLowerCase();
  const ids = new Set();
  if (!mine) return ids;
  const data = (await readKey(KEYS.data)) || {};
  const enr = data.enrichment || {};
  Object.keys(enr).forEach((id) => {
    if (String((enr[id] || {}).account_manager || "").trim().toLowerCase() === mine) ids.add(String(id));
  });
  return ids;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const can = await referralAccess(sess.username);
    if (!can.read) return res.status(403).json({ error: "Referrals are part of BackBone, which this account cannot open." });

    const perms = await permsFor(sess.username);
    const ownIds = perms && perms.superuser === true ? null : await ownClientIds(sess.username);
    const seeable = (list) => visibleReferrals(list, { ownIds, me: sess.username });

    if (req.method === "GET") {
      const doc = await readReferrals();
      return res.status(200).json({ referrals: seeable(doc.referrals), canEdit: can.edit, canDelete: can.remove, scoped: !!ownIds });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req);
    const action = String(body.action || "");
    if (action === "delete" ? !can.remove : !can.edit) {
      return res.status(403).json({
        error: action === "delete"
          ? "Deleting a referral is Admin only, since it changes the ranking."
          : "This account is read-only in BackBone.",
      });
    }

    const by = sess.username;
    const doc = await readReferrals();

    if (action === "create") {
      const v = validateReferral(body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join(" "), errors: v.errors });
      const dup = findDuplicate(doc.referrals, v.value);
      if (dup) {
        // The same referred person counts once. Pointing at the existing one
        // beats a second record that the ranking would have to ignore. The
        // record itself only goes back to someone allowed to see it.
        return res.status(409).json({
          error: v.value.referred_name + " is already logged as a referral (" + dup.id + ").",
          existing: seeable([dup])[0] || null,
        });
      }
      const { id, seq } = nextReferralId(doc);
      const rec = newReferral(v.value, { id, by });
      doc.referrals.push(rec);
      doc.seq = seq;
      await writeReferrals(doc);
      return res.status(200).json({ ok: true, referral: rec });
    }

    const id = String(body.id || "").trim();
    const idx = doc.referrals.findIndex((r) => r.id === id);
    // An "own accounts" user cannot act on a referral they cannot see.
    // Same answer as a missing one, so the route does not confirm it exists.
    if (!id || idx === -1 || seeable([doc.referrals[idx]]).length === 0) {
      return res.status(404).json({ error: "That referral was not found. Refresh and try again." });
    }
    const cur = doc.referrals[idx];
    let next;

    if (action === "update") {
      const v = validateReferral(body, { partial: true });
      if (!v.ok) return res.status(400).json({ error: v.errors.join(" "), errors: v.errors });
      const candidate = { ...cur, ...v.value };
      const dup = findDuplicate(doc.referrals, candidate, { ignoreId: cur.id });
      if (dup && cur.status !== "not_referral") {
        return res.status(409).json({ error: "That person is already logged as a referral (" + dup.id + ").", existing: seeable([dup])[0] || null });
      }
      next = editReferral(cur, v.value, { by });
    } else if (action === "confirm") {
      const r = confirmReferral(cur, { by });
      if (!r.ok) return res.status(400).json({ error: r.error });
      next = r.record;
    } else if (action === "reject") {
      next = rejectReferral(cur, { by });
    } else if (action === "reopen") {
      const dup = findDuplicate(doc.referrals, cur, { ignoreId: cur.id });
      if (dup) return res.status(409).json({ error: "That person is already logged again as " + dup.id + ".", existing: seeable([dup])[0] || null });
      next = reopenReferral(cur, { by });
    } else if (action === "thank") {
      const r = thankReferral(cur, { how: body.how, on: body.on, by });
      if (!r.ok) return res.status(400).json({ error: r.error });
      next = r.record;
    } else if (action === "delete") {
      doc.referrals.splice(idx, 1);
      await writeReferrals(doc);
      return res.status(200).json({ ok: true, deleted: id });
    } else {
      return res.status(400).json({ error: "Unknown action." });
    }

    doc.referrals[idx] = next;
    await writeReferrals(doc);
    return res.status(200).json({ ok: true, referral: next });
  } catch (e) {
    console.error("referrals error:", e);
    return res.status(500).json({ error: e.message });
  }
}
