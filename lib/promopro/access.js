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
 * Can this caller write purchase orders?
 *
 * Two gates, in this order:
 *
 *   1. Superuser always can. There has to be a way back in.
 *   2. If PromoPro Settings names specific roles, the caller's role must be
 *      one of them. Buying is a narrower job than editing, so "who can raise
 *      a PO" is its own list rather than riding on the shell's blanket
 *      can_edit flag.
 *   3. If that list is empty, fall back to the shell's can_edit, which is
 *      what this app did before the list existed. An empty list must never
 *      mean "nobody", because that is what a fresh deploy looks like and it
 *      would lock the whole team out of an app that was working yesterday.
 *
 * Reading is deliberately not gated at all, here or anywhere in the app.
 *
 * Takes the already-loaded settings when the caller has them, so a route
 * that reads settings anyway does not read them twice.
 */
export async function canEditSession(sess, settings) {
  const { user, role } = await callerFor(sess);
  if (user && user.superuser === true) return true;
  if (!role || role.can_edit === false) return false;

  const s = settings || (await loadSettings());
  const allowed = Array.isArray(s && s.editRoles) ? s.editRoles : [];
  if (!allowed.length) return true;

  return allowed.includes(String(role.name || "").toLowerCase());
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
