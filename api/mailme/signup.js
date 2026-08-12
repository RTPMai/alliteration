// api/mailme/signup.js — PUBLIC BY DESIGN. No-login opt-in endpoint for
// external signup pages (Flyover Con today, any future event/campaign page
// tomorrow).
//
// POST { name, email, list? } -> adds the person to a MailMe list. Tags an
// existing contact if the email is already known (client/lead/giving, or a
// previously-imported prospect) instead of duplicating it; otherwise creates
// a new prospect record, same shape as a one-row CSV import. The target list
// itself is created lazily on the first-ever signup for that `list` key —
// dynamic and tag-matched, so no admin setup step is needed before a signup
// page goes live, and every later signup lands in it automatically.
//
// Same shape as api/giving-intake.js and api/scan-status.js: no session,
// IP rate-limited, deliberately narrow blast radius. The worst a bad actor
// can do is add junk name/email rows tagged to one list, which is the same
// exposure a public "join our mailing list" form on any website has.
//
// `list` is checked against an ALLOWLIST, not accepted as free text — a
// public POST endpoint must not be able to spin up arbitrary MailMe lists or
// tag arbitrary existing contacts with an attacker-chosen label.

import { isConfigured } from "../../lib/kv.js";
import { isRateLimited } from "../../lib/rate-limit.js";
import { isValidEmail, normalizeEmail } from "../../lib/mailme/schema.js";
import { isRoleAddress } from "../../lib/mailme/import.js";
import { publicListSignup } from "../../lib/mailme/store.js";

const SIGNUP_MAX_PER_IP = 10;
const SIGNUP_WINDOW_SECONDS = 60 * 60;

// Add a new entry here for each future public signup page. Key is whatever
// the page sends as `list`; tag/listName are what actually gets written.
const ALLOWED_SIGNUPS = {
  "flyover-con": { tag: "Flyover Con", listName: "Flyover Con" },
};

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  // Real submitters fire this once per form fill. 10/hour from one IP is far
  // more than that, so this only catches scripted spam, same reasoning as
  // giving-intake.js.
  const ipKey = "mailme-signup:ip:" + clientIp(req);
  if (await isRateLimited(ipKey, SIGNUP_MAX_PER_IP, SIGNUP_WINDOW_SECONDS)) {
    return res.status(429).json({ error: "Too many submissions from this source." });
  }

  const body = parseBody(req);
  const listKey = String(body.list || "flyover-con").trim().toLowerCase();
  const target = ALLOWED_SIGNUPS[listKey];
  if (!target) {
    return res.status(400).json({ error: "Unknown signup list." });
  }

  const name = String(body.name || "").trim().slice(0, 200);
  const email = normalizeEmail(body.email);

  if (!name) return res.status(400).json({ error: "Name is required." });
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  if (isRoleAddress(email)) {
    return res.status(400).json({ error: "Please use a personal email address." });
  }

  try {
    const result = await publicListSignup({
      email, name, tag: target.tag, listName: target.listName,
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (e) {
    console.error("mailme signup route error:", e);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
