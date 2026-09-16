// PUT IN: lib/marketmachine/campaign.js
//
// lib/marketmachine/campaign.js — what a campaign is, and the rules it keeps.
//
// REPLACES lib/marketmachine/schema.js (Sept 2026, phase 1 of the rebuild
// Ryan approved from Jacob's handoff). The old model was a record of a
// campaign plus hand-typed numbers per channel. This one runs the work: a
// campaign has a type, the type gives it an ordered checklist in six stages,
// every step has an owner, a due date, a done box, the date it was done, and
// notes. Postal, Digital Platform and the rest are campaigns of their own,
// never a channel checkbox inside another campaign.
//
// THE RULES THAT LIVE HERE, and why here:
//
//   1. A step cannot be marked done before the steps it depends on. Launch
//      steps depend on the prelaunch review, so nothing launches unreviewed.
//      Enforced in this file, which the API calls, so the rule holds no matter
//      what screen or script asks.
//   2. Not applicable only where the handoff allows it. A required step
//      cannot be waved through.
//   3. A person's due date beats the suggestion (see dates.js).
//   4. A campaign cannot be closed as complete with open steps. Cancelled can
//      happen any time, because that is the honest answer for work that
//      stopped.
//   5. A connected campaign copies event identity and dates from its parent
//      when it is created and never again. Its own owner, audience, dates and
//      checklist are its own from then on.
//
// Pure, no storage: tests call every rule here directly. The browser imports
// it too, so the screen and the server read status the same way.
//
// ESM. Do NOT convert to module.exports.

import {
  CATALOG_VERSION, STAGES, STAGE_KEYS, typeMeta, starterSteps, isParentType, connectableTypes,
} from "./catalog.js";
import { isIsoDate, dueDateFor, todayCentral } from "./dates.js";

export const CAMPAIGN_STATUSES = ["open", "complete", "cancelled"];
export const AUDIENCE_KINDS = ["list", "public"];
export const PARTICIPATION = ["exhibitor", "attendee", "hybrid", "not_attending"];

const HISTORY_LIMIT = 200;

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 200);

function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function cleanLinks(list) {
  return (Array.isArray(list) ? list : [])
    .map((l) => ({ label: str(l && l.label, 120), url: str(l && l.url, 1000) }))
    .filter((l) => /^https?:\/\//i.test(l.url))
    .slice(0, 20);
}

function who(session) {
  return (session && (session.name || session.username)) || null;
}

function logLine(campaign, session, what) {
  const history = Array.isArray(campaign.history) ? campaign.history.slice() : [];
  history.push({ at: new Date().toISOString(), by: who(session), what: str(what, 300) });
  campaign.history = history.slice(-HISTORY_LIMIT);
}

/* ----------------------------------------------------------------------- *
 * CREATE
 * ----------------------------------------------------------------------- */

/**
 * Validate a new campaign. `parent` is the parent record when one was named,
 * already loaded by the caller, so this stays free of storage.
 */
export function validateNew(body, parent) {
  const b = body || {};
  const errors = [];
  const type = str(b.type, 40);
  const meta = typeMeta(type);
  if (!meta) errors.push("Pick a campaign type");

  if (b.parentId) {
    if (!parent) errors.push("The event this was connected to no longer exists");
    else if (!isParentType(parent.type)) errors.push("Only a Marketing Event can hold connected campaigns");
    else if (meta && !connectableTypes(parent.type).includes(type)) {
      errors.push(`${meta.label} cannot be connected under ${(typeMeta(parent.type) || {}).label || "that event"}`);
    }
    if (meta && meta.parent) errors.push("A Marketing Event cannot sit under another event");
  }

  const name = str(b.name, 120);
  if (!name && !parent) errors.push("A campaign needs a name");

  if (b.controlDate && !isIsoDate(b.controlDate)) errors.push("The date must be a real calendar date");
  if (b.audienceKind && !AUDIENCE_KINDS.includes(b.audienceKind)) errors.push("Audience must be a list or a public audience");
  if (b.participation && !PARTICIPATION.includes(b.participation)) errors.push("Unknown participation choice");
  if (b.budget !== undefined && b.budget !== null && b.budget !== "" && money(b.budget) === null) {
    errors.push("Budget must be a number, zero or more");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * A new campaign record, without an id (the store assigns one).
 *
 * With a parent: the name, controlling date and Account Manager default to
 * the parent's, but only when the request did not supply its own. The
 * audience is never copied, because a Postal campaign under a trade show
 * mails exact recipients and the show's audience is a room of strangers.
 */
export function buildCampaign(body, session, parent) {
  const b = body || {};
  const type = str(b.type, 40);
  const meta = typeMeta(type) || {};
  const now = new Date().toISOString();

  const fromParent = parent || null;
  const record = {
    name: str(b.name, 120) || (fromParent ? `${fromParent.name}: ${meta.label}` : ""),
    type,
    parentId: fromParent ? String(fromParent.id) : null,
    status: "open",
    accountManagerId: str(b.accountManagerId, 60) || (fromParent ? fromParent.accountManagerId || null : null),
    accountManagerName: str(b.accountManagerName, 120) || (fromParent ? fromParent.accountManagerName || null : null),
    audienceKind: AUDIENCE_KINDS.includes(b.audienceKind) ? b.audienceKind : "list",
    audience: str(b.audience, 500),
    controlDate: isIsoDate(b.controlDate) ? b.controlDate
      : (fromParent && isIsoDate(fromParent.controlDate) ? fromParent.controlDate : null),
    participation: meta.parent && PARTICIPATION.includes(b.participation) ? b.participation : null,
    budget: money(b.budget),
    notes: str(b.notes, 4000),
    catalogVersion: CATALOG_VERSION,
    steps: starterSteps(type).map((s) => ({
      ...s,
      dueOverride: null,
      done: false,
      doneAt: null,
      doneBy: null,
      approvedBy: null,
      notApplicable: false,
      blocked: "",
      notes: "",
      links: [],
    })),
    history: [],
    createdAt: now,
    createdBy: (session && session.username) || null,
    updatedAt: now,
  };
  logLine(record, session, fromParent
    ? `Created as a connected campaign under ${fromParent.id}`
    : "Created");
  return record;
}

/* ----------------------------------------------------------------------- *
 * HEADER EDITS
 * ----------------------------------------------------------------------- */

/**
 * Apply a header edit. Returns { ok, errors, campaign } with a NEW record;
 * the input is never mutated, so a refused edit leaves nothing half-changed.
 *
 * Type and parent cannot change after creation. The checklist was copied
 * from the type, so switching type would leave a Postal campaign carrying a
 * trade show's steps, and moving a campaign between events would move its
 * history with it silently.
 */
export function applyHeaderPatch(current, body, session) {
  const b = body || {};
  const errors = [];
  const next = JSON.parse(JSON.stringify(current || {}));
  const changed = [];

  if (b.type !== undefined && b.type !== current.type) errors.push("A campaign's type cannot change after it is created");
  if (b.parentId !== undefined && (b.parentId || null) !== (current.parentId || null)) {
    errors.push("A connected campaign cannot be moved to a different event");
  }

  if (b.name !== undefined) {
    const s = str(b.name, 120);
    if (!s) errors.push("A campaign needs a name");
    else if (s !== current.name) { next.name = s; changed.push("name"); }
  }
  if (b.accountManagerId !== undefined) {
    next.accountManagerId = str(b.accountManagerId, 60) || null;
    next.accountManagerName = str(b.accountManagerName, 120) || null;
    changed.push("Account Manager");
  }
  if (b.audienceKind !== undefined) {
    if (!AUDIENCE_KINDS.includes(b.audienceKind)) errors.push("Audience must be a list or a public audience");
    else { next.audienceKind = b.audienceKind; changed.push("audience"); }
  }
  if (b.audience !== undefined) { next.audience = str(b.audience, 500); if (!changed.includes("audience")) changed.push("audience"); }
  if (b.controlDate !== undefined) {
    if (b.controlDate && !isIsoDate(b.controlDate)) errors.push("The date must be a real calendar date");
    else if ((b.controlDate || null) !== (current.controlDate || null)) {
      next.controlDate = b.controlDate || null;
      changed.push(((typeMeta(current.type) || {}).controlLabel || "date").toLowerCase());
    }
  }
  if (b.participation !== undefined) {
    if (!isParentType(current.type)) errors.push("Only a Marketing Event has a participation choice");
    else if (b.participation && !PARTICIPATION.includes(b.participation)) errors.push("Unknown participation choice");
    else { next.participation = b.participation || null; changed.push("participation"); }
  }
  if (b.budget !== undefined) {
    if (b.budget !== null && b.budget !== "" && money(b.budget) === null) errors.push("Budget must be a number, zero or more");
    else { next.budget = money(b.budget); changed.push("budget"); }
  }
  if (b.notes !== undefined) { next.notes = str(b.notes, 4000); changed.push("notes"); }

  if (b.status !== undefined) {
    if (!CAMPAIGN_STATUSES.includes(b.status)) errors.push("Unknown campaign status");
    else if (b.status !== current.status) {
      if (b.status === "complete") {
        const open = openSteps(current);
        if (open.length) {
          errors.push(`${open.length} step${open.length === 1 ? " is" : "s are"} still open, starting with "${open[0].label}". Finish or mark them not applicable first.`);
        }
      }
      next.status = b.status;
      changed.push(b.status === "open" ? "reopened" : `marked ${b.status}`);
    }
  }

  if (errors.length) return { ok: false, errors, campaign: current };
  if (changed.length) logLine(next, session, "Changed " + changed.join(", "));
  next.updatedAt = new Date().toISOString();
  return { ok: true, errors: [], campaign: next };
}

/* ----------------------------------------------------------------------- *
 * STEP EDITS
 * ----------------------------------------------------------------------- */

const isClear = (s) => !!(s && (s.done || s.notApplicable));

export function openSteps(campaign) {
  return (Array.isArray(campaign && campaign.steps) ? campaign.steps : []).filter((s) => !isClear(s));
}

/** The dependencies of a step that are not finished yet, as step records. */
export function unmetDependencies(campaign, stepKey) {
  const steps = Array.isArray(campaign && campaign.steps) ? campaign.steps : [];
  const target = steps.find((s) => s.key === stepKey);
  if (!target) return [];
  return (target.after || [])
    .map((k) => steps.find((s) => s.key === k))
    .filter((s) => s && !isClear(s));
}

/**
 * Apply an edit to one step. Returns { ok, errors, campaign } with a new
 * record.
 *
 * Accepted fields: done, doneAt, notApplicable, notes, dueDate (a person's
 * due date; null or "" returns to the suggestion), blocked, links.
 */
export function applyStepPatch(current, stepKey, body, session, today) {
  const b = body || {};
  const errors = [];
  const next = JSON.parse(JSON.stringify(current || {}));
  const steps = Array.isArray(next.steps) ? next.steps : [];
  const s = steps.find((x) => x.key === stepKey);
  if (!s) return { ok: false, errors: ["That step is not on this campaign"], campaign: current };

  if (current.status !== "open") {
    return { ok: false, errors: [`This campaign is ${current.status}. Reopen it to change steps.`], campaign: current };
  }

  const what = [];
  const day = isIsoDate(today) ? today : todayCentral();

  if (b.dueDate !== undefined) {
    if (b.dueDate && !isIsoDate(b.dueDate)) errors.push("The due date must be a real calendar date");
    else { s.dueOverride = b.dueDate || null; what.push(b.dueDate ? `due date set to ${b.dueDate}` : "due date back to the suggestion"); }
  }

  if (b.notApplicable !== undefined) {
    const want = !!b.notApplicable;
    if (want && !s.na) errors.push(`"${s.label}" is required and cannot be marked not applicable`);
    else if (want && s.done) errors.push("A step that is done cannot also be not applicable");
    else if (want !== !!s.notApplicable) {
      if (!want) {
        const dependents = dependentsDone(next, s.key);
        if (dependents.length) errors.push(`"${dependents[0].label}" is already done and depends on this step`);
      }
      s.notApplicable = want;
      what.push(want ? "marked not applicable" : "no longer not applicable");
    }
  }

  if (b.done !== undefined) {
    const want = !!b.done;
    if (want && !s.done) {
      if (s.notApplicable) errors.push("A not applicable step cannot be marked done");
      const unmet = unmetDependencies(next, s.key);
      if (unmet.length) errors.push(`Finish "${unmet[0].label}" first`);
      if (b.doneAt && !isIsoDate(b.doneAt)) errors.push("The date completed must be a real calendar date");
      if (b.doneAt && isIsoDate(b.doneAt) && b.doneAt > day) errors.push("The date completed cannot be in the future");
      if (!errors.length) {
        s.done = true;
        s.doneAt = isIsoDate(b.doneAt) ? b.doneAt : day;
        s.doneBy = who(session);
        s.approvedBy = s.approval ? who(session) : null;
        s.blocked = "";
        what.push(s.approval ? `approved by ${s.approvedBy || "someone"}` : "done");
      }
    } else if (!want && s.done) {
      const dependents = dependentsDone(next, s.key);
      if (dependents.length) errors.push(`"${dependents[0].label}" is already done and depends on this step`);
      else {
        s.done = false; s.doneAt = null; s.doneBy = null; s.approvedBy = null;
        what.push("reopened");
      }
    }
  } else if (b.doneAt !== undefined && s.done) {
    if (!isIsoDate(b.doneAt)) errors.push("The date completed must be a real calendar date");
    else if (b.doneAt > day) errors.push("The date completed cannot be in the future");
    else { s.doneAt = b.doneAt; what.push(`date completed set to ${b.doneAt}`); }
  }

  if (b.blocked !== undefined) {
    const blocked = s.done ? "" : str(b.blocked, 500);
    if (blocked !== (s.blocked || "")) {
      s.blocked = blocked;
      what.push(blocked ? "blocker noted" : "blocker cleared");
    }
  }
  if (b.notes !== undefined) {
    const notes = str(b.notes, 4000);
    if (notes !== (s.notes || "")) { s.notes = notes; what.push("notes"); }
  }
  if (b.links !== undefined) {
    const links = cleanLinks(b.links);
    if (JSON.stringify(links) !== JSON.stringify(s.links || [])) { s.links = links; what.push("links"); }
  }

  if (errors.length) return { ok: false, errors, campaign: current };
  if (what.length) logLine(next, session, `${s.label}: ${what.join(", ")}`);
  next.updatedAt = new Date().toISOString();
  return { ok: true, errors: [], campaign: next };
}

function dependentsDone(campaign, key) {
  return (campaign.steps || []).filter((x) => (x.after || []).includes(key) && x.done);
}

/* ----------------------------------------------------------------------- *
 * READING A CAMPAIGN
 * ----------------------------------------------------------------------- */

/**
 * Where a campaign stands, in plain words (handoff: current step, next
 * action, owner, due date and blocker, first).
 */
export function progress(campaign, today) {
  const c = campaign || {};
  const day = isIsoDate(today) ? today : todayCentral();
  const steps = Array.isArray(c.steps) ? c.steps : [];
  const ordered = STAGE_KEYS.flatMap((stage) => steps.filter((s) => s.stage === stage));

  const withDue = ordered.map((s) => ({ ...s, due: dueDateFor(s, c.controlDate) }));
  const open = withDue.filter((s) => !isClear(s));
  const next = open[0] || null;
  const overdue = open.filter((s) => s.due && s.due < day);
  const blocked = open.filter((s) => s.blocked);
  const doneCount = withDue.length - open.length;

  let label;
  if (c.status === "cancelled") label = "Cancelled";
  else if (c.status === "complete") label = "Complete";
  else if (!withDue.length) label = "No steps";
  else if (!open.length) label = "Ready to close";
  else if (doneCount === 0) label = "Not started";
  else label = (STAGES.find((st) => st.key === next.stage) || {}).doing || "In progress";

  return {
    label,
    stage: next ? next.stage : null,
    next: next ? { key: next.key, label: next.label, owner: ownerFor(next, c), due: next.due, blocked: next.blocked || "" } : null,
    total: withDue.length,
    done: doneCount,
    overdue: overdue.length,
    firstOverdue: overdue[0] ? { key: overdue[0].key, label: overdue[0].label, due: overdue[0].due } : null,
    blocked: blocked.length,
    firstBlocker: blocked[0] ? { key: blocked[0].key, label: blocked[0].label, blocked: blocked[0].blocked } : null,
    missingDate: !isIsoDate(c.controlDate),
  };
}

/**
 * The owner to show. "Account Manager" becomes the campaign's named Account
 * Manager when there is one; every other owner is shown as the handoff wrote
 * it.
 */
export function ownerFor(step, campaign) {
  const owner = String((step && step.owner) || "");
  const am = campaign && campaign.accountManagerName;
  if (am && /^Account Manager$/.test(owner)) return am;
  if (am && /Account Manager$/.test(owner) && !/Assigned Account Manager/.test(owner)) {
    return owner.replace(/Account Manager$/, am);
  }
  return owner;
}

/** Header dates, read from the steps they belong to (one source, not two). */
export function headerDates(campaign) {
  const c = campaign || {};
  const steps = Array.isArray(c.steps) ? c.steps : [];
  const due = (key) => {
    const s = steps.find((x) => x.key === key);
    return s ? dueDateFor(s, c.controlDate) : null;
  };
  const dated = steps.map((s) => dueDateFor(s, c.controlDate)).filter(Boolean).sort();
  return {
    workingStart: dated[0] || null,
    prelaunchReview: due("prelaunch_review"),
    control: isIsoDate(c.controlDate) ? c.controlDate : null,
    postLaunchReview: due("post_review"),
  };
}

/**
 * The line a parent event shows for each connected campaign: owner, status,
 * next action, due date, blocker. Status and next action come from the
 * child's own checklist, never flattened into the parent's.
 */
export function childSummary(child, today) {
  const p = progress(child, today);
  const meta = typeMeta(child.type) || {};
  return {
    id: child.id,
    name: child.name,
    type: child.type,
    typeLabel: meta.label || child.type,
    accountManagerName: child.accountManagerName || null,
    status: child.status,
    progress: p,
  };
}

/**
 * Is this campaign the signed-in person's? Their own Account Manager record,
 * or one they created. `employeeId` is resolved on the server from CrewCore;
 * the browser never guesses it from a display name.
 */
export function isMine(campaign, username, employeeId) {
  const c = campaign || {};
  if (employeeId && c.accountManagerId && String(c.accountManagerId) === String(employeeId)) return true;
  return !!(username && c.createdBy && String(c.createdBy).toLowerCase() === String(username).toLowerCase());
}

/**
 * What a signed-in person who is not an Admin receives.
 *
 * MarketMachine is Admin only for now (Ryan, Sept 2026). MailMe still needs to
 * offer "which campaign does this email belong to" to the people who send
 * email, so they get names and ids and nothing else: no steps, owners, notes,
 * budget or history.
 *
 * `channels` keeps MailMe's picker working unchanged. It used to list a
 * campaign's email channel items; campaigns no longer have channels, so each
 * one offers a single email slot until the MailMe link is rebuilt in a later
 * phase.
 */
export function pickerShape(campaigns) {
  return (Array.isArray(campaigns) ? campaigns : [])
    .filter((c) => c && c.status === "open")
    .map((c) => ({
      id: c.id,
      name: c.name,
      channels: [{ id: "email", type: "email", name: "Email for this campaign" }],
    }));
}
