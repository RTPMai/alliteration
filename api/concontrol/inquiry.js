// api/concontrol/inquiry.js — PUBLIC BY DESIGN. No-login sponsor inquiry
// endpoint for the event site's /sponsor page.
//
// POST { company, contactName, email, phone?, website?, tier?, message?, event? }
//   -> creates a sponsor record at status "inquiry", or appends the message to
//      the existing record if that company has already been entered.
//
// Same shape as api/mailme/signup.js, api/giving-intake.js and
// api/scan-status.js: no session, IP rate limited, narrow blast radius. The
// worst a bad actor can do is create junk inquiry rows on one event, which is
// the same exposure any public "sponsor us" form has. They cannot set money,
// status, payments or deliverables: this route accepts a fixed, small list of
// fields and drops everything else, so a POST cannot mark itself paid.
//
// WHY IT MATTERS. Today a sponsor inquiry is an email somebody re-types into a
// spreadsheet, or does not. Landing it as a record means the clock starts at
// the moment they asked, not at the moment somebody got round to it.

import { isRateLimited } from "../../lib/rate-limit.js";
import { intakeLimit } from "../../lib/concontrol/intake.js";
import {
  isValidEmail, newSponsor, DEFAULT_EVENT,
} from "../../lib/concontrol/schema.js";
import {
  saveSponsor, nextSponsorId, findByCompany, getSettings, updateSponsor,
} from "../../lib/concontrol/store.js";
import { notifyInbound } from "../../lib/concontrol/notify.js";


// Browsers block a cross-origin fetch() unless the SERVER names the calling
// origin. Every site that embeds the form needs to be listed here or its
// submissions fail silently in a console nobody is watching. Same list shape
// as api/mailme/signup.js; keep them in step when a domain moves.
const ALLOWED_ORIGINS = [
  "https://www.flyovercon.ink",
  "https://flyovercon.ink",
  "https://foc-peach.vercel.app",
];

// Events that can be posted to from outside. An allowlist, not free text: a
// public endpoint must not be able to spin up arbitrary event buckets.
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
    const limited = await isRateLimited(`con-inquiry:${bucket}`, limit.max, limit.windowSeconds);
    if (limited) {
      return res.status(429).json({ error: "Too many submissions. Try again later." });
    }

    const b = parseBody(req);

    // HONEYPOT. The form carries a field a person never sees and never fills.
    // Anything in it is a bot, and the answer is a cheerful 200 rather than an
    // error: telling a scraper which check caught it is how it learns to pass.
    if (clean(b._hp, 50) || clean(b._gotcha, 50) || clean(b.fax, 50)) {
      return res.status(200).json({ ok: true, id: null });
    }

    const company = clean(b.company, 200);
    const contactName = clean(b.contactName || b.name, 120);
    const email = clean(b.email, 200).toLowerCase();
    const message = clean(b.message || b.notes, 2000);

    if (!company) return res.status(400).json({ error: "Company name is required" });
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "That email address does not look right" });

    // The public form labels this field "Level you are considering" and the
    // record calls it a tier. Accepting both names here rather than renaming
    // one of them: the page is somebody else's deploy, and a field that
    // silently arrives empty is worse than two spellings.
    const level = clean(b.level || b.tier, 60);

    const settings = await getSettings();
    const asked = clean(b.event, 20);
    const event = ALLOWED_EVENTS.includes(asked) ? asked : (settings.event || DEFAULT_EVENT);

    const note = [
      `Inquiry from ${event} /sponsor, ${new Date().toISOString().slice(0, 10)}`,
      level ? `Interested in: ${level}` : null,
      message || null,
    ].filter(Boolean).join("\n");

    // Same company twice is one sponsor who submitted twice, not two
    // sponsors. The second submission appends rather than creating a
    // duplicate somebody has to spot and merge by hand later.
    const existing = await findByCompany(company, event);
    if (existing) {
      const notes = [existing.notes, note].filter(Boolean).join("\n\n");
      await updateSponsor(existing.id, { notes });
      await notifyInbound({
        to: settings.inquiryNotifyTo,
        title: `${existing.company} got back in touch about sponsoring`,
        detail: message || note,
        by: "Sponsor form",
      });
      return res.status(200).json({ ok: true, id: existing.id, duplicate: true });
    }

    const id = await nextSponsorId();
    const record = {
      ...newSponsor(id, null),
      event,
      company,
      contactName,
      email,
      phone: clean(b.phone, 40),
      website: clean(b.website, 200),
      tier: level,
      notes: note,
      source: "sponsor-form",
    };

    await saveSponsor(record);

    // The record landing somewhere nobody looks is a quieter version of the
    // email this replaced. Fails soft: a nudge that cannot be raised never
    // costs the inquiry.
    await notifyInbound({
      to: settings.inquiryNotifyTo,
      title: `Sponsor inquiry from ${company}${level ? " (" + level + ")" : ""}`,
      detail: [contactName, email, message].filter(Boolean).join("\n"),
      by: "Sponsor form",
    });

    return res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error("concontrol inquiry route error:", e);
    return res.status(500).json({ error: "Could not record that inquiry" });
  }
}
