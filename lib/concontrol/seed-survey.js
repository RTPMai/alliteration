// lib/concontrol/seed-survey.js — turn the FOC26 audience survey into a
// starting program.
//
// WHAT THIS IS FOR. Nineteen shops answered "what should we teach", each
// picking five topics from a list and naming one as the session they would not
// miss. That is the best demand signal the event has ever had, and it was
// sitting in a spreadsheet tab while the Sessions screen sat empty.
//
// WHAT IT DOES NOT DO. It does not build the grid. Every session it creates is
// an IDEA with no day, no time and no track, because how many of these fit and
// what runs against what is a judgement call, and an importer that guessed
// would produce a schedule somebody has to take apart before they can use it.
// It fills the list you choose from, not the schedule.
//
// COUNTS ARE KEPT, NOT COLLAPSED INTO A RANK. Each idea carries how many
// people picked it and how many named it as their one must-have, because those
// two numbers disagree in useful ways: "Burnout and the isolation of running a
// shop" was picked seven times and named as nobody's must-have, which is a
// different kind of session from one that four people would come for alone.
//
// IT IS RERUNNABLE. Matching is on the title, so running it twice updates the
// counts on the ideas it already made rather than making them again. Anything
// you have edited, scheduled, or confirmed is left alone entirely: once a
// session has a time on it, this stops touching it.
//
// ESM. Do NOT convert to module.exports.

import { newSession, newSpeaker } from "./program.js";
import {
  listSessions, saveSession, updateSession, nextSessionId,
  listSpeakers, saveSpeaker, updateSpeaker, nextSpeakerId,
} from "./store.js";
import { historyEntry } from "./schema.js";

/** Same loose match the sponsor importer uses: case, spacing and punctuation. */
export function titleKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Turn raw survey rows into one row per topic.
 *
 * `topics` arrives as a single pipe-separated string per response, which is how
 * a multi-select lands in a sheet. Splitting here rather than at the call site
 * keeps the parsing next to the thing that knows the shape.
 */
export function tallyTopics(rows) {
  const picked = new Map();
  const must = new Map();

  for (const row of rows || []) {
    const raw = String((row && row.topics) || "");
    for (const part of raw.split("|")) {
      const topic = part.trim();
      if (!topic) continue;
      picked.set(topic, (picked.get(topic) || 0) + 1);
    }
    const one = String((row && row.must_have_session) || "").trim();
    if (one) must.set(one, (must.get(one) || 0) + 1);
  }

  // A topic named as somebody's must-have but not present in any picks list
  // still counts. It happened in the FOC26 data and dropping it would lose the
  // strongest signal in the survey.
  for (const topic of must.keys()) {
    if (!picked.has(topic)) picked.set(topic, 0);
  }

  const out = Array.from(picked.keys()).map((topic) => ({
    topic,
    picked: picked.get(topic) || 0,
    mustHave: must.get(topic) || 0,
  }));

  // Must-haves break the tie, because a session four people would come for
  // alone outranks one that seven people ticked among five.
  out.sort((a, b) => (b.mustHave - a.mustHave) || (b.picked - a.picked) || a.topic.localeCompare(b.topic));
  return out;
}

/** The free-text answers, cleaned of the ones that are not answers. */
const NON_ANSWERS = ["no", "no.", "none", "n/a", "na", "?", "unsure", "unsure.", "anyone!", "nothing"];

export function usefulText(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  if (NON_ANSWERS.includes(s.toLowerCase())) return "";
  // "Not that I can think of. But I'm sure there is." is a polite no.
  if (/^not that i can think of/i.test(s)) return "";
  return s;
}

export function blurbFor(row) {
  const bits = [
    `Picked by ${row.picked} of the ${row.respondents} shops who answered the FOC26 survey.`,
    row.mustHave
      ? `${row.mustHave} named it as the one session they would not miss.`
      : "Nobody named it as their single must-have.",
  ];
  return bits.join(" ");
}

/**
 * Create or refresh the session ideas.
 *
 * Returns what it did rather than logging, so a caller can print a summary and
 * a test can assert on it.
 */
export async function seedSessions(rows, event, who) {
  const respondents = (rows || []).length;
  const tally = tallyTopics(rows);
  const existing = await listSessions(event);
  const byTitle = new Map(existing.map((s) => [titleKey(s.title), s]));

  const created = [];
  const updated = [];
  const skipped = [];

  for (const row of tally) {
    const hit = byTitle.get(titleKey(row.topic));
    const blurb = blurbFor({ ...row, respondents });

    if (hit) {
      // Anything with a time on it, or anything past the idea stage, is
      // somebody's decision. Overwriting it would be this script deciding it
      // knows better than the person who scheduled the day.
      if (hit.start || hit.status !== "idea") { skipped.push(hit.title); continue; }
      await updateSession(hit.id, { blurb }, historyEntry("survey counts refreshed", who));
      updated.push(hit.title);
      continue;
    }

    const id = await nextSessionId();
    const record = {
      ...newSession(id, who, event),
      title: row.topic,
      blurb,
      // No day, no start, no track. See the note at the top of this file.
      status: "idea",
      notes: "Created from the FOC26 audience survey.",
      history: [historyEntry("created from the FOC26 survey", who)],
    };
    await saveSession(record);
    created.push(row.topic);
  }

  return { respondents, topics: tally.length, created, updated, skipped };
}

/**
 * The dream-speaker answers, as wishlist records.
 *
 * Names only. A survey answer reading "someone like Christy who was passionate
 * about everything" is not a name, and a record called that would be a joke
 * sitting in the speaker list forever. Those go in the notes of the record they
 * belong to, or nowhere.
 */
export async function seedWishlist(names, event, who) {
  const existing = await listSpeakers(event);
  const byName = new Map(existing.map((s) => [titleKey(s.name), s]));

  const created = [];
  const skipped = [];

  for (const entry of names || []) {
    const name = String((entry && entry.name) || "").trim();
    if (!name) continue;
    const hit = byName.get(titleKey(name));

    if (hit) {
      // Somebody who has since proposed, been invited or confirmed does not get
      // dragged back to wishlist.
      if (hit.status !== "wishlist") { skipped.push(name); continue; }
      const notes = [hit.notes, entry.note].filter(Boolean).join("\n");
      await updateSpeaker(hit.id, { notes }, historyEntry("asked for again in the survey", who));
      continue;
    }

    const id = await nextSpeakerId();
    await saveSpeaker({
      ...newSpeaker(id, who, event),
      name,
      company: String((entry && entry.company) || "").trim(),
      status: "wishlist",
      topic: "",
      notes: [entry.note, "Named in the FOC26 audience survey as somebody attendees would drive to hear."]
        .filter(Boolean).join("\n"),
      source: "survey",
      history: [historyEntry("added from the FOC26 survey wishlist", who)],
    });
    created.push(name);
    byName.set(titleKey(name), { name, status: "wishlist" });
  }

  return { created, skipped };
}
