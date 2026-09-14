// api/concontrol/speak.js — PUBLIC BY DESIGN. The call-for-speakers form.
//
// POST { name, email, company?, phone?, topic?, bio?, travelNeeded? }
//   -> creates a speaker at status "proposed", or updates the proposal that
//      email already has.
//
// Same shape and the same guards as inquiry.js: no session, IP rate limited,
// honeypot aware, a fixed short field list so a POST cannot set status,
// materials or anything else that decides an outcome. The worst a bad actor
// can do is file junk proposals on one event.
//
// A proposal we passed on is next year's list, which is why nothing here ever
// deletes and a repeat submission updates rather than duplicating.

import { isRateLimited } from "../../lib/rate-limit.js";
import { DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import { newSpeaker } from "../../lib/concontrol/program.js";
import {
  saveSpeaker, updateSpeaker, nextSpeakerId, findSpeakerByEmail, getSettings,
} from "../../lib/concontrol/store.js";
import { notifyInbound } from "../../lib/concontrol/notify.js";

const MAX_PER_IP = 10;
const WINDOW_SECONDS = 60 * 60;

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

function isValidEmail(v) {
  const s = clean(v).toLowerCase();
  return !!s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
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
    const limited = await isRateLimited(`cc-speak:${clientIp(req)}`, MAX_PER_IP, WINDOW_SECONDS);
    if (limited) return res.status(429).json({ error: "Too many submissions. Try again later." });

    const b = parseBody(req);

    // Honeypot. A cheerful 200 rather than an error: telling a scraper which
    // check caught it is how it learns to pass.
    if (clean(b._hp, 50) || clean(b.fax, 50)) return res.status(200).json({ ok: true, id: null });

    const name = clean(b.name || b.contactName, 120);
    const email = clean(b.email, 200).toLowerCase();
    const topic = clean(b.topic || b.message || b.session, 2000);

    if (!name) return res.status(400).json({ error: "Your name is required" });
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "That email address does not look right" });

    const settings = await getSettings();
    const asked = clean(b.event, 20);
    const event = ALLOWED_EVENTS.includes(asked) ? asked : (settings.event || DEFAULT_EVENT);

    const existing = await findSpeakerByEmail(email, event);
    if (existing) {
      const notes = [existing.notes, `Submitted again ${new Date().toISOString().slice(0, 10)}:\n${topic}`]
        .filter(Boolean).join("\n\n");
      await updateSpeaker(existing.id, { notes });
      await notifyInbound({
        to: settings.speakNotifyTo,
        title: `${existing.name} submitted another session idea`,
        detail: topic,
        by: "Call for speakers",
      });
      return res.status(200).json({ ok: true, id: existing.id, duplicate: true });
    }

    const id = await nextSpeakerId();
    const record = {
      ...newSpeaker(id, null, event),
      name,
      email,
      company: clean(b.company, 160),
      phone: clean(b.phone, 40),
      topic,
      bio: clean(b.bio, 4000),
      travelNeeded: b.travelNeeded === true || b.travelNeeded === "true" || b.travelNeeded === "yes",
      source: "speak-form",
    };

    await saveSpeaker(record);

    await notifyInbound({
      to: settings.speakNotifyTo,
      title: `Session proposal from ${name}${record.company ? ", " + record.company : ""}`,
      detail: topic,
      by: "Call for speakers",
    });

    return res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error("concontrol speak route error:", e);
    return res.status(500).json({ error: "Could not record that proposal" });
  }
}
