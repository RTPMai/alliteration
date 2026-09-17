// PUT IN: lib/reviews/access.js
// lib/reviews/access.js: who may use RaveReviews.
//
// ADMIN ONLY: the per-account Admin flag, strictly `superuser === true`.
// Roles are gone (Sep 2026) and a truthy check is how the CrewCore trap
// happened, so this is the whole rule. Ticking the app on somebody's account
// can put it in their rail, and every route still answers 403.
//
// ESM. Do NOT convert to module.exports.

export function canUseReviews(perms) {
  return !!perms && perms.superuser === true;
}

export const DENIED = "RaveReviews is admin only.";
