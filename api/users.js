// api/users.js — account management. Admin only.
//
// In the old split deployments this file existed only in ErrorEngine, while
// BackBone kept its accounts in lib/users.js with no HTTP surface. Under the
// shell there is one account list, so there is one route to manage it.
//
//   GET    /api/users            -> list accounts + available roles
//   POST   /api/users            -> create { username, password, name, role }
//   PATCH  /api/users?username=  -> update { name?, role?, password? }
//   DELETE /api/users?username=  -> remove
//
// Every action requires an admin session. requireAuth sends the 401/403 itself.

import { requireAuth } from "../lib/session.js";
import {
  listUsers, createUser, updateUser, deleteUser, getRoles, saveRoles, deleteRole,
} from "../lib/users.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only administrators manage accounts. Without this, any signed-in viewer
  // could promote themselves.
  const sess = requireAuth(req, res, "admin");
  if (!sess) return;

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const username = (req.query && req.query.username) || body.username || "";
  const roleName = (req.query && req.query.role) || body.roleName || "";
  const scope = (req.query && req.query.scope) || body.scope || "";

  try {
    // ---- roles ----
    // Routed by ?scope=roles so accounts and roles can share one endpoint
    // rather than adding a second serverless function for four handlers.
    if (scope === "roles") {
      if (req.method === "GET") {
        return res.status(200).json({ roles: await getRoles() });
      }
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        if (!body.roles || typeof body.roles !== "object") {
          return res.status(400).json({ error: "roles object is required" });
        }
        // saveRoles enforces the invariants: admin keeps every app, and no
        // other role may end up with none.
        const saved = await saveRoles(body.roles);
        return res.status(200).json({ ok: true, roles: saved });
      }
      if (req.method === "DELETE") {
        if (!roleName) return res.status(400).json({ error: "role is required" });
        await deleteRole(roleName);
        return res.status(200).json({ ok: true, roles: await getRoles() });
      }
      res.setHeader("Allow", "GET, POST, DELETE");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (req.method === "GET") {
      const [users, roles] = await Promise.all([listUsers(), getRoles()]);
      return res.status(200).json({ users, roles });
    }

    if (req.method === "POST") {
      const user = await createUser({
        username: body.username,
        password: body.password,
        name: body.name,
        role: body.role,
      });
      return res.status(201).json({ ok: true, user });
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      if (!username) return res.status(400).json({ error: "username is required" });
      const patch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.role !== undefined) patch.role = body.role;
      if (body.password !== undefined) patch.password = body.password;
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
