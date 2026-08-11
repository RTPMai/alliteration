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
import { isRateLimited, resetKey } from "../lib/rate-limit.js";

// Login lockout. Two keys checked together:
//   - per-username, so a guessed/scripted attack against ONE account gets
//     shut down fast (5 tries / 15 min).
//   - per-IP, looser (20 tries / 15 min), so a script rotating through many
//     usernames from one machine still gets caught even though no single
//     username crossed its own limit.
// Window and limits are deliberately generous for a team this size — this is
// meant to stop a brute-force script, not to lock Ryan out after a couple of
// typos.
const LOGIN_MAX_PER_USER = 5;
const LOGIN_MAX_PER_IP = 20;
const LOGIN_WINDOW_SECONDS = 15 * 60;

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

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
      const usernameRaw = String(body.username || "");
      const userKey = "login:user:" + usernameRaw.trim().toLowerCase();
      const ipKey = "login:ip:" + clientIp(req);

      // Check both before touching the password. A locked-out request should
      // never reach scrypt, or the lockout does nothing to reduce load.
      const [userLimited, ipLimited] = await Promise.all([
        isRateLimited(userKey, LOGIN_MAX_PER_USER, LOGIN_WINDOW_SECONDS),
        isRateLimited(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_SECONDS),
      ]);
      if (userLimited || ipLimited) {
        res.setHeader("Retry-After", String(LOGIN_WINDOW_SECONDS));
        return res.status(429).json({
          error: "Too many login attempts. Wait 15 minutes and try again.",
        });
      }

      const user = await authenticate(body.username, body.password);
      if (!user) return res.status(401).json({ error: "Invalid username or password" });

      // Success — clear this user's counter so a couple of earlier typos in
      // this window don't count against their next login.
      await resetKey(userKey);

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
