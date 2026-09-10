// api/users.js — account management. Admin only.
//
// In the old split deployments this file existed only in ErrorEngine, while
// BackBone kept its accounts in lib/users.js with no HTTP surface. Under the
// shell there is one account list, so there is one route to manage it.
//
//   GET    /api/users            -> list accounts
//   POST   /api/users            -> create { username, password, name, access? }
//   PATCH  /api/users?username=  -> update { name?, password?, access?, superuser? }
//   DELETE /api/users?username=  -> remove
//
// ROLES ARE GONE, Sep 2026. There is no ?scope=roles any more: access lives on
// the account and is edited there. See lib/user-grants.js.
//
// Every action requires an ADMIN session, and admin now means the per-account
// Admin flag, not a role name in a cookie. That matters here more than
// anywhere: a cookie is issued at sign-in and a role name inside one is a
// claim, while permsFor reads storage.

import { requireAuth } from "../lib/session.js";
import {
  listUsers, createUser, updateUser, deleteUser, permsFor,
} from "../lib/users.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only administrators manage accounts. Without this, any signed-in viewer
  // could promote themselves.
  const sess = requireAuth(req, res);
  if (!sess) return;

  // Read live rather than trusting the cookie's claim.
  const perms = await permsFor(sess.username);
  if (!perms || perms.superuser !== true) {
    return res.status(403).json({ error: "Admin only" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const username = (req.query && req.query.username) || body.username || "";

  try {
    if (req.method === "GET") {
      return res.status(200).json({ users: await listUsers() });
    }

    if (req.method === "POST") {
      const user = await createUser({
        username: body.username,
        password: body.password,
        name: body.name,
        // Optional. Absent means an account with no apps at all, which is
        // deliberate: see emptyAccess() in lib/user-grants.js.
        access: body.access,
      });
      return res.status(201).json({ ok: true, user });
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      if (!username) return res.status(400).json({ error: "username is required" });
      const patch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.password !== undefined) patch.password = body.password;
      if (body.superuser !== undefined) patch.superuser = body.superuser === true;
      // The whole access record for this person. updateUser normalizes:
      // unknown keys are dropped rather than stored looking like settings.
      if (body.access !== undefined) patch.access = body.access;
      const user = await updateUser(username, patch);
      return res.status(200).json({ ok: true, user });
    }

    if (req.method === "DELETE") {
      if (!username) return res.status(400).json({ error: "username is required" });
      // Deleting yourself while signed in leaves a valid cookie for an account
      // that no longer exists. Blocked outright rather than handled downstream.
      if (username.toLowerCase() === String(sess.username).toLowerCase()) {
        return res.status(400).json({ error: "You cannot delete your own account" });
      }
      await deleteUser(username);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("users error:", e);
    // Validation failures are the user's problem to fix, not server faults.
    const isValidation = /required|must be|already exists|not found|Cannot|Unknown role/i.test(e.message);
    return res.status(isValidation ? 400 : 500).json({ error: e.message });
  }
}
