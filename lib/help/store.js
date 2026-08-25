// lib/help/store.js — the log of what people asked the help bot.
//
// WHY THIS EXISTS. The knowledge pack (lib/help/content.js) is a first draft
// written from the code. It will have holes, and the only reliable way to
// find them is to see what people actually asked that it could not answer.
// This log is the roadmap for filling the pack in.
//
// Every question is recorded, answered or not, along with which documents
// were used. Answered questions matter too: a question the bot answered from
// the wrong app's doc looks fine to the asker and is worth catching.
//
// WHAT IS NOT STORED: the answer text. It can be regenerated, it is the
// largest thing here, and this is a log for finding gaps rather than a
// transcript archive. Also nothing beyond the asker's username, because a
// list of who asked what about pay or reviews is not something this platform
// needs to hold.
//
// Capped at the most recent 500. This is a diagnostic, and an uncapped log
// on a shared KV budget is how a diagnostic becomes an incident.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";

const KEY = "help_data:questions";
const MAX_ENTRIES = 500;

export async function listQuestions() {
  const rows = await getRaw(KEY);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Append one question. Never throws at the caller: a help answer that
 * arrived is not worth failing because the diagnostic log did not write.
 */
export async function logQuestion(entry) {
  try {
    const rows = await listQuestions();
    rows.unshift({
      at: new Date().toISOString(),
      by: String((entry && entry.by) || "").toLowerCase(),
      question: String((entry && entry.question) || "").slice(0, 500),
      app: (entry && entry.app) || null,
      // Which docs the answer was built from, so a wrong-doc answer is
      // findable later. Empty means nothing scored and the bot said it did
      // not know, which is the case worth reading first.
      sources: Array.isArray(entry && entry.sources) ? entry.sources.slice(0, 5) : [],
      answered: !!(entry && entry.answered),
    });
    await setRaw(KEY, rows.slice(0, MAX_ENTRIES));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The questions nothing could answer, newest first. This is the list to read
 * when deciding what to add to the knowledge pack.
 */
export function unanswered(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && !r.answered);
}
