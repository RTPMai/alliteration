// lib/concontrol/undo-seed.js — take back what the survey seeding put on the
// program.
//
// An earlier version of this app imported the FOC26 survey straight into
// Sessions and the dream-speaker answers straight into Speakers. Both were
// wrong: they are responses, and they now live on the Responses screen.
//
// It also covers the prior-year sponsors, which are not responses but are the
// same kind of mistake from the other end: a board that looks full of sponsors
// nobody has spoken to yet. Anything with a conversation attached stays.
//
// It lives in lib/ rather than inside the route so the tests can call it for
// real against a fake Upstash. A test that greps the route for a function name
// proves the letters are there, not that the code runs, and this repo has been
// bitten by exactly that.
//
// ESM. Do NOT convert to module.exports.

import {
  listSessions, deleteSession, listSpeakers, deleteSpeaker,
  listSponsors, deleteSponsor,
} from "./store.js";

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
  const removedSponsors = [];
  const keptSponsors = [];

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

  // Last year's sponsors, seeded as this year's prospects. Same rule: only the
  // ones still exactly as they arrived. A prospect you have priced, invoiced,
  // taken money from, given a level, or even written a note on is a
  // conversation in progress, and it stays.
  for (const sp of await listSponsors(event)) {
    if (String(sp.source || "") !== "prior-year") continue;
    const touched = sp.status !== "inquiry"
      || sp.committed !== null
      || sp.invoicedAmount !== null
      || (sp.payments || []).length > 0
      || !!sp.tier
      || (sp.moments || []).length > 0
      || !!sp.contactName
      || !!sp.email;
    if (touched) { keptSponsors.push(sp.company); continue; }
    await deleteSponsor(sp.id);
    removedSponsors.push(sp.company);
  }

  return {
    removedSessions, keptSessions,
    removedSpeakers, keptSpeakers,
    removedSponsors, keptSponsors,
  };
}
