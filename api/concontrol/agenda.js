// api/concontrol/agenda.js — PUBLIC BY DESIGN, READ ONLY. The schedule, for
// the event website.
//
// GET -> { event, agenda: [...] }, confirmed sessions only, with speaker names,
//        bios and headshots resolved.
//
// This exists so the event site stops holding a second copy of the schedule.
// Today the grid lives in the website's source AND in whatever we agreed with
// each speaker, and those two drift every year between "confirmed" and
// "printed". One of them has to be the record, and it is this one.
//
// WHY PUBLIC IS SAFE HERE. It returns exactly what is already going on a
// public agenda page: title, blurb, time, track, speaker name, company, bio,
// headshot. It returns nothing about a proposal we passed on, nothing about a
// session still being negotiated, nothing about money, and no email addresses
// or phone numbers. publicAgenda() is the filter, and it is allowlist shaped:
// it names the fields it emits rather than removing the ones it must not.
//
// No write method exists on this route at all.

import { DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import { publicAgenda } from "../../lib/concontrol/program.js";
import { listSessions, listSpeakers, getSettings } from "../../lib/concontrol/store.js";

// The event sites, plus their preview domains. A page on one of these can read
// the agenda straight from its own JS.
const ALLOWED_ORIGINS = [
  "https://www.flyovercon.ink",
  "https://flyovercon.ink",
  "https://foc-peach.vercel.app",
];

export default async function handler(req, res) {
  const origin = (req.headers && req.headers.origin) || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // A minute of caching. The agenda changes a few times a month at most, and
  // a build step or a page hit should not pay for a full KV read every time.
  res.setHeader("Cache-Control", "public, max-age=60");

  try {
    const settings = await getSettings();
    const event = (req.query && req.query.event ? String(req.query.event) : "") || settings.event || DEFAULT_EVENT;
    const sessions = await listSessions(event);
    const speakers = await listSpeakers(event);
    return res.status(200).json({
      event,
      eventName: settings.eventName,
      eventDate: settings.eventDate,
      agenda: publicAgenda(sessions, speakers),
    });
  } catch (e) {
    console.error("concontrol agenda route error:", e);
    // A site build asking for the agenda should get an empty list and a reason,
    // not a 500 that fails the build.
    return res.status(200).json({ event: null, agenda: [], error: "Agenda is unavailable right now" });
  }
}
