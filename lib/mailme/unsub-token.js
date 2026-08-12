// lib/mailme/unsub-token.js — unsubscribe token make/read.
//
// Pulled out of api/mailme/unsubscribe.js so the SEND path (lib/mailme/send.js)
// can embed a real token in every outgoing email without lib/ reaching into
// api/. lib/ never imports from api/ anywhere else in this repo; this file is
// what keeps that true here too. api/mailme/unsubscribe.js re-exports these
// so nothing calling it needs to change.
//
// See api/mailme/unsubscribe.js for the full token design rationale (HMAC of
// the contact id under SESSION_SECRET, never expires, never carries the
// email address).
//
// ESM. Do NOT convert to module.exports.

import crypto from "crypto";
import { safeEqual } from "../session.js";

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

/** Build a token for a contact id. */
export function makeToken(contactId) {
  const id = b64url(String(contactId));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(id).digest());
  return `${id}.${sig}`;
}

/** Verify a token, returning the contact id or null. */
export function readToken(token) {
  try {
    const raw = String(token || "");
    const dot = raw.lastIndexOf(".");
    if (dot === -1) return null;
    const id = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = b64url(crypto.createHmac("sha256", secret()).update(id).digest());
    if (!safeEqual(sig, expected)) return null;
    const pad = id.length % 4 ? "=".repeat(4 - (id.length % 4)) : "";
    return Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
  } catch (e) {
    return null;
  }
}
