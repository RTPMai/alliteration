// PUT IN: lib/giving-access.js (NEW FILE)
//
// lib/giving-access.js — who may do what inside GivingGauge.
//
// WHY THIS EXISTS. Until Sep 2026 the app had two gates and both were wrong
// in opposite directions:
//
//   1. Adding a request by hand, importing from Jotform and re-running the
//      roster match all checked `sess.role !== "admin" && sess.role !== "manager"`.
//      That matches the role NAME literally, so a role created in Settings
//      with GivingGauge ticked and every permission on still got a 403. The
//      same literal-name mistake PromoPro had (see lib/promopro/access.js).
//   2. Approving and declining had NO check at all, on the screen or on the
//      server. Anyone who could open the app could decide a donation. So
//      granting a member of staff access to type in a phone request also
//      handed them the decision, which is the opposite of what was wanted.
//
// So: three separate questions, each answered once, here, and asked by both
// the server (api/giving-requests.js) and the screen (apps/givinggauge.js)
// so the buttons and the routes cannot disagree.
//
//   ADD      type in a request, record what a donation cost, fix a
//            classification, attach an account. The everyday work.
//   DECIDE   approve or decline. Ryan's call, Sep 2026: a per-role switch in
//            Settings, so who can add and who can decide are separate
//            questions rather than one grant.
//   MANAGE   pull the whole Jotform history in, re-run matching over every
//            stored request. Bulk maintenance over the entire queue.
//
// PURE, and it must stay that way: no imports at all. lib/users.js imports
// this file, so an import back into users.js would be a cycle, and
// apps/givinggauge.js and apps/settings.js import it straight into the
// browser, where anything reaching for node's crypto would fail to load.
//
// ESM. Do NOT convert to module.exports.

/**
 * The per-account Admin flag is always the way back in. Without it, a role
 * misconfigured in Settings could leave nobody able to fix the queue.
 */
function isFlaggedAdmin(user) {
  return !!(user && user.superuser === true);
}

function roleLabel(role) {
  if (!role) return "no role";
  return "the " + (role.label || role.name || "unnamed") + " role";
}

/**
 * CAN THIS PERSON PUT SOMETHING IN THE QUEUE, OR CORRECT WHAT IS THERE.
 *
 * Rides on the shell's existing can_edit switch rather than adding a fourth
 * checkbox. Somebody who is read-only everywhere else in the shell should not
 * become a writer here because a different box was ticked, and an admin
 * granting GivingGauge to a member of staff so they can type in a phone call
 * has already had to answer "can this person edit" on the same screen.
 */
export function givingAddVerdict(user, role) {
  if (isFlaggedAdmin(user)) return { allowed: true, why: "Admin flag on the account" };
  if (!role) return { allowed: false, why: "No role on the account" };
  if (role.can_edit === false) {
    return { allowed: false, why: roleLabel(role) + " is read-only in the shell" };
  }
  return { allowed: true, why: roleLabel(role) + " can edit" };
}

/**
 * CAN THIS PERSON APPROVE OR DECLINE.
 *
 * `can_decide_giving` is the switch, and an explicit value always wins, in
 * both directions. Ticked on a read-only role still decides: that is somebody
 * deliberately saying "this person judges requests but does not maintain the
 * records", and silently ignoring the box they just ticked is worse than an
 * unusual combination.
 *
 * UNDEFINED IS THE INTERESTING CASE and it is why this is not a plain
 * `=== true`. Roles saved before this switch existed carry no such field, and
 * before this change EVERY role that could open the app could decide. Reading
 * a missing field as false would silently take the decision away from whoever
 * has it today, on deploy day, with nothing on screen to explain it. So a
 * missing value falls back to what actually decided before: an all-data role
 * that can write. That is admin and manager, plus any role created in
 * Settings with the app ticked, which is exactly today's population.
 *
 * New roles are written with the flag off from the moment they are created
 * (see apps/settings.js), so "undefined" only ever means "existed before this
 * deploy" and the fallback cannot quietly hand the decision to somebody new.
 */
export function givingDecideVerdict(user, role) {
  if (isFlaggedAdmin(user)) return { allowed: true, why: "Admin flag on the account" };
  if (!role) return { allowed: false, why: "No role on the account" };

  if (role.can_decide_giving === true) {
    return { allowed: true, why: roleLabel(role) + " may decide donation requests" };
  }
  if (role.can_decide_giving === false) {
    return { allowed: false, why: roleLabel(role) + " may add requests but not decide them" };
  }

  const legacy = role.data_scope === "all" && role.can_edit !== false;
  return legacy
    ? { allowed: true, why: roleLabel(role) + " decided requests before this switch existed" }
    : { allowed: false, why: roleLabel(role) + " has never been able to decide requests" };
}

/**
 * CAN THIS PERSON RUN THE BULK JOBS: import from Jotform, re-match everything.
 *
 * Deliberately narrower than adding. Both of these rewrite every stored
 * request in one press, and neither is part of anyone's day: the import is for
 * catching up a form that has been collecting submissions, and the re-match is
 * the repair button for a scoring change. Same test the rest of the shell uses
 * for "can change something shared" (api/notifications.js callerIsAdmin,
 * api/websitewidget/sites.js Manage Sites), so the answer does not depend on
 * which app is asking.
 */
export function givingManageVerdict(user, role) {
  if (isFlaggedAdmin(user)) return { allowed: true, why: "Admin flag on the account" };
  if (!role) return { allowed: false, why: "No role on the account" };
  if (role.can_edit === false) {
    return { allowed: false, why: roleLabel(role) + " is read-only in the shell" };
  }
  if (role.data_scope !== "all") {
    return { allowed: false, why: roleLabel(role) + " only sees its own accounts" };
  }
  return { allowed: true, why: roleLabel(role) + " sees all data and can edit" };
}

export function canAddGiving(user, role) { return givingAddVerdict(user, role).allowed; }
export function canDecideGiving(user, role) { return givingDecideVerdict(user, role).allowed; }
export function canManageGiving(user, role) { return givingManageVerdict(user, role).allowed; }

/**
 * The same three answers from a perms blob instead of a user record and a
 * role. permsFor() resolves them server side and ships them in the session
 * payload; the screen reads them back off ctx.perms. Kept here rather than
 * inlined in the app so there is one name for each answer everywhere.
 */
export function permsCanAdd(perms) { return !!(perms && perms.can_add_giving); }
export function permsCanDecide(perms) { return !!(perms && perms.can_decide_giving); }
export function permsCanManage(perms) { return !!(perms && perms.can_manage_giving); }
