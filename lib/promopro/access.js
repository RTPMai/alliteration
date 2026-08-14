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
 * Can this caller write purchase orders? can_edit, or superuser. Read access
 * is intentionally not gated at all: the whole point of the app is that an
 * account manager can see where an order stands without asking anybody.
 */
export async function canEditSession(sess) {
  const { user, role } = await callerFor(sess);
  if (user && user.superuser === true) return true;
  return !!(role && role.can_edit !== false);
}
