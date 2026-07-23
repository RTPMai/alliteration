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
    label: "Administrator",
    protected: true,          // cannot be deleted; an app with no admin is unfixable
    apps: ["backbone", "shopstock", "errorengine", "givinggauge", "traveltrack"],
    data_scope: "all",        // "all" | "own"
    can_edit: true,
    can_export: true,
  },
  manager: {
    name: "manager",
    label: "Manager",
    protected: false,
    apps: ["backbone", "shopstock", "errorengine", "givinggauge", "traveltrack"],
    data_scope: "all",
    can_edit: true,
    can_export: true,
  },
  am: {
    name: "am",
    label: "Account Manager",
    protected: false,
    apps: ["backbone", "shopstock", "traveltrack"],
    data_scope: "own",        // sees their own accounts, not the whole roster
    can_edit: true,
    can_export: false,
  },
  viewer: {
    name: "viewer",
    label: "Viewer (read-only)",
    protected: false,
    apps: ["backbone"],
    data_scope: "all",
    can_edit: false,
    can_export: false,
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
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
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
    role: u.role,
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
    return { ...DEFAULT_ROLES, ...stored };
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
    apps: DEFAULT_ROLES.admin.apps.slice(),
    data_scope: "all",
    can_edit: true,
    can_export: true,
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
 * Permissions for the front end, in the shape the shell's registry expects.
 * perms.tabs carries app IDs; per-view grants use "<appId>:<view>".
 */
export async function permsFor(username) {
  const rec = await getUserRecord(username);
  if (!rec) return { tabs: [] };
  const role = await getRole(rec.role);
  return {
    tabs: Array.isArray(role.apps) ? role.apps.slice() : [],
    data_scope: role.data_scope || "all",
    can_edit: role.can_edit !== false,
    can_export: role.can_export !== false,
    role: rec.role,
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

export async function countAdmins() {
  const map = await readUsers();
  return Object.values(map).filter((u) => u.role === "admin").length;
}

/* ------------------------------------------------------------------ *
 * WRITES
 * ------------------------------------------------------------------ */

export async function createUser({ username, password, name, role }) {
  const u = norm(username);
  if (!u) throw new Error("Username is required");
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) {
    throw new Error("Username must be 3-32 characters: letters, numbers, dot, dash, underscore");
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const roles = await getRoles();
  const r = String(role || "viewer");
  if (!roles[r]) throw new Error(`Unknown role: ${r}`);

  const map = await readUsers();
  if (map[u]) throw new Error(`User "${u}" already exists`);

  const rec = {
    username: u,
    name: String(name || u).trim(),
    role: r,
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

  if (patch.role !== undefined) {
    const roles = await getRoles();
    if (!roles[patch.role]) throw new Error(`Unknown role: ${patch.role}`);
    // Demoting the last admin would leave nobody able to manage accounts.
    if (rec.role === "admin" && patch.role !== "admin" && (await countAdmins()) <= 1) {
      throw new Error("Cannot demote the last administrator");
    }
    rec.role = patch.role;
  }

  if (patch.password !== undefined) {
    if (String(patch.password).length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    rec.password_hash = await hashPassword(patch.password);
  }

  map[u] = rec;
  await writeUsers(map);
  return publicUser(rec);
}

export async function deleteUser(username) {
  const u = norm(username);
  const map = await readUsers();
  if (!map[u]) throw new Error(`User "${u}" not found`);
  if (map[u].role === "admin" && (await countAdmins()) <= 1) {
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
