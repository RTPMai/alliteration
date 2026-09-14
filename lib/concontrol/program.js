// lib/concontrol/program.js — ConControl sessions and speakers.
//
// The program builder. Whatever is in here is what the public agenda shows,
// which is the whole reason it is not a spreadsheet: the schedule currently
// lives in the website's source and in somebody's head, and those two drift
// every single year between "confirmed" and "printed".
//
// TWO RECORDS, NOT ONE. A speaker exists before a session does (they propose,
// we say yes or not yet) and one speaker can carry two sessions. Folding them
// together would mean either duplicating a bio or losing a proposal that never
// became a session, and the proposals we said no to are the list we go back to
// next year.
//
// ESM. Do NOT convert to module.exports.

import { isoDate } from "./schema.js";

/**
 * Gate A and Gate B, the two tracks that run at once, plus "whole room" for
 * the things that are not a track: breakfast, lunch, the round table, happy
 * hour. Naming the shared slots as a track rather than leaving them out is
 * what lets the grid show a lunch block across both columns instead of a hole.
 */
export const TRACKS = [
  { key: "a", label: "Gate A" },
  { key: "b", label: "Gate B" },
  { key: "all", label: "Whole room" },
];
export const TRACK_KEYS = TRACKS.map((t) => t.key);

export const FORMATS = ["session", "panel", "demo", "round table", "meal", "social"];

/**
 * Where a slot is up to. "held" is the one that earns its place: a slot
 * promised to somebody who has not confirmed looks exactly like an empty slot
 * from the outside, and that is how a gap gets discovered in April.
 */
export const SESSION_STATUSES = ["idea", "invited", "held", "confirmed", "declined", "cancelled"];
export const SESSION_STATUS_LABELS = {
  idea: "Idea",
  invited: "Invited",
  held: "Holding for them",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** Only confirmed sessions are public. Everything else is a plan. */
export const PUBLIC_SESSION_STATUSES = ["confirmed"];

// "wishlist" is a name somebody ASKED FOR, not a person who offered. The
// FOC26 survey asked who attendees would drive to hear and came back with
// thirteen answers, and filing those as proposals would mean the Speakers
// screen could not tell a person who volunteered from a person we have never
// contacted. It is first in the list because it is the earliest thing a
// speaker record can be.
export const SPEAKER_STATUSES = ["wishlist", "proposed", "invited", "confirmed", "declined", "passed"];
export const SPEAKER_STATUS_LABELS = {
  wishlist: "Somebody asked for them",
  proposed: "Proposed",
  invited: "Invited",
  confirmed: "Confirmed",
  declined: "They declined",
  passed: "We passed",
};

/**
 * What a speaker has to get to us before they can be on a page or a stage.
 * Same three-state rule as the sponsor checklist, for the same reason: a blank
 * is not an answer.
 */
export const SPEAKER_MATERIALS = [
  { key: "bio", label: "Bio" },
  { key: "headshot", label: "Headshot" },
  { key: "title", label: "Session title and description" },
  { key: "slides", label: "Slides or outline" },
  { key: "av", label: "Equipment needs confirmed" },
  { key: "travel", label: "Travel and lodging settled" },
];
export const MATERIAL_KEYS = SPEAKER_MATERIALS.map((m) => m.key);
export const MATERIAL_STATES = ["open", "done", "na"];

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function pickOne(raw, allowed, fallback) {
  const s = str(raw);
  return allowed.includes(s) ? s : fallback;
}

function isValidEmail(v) {
  const s = str(v).toLowerCase();
  return !!s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/** HH:MM, 24 hour. Stored flat because a session is a slot, not a timestamp. */
export function isTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str(v));
}

/* ------------------------------------------------------------------ *
 * SESSIONS
 * ------------------------------------------------------------------ */

export function newSession(id, who, event) {
  return {
    id,
    event,
    title: "",
    blurb: "",
    speakerIds: [],
    format: "session",
    track: "a",
    day: 1,
    start: "",
    minutes: 60,
    status: "idea",
    equipment: "",
    // A sponsored slot: lunch provided by, happy hour presented by. Holds a
    // sponsor id, so the agenda and the sponsor's obligations are the same
    // fact rather than two.
    sponsorId: null,
    notes: "",
    createdAt: new Date().toISOString(),
    createdBy: str(who) || null,
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

export function validateSessionPatch(body, speakerIds) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const patch = {};

  if ("title" in b) {
    const title = str(b.title);
    if (!title) errors.push("A session needs a title");
    else patch.title = title.slice(0, 200);
  }

  if ("blurb" in b) patch.blurb = str(b.blurb).slice(0, 2000);
  if ("equipment" in b) patch.equipment = str(b.equipment).slice(0, 500);
  if ("notes" in b) patch.notes = str(b.notes).slice(0, 2000);
  if ("event" in b) patch.event = str(b.event);

  if ("format" in b) {
    const f = str(b.format);
    if (!FORMATS.includes(f)) errors.push(`Unknown format "${f}"`);
    else patch.format = f;
  }

  if ("track" in b) {
    const t = str(b.track);
    if (!TRACK_KEYS.includes(t)) errors.push(`Unknown track "${t}"`);
    else patch.track = t;
  }

  if ("status" in b) {
    const s = str(b.status);
    if (!SESSION_STATUSES.includes(s)) errors.push(`Unknown status "${s}"`);
    else patch.status = s;
  }

  if ("day" in b) {
    const d = Number(b.day);
    if (!Number.isInteger(d) || d < 1 || d > 5) errors.push("Day must be 1 or 2");
    else patch.day = d;
  }

  if ("start" in b) {
    if (b.start === null || b.start === "") patch.start = "";
    else if (!isTime(b.start)) errors.push("Start time must be HH:MM");
    else patch.start = str(b.start);
  }

  if ("minutes" in b) {
    const m = Number(b.minutes);
    if (!Number.isFinite(m) || m <= 0 || m > 600) errors.push("Length must be minutes, more than zero");
    else patch.minutes = Math.round(m);
  }

  if ("speakerIds" in b) {
    const rows = Array.isArray(b.speakerIds) ? b.speakerIds : null;
    if (!rows) errors.push("Speakers must be a list");
    else {
      const clean = [];
      for (const raw of rows) {
        const id = str(raw);
        if (!id) continue;
        // Checked against the real speaker list: a session pointing at a
        // speaker who was deleted renders as a blank name on the public
        // agenda, which is worse than refusing it here.
        if (Array.isArray(speakerIds) && !speakerIds.includes(id)) {
          errors.push(`No speaker with id ${id}`);
          continue;
        }
        if (!clean.includes(id)) clean.push(id);
      }
      patch.speakerIds = clean;
    }
  }

  if ("sponsorId" in b) {
    patch.sponsorId = b.sponsorId === null || b.sponsorId === "" ? null : str(b.sponsorId);
  }

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Slots where two sessions claim the same track at the same time on the same
 * day, and confirmed sessions with nowhere to be.
 *
 * Reported, never resolved. Two speakers both told they have 10:30 in Gate A
 * is a phone call somebody has to make, and an app that silently showed one of
 * them would hide it until the printed agenda.
 */
export function scheduleConflicts(sessions) {
  const live = (sessions || []).filter(
    (s) => !["declined", "cancelled"].includes(pickOne(s.status, SESSION_STATUSES, "idea"))
  );

  const clashes = [];
  const seen = new Map();
  for (const s of live) {
    if (!s.start) continue;
    const key = `${s.day}|${s.start}|${s.track}`;
    // The whole-room track collides with everything at that time, which is
    // the point of it: nothing runs against lunch.
    if (seen.has(key)) clashes.push({ kind: "double-booked", day: s.day, start: s.start, track: s.track, ids: [seen.get(key), s.id] });
    else seen.set(key, s.id);

    if (s.track !== "all") {
      const allKey = `${s.day}|${s.start}|all`;
      if (seen.has(allKey)) {
        clashes.push({ kind: "runs-against-whole-room", day: s.day, start: s.start, track: s.track, ids: [seen.get(allKey), s.id] });
      }
    }
  }

  const unscheduled = live
    .filter((s) => s.status === "confirmed" && (!s.start || !s.day))
    .map((s) => ({ kind: "confirmed-with-no-slot", ids: [s.id] }));

  const speakerless = live
    .filter((s) => s.status === "confirmed" && !(s.speakerIds || []).length && !["meal", "social"].includes(s.format))
    .map((s) => ({ kind: "confirmed-with-no-speaker", ids: [s.id] }));

  return clashes.concat(unscheduled, speakerless);
}

/**
 * The agenda as the public site would print it. Confirmed only, ordered the
 * way the day runs, with speaker names resolved.
 *
 * Exists so the website can read one endpoint instead of the schedule being
 * maintained in two places. A session with no slot is left OUT rather than
 * printed at the top: an agenda with a floating entry reads as a mistake,
 * which it is, and scheduleConflicts() already names it where somebody can
 * fix it.
 */
export function publicAgenda(sessions, speakers) {
  const byId = new Map((speakers || []).map((s) => [s.id, s]));
  return (sessions || [])
    .filter((s) => PUBLIC_SESSION_STATUSES.includes(s.status) && s.start && s.day)
    .map((s) => ({
      day: s.day,
      start: s.start,
      minutes: s.minutes,
      track: s.track,
      trackLabel: (TRACKS.find((t) => t.key === s.track) || {}).label || s.track,
      format: s.format,
      title: s.title,
      blurb: s.blurb,
      speakers: (s.speakerIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((sp) => ({ name: sp.name, company: sp.company, bio: sp.bio, headshot: sp.headshot })),
    }))
    .sort((a, b) => (a.day - b.day) || a.start.localeCompare(b.start) || a.track.localeCompare(b.track));
}

/* ------------------------------------------------------------------ *
 * SPEAKERS
 * ------------------------------------------------------------------ */

export function newSpeaker(id, who, event) {
  const materials = {};
  for (const m of MATERIAL_KEYS) materials[m] = { state: "open", at: null, by: null };
  return {
    id,
    event,
    name: "",
    company: "",
    email: "",
    phone: "",
    bio: "",
    headshot: "",
    topic: "",
    status: "proposed",
    travelNeeded: false,
    travelNotes: "",
    materials,
    notes: "",
    source: "manual",
    createdAt: new Date().toISOString(),
    createdBy: str(who) || null,
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

export function validateSpeakerPatch(body) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const patch = {};

  if ("name" in b) {
    const name = str(b.name);
    if (!name) errors.push("A speaker needs a name");
    else patch.name = name.slice(0, 120);
  }

  if ("email" in b) {
    const email = str(b.email).toLowerCase();
    if (email && !isValidEmail(email)) errors.push("That email address does not look right");
    else patch.email = email;
  }

  if ("company" in b) patch.company = str(b.company).slice(0, 160);
  if ("phone" in b) patch.phone = str(b.phone).slice(0, 40);
  if ("bio" in b) patch.bio = str(b.bio).slice(0, 4000);
  if ("headshot" in b) patch.headshot = str(b.headshot).slice(0, 500);
  if ("topic" in b) patch.topic = str(b.topic).slice(0, 2000);
  if ("travelNotes" in b) patch.travelNotes = str(b.travelNotes).slice(0, 2000);
  if ("notes" in b) patch.notes = str(b.notes).slice(0, 4000);
  if ("event" in b) patch.event = str(b.event);
  if ("travelNeeded" in b) patch.travelNeeded = b.travelNeeded === true || b.travelNeeded === "true";

  if ("status" in b) {
    const s = str(b.status);
    if (!SPEAKER_STATUSES.includes(s)) errors.push(`Unknown status "${s}"`);
    else patch.status = s;
  }

  if ("materials" in b) {
    const raw = b.materials && typeof b.materials === "object" ? b.materials : null;
    if (!raw) errors.push("Materials must be an object");
    else {
      const clean = {};
      for (const key of Object.keys(raw)) {
        if (!MATERIAL_KEYS.includes(key)) { errors.push(`Unknown material "${key}"`); continue; }
        const entry = raw[key] || {};
        const state = str(entry.state);
        if (state && !MATERIAL_STATES.includes(state)) { errors.push(`Unknown state "${state}" for ${key}`); continue; }
        clean[key] = { state: state || "open", at: isoDate(entry.at), by: str(entry.by) || null };
      }
      patch.materials = clean;
    }
  }

  return { ok: errors.length === 0, errors, patch };
}

export function materialStates(speaker) {
  const raw = (speaker && speaker.materials) || {};
  const out = {};
  for (const m of SPEAKER_MATERIALS) {
    const entry = raw[m.key];
    out[m.key] = {
      label: m.label,
      state: pickOne(entry && entry.state, MATERIAL_STATES, "open"),
      at: isoDate(entry && entry.at),
      by: str(entry && entry.by) || null,
    };
  }
  return out;
}

export function materialProgress(speaker) {
  const states = materialStates(speaker);
  let done = 0;
  let open = 0;
  for (const key of MATERIAL_KEYS) {
    const s = states[key].state;
    if (s === "done") done += 1;
    else if (s !== "na") open += 1;
  }
  // N/A is out of the denominator, same as the sponsor checklist. A local
  // speaker who needs no travel is not missing a travel arrangement.
  return { done, open, owed: done + open, complete: open === 0 };
}

/**
 * What is blocking the program, in one list.
 *
 * Only confirmed speakers are chased for materials. Chasing somebody for a
 * headshot before they have said yes is how a proposal turns into a no.
 */
export function programBlockers(sessions, speakers) {
  const out = scheduleConflicts(sessions).slice();
  for (const sp of speakers || []) {
    if (sp.status !== "confirmed") continue;
    const p = materialProgress(sp);
    if (!p.complete) {
      out.push({ kind: "speaker-materials", ids: [sp.id], open: p.open, name: sp.name });
    }
  }
  return out;
}
