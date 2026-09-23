// PUT IN: lib/concontrol/social.js
// lib/concontrol/social.js: ConControl's social plan.
//
// The plan arrives as a JSON file (foc27_social_plan.json): every post from
// the first sponsor announcement to the results post, the decisions that
// block some of them, the goals and the posting rules. This file turns that
// into records ConControl can track: what is going out when, what has gone
// out, what is still waiting on somebody.
//
// THE FILE IS A PLAN, THE RECORDS ARE WHAT HAPPENED. The plan will be
// regenerated as the event gets closer. Loading a new copy must never undo
// work: a post marked posted stays posted, copy somebody rewrote stays
// rewritten, a decision somebody made stays made. So every field a person
// edits is remembered in `edited`, and a reload only touches fields nobody
// has changed. Same rule as the seed imports: running it twice by accident
// should not cost an afternoon.
//
// TWO KINDS OF "WAITING ON". A post's depends_on list mixes two things. Items
// prefixed decision: are questions for Ryan (price, registration date) and
// live as decision records. Everything else is a real-world condition (a Gold
// sponsor signed, a speaker confirmed) that somebody ticks when it happens.
// Folding them together would mean a sponsor signing looks like a decision
// nobody made.
//
// All the date math is on plain YYYY-MM-DD strings in Central time. A post
// going out "Tuesday" is a Tuesday in Polk City, not in UTC.
//
// lib/ never imports from api/. ESM. Do NOT convert to module.exports.

import { isoDate } from "./schema.js";

/* ------------------------------------------------------------------ *
 * VOCABULARY
 * ------------------------------------------------------------------ */

/**
 * planned, drafted and conditional come from the plan file. scheduled,
 * posted and skipped are ours. "scheduled" earns its place because the rules
 * say posts are batched into Meta Business Suite ahead of time: a post that
 * is queued there is not done yet, but nobody needs to chase it either.
 * "skipped" is a real answer (a conditional post whose sponsor never signed)
 * rather than a post that sits overdue forever.
 */
export const POST_STATUSES = ["planned", "drafted", "conditional", "scheduled", "posted", "skipped"];
export const POST_STATUS_LABELS = {
  planned: "Planned",
  drafted: "Copy written",
  conditional: "Conditional",
  scheduled: "Scheduled",
  posted: "Posted",
  skipped: "Skipped",
};
/** Nothing left to do on these. */
export const DONE_STATUSES = ["posted", "skipped"];
/** A reload of the plan never moves a post out of these. */
const STICKY_STATUSES = ["scheduled", "posted", "skipped"];

export const CHANNELS = ["facebook", "instagram", "linkedin", "email"];
export const CHANNEL_LABELS = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  email: "Email",
};

export const CTA_LABELS = {
  notify_list: "Notify list",
  survey: "Survey",
  registration: "Registration",
  waitlist_or_registration: "Registration or waitlist",
  sponsor_packet: "Sponsor packet",
  waitlist: "Waitlist",
};

export const DECISION_STATUSES = ["open", "decided"];

/** Fields a person can change on a post, and so the fields `edited` tracks. */
const POST_FIELDS = ["date", "title", "status", "channels", "copy", "notes", "cta"];
/** Fields a reload refreshes from the file unless somebody edited them. */
const PLAN_POST_FIELDS = ["date", "phase", "title", "type", "goal", "cta", "channels", "depends_on", "assets", "copy", "notes", "status"];

const MAX_COPY = 5000;

/* ------------------------------------------------------------------ *
 * SMALL HELPERS
 * ------------------------------------------------------------------ */

function str(v, max) {
  const s = v == null ? "" : String(v).trim();
  return max ? s.slice(0, max) : s;
}

/** Today in Polk City, as YYYY-MM-DD. */
export function todayCentral(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Whole days from a to b, both YYYY-MM-DD. Positive when b is later. */
export function dayDiff(a, b) {
  const ta = Date.parse(a + "T12:00:00Z");
  const tb = Date.parse(b + "T12:00:00Z");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** The Monday of the week a date falls in, as YYYY-MM-DD. */
export function weekOf(iso) {
  const d = new Date(iso + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function phaseLabel(phase) {
  const s = String(phase || "").replace(/^\d+_/, "").replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

export function conditionLabel(key) {
  const s = String(key || "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** The decision keys and plain conditions a post waits on, split apart. */
export function splitDepends(dependsOn) {
  const decisions = [];
  const conditions = [];
  for (const raw of Array.isArray(dependsOn) ? dependsOn : []) {
    const item = str(raw, 120);
    if (!item) continue;
    if (item.startsWith("decision:")) decisions.push(item.slice(9));
    else conditions.push(item);
  }
  return { decisions, conditions };
}

/** A post has copy if any version of it has words in it. */
export function hasCopy(copy) {
  if (typeof copy === "string") return copy.trim().length > 0;
  if (copy && typeof copy === "object") return Object.values(copy).some((v) => typeof v === "string" && v.trim());
  return false;
}

function copyText(copy) {
  if (typeof copy === "string") return copy;
  if (copy && typeof copy === "object") return Object.values(copy).filter((v) => typeof v === "string").join("\n");
  return "";
}

/**
 * Things in the copy that break the plan's own rules. Warnings, not refusals:
 * a person saving a half-finished draft should not be blocked by it, but a
 * post going out with one should be obvious before it does.
 */
export function copyWarnings(copy) {
  const text = copyText(copy);
  const out = [];
  if (text.indexOf("\u2014") !== -1) out.push("Has an em dash. The plan says no em dashes in any copy.");
  return out;
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

function cleanCopy(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "string") {
    if (raw.length > MAX_COPY) return { ok: false, error: `Copy is over ${MAX_COPY} characters` };
    return { ok: true, value: raw.trim() ? raw : null };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out = {};
    const keys = Object.keys(raw).slice(0, 6);
    for (const k of keys) {
      const key = str(k, 40);
      const v = raw[k];
      if (!key) continue;
      if (v !== null && typeof v !== "string") return { ok: false, error: "Each version of the copy must be text" };
      if (v && v.length > MAX_COPY) return { ok: false, error: `Copy is over ${MAX_COPY} characters` };
      out[key] = v || "";
    }
    return { ok: true, value: Object.keys(out).length ? out : null };
  }
  return { ok: false, error: "Copy must be text" };
}

function cleanChannels(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const c of raw) {
    const k = str(c, 20).toLowerCase();
    if (CHANNELS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * What a person may change on a post. Returns only the fields that were sent,
 * so a PATCH from a screen showing four fields cannot blank the other eight.
 */
export function validatePostPatch(body) {
  const b = body && typeof body === "object" ? body : {};
  const patch = {};
  const errors = [];

  if ("date" in b) {
    const d = isoDate(b.date);
    if (!d) errors.push("A post needs a real date");
    else patch.date = d;
  }
  if ("title" in b) {
    const t = str(b.title, 200);
    if (!t) errors.push("A post needs a title");
    else patch.title = t;
  }
  if ("status" in b) {
    if (!POST_STATUSES.includes(b.status)) errors.push("Unknown status");
    else patch.status = b.status;
  }
  if ("channels" in b) {
    const ch = cleanChannels(b.channels);
    if (ch === null) errors.push("Channels must be a list");
    else patch.channels = ch;
  }
  if ("copy" in b) {
    const c = cleanCopy(b.copy);
    if (!c.ok) errors.push(c.error);
    else patch.copy = c.value;
  }
  if ("notes" in b) patch.notes = str(b.notes, 2000) || null;
  if ("cta" in b) {
    if (b.cta === null || b.cta === "") patch.cta = null;
    else if (!CTA_LABELS[b.cta]) errors.push("Unknown call to action");
    else patch.cta = b.cta;
  }

  return { ok: errors.length === 0, errors, patch };
}

export function validateDecisionPatch(body) {
  const b = body && typeof body === "object" ? body : {};
  const patch = {};
  const errors = [];
  if ("status" in b) {
    if (!DECISION_STATUSES.includes(b.status)) errors.push("A decision is open or decided");
    else patch.status = b.status;
  }
  if ("answer" in b) patch.answer = str(b.answer, 2000) || null;
  if ("needed_by" in b) {
    if (b.needed_by === null || b.needed_by === "") patch.needed_by = null;
    else {
      const d = isoDate(b.needed_by);
      if (!d) errors.push("Needed by must be a real date");
      else patch.needed_by = d;
    }
  }
  if (patch.status === "decided" && "answer" in b && !patch.answer) {
    errors.push("Say what was decided");
  }
  return { ok: errors.length === 0, errors, patch };
}

/* ------------------------------------------------------------------ *
 * THE PLAN FILE
 * ------------------------------------------------------------------ */

/**
 * Read an uploaded plan into the shapes we store. Refuses a file that is not
 * a plan at all rather than importing half of it: a wrong file dropped on the
 * button (it has happened with every other upload in this repo) should say so.
 */
export function readPlan(raw) {
  let plan = raw;
  if (typeof plan === "string") {
    try { plan = JSON.parse(plan); } catch (e) { return { ok: false, error: "That file is not valid JSON" }; }
  }
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.posts)) {
    return { ok: false, error: "That file has no posts list. Is it the social plan?" };
  }

  const posts = [];
  const errors = [];
  const seen = new Set();
  for (const p of plan.posts) {
    const id = str(p && p.id, 60);
    const date = isoDate(p && p.date);
    if (!id || !date) { errors.push(`A post is missing its id or date (${id || "no id"})`); continue; }
    if (seen.has(id)) { errors.push(`${id} appears twice`); continue; }
    seen.add(id);
    const copy = cleanCopy(p.copy);
    posts.push({
      id,
      date,
      phase: str(p.phase, 60) || null,
      title: str(p.title, 200) || id,
      type: str(p.type, 40) || null,
      goal: str(p.goal, 40) || null,
      cta: p.cta && CTA_LABELS[p.cta] ? p.cta : null,
      channels: cleanChannels(p.channels) || [],
      status: POST_STATUSES.includes(p.status) ? p.status : "planned",
      depends_on: Array.isArray(p.depends_on) ? p.depends_on.map((x) => str(x, 120)).filter(Boolean) : [],
      assets: Array.isArray(p.assets) ? p.assets.map((x) => str(x, 500)).filter(Boolean) : null,
      copy: copy.ok ? copy.value : null,
      notes: str(p.notes, 2000) || null,
    });
  }

  const decisions = [];
  for (const d of Array.isArray(plan.decisions) ? plan.decisions : []) {
    const key = str(d && d.id, 60);
    if (!key) continue;
    decisions.push({
      key,
      question: str(d.question, 300) || key,
      placeholder: str(d.placeholder, 300) || null,
      needed_by: isoDate(d.needed_by) || null,
      status: d.status === "decided" ? "decided" : "open",
      answer: str(d.answer, 2000) || null,
    });
  }

  const meta = {
    plan: str(plan.plan, 120) || "Social plan",
    generated: isoDate(plan.generated) || null,
    eventInfo: plan.event && typeof plan.event === "object" ? plan.event : null,
    goals: Array.isArray(plan.goals) ? plan.goals.slice(0, 20) : [],
    rules: Array.isArray(plan.rules) ? plan.rules.map((r) => str(r, 400)).filter(Boolean) : [],
    triggers: Array.isArray(plan.triggers) ? plan.triggers.slice(0, 20) : [],
  };

  if (!posts.length) return { ok: false, error: errors[0] || "The plan has no posts in it" };
  return { ok: true, posts, decisions, meta, errors };
}

/**
 * Fold a freshly read plan into what is already stored.
 *
 * Returns the records to write plus a count of what happened, which the
 * screen says out loud. Posts that are stored but no longer in the file are
 * left alone and counted, never deleted: the file dropping a post is not the
 * same as somebody deciding not to post it.
 */
export function mergePlan(existingPosts, existingDecisions, existingMeta, incoming, event, who, now = new Date()) {
  const stamp = now.toISOString();
  const byId = new Map((existingPosts || []).map((p) => [p.id, p]));
  const decByKey = new Map((existingDecisions || []).map((d) => [d.key, d]));

  const posts = [];
  const counts = { added: 0, updated: 0, unchanged: 0, kept: 0, decisionsAdded: 0, decisionsUpdated: 0, notInFile: 0 };

  for (const p of incoming.posts) {
    const old = byId.get(p.id);
    if (!old) {
      posts.push({
        ...p,
        event,
        edited: [],
        postedAt: null,
        postedBy: null,
        source: "plan",
        createdAt: stamp,
        createdBy: who,
        updatedAt: stamp,
        history: [{ at: stamp, by: who, what: "loaded from the plan" }],
      });
      counts.added++;
      continue;
    }
    const edited = Array.isArray(old.edited) ? old.edited : [];
    const next = { ...old };
    const changed = [];
    for (const f of PLAN_POST_FIELDS) {
      if (edited.includes(f)) continue;
      if (f === "status" && STICKY_STATUSES.includes(old.status)) continue;
      if (JSON.stringify(old[f] === undefined ? null : old[f]) !== JSON.stringify(p[f] === undefined ? null : p[f])) {
        next[f] = p[f];
        changed.push(f);
      }
    }
    if (changed.length) {
      next.updatedAt = stamp;
      next.history = (Array.isArray(old.history) ? old.history : []).concat([
        { at: stamp, by: who, what: `plan reload changed ${changed.join(", ")}` },
      ]);
      posts.push(next);
      counts.updated++;
    } else {
      counts.unchanged++;
    }
    if (edited.length || STICKY_STATUSES.includes(old.status)) counts.kept++;
  }

  const inFile = new Set(incoming.posts.map((p) => p.id));
  counts.notInFile = (existingPosts || []).filter((p) => !inFile.has(p.id)).length;

  const decisions = [];
  for (const d of incoming.decisions) {
    const old = decByKey.get(d.key);
    if (!old) {
      decisions.push({
        ...d,
        id: `${event}-${d.key}`,
        event,
        edited: [],
        createdAt: stamp,
        createdBy: who,
        updatedAt: stamp,
        history: [{ at: stamp, by: who, what: "loaded from the plan" }],
      });
      counts.decisionsAdded++;
      continue;
    }
    // A decision somebody made is never reopened by a file that still says
    // "open". The file is written before the answer exists.
    const edited = Array.isArray(old.edited) ? old.edited : [];
    const next = { ...old };
    let changed = false;
    for (const f of ["question", "placeholder", "needed_by"]) {
      if (edited.includes(f)) continue;
      if ((old[f] || null) !== (d[f] || null)) { next[f] = d[f]; changed = true; }
    }
    if (old.status !== "decided" && d.status === "decided" && !edited.includes("status")) {
      next.status = "decided";
      next.answer = old.answer || d.answer;
      changed = true;
    }
    if (changed) {
      next.updatedAt = stamp;
      decisions.push(next);
      counts.decisionsUpdated++;
    }
  }

  const prevConditions = existingMeta && existingMeta.conditions && typeof existingMeta.conditions === "object"
    ? existingMeta.conditions : {};
  const meta = {
    ...incoming.meta,
    event,
    conditions: { ...prevConditions },
    loadedAt: stamp,
    loadedBy: who,
  };

  return { posts, decisions, meta, counts };
}

/**
 * Remember which fields a person changed, so a plan reload leaves them be.
 * Marking a post posted counts as editing its status; editing the copy counts
 * as editing the copy.
 */
export function markEdited(existing, patch) {
  const edited = new Set(Array.isArray(existing && existing.edited) ? existing.edited : []);
  for (const f of POST_FIELDS) if (f in patch) edited.add(f);
  return Array.from(edited);
}

/* ------------------------------------------------------------------ *
 * READINESS AND WHAT IS STUCK
 * ------------------------------------------------------------------ */

/**
 * What a post is still waiting on: decisions not yet made, and conditions
 * nobody has ticked. Unknown decision keys count as waiting, because a post
 * pointing at a decision the plan forgot to list is still not ready.
 */
export function postWaitingOn(post, decisions, conditions) {
  const { decisions: dKeys, conditions: cKeys } = splitDepends(post && post.depends_on);
  const byKey = new Map((decisions || []).map((d) => [d.key, d]));
  const met = conditions && typeof conditions === "object" ? conditions : {};
  const openDecisions = dKeys.filter((k) => !(byKey.get(k) && byKey.get(k).status === "decided"));
  const openConditions = cKeys.filter((k) => met[k] !== true);
  return {
    decisions: openDecisions.map((k) => ({ key: k, question: byKey.get(k) ? byKey.get(k).question : conditionLabel(k) })),
    conditions: openConditions.map((k) => ({ key: k, label: conditionLabel(k) })),
    ready: openDecisions.length === 0 && openConditions.length === 0,
  };
}

/**
 * One post's standing today. `due` is days until it goes out (negative when
 * the date has passed). Everything the screen colors a row by comes from here
 * so the Social screen and Home cannot disagree about what is late.
 */
export function postState(post, decisions, conditions, today) {
  const done = DONE_STATUSES.includes(post.status);
  const due = dayDiff(today, post.date);
  const waiting = postWaitingOn(post, decisions, conditions);
  const copy = hasCopy(post.copy);
  const taskish = post.type === "task";
  return {
    done,
    due,
    overdue: !done && due !== null && due < 0,
    needsCopy: !done && !copy && post.status !== "scheduled",
    waiting,
    warnings: copyWarnings(post.copy),
    taskish,
  };
}

/** How far ahead a post with no copy starts showing up on Home. */
export const COPY_WARNING_DAYS = 7;

/**
 * Everything on the social side that is waiting on somebody, for Home.
 *
 * Every open decision is listed, soonest needed first: they are the things
 * only Ryan can unblock, and Ryan asked for them on Home. Then posts whose
 * date has passed without being marked posted or skipped, then posts going
 * out within a week that still have no copy or are still waiting on
 * something.
 */
export function socialBlockers(posts, decisions, conditions, today) {
  const out = [];
  const open = (decisions || [])
    .filter((d) => d.status !== "decided")
    .slice()
    .sort((a, b) => String(a.needed_by || "9999").localeCompare(String(b.needed_by || "9999")));
  for (const d of open) {
    const days = d.needed_by ? dayDiff(today, d.needed_by) : null;
    out.push({ kind: "decision", id: d.id, key: d.key, question: d.question, needed_by: d.needed_by, days, late: days !== null && days < 0 });
  }

  const sorted = (posts || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  for (const p of sorted) {
    const s = postState(p, decisions, conditions, today);
    if (s.done) continue;
    if (s.overdue) {
      out.push({ kind: "post-overdue", id: p.id, title: p.title, date: p.date, days: s.due });
      continue;
    }
    if (s.due !== null && s.due <= COPY_WARNING_DAYS) {
      if (!s.waiting.ready) {
        out.push({ kind: "post-waiting", id: p.id, title: p.title, date: p.date, days: s.due,
          on: s.waiting.decisions.map((x) => x.question).concat(s.waiting.conditions.map((x) => x.label)) });
      } else if (s.needsCopy) {
        out.push({ kind: "post-no-copy", id: p.id, title: p.title, date: p.date, days: s.due });
      }
    }
  }
  return out;
}

/** The next post that has not gone out, for the Home card. */
export function nextPost(posts, today) {
  return (posts || [])
    .filter((p) => !DONE_STATUSES.includes(p.status) && p.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

/** Posts grouped by the Monday of their week, in date order. */
export function groupByWeek(posts) {
  const groups = new Map();
  const sorted = (posts || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  for (const p of sorted) {
    const w = weekOf(p.date) || "unknown";
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(p);
  }
  return Array.from(groups, ([week, items]) => ({ week, posts: items }));
}

/** The totals strip on the Social screen. */
export function socialSummary(posts, decisions, conditions, today) {
  let posted = 0; let overdue = 0; let needsCopySoon = 0; let skipped = 0;
  for (const p of posts || []) {
    const s = postState(p, decisions, conditions, today);
    if (p.status === "posted") posted++;
    if (p.status === "skipped") skipped++;
    if (s.overdue) overdue++;
    if (s.needsCopy && s.due !== null && s.due >= 0 && s.due <= 14) needsCopySoon++;
  }
  return {
    total: (posts || []).length,
    posted,
    skipped,
    overdue,
    needsCopySoon,
    openDecisions: (decisions || []).filter((d) => d.status !== "decided").length,
  };
}
