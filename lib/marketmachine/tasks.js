// PUT IN: lib/marketmachine/tasks.js
//
// lib/marketmachine/tasks.js — whose job is this, and what do they see.
//
// PHASE 5 (Sept 2026). The campaign page is thorough because Jacob's masters
// are thorough: a Try On Day runs 19 steps, a trade show 33. That is the right
// amount of detail for the person running the campaign and the wrong amount
// for somebody who owes it one thing. Ryan's call: build the simple way in
// before anyone else is let into the app.
//
// So this file answers one question: which open steps belong to the person
// asking. They get a line each, with a short why, and a box to tick. Nothing
// about stages, formulas, connections or scorecards.
//
// WHOSE STEP IS IT. Two ways, and only two:
//   1. The step's owner is the Account Manager and they ARE the campaign's
//      Account Manager, matched on the CrewCore employee id, never on a name
//      somebody typed.
//   2. The owner names them. "Jacob", "Ryan and Megan", "Margo, Ryan, and
//      Megan" are all Ryan's or Jacob's, matched on whole words against their
//      first name and their full name.
//
// A GENERIC OWNER IS NOBODY'S. "Assigned staff", "Production", "Art",
// "Campaign owner" name a job, not a person, so those steps never appear in
// anyone's list. Guessing would put a stranger's work in somebody's face and,
// worse, let the real owner assume it was covered. They stay visible on the
// campaign page, where a person is looking at the whole thing anyway.
//
// Pure. The server decides what a person may tick using the same function the
// screen uses to decide what to show them.
//
// ESM. Do NOT convert to module.exports.

import { STAGE_KEYS, typeMeta } from "./catalog.js";
import { dueDateFor, todayCentral } from "./dates.js";

/** Owner labels that name a role rather than a person. */
const GENERIC = [
  "campaign owner", "campaign owners", "account manager", "assigned account manager",
  "production", "art", "assigned staff", "attending staff", "assigned owners",
  "shipping", "decorator", "production employee", "meeting owner", "assigned parade staff",
  "assigned construction and production staff", "purchasing and shipping", "attending ams",
  "employee incurring expense", "assigned challenge owner", "intake employee",
];

function words(s) {
  return String(s || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * Does this owner label name this person?
 *
 * Whole words only: "Megan" never matches inside another word, and a person
 * called Ryan is not matched by "Bryan".
 */
export function ownerNames(ownerLabel, person) {
  const p = person || {};
  const label = String(ownerLabel || "").toLowerCase().trim();
  if (!label) return false;
  if (GENERIC.includes(label)) return false;
  const inLabel = words(label);
  const full = words(p.name);
  if (!full.length) return false;
  const first = full[0];
  // A first name alone is enough ("Jacob", "Ryan and Megan"), but only when it
  // stands as its own word in the label.
  if (inLabel.includes(first)) return true;
  // A full name written out also counts.
  return full.length > 1 && full.every((w) => inLabel.includes(w));
}

/**
 * Is this step this person's? `employeeId` is resolved on the server from
 * CrewCore, so an Account Manager step is matched on the record, not a name.
 */
export function isMyStep(campaign, step, person) {
  if (!campaign || !step) return false;
  if (campaign.status !== "open") return false;
  if (step.done || step.notApplicable) return false;
  const p = person || {};
  const owner = String(step.owner || "");
  const amStep = /account manager/i.test(owner) && !/assigned account manager/i.test(owner);
  if (amStep && p.employeeId && campaign.accountManagerId &&
      String(campaign.accountManagerId) === String(p.employeeId)) return true;
  return ownerNames(owner, p);
}

/**
 * May this person tick this step? The same rule, plus admins, who can tick
 * anything because they are the ones fixing a record after the fact.
 */
export function canTickStep(campaign, step, person) {
  if (person && person.admin) return true;
  return isMyStep(campaign, step, person);
}

/**
 * Why this task exists, in one short line.
 *
 * The step's own help when it has one, cut to its first sentence, because a
 * paragraph in a list of tasks is a paragraph nobody reads. Otherwise the
 * campaign it belongs to, which is a real answer rather than a filler one.
 */
export function whyLine(campaign, step) {
  const help = String((step && step.help) || "").trim();
  if (help) {
    const first = help.split(/(?<=[.!?])\s/)[0].trim();
    return first.length > 160 ? first.slice(0, 157).trimEnd() + "..." : first;
  }
  const meta = typeMeta(campaign && campaign.type) || {};
  return `Part of ${campaign.name}, a ${meta.label || "campaign"} campaign.`;
}

/**
 * What opens under a task when somebody taps Details (Sept 24 2026).
 *
 * Ryan: My tasks did not link to the campaign or show anything past one line,
 * so a person could not see what the step was about. The campaign page is
 * still admin only, so for everyone else the answer is the few facts that
 * belong to THIS step plus the campaign's basics, and nothing more:
 *
 *   - the step's full help text (the list shows only its first sentence)
 *   - the step's own notes and files, which is where the proof, the artwork
 *     link or the Printavo invoice usually lives
 *   - the campaign's key date under its own name ("Parade date"), its Account
 *     Manager, and who it is for
 *
 * Deliberately NOT here: the budget, campaign notes, history, connections,
 * the scorecard, and every other person's steps. Those stay on the campaign
 * page, which Admins open from the same row.
 */
export function taskDetails(campaign, step, meta) {
  const c = campaign || {};
  const s = step || {};
  const m = meta || typeMeta(c.type) || {};
  return {
    help: String(s.help || "").trim(),
    notes: String(s.notes || "").trim(),
    links: (Array.isArray(s.links) ? s.links : [])
      .filter((l) => l && /^https?:\/\//i.test(String(l.url || "")))
      .map((l) => ({ label: String(l.label || ""), url: String(l.url) })),
    dateLabel: m.controlLabel || "Campaign date",
    date: c.controlDate || null,
    accountManager: c.accountManagerName || null,
    audience: String(c.audience || "").trim(),
  };
}

/**
 * Everything this person owes, soonest first, with undated work last rather
 * than first: a task with no date is not urgent, and sorting it to the top
 * would bury the ones that are.
 */
export function myTasks(campaigns, person, today) {
  const day = today || todayCentral();
  const out = [];
  (Array.isArray(campaigns) ? campaigns : []).forEach((c) => {
    const steps = Array.isArray(c.steps) ? c.steps : [];
    const ordered = STAGE_KEYS.flatMap((stage) => steps.filter((s) => s.stage === stage));
    const firstOpen = ordered.find((s) => !s.done && !s.notApplicable);
    ordered.forEach((s) => {
      if (!isMyStep(c, s, person)) return;
      const waitingOn = (s.after || [])
        .map((k) => steps.find((x) => x.key === k))
        .find((x) => x && !x.done && !x.notApplicable);
      const due = dueDateFor(s, c.controlDate);
      const meta = typeMeta(c.type) || {};
      out.push({
        campaignId: c.id,
        campaignName: c.name,
        typeLabel: (typeMeta(c.type) || {}).label || c.type,
        key: s.key,
        label: s.label,
        why: whyLine(c, s),
        due,
        overdue: !!(due && due < day),
        next: firstOpen ? firstOpen.key === s.key : false,
        waitingOn: waitingOn ? waitingOn.label : null,
        blocked: s.blocked || "",
        approval: !!s.approval,
        details: taskDetails(c, s, meta),
      });
    });
  });

  return out.sort((a, b) => {
    const ad = a.due || "9999-99-99";
    const bd = b.due || "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.campaignName).localeCompare(String(b.campaignName));
  });
}

/**
 * The three groups the simple screen shows. Anything waiting on somebody
 * else's step is set aside rather than listed as due: telling a person to do
 * something they cannot start yet is how a task list stops being believed.
 */
export function groupTasks(tasks, today) {
  const day = today || todayCentral();
  const soon = new Date(Date.UTC(...day.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))));
  soon.setUTCDate(soon.getUTCDate() + 7);
  const within = soon.toISOString().slice(0, 10);

  const ready = tasks.filter((t) => !t.waitingOn);
  return {
    overdue: ready.filter((t) => t.overdue),
    soon: ready.filter((t) => !t.overdue && t.due && t.due <= within),
    later: ready.filter((t) => !t.overdue && (!t.due || t.due > within)),
    waiting: tasks.filter((t) => t.waitingOn),
  };
}
