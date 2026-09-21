// api/crewcore/employees.js — employee roster CRUD, scoped by role.
//
// GET    -> admin (superuser or the admin role): every employee.
//           everyone else: just the
//           caller's own record (via their linked username), with
//           ADMIN_ONLY_FIELDS stripped even for that own record.
// POST   -> create an employee. Admin only (see isCrewCoreAdmin; can_edit
//           is not required here — CrewCore write access is admin/superuser
//           by design, not gated on the generic can_edit flag other apps use,
//           since a record here is pay and review data, not a lead or trip).
// PATCH  -> edit. Admin-scope only.
// DELETE -> admin-scope only.
//
// LOGINS, Sep 21 2026 (Ryan): every roster row carries `gaps` (no_email,
// no_login) so the Roster can flag them. Adding somebody with no login makes
// one (create_login, on by default in the form), and POST action=create_login
// makes one for somebody already on the roster. Making an account needs the
// per-account Admin flag itself, not just CrewCore admin, because it is the
// same power as Settings > Accounts. The temporary password comes back ONCE
// in the response and is never stored in plain text. See
// lib/crewcore/accounts.js.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, listUsers, createUser } from "../../lib/users.js";
import { randomInt } from "node:crypto";
import { suggestUsername, tempPassword, rosterGaps } from "../../lib/crewcore/accounts.js";
import { validateEmployee, stripAdminFields, stripSecrets, isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import { validatePin } from "../../lib/crewcore/timeclock.js";
import { hashPassword } from "../../lib/users.js";
import {
  listEmployees, getEmployee, getEmployeeByUsername,
  saveEmployee, updateEmployee, deleteEmployee, seedFromContactList,
} from "../../lib/crewcore/store.js";

// Checks the "Shell username (optional)" link before saving, rather than
// letting a typo silently save. A broken link leaves a self-serve employee
// stuck seeing "ask an admin to link your account" with nothing pointing at
// why — this catches it at write time instead.
//   - blank/null username is always fine, the link is optional
//   - the username must belong to a REAL shell account
//   - it can't already be claimed by a DIFFERENT employee record (one login,
//     one employee record — otherwise two people could resolve to the same
//     self-serve identity)
async function checkUsernameLink(username, ownEmployeeId) {
  if (!username) return null; // optional field, nothing to check
  const user = await getUser(username);
  if (!user) return "Shell username \"" + username + "\" does not match any Alliteration account.";

  const all = await listEmployees();
  const claimedBy = all.find(
    (e) => e.id !== ownEmployeeId && String(e.username || "").toLowerCase() === String(username).toLowerCase()
  );
  if (claimedBy) {
    return "Shell username \"" + username + "\" is already linked to " + (claimedBy.name || claimedBy.id) + ".";
  }
  return null;
}

/**
 * Turns a plaintext kiosk passcode on the request into a stored hash, and
 * only ever in that direction. Handled here rather than in validateEmployee
 * so that hashing is on the one admin-authenticated path, and no route that
 * happens to pass a body through the validator can write a passcode by
 * accident.
 *
 * Three cases:
 *   clock_pin absent      -> leave whatever is stored alone
 *   clock_pin "" or null  -> clear it (that person can no longer punch)
 *   clock_pin "4821"      -> validate the digits, hash, store
 *
 * Same scrypt hashing as a shell login password. A four digit code has a
 * small keyspace no matter how it is hashed, which is why the real defence
 * is the per-employee lockout in api/crewcore/clock.js, not the hash. The
 * hash is here so a leaked database dump is not a list of everyone's codes.
 */
async function applyPinToRecord(body, record) {
  if (body.clock_pin === undefined) return null;
  if (body.clock_pin === "" || body.clock_pin === null) {
    record.clock_pin_hash = null;
    return null;
  }
  const check = validatePin(body.clock_pin);
  if (!check.ok) return check.error;
  record.clock_pin_hash = await hashPassword(check.pin);
  return null;
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/**
 * Make a login for a roster person and link it. Returns { username,
 * temp_password } or { error }. Never throws: the roster record is already
 * saved, and failing to make a login must not lose it.
 */
async function createLoginFor(emp) {
  try {
    const [users, roster] = await Promise.all([listUsers(), listEmployees()]);
    const accounts = new Set(users.map((u) => u.username));
    // A roster username with no account behind it is reused if it is free:
    // somebody typed it on purpose.
    const typed = String(emp.username || "").trim().toLowerCase();
    const claimed = new Set(roster.filter((e) => e.id !== emp.id).map((e) => String(e.username || "").toLowerCase()).filter(Boolean));
    let username = typed && !accounts.has(typed) && !claimed.has(typed) && /^[a-z0-9._-]{3,32}$/.test(typed) ? typed : null;
    if (!username) username = suggestUsername(emp.name, new Set([...accounts, ...claimed]));
    if (!username) return { error: "Couldn't work out a free username for " + emp.name };
    const temp_password = tempPassword((n) => randomInt(n));
    await createUser({ username, password: temp_password, name: emp.name, access: { apps: ["crewcore"] } });
    await updateEmployee(emp.id, { username });
    return { username, temp_password };
  } catch (e) {
    console.error("crewcore/employees: login creation failed, the employee was still saved:", e.message);
    return { error: e.message || "The login could not be made" };
  }
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return {
    canMakeLogins: !!(user && user.superuser === true),
    // Superuser flag or the protected admin role. Deliberately NOT data_scope:
    // see isCrewCoreAdmin() in lib/crewcore/schema.js for why.
    isAdmin: isCrewCoreAdmin({
      superuser: user && user.superuser,
      roleName: user ? user.role : sess.role,
    }),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { isAdmin, canMakeLogins } = await callerScope(sess);

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      const seed = req.query && req.query.seed;

      // One-time roster seed from the Wix Contact List, admin-triggered.
      if (seed === "1") {
        if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
        const result = await seedFromContactList(sess.username);
        return res.status(200).json(result);
      }

      if (isAdmin) {
        if (id) {
          const emp = await getEmployee(id);
          if (!emp) return res.status(404).json({ error: "Employee not found" });
          return res.status(200).json({ employee: stripSecrets(emp) });
        }
        // stripSecrets on the admin path too: the passcode hash is a
        // credential, and an admin has no use for reading one. They set a
        // new code instead. has_clock_pin comes back so the Roster can show
        // who is still not set up on the kiosk.
        const [rows, users] = await Promise.all([listEmployees(), listUsers()]);
        const logins = new Set(users.map((u) => u.username));
        const employees = rows.map((e) => ({ ...stripSecrets(e), gaps: rosterGaps(e, logins) }));
        return res.status(200).json({ employees, can_make_logins: canMakeLogins });
      }

      // Self-serve: only the caller's own record, and only the non-sensitive
      // fields. No id lookup for anyone else — an id in the query is ignored
      // for a self-serve caller rather than honored, so there is no way to
      // fetch a coworker's record by guessing an EMP-##### id.
      const own = await getEmployeeByUsername(sess.username);
      if (!own) return res.status(200).json({ employee: null });
      return res.status(200).json({ employee: stripAdminFields(own) });
    }

    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (req.method === "POST" && parseBody(req).action === "create_login") {
      if (!canMakeLogins) return res.status(403).json({ error: "Making logins needs the Admin flag" });
      const body = parseBody(req);
      const emp = await getEmployee(body.id || (req.query && req.query.id));
      if (!emp) return res.status(404).json({ error: "Employee not found" });
      const users = await listUsers();
      if (!rosterGaps(emp, new Set(users.map((u) => u.username))).no_login) {
        return res.status(409).json({ error: emp.name + " already has a login: " + emp.username });
      }
      const login = await createLoginFor(emp);
      if (login.error) return res.status(400).json({ error: login.error });
      const fresh = await getEmployee(emp.id);
      return res.status(201).json({ ok: true, login, employee: { ...stripSecrets(fresh), gaps: { ...rosterGaps(fresh, new Set([login.username])) } } });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const { ok, errors, record } = validateEmployee(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const usernameError = await checkUsernameLink(record.username, null);
      if (usernameError) return res.status(400).json({ error: usernameError });

      const pinError = await applyPinToRecord(body, record);
      if (pinError) return res.status(400).json({ error: pinError });

      record.created_by = sess.username;
      record.created_at = new Date().toISOString();
      record.updated_at = record.created_at;

      let employee = await saveEmployee(record);

      // A new roster person with no login gets one, unless the form said not
      // to (somebody who will never sign in, like a seasonal helper).
      let login = null;
      if (!record.username && body.create_login !== false) {
        login = canMakeLogins ? await createLoginFor(employee) : { error: "Only an account with the Admin flag can make logins" };
        if (login.username) employee = await getEmployee(employee.id);
      }
      const users = await listUsers();
      return res.status(201).json({
        ok: true, login,
        employee: { ...stripSecrets(employee), gaps: rosterGaps(employee, new Set(users.map((u) => u.username))) },
      });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing employee id" });

      const existing = await getEmployee(id);
      if (!existing) return res.status(404).json({ error: "Employee not found" });

      const { ok, errors, record } = validateEmployee(body, { partial: true, id });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      if (record.username !== undefined) {
        const usernameError = await checkUsernameLink(record.username, id);
        if (usernameError) return res.status(400).json({ error: usernameError });
      }

      const pinError = await applyPinToRecord(body, record);
      if (pinError) return res.status(400).json({ error: pinError });

      const employee = await updateEmployee(id, record);
      const users = await listUsers();
      return res.status(200).json({ ok: true, employee: { ...stripSecrets(employee), gaps: rosterGaps(employee, new Set(users.map((u) => u.username))) } });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing employee id" });

      const existing = await getEmployee(id);
      if (!existing) return res.status(404).json({ error: "Employee not found" });

      await deleteEmployee(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/employees route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
