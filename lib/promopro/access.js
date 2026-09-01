// lib/promopro/access.js — one admin check for every PromoPro route.
//
// WHY THIS EXISTS. PromoPro's routes originally each did:
//
//     const perms = await permsFor(sess.username);
//     const isAdmin = perms.role === "admin" || perms.superuser === true;
//
// which is wrong in two ways the rest of the shell already knew about:
//
//   1. It matches the role NAME literally. "admin" passes, "manager" does
//      not, even though manager carries data_scope "all" and is admin-
//      equivalent everywhere else in the app. Any custom role an admin
//      creates fails too.
//   2. It assumes the session carries a username. api/websitewidget/sites.js
//      and api/crewcore/employees.js both guard `sess.username ? ... : null`
//      and fall back to `sess.role`, which means a session without one is a
//      real case. permsFor(undefined) returns `{ tabs: [] }` — no role, no
//      superuser — so the caller silently becomes a non-admin.
//
// The visible symptom of (2) was a PromoPro Settings screen telling Ryan
// there were no active employees in CrewCore while his roster showed twelve.
// The route had quietly decided he was not an admin, so it never attached the
// candidate list, and the front end (which computed admin its own way, and
// got the right answer) reported the empty result as though the roster had
// been read and found empty. Two different definitions of "admin" produced a
// bug report aimed at the wrong system entirely.
//
// So: one helper, matching what already works elsewhere, used by every route.
//
// ESM. Do NOT convert to module.exports.

import { getUser, getRole } from "../users.js";

/**
 * Resolve the caller's account and role from a session, tolerating a session
 * that carries a role but no username. Same shape the working routes use.
 */
export async function callerFor(sess) {
  const s = sess || {};
  const user = s.username ? await getUser(s.username) : null;
  const role = await getRole(user ? user.role : s.role);
  return { user, role };
}

/**
 * Admin for PromoPro's purposes: anyone whose role sees all data, or any
 * superuser. Deliberately the same test api/websitewidget/sites.js uses for
 * Manage Sites, so "who can change shared settings" means one thing across
 * the shell rather than one thing per app.
 */
export async function isAdminSession(sess) {
  const { user, role } = await callerFor(sess);
  return !!((role && role.data_scope === "all") || (user && user.superuser === true));
}

/**
 * Reading is deliberately not gated at all, here or anywhere in the app: the
 * whole point of PromoPro is that an AM can see where an order stands
 * without asking. WRITING is what the two functions below decide.
 */

/**
 * CAN THIS PERSON RAISE A PURCHASE ORDER, AND WHY.
 *
 * Pure and separate from the session lookup so the SAME decision can be
 * asked about somebody else. "Who can buy right now" turned out to be a
 * question nobody could answer: the rule is three clauses deep, spread over
 * a role flag, a settings list and a per-account switch, and the only way to
 * find out was to ask a person to try. A permission you cannot audit is a
 * permission you cannot tighten, because you cannot see what tightening it
 * would break.
 *
 * `why` is written to be read by Ryan on the Settings screen, not parsed.
 *
 * The three clauses, in order:
 *   1. Superuser always can. There has to be a way back in.
 *   2. No shell edit rights at all means no. A viewer is a viewer.
 *   3. If Settings names roles, the caller's role must be one of them. If it
 *      names none, fall back to the shell's own can_edit, which is what this
 *      app did before the list existed. An empty list must never mean
 *      "nobody": that is what a fresh deploy looks like and it would lock
 *      the whole team out of an app that worked yesterday.
 */
export function editVerdict(user, role, settings) {
  if (user && user.superuser === true) {
    return { allowed: true, why: "Admin flag on the account" };
  }
  if (!role) {
    return { allowed: false, why: "No role on the account" };
  }
  if (role.can_edit === false) {
    return { allowed: false, why: "The " + (role.label || role.name) + " role is read-only in the shell" };
  }

  const allowed = Array.isArray(settings && settings.editRoles) ? settings.editRoles : [];
  const name = String(role.name || "").toLowerCase();

  if (!allowed.length) {
    return {
      allowed: true,
      why: "Nobody is named in Settings, so shell edit rights decide",
      viaFallback: true,
    };
  }
  if (allowed.includes(name)) {
    return { allowed: true, why: "The " + (role.label || role.name) + " role is named in Settings" };
  }
  return { allowed: false, why: "The " + (role.label || role.name) + " role is not named in Settings" };
}

/**
 * CAN THIS PERSON BOOK IN STOCK THAT ARRIVED.
 *
 * Deliberately WIDER than raising one, and deliberately not affected by the
 * Settings list at all. Ryan's call, Sep 2026: buying is a decision to spend
 * money and belongs to a few people; recording that a box turned up is a
 * record of a physical event and belongs to whoever opened the box. Tying
 * the two together would mean tightening who can buy also stops the shop
 * booking in deliveries, and the predictable result of that is receipts
 * getting entered late by somebody else, or not at all.
 *
 * This is exactly today's behaviour, so narrowing the buyers list changes
 * nothing about receiving on deploy day.
 */
export function receiveVerdict(user, role) {
  if (user && user.superuser === true) {
    return { allowed: true, why: "Admin flag on the account" };
  }
  if (!role) return { allowed: false, why: "No role on the account" };
  if (role.can_edit === false) {
    return { allowed: false, why: "The " + (role.label || role.name) + " role is read-only in the shell" };
  }
  return { allowed: true, why: "Anyone with shell edit rights can book in stock" };
}

export async function canEditSession(sess, settings) {
  const { user, role } = await callerFor(sess);
  if (user && user.superuser === true) return true;
  const s = settings || (await loadSettings());
  return editVerdict(user, role, s).allowed;
}

export async function canReceiveSession(sess) {
  const { user, role } = await callerFor(sess);
  return receiveVerdict(user, role).allowed;
}

/**
 * Settings read used only by the gate above. Imported lazily so this module
 * stays cheap for the routes that pass their own settings in, and so a
 * settings read failure denies nothing it should not: a store that cannot be
 * read returns no role list, which falls back to the shell's own permission
 * rather than locking everyone out.
 */
async function loadSettings() {
  try {
    const { getSettings } = await import("./store.js");
    return await getSettings();
  } catch (e) {
    console.error("[promopro] could not read settings for the edit gate:", e && e.message);
    return {};
  }
}
