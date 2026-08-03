// lib/mailme/access.js — MailMe's server-side access guard.
//
// WHY THIS EXISTS. js/registry.js's canAccess() is the FRONT END's check: it
// decides what the rail renders. A front-end check is a convenience, never a
// control — anyone can call /api/mailme/contacts directly with a valid session
// cookie for some other app. MailMe holds the customer email list and the
// unsubscribe ledger, so its routes enforce the same rule server-side.
//
// The rule mirrors canAccess() exactly:
//   - superuser  -> allowed
//   - role whose apps[] grants 'mailme' -> allowed
//   - everyone else -> denied
//
// Note the deliberate absence of the "legacy BackBone-only tabs" fallback
// canAccess() carries. That fallback exists so pre-existing stored roles keep
// working instead of locking people out on deploy, and it grants BackBone.
// It can never grant mailme, so reproducing it here would be dead code that
// looks like a loophole.
//
// ESM. Do NOT convert to module.exports.

import { permsFor } from "../users.js";

export const APP_ID = "mailme";

/**
 * Guard for MailMe API routes. Sends the 403 itself and returns false, so
 * callers do:
 *     const sess = requireAuth(req, res);
 *     if (!sess) return;
 *     if (!(await requireMailMe(sess, res))) return;
 */
export async function requireMailMe(sess, res) {
  const perms = await permsFor(sess.username);

  if (perms && perms.superuser === true) return true;

  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  if (tabs.includes(APP_ID)) return true;

  res.status(403).json({ error: "MailMe access is not granted to this account" });
  return false;
}

/**
 * Whether the caller may make CHANGES (edit campaigns, change a contact's
 * subscribe status) as opposed to just reading. Separate from access because
 * the read-only case is legitimate: someone may need to see who unsubscribed
 * without being able to un-unsubscribe them.
 */
export async function canEditMailMe(sess) {
  const perms = await permsFor(sess.username);
  if (perms && perms.superuser === true) return true;
  return !!(perms && perms.can_edit !== false && Array.isArray(perms.tabs) && perms.tabs.includes(APP_ID));
}
