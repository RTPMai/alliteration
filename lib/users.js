// PUT IN: lib/users.js (REPLACES the current one)
// lib/users.js — THE ONE GUEST LIST.
//
// Replaces BackBone's lib/users.js and ErrorEngine's lib/user-store.js. Those
// two stored accounts separately AND hashed passwords in incompatible formats
// (BackBone: "salt:hash" hex, sync; ErrorEngine: "scrypt$N$salt$hash" base64,
// async). Same algorithm, mutually unreadable output — which is why a shared
// cookie alone was never going to be one login.
//
// This file takes ErrorEngine's hashing (async, tunable, timing-safe) and
// BackBone's richer permissions (per-app access, not just a role label).
//
// Users live in ONE key as { [username]: record }. Roles live in another.
// Passwords are scrypt-hashed: no external dependency, and deliberately slow, so
// a leaked user table can't be brute-forced the way a plain SHA-256 table could.
//
// Stored hash format: scrypt$N$salt_b64$hash_b64
//
// ESM. Do NOT convert to module.exports.

import crypto from "crypto";
import { getRaw, setRaw, keys } from "./kv.js";
// Employee records, for the time clock grant in permsFor(). Safe to import:
// lib/crewcore/store.js pulls in kv.js and its own schema only, so there is
// no cycle back into this file.
import { getEmployeeByUsername } from "./crewcore/store.js";
// The one definition of "is this caller a CrewCore administrator", shared by
// the routes, the screen, the shell registry and permsFor() below.
import { isCrewCoreAdmin } from "./crewcore/schema.js";
// The three GivingGauge answers (add / decide / manage), resolved here so the
// screen gets booleans instead of re-deriving the rule in the browser. That
// file imports NOTHING, so this cannot become a cycle.
import { canAddGiving, canDecideGiving, canManageGiving } from "./giving-access.js";
// PER-ACCOUNT GRANTS, Sep 2026. The role is a starting point; an account may
// carry its own answers and they win. Also pure, also imports nothing, so it
// cannot become a cycle and apps/settings.js can load it in the browser.
import {
  resolveAccess, normalizeAccess, tabsFor, asRole, accessFromRole, emptyAccess,
} from "./user-grants.js";

/**
 * The CrewCore views somebody who is not a CrewCore admin may reach. Kept
 * beside the roles rather than inside them because it is a ceiling, not a
 * grant: it applies to every role, including ones created in Settings that
 * carry no tabs list at all. js/registry.js holds the same list for the
 * client-side half of the same rule.
 */
const CREWCORE_SELF_VIEWS = [
  "crewcore:dashboard",
  "crewcore:timeclock",
  "crewcore:stipend",
  "crewcore:samples",
  "crewcore:kudos",
  "crewcore:reviews",
  "crewcore:handbook",
];

const SCRYPT_N = 16384;
const KEYLEN = 64;

/* ------------------------------------------------------------------ *
 * ROLES
 *
 * A role answers two questions: what can this person DO (edit? export?), and
 * which APPS can they open.
 *
 * `apps` holds registry app IDs and maps to perms.tabs in the front end. The
 * shell's canAccess() treats a list with no app IDs as a legacy BackBone-only
 * value, so old stored roles keep working until they are re-saved.
 * ------------------------------------------------------------------ */

export const DEFAULT_ROLES = {
  admin: {
    name: "admin",
    // LABEL, Aug 2026: was "Administrator". The per-account elevated flag is
    // now called Admin everywhere in the UI (Ryan's call — "SuperUser" was
    // jargon), and two things both reading "Admin" on the Accounts screen
    // would be unreadable. The role KEY stays "admin": it is stored on every
    // user record and checked by name in isCrewCoreAdmin() and canAccess().
    label: "Full access",
    protected: true,          // cannot be deleted; an app with no admin is unfixable
    apps: ["backbone", "shopstock", "errorengine", "givinggauge", "traveltrack", "stitchsense"],
    data_scope: "all",        // "all" | "own"
    can_edit: true,
    can_export: true,
    manage_lists: true,       // curate ErrorEngine's taxonomy + price lists
    can_delete_notifications: true,
    can_decide_giving: true,  // approve/decline in GivingGauge
  },
  manager: {
    name: "manager",
    label: "Manager",
    protected: false,
    apps: ["backbone", "shopstock", "errorengine", "givinggauge", "traveltrack", "stitchsense"],
    data_scope: "all",
    can_edit: true,
    can_export: true,
    manage_lists: true,
    can_delete_notifications: true,
    can_decide_giving: true,  // manager has always been able to decide
  },
  am: {
    name: "am",
    label: "Account Manager",
    protected: false,
    // StitchSense is the reason this app exists: an AM quoting embroidery
    // needs a stitch count before they can price it.
    apps: ["backbone", "shopstock", "traveltrack", "stitchsense"],
    data_scope: "own",        // sees their own accounts, not the whole roster
    can_edit: true,
    can_export: false,
    manage_lists: false,
    can_delete_notifications: true,
  },
  viewer: {
    name: "viewer",
    label: "Viewer (read-only)",
    protected: false,
    apps: ["backbone"],
    data_scope: "all",
    can_edit: false,
    can_export: false,
    manage_lists: false,
    can_delete_notifications: true,
  },
  // Self-serve CrewCore access, decided Aug 3 2026: production/office staff
  // who need to see their own profile, their own apparel stipend balance,
  // and the handbook, but nothing else in the shell and no other employee's
  // data. data_scope "own" is what api/crewcore/*.js reads to gate a caller
  // down to their own employee record — see lib/crewcore/schema.js's
  // ADMIN_ONLY_FIELDS for the fields stripped even from that own-record
  // view. PTO self-serve (crewcore:pto) was removed from this role's tabs
  // Aug 2026 when PTO tracking moved to QuickBooks — see DEPLOY-NOTES.md.
  //
  // apps lists 'crewcore' (app-level access), but tabs ALSO carries scoped
  // "crewcore:<view>" entries so allowedViews() hides Settings from the
  // rail. Without those scoped entries, allowedViews() falls back to "no
  // grants recorded means every view", which would put a shop-wide Settings
  // tab in front of a self-serve employee.
  employee: {
    name: "employee",
    label: "Employee (self-serve)",
    protected: false,
    // StitchSense is granted, but scoped to Stitch Guess ONLY. The embroidery
    // team playing the guessing game is the point; a production employee does
    // not need the quoting tool, the archive import, or the accuracy log, and
    // allowedViews() falls back to "every view" if no scoped entries exist.
    apps: ["crewcore", "stitchsense"],
    // ROSTER REMOVED, Aug 2026 (Ryan's call): the roster is a list of the
    // whole team and is not something everyone with a login should be able
    // to open. The self-serve profile card that used to live inside this
    // view moved to CrewCore's Dashboard, which is where an employee now
    // lands — see apps/crewcore.js _renderDashboardSelf(). The scoped roster
    // grant is gone from this list and must not come back.
    //
    // "crewcore:timeclock" is granted here but is STRIPPED at runtime for
    // anyone whose employee record has clock_enabled false — see permsFor()
    // below. Salaried staff who never punch have no hours to read.
    //
    // "crewcore:kudos" is the only WRITE this role has anywhere in the
    // shell, added Sep 2026. Employees giving each other credit was the
    // point of the feature, so a read-only version of it would be pointless.
    // What can be written is one short message addressed to somebody else on
    // the roster; api/crewcore/kudos.js refuses a self-addressed one.
    tabs: ["crewcore:dashboard", "crewcore:timeclock", "crewcore:stipend", "crewcore:samples", "crewcore:kudos", "crewcore:reviews", "crewcore:handbook", "stitchsense:guess"],
    data_scope: "own",
    can_edit: false,
    can_export: false,
    manage_lists: false,
    can_delete_notifications: true,
  },
};

const norm = (u) => String(u || "").trim().toLowerCase();

/* ------------------------------------------------------------------ *
 * PASSWORD HASHING
 * ------------------------------------------------------------------ */

function scrypt(password, salt, len = KEYLEN, n = SCRYPT_N) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, len, { N: n }, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const dk = await scrypt(password, salt, expected.length, Number(n));
    // Constant-time compare — a plain === leaks timing information.
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * STORAGE
 * ------------------------------------------------------------------ */

async function readUsers() {
  const data = await getRaw(keys.users());
  const map = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return await migrateRoles(map);
}

/**
 * ONE-TIME MIGRATION OFF ROLES, Sep 2026.
 *
 * Runs on the first read after deploy and never again: an account with an
 * `access` object is already done, and once every account has one this
 * returns immediately. Idempotent, so a cold start mid-migration is safe.
 *
 * Two things it does, and both matter:
 *
 *   1. Bakes each account's CURRENT resolved access onto the account, so
 *      nobody's access changes on the day. Role apps, role flags, the scoped
 *      view entries from the old `tabs` list, and any per-account override
 *      shipped earlier in September, all folded into one record.
 *   2. Sets the Admin flag on anyone who held the "admin" role. With roles
 *      gone the flag is the ONLY administrator, so without this step the
 *      migration would lock everybody out of Settings on deploy. This is the
 *      single most important line in the file.
 */
async function migrateRoles(map) {
  const names = Object.keys(map);
  if (!names.length) return map;
  if (names.every((u) => map[u] && map[u].access)) return map;

  const roles = await getRoles();
  let changed = false;

  names.forEach((u) => {
    const rec = map[u];
    if (!rec || rec.access) return;
    const role = roles[rec.role] || {};
    rec.access = accessFromRole(role, rec.grants);
    // The way back in. Anyone who administered through the role keeps
    // administering through the flag.
    if (String(rec.role || "").trim().toLowerCase() === "admin") rec.superuser = true;
    delete rec.grants;
    map[u] = rec;
    changed = true;
  });

  if (changed) await setRaw(keys.users(), map);
  return map;
}

async function writeUsers(map) {
  await setRaw(keys.users(), map);
  return map;
}

/** Public shape — NEVER includes password_hash. */
function publicUser(u) {
  return {
    username: u.username,
    name: u.name || u.username,
    // The per-account Admin flag. With roles gone this is the ONLY
    // administrator there is, which is why the last one cannot be removed.
    superuser: u.superuser === true,
    // The whole access answer for this person. Not an override of anything,
    // it IS what they can do.
    access: resolveAccess(u.access),
    // HISTORICAL ONLY. The role this account used to be on, kept on the record
    // after the migration and passed through here for one reason: PromoPro's
    // buyer list named roles, and converting it to people needs to know who
    // was on what. Nothing reads it for access. Do not start.
    role: u.role || null,
    created_at: u.created_at || null,
    last_login: u.last_login || null,
  };
}

/* ------------------------------------------------------------------ *
 * ROLES
 * ------------------------------------------------------------------ */

export async function getRoles() {
  const stored = await getRaw(keys.roles());
  // Merge rather than return stored wholesale: if a roles map was written before
  // a new role existed, returning it as-is would permanently hide that role and
  // make createUser reject it. Stored values still win for any role present in
  // both, so customisation survives.
  if (stored && typeof stored === "object" && Object.keys(stored).length) {
    const merged = { ...DEFAULT_ROLES, ...stored };

    // TABS ARE OWNED BY CODE, NOT BY STORAGE.
    //
    // `tabs` carries the per-view grants ("crewcore:roster") that
    // allowedViews() filters a rail down to. Nothing in the UI can edit
    // them: the role editor covers apps, data_scope, and the can_* flags,
    // and that is all. So a stored tabs array is never a choice somebody
    // made, it is only a snapshot of what DEFAULT_ROLES said on the day
    // the roles map was last written for some OTHER reason.
    //
    // Letting that snapshot win means adding a view to an app silently
    // hides it from every scoped role, on any deploy where roles had ever
    // been saved, with no error and nothing in a log. That is how
    // CrewCore's Time Clock view came to be unreachable for the self-serve
    // employee role (Aug 2026) despite being built, granted, and tested.
    //
    // If a tabs editor is ever added to Settings, this has to change with
    // it: stored would then carry real intent and would need to win again.
    //
    // LABELS ARE OWNED BY CODE TOO, for the same reason and only for roles
    // that ship in DEFAULT_ROLES. The role editor sets a label once, when a
    // NEW role is created, and never again — so a stored label on a shipped
    // role is another stale snapshot, not somebody's choice. Renaming the
    // admin role to "Full access" (Aug 2026, so it stops colliding with the
    // per-account Admin flag) would otherwise never show up on any deploy
    // where roles had been saved, which is all of them. Labels somebody
    // typed, on roles they created, are untouched: those keys are not in
    // DEFAULT_ROLES.
    Object.keys(merged).forEach((name) => {
      if (!DEFAULT_ROLES[name]) return;
      const fixed = { ...merged[name] };
      if (Array.isArray(DEFAULT_ROLES[name].tabs)) fixed.tabs = DEFAULT_ROLES[name].tabs.slice();
      if (DEFAULT_ROLES[name].label) fixed.label = DEFAULT_ROLES[name].label;
      merged[name] = fixed;
    });

    return merged;
  }
  return DEFAULT_ROLES;
}

export async function saveRoles(roles) {
  if (!roles || typeof roles !== "object") throw new Error("Invalid roles payload");
  if (!roles.admin) throw new Error("Cannot delete the admin role");

  // Force admin to keep full access. An admin who unticked an app on their own
  // role would be locked out of the only screen that could undo it, and the fix
  // would be editing storage by hand.
  roles.admin = Object.assign({}, roles.admin, {
    protected: true,
    label: DEFAULT_ROLES.admin.label,
    apps: DEFAULT_ROLES.admin.apps.slice(),
    data_scope: "all",
    can_edit: true,
    can_export: true,
    manage_lists: true,
    can_decide_giving: true,
  });

  // Every other role must keep at least one app, or its users sign in to a blank
  // screen with nowhere to navigate.
  Object.keys(roles).forEach((k) => {
    if (k === "admin") return;
    if (!Array.isArray(roles[k].apps) || roles[k].apps.length === 0) {
      throw new Error(`Role "${k}" has no apps — its users would sign in to a blank screen.`);
    }
  });

  await setRaw(keys.roles(), roles);
  return roles;
}

/**
 * Delete a role. Refuses if anyone still has it, because a user pointing at a
 * role that no longer exists falls through to viewer permissions silently —
 * they would not lose access, they would quietly lose the RIGHT access.
 */
export async function deleteRole(name) {
  const roles = await getRoles();
  if (!roles[name]) throw new Error(`Role "${name}" not found`);
  if (roles[name].protected) throw new Error(`The ${name} role cannot be deleted`);

  const holders = (await listUsers()).filter((u) => u.role === name);
  if (holders.length) {
    throw new Error(
      `${holders.length} ${holders.length === 1 ? "person is" : "people are"} still using ` +
      `the "${name}" role (${holders.map((u) => u.username).join(", ")}). ` +
      `Move them to another role first.`
    );
  }

  delete roles[name];
  await setRaw(keys.roles(), roles);
  return { ok: true };
}

export async function getRole(name) {
  const roles = await getRoles();
  return roles[name] || roles.viewer || DEFAULT_ROLES.viewer;
}

/**
 * The caller's employee record, or null. Never throws: permissions are read
 * on every sign-in and on several hot routes, and a CrewCore storage hiccup
 * must not be able to lock somebody out of the whole shell. A failed lookup
 * falls back to leaving the grant alone, which is the same thing an unlinked
 * account gets.
 */
async function employeeForUsername(username) {
  try {
    return await getEmployeeByUsername(username);
  } catch (e) {
    console.error("permsFor: employee lookup failed", e);
    return null;
  }
}

/**
 * Permissions for the front end, in the shape the shell's registry expects.
 * perms.tabs carries app IDs; per-view grants use "<appId>:<view>".
 */
export async function permsFor(username) {
  const rec = await getUserRecord(username);
  if (!rec) return { tabs: [] };

  // ROLES ARE GONE, Sep 2026. The account carries the whole answer.
  const access = resolveAccess(rec.access);
  // Shaped like the old role object so lib/giving-access.js and the other
  // role-shaped readers did not have to learn that roles no longer exist.
  const effectiveRole = asRole(access);
  const isAdmin = rec.superuser === true;

  // APP-LEVEL ONLY. A "<app>:<view>" entry in an apps list would land
  // straight on tabs below and skip every ceiling, because the ceilings
  // filter the per-view list and this is not it. normalizeAccess strips them
  // on the way in as well; this is the second of the two.
  const appGrants = access.apps.filter((a) => a.indexOf(":") === -1);
  // Per-view narrowing now lives on the account, in access.views, rather than
  // in a code-owned role `tabs` array. That is the whole point of the change:
  // "StitchSense, guess only" is a thing you tick for a person.
  let viewGrants = tabsFor(access).filter((t) => t.indexOf(":") !== -1);

  // CREWCORE IS DENY-BY-DEFAULT PER VIEW, Aug 28 2026, and this survives the
  // removal of roles unchanged.
  //
  // The rule used to be "no per-view list means every view of any app you can
  // open", which is right for the other apps and was wrong for this one. An
  // office account was handed Roster, Time Clock and Settings that way: the
  // server answered every one of her requests with her own record only, and
  // the rail still offered her the whole team's roster.
  //
  // So the self-serve set is a CEILING, applied to anyone who is not an
  // Admin, AFTER the account's own grants are resolved. With roles gone the
  // Admin FLAG is the only thing that lifts it. No checkbox on the Access
  // editor can, and none should ever be added.
  if (appGrants.includes("crewcore") && !isAdmin) {
    const kept = viewGrants.filter((t) => t.startsWith("crewcore:") && CREWCORE_SELF_VIEWS.includes(t));
    viewGrants = viewGrants
      .filter((t) => !t.startsWith("crewcore:"))
      .concat(kept.length ? kept : CREWCORE_SELF_VIEWS.slice());
  }

  // TIME CLOCK, Aug 2026: the view is only for people who actually punch.
  // Every employee record carries clock_enabled (off = salaried, does not
  // punch), so the grant is narrowed here rather than being a second switch
  // somebody has to remember to flip.
  //
  // Unlinked accounts (no employee record yet) keep the grant: they already
  // land on "ask an admin to link you" everywhere in CrewCore, and hiding a
  // tab as well would just be a second symptom of the same missing link.
  if (viewGrants.includes("crewcore:timeclock")) {
    const emp = await employeeForUsername(username);
    if (emp && emp.clock_enabled === false) {
      viewGrants = viewGrants.filter((t) => t !== "crewcore:timeclock");
    }
  }

  return {
    tabs: appGrants.concat(viewGrants),
    data_scope: access.data_scope,
    can_edit: access.can_edit,
    can_export: access.can_export,
    // GIVINGGAUGE, Sep 2026. Three separate answers, resolved by
    // lib/giving-access.js, which api/giving-requests.js asks the same way.
    // Deciding is its own per-role switch (Settings > Roles) because adding a
    // request that came in over the phone and judging one are different jobs:
    // staff were given the app to do the first without being handed the
    // second. See that file for why a role saved before the switch existed
    // keeps deciding.
    can_add_giving: canAddGiving(rec, effectiveRole),
    can_decide_giving: canDecideGiving(rec, effectiveRole),
    can_manage_giving: canManageGiving(rec, effectiveRole),
    // Opt-in, unlike can_edit/can_export: roles stored before this flag
    // existed must not silently gain list-editing rights.
    manage_lists: access.manage_lists,
    // Opt-OUT, like can_edit/can_export (default true unless a role
    // explicitly turns it off): controls whether people with this role can
    // delete a notification they created or were assigned — Ryan's ask, a
    // per-role switch rather than hardcoded to "creator/assignee always
    // can." Admins/superusers can always delete regardless of this flag —
    // see api/notifications.js callerIsAdmin().
    can_delete_notifications: access.can_delete_notifications,
    // Per-account, not per-role. THIS WAS MISSING before: js/registry.js's
    // canAccess() has always checked perms.superuser, but nothing ever set
    // it, so stub apps (CrewCore, MailMe, TeleTally, WebsiteWidget) were
    // invisible to every account, including admin. Toggled from the
    // Accounts screen.
    // The one and only administrator test now that roles are gone.
    superuser: isAdmin,
    // Kept so the many callers reading perms.role === "admin" keep meaning
    // what they meant. It is DERIVED from the flag, not stored, and it is
    // the only place a role name survives anywhere in the shell.
    role: isAdmin ? "admin" : "account",
  };
}

/* ------------------------------------------------------------------ *
 * READS
 * ------------------------------------------------------------------ */

/** Drives the "create the first account" screen. */
export async function noUsersYet() {
  const map = await readUsers();
  return Object.keys(map).length === 0;
}

export async function listUsers() {
  const map = await readUsers();
  return Object.values(map)
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
}

/** Full record INCLUDING the hash — for login only. Never send to a client. */
export async function getUserRecord(username) {
  const map = await readUsers();
  return map[norm(username)] || null;
}

export async function getUser(username) {
  const rec = await getUserRecord(username);
  return rec ? publicUser(rec) : null;
}

/**
 * Administrators, counted by the FLAG. With roles gone this is the only
 * definition, and it is what stops the last one being removed.
 */
export async function countAdmins() {
  const map = await readUsers();
  return Object.values(map).filter((u) => u.superuser === true).length;
}

/**
 * One person's resolved access, shaped like the old role object.
 *
 * This is what every route should ask. Before roles were removed those routes
 * called getRole(user.role), which meant a per-account setting was honoured by
 * the rail and ignored by the server.
 */
export async function getAccess(username) {
  const rec = await getUserRecord(username);
  return asRole(rec ? rec.access : null);
}

/* ------------------------------------------------------------------ *
 * WRITES
 * ------------------------------------------------------------------ */

export async function createUser({ username, password, name, access, superuser }) {
  const u = norm(username);
  if (!u) throw new Error("Username is required");
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) {
    throw new Error("Username must be 3-32 characters: letters, numbers, dot, dash, underscore");
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const map = await readUsers();
  if (map[u]) throw new Error(`User "${u}" already exists`);

  const rec = {
    username: u,
    name: String(name || u).trim(),
    // A new account starts with NOTHING, not a default set of apps. With no
    // role to inherit, a default would be a guess applied at the moment
    // nobody is looking. An empty rail is a problem you see and fix; access
    // nobody chose is the kind you find out about later.
    access: access ? normalizeAccess(access) : emptyAccess(),
    superuser: superuser === true,
    password_hash: await hashPassword(password),
    created_at: new Date().toISOString(),
    last_login: null,
  };

  map[u] = rec;
  await writeUsers(map);
  return publicUser(rec);
}

export async function updateUser(username, patch = {}) {
  const u = norm(username);
  const map = await readUsers();
  const rec = map[u];
  if (!rec) throw new Error(`User "${u}" not found`);

  if (patch.name !== undefined) rec.name = String(patch.name).trim();


  if (patch.password !== undefined) {
    if (String(patch.password).length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    rec.password_hash = await hashPassword(patch.password);
  }

  if (patch.superuser !== undefined) {
    // THE LOCKOUT GUARD. With roles gone the Admin flag is the only
    // administrator there is, so removing the last one leaves nobody able to
    // reach Settings and no way back in short of editing storage by hand.
    if (rec.superuser === true && patch.superuser !== true && (await countAdmins()) <= 1) {
      throw new Error("Cannot remove the last administrator");
    }
    rec.superuser = patch.superuser === true;
  }

  // ACCESS. The whole answer for this person, not an override of anything.
  // Unknown keys are dropped by normalizeAccess rather than stored looking
  // like settings that do nothing.
  if (patch.access !== undefined) {
    rec.access = normalizeAccess(patch.access);
  }

  map[u] = rec;
  await writeUsers(map);
  return publicUser(rec);
}

export async function deleteUser(username) {
  const u = norm(username);
  const map = await readUsers();
  if (!map[u]) throw new Error(`User "${u}" not found`);
  if (map[u].superuser === true && (await countAdmins()) <= 1) {
    throw new Error("Cannot delete the last administrator");
  }
  delete map[u];
  await writeUsers(map);
  return { ok: true };
}

export async function touchLastLogin(username) {
  const u = norm(username);
  const map = await readUsers();
  if (!map[u]) return;
  map[u].last_login = new Date().toISOString();
  await writeUsers(map);
}

/* ------------------------------------------------------------------ *
 * AUTHENTICATE
 * ------------------------------------------------------------------ */

export async function authenticate(username, password) {
  const rec = await getUserRecord(username);
  if (!rec) {
    // Burn comparable work so a missing user isn't distinguishable by timing
    // from a wrong password.
    await hashPassword("dummy");
    return null;
  }
  const ok = await verifyPassword(password, rec.password_hash);
  return ok ? publicUser(rec) : null;
}
