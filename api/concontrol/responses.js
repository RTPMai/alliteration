// api/concontrol/responses.js — everything people sent us, in one place.
//
// GET                          the four streams, plus the survey summary
// POST { what: "import-survey", csv }   paste the sheet export
// POST { what: "import-signups", csv }  same, for the notify list
// POST { what: "load-foc26" }          load the FOC26 survey and notify list
// POST { what: "promote", topic }       turn one asked-for topic into a session idea
// DELETE ?id=&kind=            remove one imported response, admin only
//
// WHY IMPORT BY PASTE RATHER THAN A FILE IN THE REPO. The survey carries names,
// email addresses and people writing candidly about their own businesses. A
// copy in git would put that in every clone forever and be stale the day
// somebody answers again. A paste of the CSV export is two minutes now and two
// minutes next year.
//
// WHO CAN SEE IT. Reading needs edit rights, not merely a login. These are
// people writing candidly about what is going wrong in their shops, on the
// understanding that we asked. That is a narrower circle than "did the sponsor
// send a logo".

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import { historyEntry, DEFAULT_EVENT } from "../../lib/concontrol/schema.js";
import {
  newResponse, newSignup, rowsFromCsv, responseKey, summarise, signupIsUsable,
} from "../../lib/concontrol/responses.js";
import { newSession } from "../../lib/concontrol/program.js";
import { FOC26_SURVEY, FOC26_SIGNUPS } from "../../lib/concontrol/foc26-responses.js";
import {
  listResponses, saveResponse, updateResponse, deleteResponse, nextResponseId,
  listSignups, saveSignup, deleteSignup, nextSignupId,
  listSponsors, listSpeakers, listSessions, saveSession, nextSessionId,
  getSettings,
} from "../../lib/concontrol/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function gate(sess) {
  const perms = await permsFor(sess.username);
  const superuser = !!(perms && perms.superuser === true);
  return {
    canSee: superuser || !!(perms && perms.can_edit !== false),
    canEdit: superuser || !!(perms && perms.can_edit !== false),
    canDelete: superuser || !!(perms && perms.role === "admin"),
  };
}

/**
 * Import survey rows.
 *
 * Rerunnable. Matching is email plus the submitted-at stamp, so pasting the
 * whole sheet again after three new answers adds three records rather than
 * nineteen duplicates.
 */
async function importSurvey(csv, event, who) {
  const { rows, unknown } = rowsFromCsv(csv);
  return importSurveyRows(rows, event, who, unknown);
}

async function importSurveyRows(rows, event, who, unknown) {
  const existing = await listResponses(event);
  const seen = new Set(existing.filter((r) => r.kind === "survey").map((r) => responseKey(r.answers)));

  const created = [];
  let duplicate = 0;
  let empty = 0;

  for (const answers of rows) {
    // A row with nothing in it but a timestamp is a blank submission.
    const said = Object.keys(answers).filter((k) => k !== "submitted_at" && answers[k]);
    if (!said.length) { empty += 1; continue; }

    const key = responseKey(answers);
    if (seen.has(key)) { duplicate += 1; continue; }

    const id = await nextResponseId();
    const record = newResponse(id, event, "survey", answers, "sheet-import");
    record.history = [historyEntry("imported from the sheet", who)];
    await saveResponse(record);
    seen.add(key);
    created.push(id);
  }

  return { created: created.length, duplicate, empty, unknownColumns: unknown || [] };
}

/**
 * Import notify signups.
 *
 * An email and nothing else is still a signup. Two of these were sitting in a
 * shifted column of the sheet with no name and no city, and a shape that
 * refuses them is the shape that loses them.
 */
async function importSignups(csv, event, who) {
  return importSignupRows(rowsFromCsv(csv).rows, event, who);
}

async function importSignupRows(rows, event, who) {
  const existing = await listSignups(event);
  const seen = new Set(existing.map((r) => String((r.answers || {}).email || "").toLowerCase()));

  const created = [];
  let duplicate = 0;
  let unusable = 0;

  for (const answers of rows) {
    if (!signupIsUsable(answers)) { unusable += 1; continue; }
    const email = String(answers.email).toLowerCase();
    if (seen.has(email)) { duplicate += 1; continue; }

    const id = await nextSignupId();
    const record = newSignup(id, event, answers, "sheet-import");
    record.history = [historyEntry("imported from the sheet", who)];
    await saveSignup(record);
    seen.add(email);
    created.push(id);
  }

  return { created: created.length, duplicate, unusable };
}

/**
 * Turn one asked-for topic into a session idea.
 *
 * ONE AT A TIME, ON PURPOSE. The first version of this created all twenty-six
 * at once, which put a program on the board that nobody had agreed to. What
 * people asked for and what we decided to teach are two different lists.
 *
 * The idea arrives with no day, no time and no track. Where it goes is the
 * next decision, not this one.
 */
async function promote(topic, event, who, records) {
  const title = String(topic || "").trim();
  if (!title) return { error: "Which topic?" };

  const sessions = await listSessions(event);
  const hit = sessions.find((s) => s.title.toLowerCase() === title.toLowerCase());
  if (hit) return { already: true, id: hit.id };

  const id = await nextSessionId();
  const picked = records.filter((r) => String((r.answers || {}).topics || "").includes(title)).length;
  const must = records.filter((r) => String((r.answers || {}).must_have_session || "").trim() === title).length;

  await saveSession({
    ...newSession(id, who, event),
    title,
    blurb: `Asked for by ${picked} of the ${records.length} shops who answered the survey.`
      + (must ? ` ${must} named it as the one session they would not miss.` : ""),
    status: "idea",
    notes: "Promoted from the survey responses.",
    history: [historyEntry("promoted from a survey topic", who)],
  });

  // Stamped on every response that asked for it, so the screen can show which
  // asks have been acted on and which are still just asks.
  for (const rec of records) {
    if (!String((rec.answers || {}).topics || "").includes(title)) continue;
    const actedOn = Array.isArray(rec.actedOn) ? rec.actedOn.slice() : [];
    if (actedOn.includes(title)) continue;
    actedOn.push(title);
    await updateResponse(rec.id, { actedOn });
  }

  return { id, title };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};

  try {
    const settings = await getSettings();
    const event = (q.event && String(q.event)) || settings.event || DEFAULT_EVENT;
    const { canSee, canEdit, canDelete } = await gate(sess);

    if (!canSee) {
      return res.status(403).json({
        error: "Responses are not open to read-only accounts: people wrote candidly about their own shops.",
      });
    }

    if (req.method === "GET") {
      const [all, signups, sponsors, speakers] = [
        await listResponses(event), await listSignups(event),
        await listSponsors(event), await listSpeakers(event),
      ];
      const survey = all.filter((r) => r.kind === "survey");

      return res.status(200).json({
        event,
        // THE FOUR STREAMS ARE THE FOUR FORMS. What belongs here is what
        // somebody submitted, so these filter on SOURCE, not on status.
        //
        // Status would be wrong in both directions: a sponsor moved from
        // inquiry to committed still applied, and a sponsor typed in by hand
        // at status inquiry never did. Prior-year prospects and names off a
        // wish list are ours, not theirs, and they do not belong on a screen
        // called Responses.
        inquiries: sponsors.filter((s) => s.source === "sponsor-form"),
        proposals: speakers.filter((s) => s.source === "speak-form"),
        survey,
        signups,
        summary: summarise(survey),
        canEdit,
        canDelete,
      });
    }

    if (req.method === "POST") {
      if (!canEdit) return res.status(403).json({ error: "Your role is read-only in ConControl." });
      const b = parseBody(req);
      const what = String(b.what || "");

      if (what === "import-survey") {
        if (!String(b.csv || "").trim()) return res.status(400).json({ error: "Paste the CSV first" });
        return res.status(200).json({ ok: true, ...(await importSurvey(b.csv, event, sess.username)) });
      }

      if (what === "import-signups") {
        if (!String(b.csv || "").trim()) return res.status(400).json({ error: "Paste the CSV first" });
        return res.status(200).json({ ok: true, ...(await importSignups(b.csv, event, sess.username)) });
      }

      // The FOC26 data ships with the app so this is one button. Every earlier
      // version of it asked somebody to export a CSV and paste it, and went
      // unrun. Same matching as the paste, so pressing it twice is harmless
      // and a later paste of the same sheet adds nothing.
      if (what === "load-foc26") {
        const survey = await importSurveyRows(FOC26_SURVEY, event, sess.username, []);
        const signups = await importSignupRows(FOC26_SIGNUPS, event, sess.username);
        return res.status(200).json({ ok: true, survey, signups });
      }

      if (what === "promote") {
        const records = (await listResponses(event)).filter((r) => r.kind === "survey");
        const out = await promote(b.topic, event, sess.username, records);
        if (out.error) return res.status(400).json({ error: out.error });
        return res.status(200).json({ ok: true, ...out });
      }

      return res.status(400).json({ error: `Nothing to do called "${what}"` });
    }

    if (req.method === "DELETE") {
      if (!canDelete) return res.status(403).json({ error: "Deleting a response is admin only." });
      const id = q.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const gone = String(q.kind) === "signup" ? await deleteSignup(id) : await deleteResponse(id);
      if (!gone) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("concontrol responses route error:", e);
    return res.status(500).json({ error: e.message || "Responses request failed" });
  }
}
