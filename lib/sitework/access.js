// PUT IN: lib/sitework/access.js
// lib/sitework/access.js — who is allowed to see the StickySituations board.
//
// WHY THIS FILE EXISTS. The rule lived as a private helper inside
// api/sitework.js, which was fine while exactly one route asked the question.
// Notifications now asks it too, because a notification can link to a sticky
// and the picker that searches the board has to answer "are you allowed to see
// this" before it hands back titles. Copying the helper into a second route is
// how the CrewCore trap happens: two copies of one rule, and the day somebody
// tightens one, the other quietly keeps letting people in.
//
// The rule itself is unchanged: the per-account Admin flag, or a role with
// "stickies" ticked in Settings. Exact and opt-in, no fallback that infers the
// grant from a role's shape. This must keep agreeing with canAccess() in
// js/registry.js; test/sitework.test.cjs checks that by calling both.
//
// ESM. lib/ never imports from api/.

import { getUser, permsFor } from "../users.js";

export const SITE_APP_ID = "stickies";

/**
 * Can this session see the build board at all?
 *
 * Reading the board and changing it are different questions; this one is read.
 * Writes additionally require can_edit, which stays in api/sitework.js next to
 * the writes it guards.
 */
export async function canSeeBoard(sess) {
  if (!sess || !sess.username) return false;
  const user = await getUser(sess.username);
  if (!user) return false;
  if (user.superuser === true) return true;
  const perms = await permsFor(sess.username);
  const tabs = Array.isArray(perms && perms.tabs) ? perms.tabs : [];
  return tabs.includes(SITE_APP_ID);
}
