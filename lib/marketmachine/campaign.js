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
import { formFor, cleanForm, picksGate, proposalsFor } from "./forms.js";

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

// "printavo.com/invoices/123" and "www.x.com" are web addresses people paste
// without the https://. They used to be dropped without a word.
export function withScheme(url) {
  const s = String(url == null ? "" : url).trim();
  if (!s || /^https?:\/\//i.test(s)) return s;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(s)) return "https://" + s;
  return s;
}

function cleanLinks(list) {
  return (Array.isArray(list) ? list : [])
    .map((l) => ({ label: str(l && l.label, 120), url: withScheme(str(l && l.url, 1000)) }))
    .filter((l) => /^https?:\/\//i.test(l.url))
    .slice(0, 20);
}

/* ----------------------------------------------------------------------- *
 * ACCOUNT MANAGERS (more than one, Sep 29 2026)
 *
 * Ryan: a campaign like Happy Holiday Helpers belongs to several Account
 * Managers at once. A campaign now holds `accountManagers`, a list of
 * { id, name }. `accountManagerId` / `accountManagerName` are kept, set to
 * the FIRST one, because MailMe's picker, older campaigns and anything not
 * yet updated still read them. amsOf() is the one reader: it understands
 * both shapes, so a campaign saved before today reads the same as one saved
 * after.
 * ----------------------------------------------------------------------- */

export const MAX_ACCOUNT_MANAGERS = 12;

export function amsOf(campaign) {
  const c = campaign || {};
  const list = Array.isArray(c.accountManagers) ? c.accountManagers : null;
  const raw = list && list.length ? list
    : (c.accountManagerId || c.accountManagerName ? [{ id: c.accountManagerId, name: c.accountManagerName }] : []);
  const seen = new Set();
  const out = [];
  raw.forEach((a) => {
    const id = str(a && a.id, 60);
    const name = str(a && a.name, 120);
    if (!id && !name) return;
    const key = id || "name:" + name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: id || null, name: name || null });
  });
  return out.slice(0, MAX_ACCOUNT_MANAGERS);
}

/** "Abby Penton", "Abby Penton and Jacob Whitman", "A, B, and C". */
export function amNames(campaign) {
  const names = amsOf(campaign).map((a) => a.name).filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

/**
 * Read the Account Managers a request asked for. Accepts the new list
 * (`accountManagers: [{id, name}]`) or the old single pair, so a script or
 * screen that has not been updated keeps working. Returns null when the
 * request said nothing about Account Managers.
 */
function amsFromBody(b) {
  if (Array.isArray(b.accountManagers)) return amsOf({ accountManagers: b.accountManagers });
  if (b.accountManagerId !== undefined) {
    return amsOf({ accountManagerId: b.accountManagerId, accountManagerName: b.accountManagerName });
  }
  return null;
}

function setAms(record, list) {
  record.accountManagers = list;
  record.accountManagerId = list[0] ? list[0].id : null;
  record.accountManagerName = list[0] ? list[0].name : null;
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
    accountManagers: [],
    accountManagerId: null,
    accountManagerName: null,
    platforms: [],
    art: [],
    platformLinks: {},
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
  const asked = amsFromBody(b);
  setAms(record, asked && asked.length ? asked : (fromParent ? amsOf(fromParent) : []));
  if (Array.isArray(b.platforms)) record.platforms = cleanPlatforms(b.platforms);
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
  const askedAms = amsFromBody(b);
  if (askedAms) {
    const before = JSON.stringify(amsOf(current));
    if (JSON.stringify(askedAms) !== before) {
      setAms(next, askedAms);
      changed.push(askedAms.length > 1 ? "Account Managers" : "Account Manager");
    }
  }
  if (b.platforms !== undefined) {
    const list = cleanPlatforms(b.platforms);
    const removed = platformsOf(current).filter((p) => !list.includes(p));
    const withArt = removed.filter((p) => (current.art || []).some((a) => a.platform === p));
    if (withArt.length) {
      errors.push(`${platformLabel(withArt[0])} still has art attached. Remove its art first, then untick it.`);
    } else if (JSON.stringify(list) !== JSON.stringify(platformsOf(current))) {
      next.platforms = list;
      changed.push("platforms");
    }
  }
  if (b.platformLink !== undefined) {
    const pl = b.platformLink || {};
    const key = String(pl.platform || "");
    const url = str(pl.url, 1000);
    if (!PLATFORM_KEYS.includes(key)) errors.push("Unknown platform");
    else if (url && !/^https?:\/\//i.test(url)) errors.push("The post or ad link must be a full web address");
    else {
      const links = Object.assign({}, current.platformLinks || {});
      if (url) links[key] = url; else delete links[key];
      next.platformLinks = links;
      changed.push(`${platformLabel(key)} link`);
    }
  }
  if (b.removeArt !== undefined) {
    const url = String(b.removeArt || "");
    const art = Array.isArray(current.art) ? current.art : [];
    const gone = art.find((a) => a.url === url);
    if (!gone) errors.push("That art is not on this campaign");
    else {
      next.art = art.filter((a) => a.url !== url);
      changed.push(`removed ${platformLabel(gone.platform)} art "${gone.name || "file"}"`);
    }
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

  // A STEP'S OWN FORM (Oct 1 2026): results, audience, spend, picks. See
  // lib/marketmachine/forms.js for which step carries which form.
  // Saved BEFORE done is checked, so "Save and mark done" is judged on
  // what was just typed (five picks), not on what was there before.
  if (b.form !== undefined) {
    const cleaned = cleanForm(s, b.form);
    if (!cleaned.ok) cleaned.errors.forEach((e) => errors.push(e));
    else if (JSON.stringify(cleaned.form) !== JSON.stringify(s.form || null)) {
      s.form = cleaned.form;
      what.push("form saved");
      // The audience step decides who the campaign's emails go to.
      if (formFor(s) === "audience") {
        next.audienceListId = cleaned.form.listId || null;
        if (cleaned.form.listName) { next.audience = cleaned.form.listName; next.audienceKind = "list"; }
      }
    }
  }

  if (b.done !== undefined) {
    const want = !!b.done;
    if (want && !s.done) {
      if (s.notApplicable) errors.push("A not applicable step cannot be marked done");
      const unmet = unmetDependencies(next, s.key);
      if (unmet.length) errors.push(`Finish "${unmet[0].label}" first`);
      const gate = stepGate(next, s.key);
      if (gate) errors.push(gate);
      // Picks with Personality: five complete picks, once picks are entered
      // on the step's form (lib/marketmachine/forms.js).
      const pg = picksGate(s);
      if (pg) errors.push(pg);
      if (b.doneAt && !isIsoDate(b.doneAt)) errors.push("The date completed must be a real calendar date");
      if (b.doneAt && isIsoDate(b.doneAt) && b.doneAt > day) errors.push("The date completed cannot be in the future");
      if (!errors.length) {
        s.done = true;
        s.doneAt = isIsoDate(b.doneAt) ? b.doneAt : day;
        s.doneBy = who(session);
        s.approvedBy = s.approval ? who(session) : null;
        s.blocked = "";
        if (s.approval) {
          // The decision is kept with the step, and so is any spend it
          // approved, so "approved spend" is a sum of decisions, not a figure
          // somebody typed. A send-back before it stays in the history.
          const amount = proposalsFor(next, s).reduce((sum, p) => sum + Number(p.form.amount || 0), 0);
          s.form = { decision: "approved", by: who(session), at: day, approvedAmount: amount || null };
        }
        what.push(s.approval ? `approved by ${s.approvedBy || "someone"}` : "done");
      }
    } else if (!want && s.done) {
      const dependents = dependentsDone(next, s.key);
      if (dependents.length) errors.push(`"${dependents[0].label}" is already done and depends on this step`);
      else {
        s.done = false; s.doneAt = null; s.doneBy = null; s.approvedBy = null;
        if (s.approval && s.form && s.form.decision === "approved") s.form = null;
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
  // SEND BACK (Oct 1 2026): the other half of an approval. The comment
  // becomes the step's blocker, so whoever has to fix it sees why without
  // opening anything.
  if (b.sendBack !== undefined) {
    const comment = str(b.sendBack, 500);
    if (!s.approval) errors.push("Only an approval can be sent back");
    else if (s.done) errors.push("It is already approved. Mark it not done first.");
    else if (!comment) errors.push("Say what needs to change");
    else {
      s.form = { decision: "sent_back", comment, by: who(session), at: day };
      s.blocked = `Sent back by ${who(session) || "the approver"}: ${comment}`;
      what.push(`sent back: ${comment}`);
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
 * PLATFORMS AND ART (Sep 29 2026)
 *
 * The Digital Platform checklist said "Only selected platforms get Art" and
 * offered no way to select one. A campaign now holds `platforms`, and each
 * selected platform gets its art files and, once it is live, the link to the
 * post or ad.
 *
 * Two steps are held to it, on the server, for new and old campaigns alike
 * (the rule is looked up by step key from the catalog, not copied onto the
 * step, so campaigns made before today get it too):
 *   - the step that chooses platforms cannot be done with none chosen
 *   - the Art step cannot be done while a chosen platform has no art
 * ----------------------------------------------------------------------- */

export const PLATFORMS = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "youtube", label: "YouTube" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "email", label: "Email" },
  { key: "paid_ad", label: "Paid ad" },
  { key: "other", label: "Other" },
];
export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);
export const platformLabel = (k) => (PLATFORMS.find((p) => p.key === k) || { label: k }).label;

export const ART_LIMIT = 60;

function cleanPlatforms(list) {
  const want = new Set((Array.isArray(list) ? list : []).map(String));
  return PLATFORM_KEYS.filter((k) => want.has(k));
}

export function platformsOf(campaign) {
  return cleanPlatforms(campaign && campaign.platforms);
}

/** The catalog's gate for a step: "platforms", "art", or "". */
export function stepRule(campaign, stepKey) {
  const meta = typeMeta(campaign && campaign.type);
  const def = meta && (meta.steps || []).find((x) => x.key === stepKey);
  return (def && def.gate) || "";
}

/** Does this campaign type pick platforms at all? */
export function usesPlatforms(campaign) {
  const meta = typeMeta(campaign && campaign.type);
  return !!(meta && (meta.steps || []).some((x) => x.gate === "platforms"));
}

/** Platforms that are chosen but have no art yet. */
export function platformsMissingArt(campaign) {
  const art = Array.isArray(campaign && campaign.art) ? campaign.art : [];
  return platformsOf(campaign).filter((p) => !art.some((a) => a.platform === p));
}

/** Why a step cannot be ticked yet, or "" when it can. */
export function stepGate(campaign, stepKey) {
  const rule = stepRule(campaign, stepKey);
  if (rule === "platforms" && !platformsOf(campaign).length) {
    return "Pick at least one platform first (Platforms and art, above the checklist).";
  }
  if (rule === "art") {
    if (!platformsOf(campaign).length) return "Pick the platforms first, so it is clear what needs art.";
    const missing = platformsMissingArt(campaign);
    if (missing.length) return `Add art for ${missing.map(platformLabel).join(", ")} first.`;
  }
  return "";
}

/**
 * Attach one art file to a platform. `file` is { url, name, bytes } after the
 * upload route has stored it. Returns { ok, errors, campaign }.
 */
/**
 * Why art cannot be added to this platform right now, or "". Checked by the
 * route BEFORE a file is stored, so a refused upload leaves nothing behind.
 */
export function artRefusal(current, platform) {
  if (!PLATFORM_KEYS.includes(platform)) return "Unknown platform";
  if (!platformsOf(current).includes(platform)) return `Tick ${platformLabel(platform)} as a platform before adding its art`;
  const art = Array.isArray(current && current.art) ? current.art : [];
  if (art.length >= ART_LIMIT) return `A campaign can hold ${ART_LIMIT} art files`;
  return "";
}

export function addArt(current, platform, file, session) {
  const errors = [];
  const refusal = artRefusal(current, platform);
  if (refusal) errors.push(refusal);
  const url = str(file && file.url, 1000);
  if (!/^https?:\/\//i.test(url)) errors.push("The art file has no address");
  const art = Array.isArray(current && current.art) ? current.art : [];
  if (errors.length) return { ok: false, errors, campaign: current };
  const next = JSON.parse(JSON.stringify(current));
  next.art = art.concat([{
    platform, url, name: str(file.name, 160) || "Art file",
    bytes: Number(file.bytes) || null,
    kind: file.link ? "link" : "file",
    at: new Date().toISOString(), by: who(session),
  }]);
  logLine(next, session, `Added ${platformLabel(platform)} art "${next.art[next.art.length - 1].name}"`);
  next.updatedAt = new Date().toISOString();
  return { ok: true, errors: [], campaign: next };
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
  const names = amsOf(campaign).map((a) => a.name).filter(Boolean);
  if (!names.length) return owner;
  if (/^Account Manager$/.test(owner)) return joinNames(names);
  if (/Account Manager$/.test(owner) && !/Assigned Account Manager/.test(owner)) {
    // "Jacob and Account Manager" with Jacob Whitman as the Account Manager
    // used to read "Jacob and Jacob Whitman". A first name already in the
    // label is that same person, so it is dropped rather than repeated.
    const lead = owner.replace(/\s*(?:,\s*and|and|,)?\s*Account Manager$/, "");
    const leadWords = lead.split(/\s*(?:,\s*and|,|\band\b)\s*/).map((w) => w.trim()).filter(Boolean);
    const firsts = names.map((n) => n.split(/\s+/)[0].toLowerCase());
    const kept = leadWords.filter((w) => !firsts.includes(w.toLowerCase()));
    return joinNames(kept.concat(names));
  }
  return owner;
}

function joinNames(list) {
  if (list.length <= 1) return list[0] || "";
  if (list.length === 2) return list[0] + " and " + list[1];
  return list.slice(0, -1).join(", ") + ", and " + list[list.length - 1];
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
    accountManagerName: amNames(child) || null,
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
  if (employeeId && amsOf(c).some((a) => a.id && String(a.id) === String(employeeId))) return true;
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
