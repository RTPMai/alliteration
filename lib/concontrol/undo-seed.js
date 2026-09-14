// lib/concontrol/undo-seed.js — take back what the survey seeding put on the
// program.
//
// An earlier version of this app imported the FOC26 survey straight into
// Sessions and the dream-speaker answers straight into Speakers. Both were
// wrong: they are responses, and they now live on the Responses screen. This
// removes what that made, from live data where it already happened.
//
// It lives in lib/ rather than inside the route so the tests can call it for
// real against a fake Upstash. A test that greps the route for a function name
// proves the letters are there, not that the code runs, and this repo has been
// bitten by exactly that.
//
// ESM. Do NOT convert to module.exports.

import { listSessions, deleteSession, listSpeakers, deleteSpeaker } from "./store.js";

/** How a session made by the old seeding identifies itself. */
export function wasSeededFromSurvey(session) {
  return /FOC26 (audience )?survey|survey responses/i.test(String((session && session.notes) || ""));
}

/**
 * ONLY WHAT NOBODY HAS TOUCHED. A session given a time, moved past "idea", put
 * on a later day or given a speaker is somebody's decision and stays. A speaker
 * since invited or confirmed stays.
 *
 * Anything kept is NAMED in the answer rather than counted silently: "left 3
 * alone" with no names is not something a person can act on.
 *
 * Matching is on HOW a record was made, never on its title. Matching titles
 * would delete a session somebody typed themselves that happened to be called
 * the same thing.
 */
export async function undoSurveySeed(event) {
  const removedSessions = [];
  const keptSessions = [];
  const removedSpeakers = [];
  const keptSpeakers = [];

  for (const s of await listSessions(event)) {
    if (!wasSeededFromSurvey(s)) continue;
    const touched = !!s.start || (s.day || 1) > 1 || s.status !== "idea" || (s.speakerIds || []).length > 0;
    if (touched) { keptSessions.push(s.title); continue; }
    await deleteSession(s.id);
    removedSessions.push(s.title);
  }

  for (const k of await listSpeakers(event)) {
    if (String(k.source || "") !== "survey") continue;
    if (k.status !== "wishlist") { keptSpeakers.push(k.name); continue; }
    await deleteSpeaker(k.id);
    removedSpeakers.push(k.name);
  }

  return { removedSessions, keptSessions, removedSpeakers, keptSpeakers };
}
