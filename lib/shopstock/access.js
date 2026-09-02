// PUT IN: lib/shopstock/access.js
//
// ShopStock: who may write, in one place.
//
// WHY THIS EXISTS. ShopStock was ported from a standalone app that had no
// accounts at all: writes were gated behind a shared ADMIN_KEY typed into its
// Admin screen. The port kept that key and bolted a session check beside it,
// spelled by hand in three routes as:
//
//     sess.role === "admin" || sess.role === "manager"
//
// That reads the role NAME and nothing else, so it disagrees with the rest of
// the shell in two ways that both bite real people:
//
//   1. The per-account Admin flag (`superuser`) does not appear in the session
//      cookie at all — the cookie carries { username, name, role }. So an
//      account flagged Admin, which every other app honours, was refused here.
//   2. A role created in Settings with can_edit ticked was refused too, because
//      its key is not literally "admin" or "manager".
//
// Both cases produced a 401, and a 401 used to paint the shell's "Session
// expired" screen over the whole page (see js/api.js). So a permission problem
// looked like being logged out, on every attempt, and the person reporting it
// could not be told apart from someone with a genuinely dead cookie.
//
// The rule now matches the house pattern used by PromoPro, TravelTrack and
// MarketMachine: writing is can_edit, and the per-account Admin flag always
// wins. Same shape as poHealth() and isOverStipend() — one function, so the
// three routes and the screen cannot drift apart.

import { getSession } from "../session.js";
import { permsFor } from "../users.js";

/**
 * The rule itself. Pure, synchronous, takes the permsFor() shape so the tests
 * can call it directly rather than reading the source for a string.
 *
 * @param {object} perms  { superuser, role, can_edit } from lib/users.js permsFor()
 * @returns {{ write: boolean, remove: boolean }}
 */
export function shopstockCan(perms) {
  const p = perms || {};
  const superuser = p.superuser === true;
  const role = typeof p.role === "string" ? p.role : "";

  // can_edit is opt-OUT in permsFor (absent means true), but an object that
  // never came from permsFor should not gain write rights by omission, so this
  // asks for the explicit true.
  const canEdit = p.can_edit === true;

  return {
    write: superuser || role === "admin" || canEdit,
    // Deleting an item, or wiping the whole list with ?all=true, stays where it
    // was: the two roles that could already do it, plus the Admin flag. This is
    // deliberately NOT widened to can_edit — it is the one action with no undo.
    remove: superuser || role === "admin" || role === "manager",
  };
}

/**
 * The rule as the routes need it: reads the session, looks the permissions up
 * fresh, and still accepts the legacy shared key so the price-scraper cron and
 * any old bookmark keep working.
 *
 * Only call this on a write. A GET in ShopStock is open to anyone signed in,
 * and the permissions lookup costs a KV read that a read path should not pay.
 *
 * @returns {{ signedIn: boolean, write: boolean, remove: boolean, via: string }}
 */
export async function shopstockAccess(req) {
  const adminKey = process.env.ADMIN_KEY;
  const supplied =
    (req.headers && req.headers["x-admin-key"]) ||
    (req.query && req.query.secret) ||
    null;

  // Confirm the key is SET before comparing, or an unset ADMIN_KEY makes every
  // anonymous request an admin (the undefined !== undefined trap).
  if (adminKey && supplied && supplied === adminKey) {
    return { signedIn: false, write: true, remove: true, via: "admin-key" };
  }

  const sess = getSession(req);
  if (!sess) return { signedIn: false, write: false, remove: false, via: "none" };

  let perms = null;
  try {
    perms = await permsFor(sess.username);
  } catch (e) {
    // A storage wobble during the lookup must not silently promote anyone.
    perms = null;
  }

  // Fall back to the role on the cookie if the lookup came back empty, so a
  // signed-in admin is never locked out of their own inventory by a bad read.
  const shape = perms
    ? { superuser: perms.superuser, role: perms.role || sess.role, can_edit: perms.can_edit }
    : { superuser: false, role: sess.role, can_edit: false };

  const can = shopstockCan(shape);
  return { signedIn: true, write: can.write, remove: can.remove, via: "session" };
}

/**
 * The 401-or-403 decision, in one place so the three routes answer alike.
 *
 * 401 means "we do not know who you are" and is the ONLY status the shell
 * treats as a dead session. 403 means "we know who you are and the answer is
 * no", which is a message on the screen, not a sign-out.
 */
export function denyWrite(res, access, what) {
  if (!access.signedIn) {
    return res.status(401).json({ error: "Not signed in" });
  }
  return res.status(403).json({
    error: "Your account does not have permission to " + (what || "change inventory") +
           ". Ask Ryan to turn on editing for your role in Settings.",
  });
}
