// lib/session.js — signed session cookies. THE ONE LOCK.
//
// This replaces BackBone's lib/session.js and ErrorEngine's lib/session.js,
// which were byte-identical apart from comments and the cookie name. Having one
// copy is the point: two copies drift, and a drifted session file means one app
// silently stops trusting the other's login.
//
// ONE COOKIE FOR ALL FIVE APPS. The old apps each set their own
// (backbone_session, errorengine_session) so one app's logout could not drop the
// other. Under the shell that separation is exactly wrong: it IS one app now,
// with one sign-in and one sign-out.
//
// SESSION_SECRET must be set, and must be the SAME value everywhere the shell
// runs. Change it and every signed-in user is signed out, because their existing
// cookies no longer verify.
//
// Sessions are HMAC-SHA256 signed, HttpOnly, and last 12 hours.
//
// ESM. Do NOT convert to module.exports — mixing module systems is what produced
// "setSessionCookie is not a function" in BackBone.

import crypto from "crypto";

const COOKIE_NAME = "alliteration_session";
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      "SESSION_SECRET is not set — generate one with: openssl rand -base64 32"
    );
  }
  return s;
}

// Constant-time string compare. A plain === leaks timing information about how
// many leading characters matched, which is enough to brute-force a secret byte
// by byte.
export function safeEqual(a, b) {
  const A = Buffer.from(String(a == null ? "" : a));
  const B = Buffer.from(String(b == null ? "" : b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64) {
  return b64url(crypto.createHmac("sha256", secret()).update(payloadB64).digest());
}

// ---- cookie plumbing --------------------------------------------------------

function parseCookies(req) {
  const raw = (req.headers && req.headers.cookie) || "";
  const out = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/**
 * Write the session cookie.
 *
 * PAYLOAD SHAPE: { username, name, role }.
 * BackBone wrote { role, username, iat } and ErrorEngine wrote
 * { username, name, role }. Both read username and role; only ErrorEngine read
 * name. This union satisfies both, and BackBone simply ignores the extra field.
 *
 * Keep this small. It rides on every request, and anything in here is stale the
 * moment the underlying record changes — permissions are looked up fresh rather
 * than trusted from the cookie.
 */
export function setSessionCookie(res, session) {
  const data = Object.assign({}, session, {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  });
  const payload = b64url(JSON.stringify(data));
  const token = payload + "." + sign(payload);

  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",              // JS in the page can't read it, so XSS can't steal it
    "SameSite=Lax",          // not sent on cross-site POSTs — blunts CSRF
    "Secure",                // HTTPS only
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; "));
}

export function clearSessionCookie(res) {
  // Clear the shell cookie AND both legacy per-app cookies. Without this, an old
  // backbone_session left over from the separate deployments would sit in the
  // browser looking like a valid login to anything still reading it.
  const expire = (name) => [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    "Max-Age=0",
  ].join("; ");

  res.setHeader("Set-Cookie", [
    expire(COOKIE_NAME),
    expire("backbone_session"),
    expire("errorengine_session"),
  ]);
}

/** Returns the session object, or null if absent / tampered / expired. */
export function getSession(req) {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;

    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    // Verify BEFORE parsing. An unverified payload is attacker-controlled input,
    // and trusting it would let anyone mint themselves a role:"admin" cookie.
    if (!safeEqual(sig, sign(payload))) return null;

    const data = JSON.parse(unb64url(payload).toString("utf8"));
    if (!data || typeof data !== "object") return null;
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;

    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Guard for API routes. Sends the 401/403 itself and returns null, so callers
 * just do:
 *     const sess = requireAuth(req, res);
 *     if (!sess) return;
 */
export function requireAuth(req, res, requiredRole) {
  const sess = getSession(req);
  if (!sess) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  if (requiredRole && sess.role !== requiredRole) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return sess;
}
