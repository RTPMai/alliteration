// api/auth.js — the ONE sign-in route for all five apps.
//
// Replaces BackBone's api/auth.js and ErrorEngine's api/auth.js, which was one
// of the two real file collisions between them.
//
// Kept SEPARATE from lib/session.js so the route and the library can never
// overwrite each other. BackBone documented that trap after losing the library's
// contents to a paste: lib/session.js does cookies, lib/users.js does accounts,
// api/auth.js is the HTTP route that uses both.
//
// Actions (via ?action= or JSON { action }):
//   session   GET   -> current session + permissions, or { authenticated:false }
//   login     POST { username, password }
//   logout    POST
//   bootstrap POST { username, password, name } -> creates the FIRST admin,
//                                                  only while no users exist

import { setSessionCookie, clearSessionCookie, getSession } from "../lib/session.js";
import { authenticate, createUser, noUsersYet, touchLastLogin, permsFor } from "../lib/users.js";
import { isConfigured } from "../lib/kv.js";

/**
 * A missing env var should produce a readable message, not Vercel's generic
 * 500. Checked here, at the top of the handler, so the answer reaches the
 * browser instead of dying somewhere in an import.
 */
function configProblem() {
  if (!process.env.SESSION_SECRET) {
    return "SESSION_SECRET is not set. Generate one with: openssl rand -base64 32, " +
           "then add it in Vercel > Settings > Environment Variables and redeploy.";
  }
  if (!isConfigured()) {
    return "Storage is not configured. Add KV_REST_API_URL and KV_REST_API_TOKEN " +
           "in Vercel > Settings > Environment Variables and redeploy.";
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const problem = configProblem();
  if (problem) return res.status(503).json({ error: problem, setup: true });

  // Vercel usually parses JSON bodies, but not always (depends on content-type
  // and runtime). Normalise so body.action is reliable either way.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};

  const action = (req.query && req.query.action) || body.action || "";

  try {
    // ---- who am I ----
    if (action === "session" || action === "me" || req.method === "GET") {
      const sess = getSession(req);
      if (!sess) {
        // needsSetup tells the sign-in screen whether to offer "create the first
        // account" — a deterministic check, not a fragile probe.
        let needsSetup = false;
        try { needsSetup = await noUsersYet(); } catch (e) { needsSetup = false; }
        return res.status(200).json({ authenticated: false, needsSetup });
      }

      // Permissions are looked up FRESH rather than read from the cookie. A role
      // change takes effect on the next request instead of waiting 12 hours for
      // the cookie to expire.
      const perms = await permsFor(sess.username);
      return res.status(200).json({
        authenticated: true,
        user: {
          username: sess.username,
          name: sess.name,
          role: sess.role,
          perms,
        },
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- logout ----
    if (action === "logout") {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // ---- create the first admin (only while the store is empty) ----
    if (action === "bootstrap") {
      if (!(await noUsersYet())) {
        return res.status(403).json({ error: "Accounts already exist — setup is disabled." });
      }
      const user = await createUser({
        username: body.username,
        password: body.password,
        name: body.name,
        role: "admin",
      });
      setSessionCookie(res, { username: user.username, name: user.name, role: user.role });
      const perms = await permsFor(user.username);
      return res.status(201).json({ ok: true, user: { ...user, perms } });
    }

    // ---- login ----
    if (action === "login" || (body.username && body.password)) {
      const user = await authenticate(body.username, body.password);
      if (!user) return res.status(401).json({ error: "Invalid username or password" });

      await touchLastLogin(user.username);
      setSessionCookie(res, { username: user.username, name: user.name, role: user.role });

      const perms = await permsFor(user.username);
      return res.status(200).json({ ok: true, user: { ...user, perms } });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("auth error:", e);
    return res.status(500).json({ error: e.message });
  }
}
