// api/concontrol/signup.js - PUBLIC BY DESIGN. No-login notify list intake for
// the event site's /notify page.
//
// POST { name?, email, city_state?, event? }
//   -> 201 and a new signup record, source "website"
//   -> 200 { duplicate } if that email is already on the list
//
// WHY THIS EXISTS. Until now the notify list only reached ConControl by a
// pasted sheet export or a person typed in by hand. The website form wrote the
// Google Sheet and stopped there, so a signup looked like it vanished. This
// closes that gap the same way sponsor inquiries and speaker pitches already
// work: flyovercon.ink/api/notify forwards here server to server.
//
// Same exposure as api/concontrol/inquiry.js: no session, rate limited, a fixed
// small field list, one event allowlist. The worst a bad actor can do is add
// junk emails to a list nobody mails without looking at it first.
//
// NO NOTIFICATION. A sponsor inquiry is a person waiting on a reply. A notify
// signup is somebody asking to hear when registration opens, and a busy
// launch day would bury the inbox. The list is the record.
//
// ESM. Do NOT convert to module.exports.

import { isRateLimited } from "../../lib/rate-limit.js";
import { intakeLimit } from "../../lib/concontrol/intake.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import { newSignup, manualSignup } from "../../lib/concontrol/responses.js";
import { listSignups, saveSignup, nextSignupId, getSettings } from "../../lib/concontrol/store.js";

const ALLOWED_ORIGINS = [
  "https://www.flyovercon.ink",
  "https://flyovercon.ink",
  "https://foc-peach.vercel.app",
];

const ALLOWED_EVENTS = ["FOC27"];

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

function clean(v, max = 300) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const origin = (req.headers && req.headers.origin) || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const limit = intakeLimit(req);
    const bucket = limit.key || clientIp(req);
    const limited = await isRateLimited(`con-signup:${bucket}`, limit.max, limit.windowSeconds);
    if (limited) return res.status(429).json({ error: "Too many submissions. Try again later." });

    const b = parseBody(req);

    // Honeypot: cheerful 200, same as the other public routes.
    if (clean(b._hp, 50) || clean(b._gotcha, 50) || clean(b.fax, 50)) {
      return res.status(200).json({ ok: true, id: null });
    }

    const settings = await getSettings();
    const asked = clean(b.event, 20);
    const event = ALLOWED_EVENTS.includes(asked) ? asked : (settings.event || DEFAULT_EVENT);

    // Same rules as a hand-added person, so website, import and manual entries
    // are one shape and dedupe against each other.
    const out = manualSignup(b, await listSignups(event));
    if (out.duplicate) return res.status(200).json({ ok: true, id: out.duplicate, duplicate: true });
    if (out.error) return res.status(400).json({ error: out.error });

    const id = await nextSignupId();
    const record = newSignup(id, event, { ...out.answers, submitted_at: clean(b.submitted_at, 40) }, "website");
    record.history = [historyEntry("signed up on the website", "website")];
    await saveSignup(record);

    return res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error("concontrol signup route error:", e);
    return res.status(500).json({ error: "Could not record that signup" });
  }
}
