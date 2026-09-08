// PUT IN: lib/backbone/inquiries.js
// lib/backbone/inquiries.js — the inquiry pipeline: stages, staleness, adoption
// of a form submission, and the "what did they ask for" half of the score.
//
// WHY THIS FILE EXISTS AT ALL.
// All of this used to live inside apps/backbone/main.js, which the browser can
// load and node cannot. So every test about the pipeline was a regular
// expression run over the source text, and a regular expression can only prove
// that letters are present, never that the code does anything. That is the same
// failure that let api/promopro/printavo.js throw on load with a green suite.
// Everything here is a plain function with no browser in it, so the screen and
// the tests call the identical code.
//
// WHY THE OUTBOUND STAGES ARE GONE (Sep 2026).
// The old ladder was New, Researching, Qualified, AM Notified, Contacted 1st,
// Contacted 2nd, Death Call, Reach Back Out, Won, Lost. Researching and
// Qualified were a place to sit while you decided whether a stranger was worth
// calling, and the three Contacted stages plus Death Call were a cold-call
// cadence: ring them, ring them again, ring them one last time, give up.
// P&M does not work that way. Business arrives already asking for something.
//
// The ladder is now the actual inbound sequence, and it ends where the old one
// did because those exit buckets were never about outbound:
//
//   New        it arrived, nobody owns it yet
//   Assigned   an account manager owns it, the customer has not heard back
//   Responded  the customer has heard back from us
//   Quoted     a number is in front of them, the clock is theirs now
//   Won / Lost / Reach Back Out
//
// Quoted is new and is the point of the rework. The old ladder had no way to
// say "a price is out and we are waiting", so every quote out for review looked
// identical to a lead nobody had touched.

/* ------------------------------------------------------------------ *
 * THE LADDER
 * ------------------------------------------------------------------ */

export const INQUIRY_STATUSES = [
  "New",
  "Assigned",
  "Responded",
  "Quoted",
  "Reach Back Out",
  "Won",
  "Lost",
];

// The stages where the inquiry is live work: somebody owes somebody something.
// Reach Back Out is deliberately NOT here. It is parked on purpose with a date,
// which is the opposite of work in progress, and rolling it in would make the
// active number look like more load than the team actually has.
export const ACTIVE_STATUSES = ["Assigned", "Responded", "Quoted"];

/**
 * Old records keep their history and get mapped on read, never rewritten in
 * storage. Rewriting would destroy the one thing the status trail is for.
 *
 * The cold stages collapse DOWNWARD on purpose. Death Call was the last call
 * before giving up, so on paper it looks further along than Contacted 1st, but
 * all three mean the same thing under the new ladder: the customer has heard
 * from us and there is no price out yet. Mapping any of them to Quoted would
 * invent a quote that was never sent.
 *
 * Researching and Qualified both map back to New. Both meant "we are deciding
 * whether to bother", a question an inbound inquiry has already answered by
 * existing. Scoring no longer moves an inquiry along the ladder at all, so
 * there is nowhere else honest for them to land.
 */
const LEGACY_STATUS_MAP = {
  Dead: "Lost",
  Researching: "New",
  Qualified: "New",
  Contacted: "Responded",
  "Contacted 1st": "Responded",
  "Contacted 2nd": "Responded",
  "Death Call": "Responded",
  "AM Notified": "Assigned",
};

export function normalizeInquiryStatus(status) {
  if (!status) return "New";
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  if (INQUIRY_STATUSES.indexOf(status) !== -1) return status;
  // An unrecognized status is a record from somewhere we do not know about.
  // Showing it as New puts it in front of a human rather than hiding it in a
  // stage the filters do not list.
  return "New";
}

export function isActive(record) {
  return ACTIVE_STATUSES.indexOf(normalizeInquiryStatus(record && record.status)) !== -1;
}

/**
 * Every status change goes through here so the record keeps a timestamped
 * trail. The trail is what makes "did anyone act on this?" answerable.
 */
export function setInquiryStatus(record, status, now) {
  if (!record) return record;
  const next = normalizeInquiryStatus(status);
  if (normalizeInquiryStatus(record.status) === next) return record;
  record.status = next;
  if (!Array.isArray(record.status_history)) record.status_history = [];
  record.status_history.push({ status: next, at: new Date(now || Date.now()).toISOString() });
  return record;
}

/* ------------------------------------------------------------------ *
 * STALENESS
 * ------------------------------------------------------------------ */

// How many days an inquiry may sit in a stage before the screen flags it.
//
// Assigned is the tightest number on this list and it is tight on purpose. It
// means somebody asked us for something and has not been answered. Two days is
// already longer than a person who filled in a form at 9am expects to wait. The
// old ladder allowed five, but five was written for a cold lead an AM had never
// promised anything to.
//
// Quoted is the loosest because the clock genuinely belongs to the customer
// once a price is out. Ten days is when it stops being their turn and starts
// being a quote nobody chased.
export const STAGE_STALE_DAYS = {
  Assigned: 2,
  Responded: 5,
  Quoted: 10,
};

/**
 * Days since the record last changed stage. Falls back to created_at for
 * records that predate the history trail, so an old record reports its real
 * age rather than nothing.
 */
export function daysInStage(record, now) {
  if (!record) return null;
  let since = record.created_at;
  if (Array.isArray(record.status_history) && record.status_history.length) {
    since = record.status_history[record.status_history.length - 1].at;
  }
  if (!since) return null;
  const started = new Date(since).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.floor(((now || Date.now()) - started) / 86400000);
}

export function isStalled(record, now) {
  if (!record) return false;
  const limit = STAGE_STALE_DAYS[normalizeInquiryStatus(record.status)];
  if (limit == null) return false;
  const d = daysInStage(record, now);
  return d !== null && d >= limit;
}

/**
 * A parked inquiry is due when its date arrives. NO DATE MEANS DUE NOW, so an
 * inquiry cannot hide in the bucket forever by skipping the date field.
 */
export function reachBackDue(record, now) {
  if (!record) return false;
  if (normalizeInquiryStatus(record.status) !== "Reach Back Out") return false;
  if (!record.reach_back_at) return true;
  const at = new Date(record.reach_back_at).getTime();
  if (!Number.isFinite(at)) return true;
  return at <= (now || Date.now());
}

/**
 * The funnel across the top of the screen. Colors are token references, never
 * hex, because css/tokens.css owns every color in this repo.
 *
 * There is no rolled-up segment any more. The old funnel folded four cold
 * stages into one "In Outreach" block because seven segments across a screen
 * was unreadable and nobody needed call one apart from call two at a glance.
 * Three live stages fit, so every stage is its own segment and the roll-up and
 * its filter special case are both gone.
 */
export const FUNNEL_STAGES = [
  { name: "New", color: "var(--muted)" },
  { name: "Assigned", color: "var(--hue-sky)" },
  { name: "Responded", color: "var(--hue-blue)" },
  { name: "Quoted", color: "var(--amber)" },
  { name: "Reach Back Out", color: "var(--hue-clay)" },
  { name: "Won", color: "var(--success)" },
  { name: "Lost", color: "var(--danger)" },
];

/* ------------------------------------------------------------------ *
 * WHAT THEY ASKED FOR
 *
 * The research agent scores the COMPANY: how big, how many locations, how
 * likely to reorder, how mature the brand. That question is worth asking and
 * it is unchanged. But it was the whole score because the whole pipeline was
 * built for strangers we had picked out of a list, and a stranger has not
 * asked for anything yet.
 *
 * An inquiry has. Somebody typed in what they want, when they want it and how
 * many. Two inquiries from identically sized companies are not the same
 * inquiry if one is an ongoing company store and the other is four hats for a
 * golf outing, and the old score could not tell them apart.
 *
 * MISSING IS NOT ZERO. Every dimension below can come back unknown, and an
 * unknown one is dropped from the denominator rather than scored low. The
 * intake form lets people skip things, and a short answer is not a bad
 * opportunity. Scoring blanks as ones would rank the customer who wrote least
 * as the worst prospect, which is a rule about typing, not about money.
 * ------------------------------------------------------------------ */

// Ongoing programs first, one-offs last. store_kind splits the online stores:
// a standing state store or catalog reorders forever, a pop-up runs once.
const ORDER_SHAPE_SCORES = {
  online_store: 5,
  bulk_merch: 4,
  bulk_promo: 4,
  live_activation: 3,
  csg: 2,
  just_a_few: 1,
};

const STORE_KIND_RECURRENCE = {
  state_store: 5,
  catalog: 5,
  pop_up: 2,
};

const PROJECT_RECURRENCE = {
  online_store: 4,
  bulk_merch: 3,
  bulk_promo: 3,
  live_activation: 2,
  csg: 1,
  just_a_few: 1,
};

// How well we know this buyer already. An existing client asking for something
// new is the cheapest revenue in the building.
const RELATIONSHIP_SCORES = {
  yes: 5,
  yes_new: 5,
  not_sure: 3,
  manual: 3,
  no: 2,
};

function firstNumber(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const m = String(v).replace(/,/g, "").match(/\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function volumeScore(qty) {
  if (qty == null) return null;
  if (qty >= 500) return 5;
  if (qty >= 250) return 4;
  if (qty >= 100) return 3;
  if (qty >= 25) return 2;
  return 1;
}

/**
 * Lead time in days, scored. A rush is not a bad job and does not score as one,
 * but it is usually a one-off somebody else could not turn around, and it costs
 * the floor more to make. A comfortable window scores highest. A date already
 * in the past is treated as no date rather than as maximum urgency, because it
 * is almost always somebody typing the wrong year.
 */
function timelineScore(inHandsDate, now) {
  if (!inHandsDate) return null;
  const at = new Date(inHandsDate).getTime();
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((at - (now || Date.now())) / 86400000);
  if (days < 0) return null;
  if (days <= 7) return 2;
  if (days <= 14) return 3;
  if (days <= 45) return 5;
  if (days <= 120) return 4;
  return 3;
}

/**
 * Score the ask itself. Returns the dimensions that could be answered, the
 * ones that could not, and a percentage over only the answered ones.
 *
 * pct is null when NOTHING was answerable. That is different from zero and the
 * screen must show it differently: a blank inquiry is not a bad inquiry, it is
 * an inquiry somebody needs to ring up and ask about.
 */
export function askScore(submission, now) {
  const s = submission || {};
  const p = s.project || {};
  const d = p.details || {};
  const entry = s.entry || {};

  const scored = [];
  const unknown = [];
  const add = (key, label, value, note) => {
    if (value == null) unknown.push({ key, label, note: note || "" });
    else scored.push({ key, label, value, note: note || "" });
  };

  add("order_shape", "What they want",
    p.type ? (ORDER_SHAPE_SCORES[p.type] != null ? ORDER_SHAPE_SCORES[p.type] : 3) : null);

  let recurrence = null;
  if (p.type === "online_store" && p.store_kind) {
    recurrence = STORE_KIND_RECURRENCE[p.store_kind] != null ? STORE_KIND_RECURRENCE[p.store_kind] : 3;
  } else if (p.type) {
    recurrence = PROJECT_RECURRENCE[p.type] != null ? PROJECT_RECURRENCE[p.type] : 2;
  }
  add("recurrence", "Chance it repeats", recurrence);

  add("volume", "How many",
    volumeScore(firstNumber(d.audience_size, d.quantity, d.fits_needed, p.quantity)));

  add("timeline", "Lead time", timelineScore(p.in_hands_date, now));

  add("relationship", "Do we know them",
    entry.existing_client ? (RELATIONSHIP_SCORES[entry.existing_client] != null ? RELATIONSHIP_SCORES[entry.existing_client] : 3) : null);

  const total = scored.reduce((sum, x) => sum + x.value, 0);
  const max = scored.length * 5;
  return {
    scored,
    unknown,
    total,
    max,
    pct: max > 0 ? Math.round((total / max) * 100) : null,
  };
}

/* ------------------------------------------------------------------ *
 * THE COMBINED SCORE
 * ------------------------------------------------------------------ */

// Half the company, half the job. Two numbers answering two real questions:
// is this an account worth having, and is this piece of work worth dropping
// something else for. Weighting them evenly is a judgment, not a measurement,
// which is exactly why it is one named constant here rather than a number
// buried in three screens.
export const FIT_WEIGHT = 0.5;

/**
 * The company-fit half, as a percentage. The research agent has shipped two
 * schema versions with different denominators (v1 sums ten 1-5 scores to 50,
 * v2 runs to 100), so the raw total means nothing without knowing which. This
 * is the one place that conversion happens.
 */
export function fitPct(qualification) {
  const q = qualification && qualification.qualification_scoring;
  if (!q || typeof q.total_score !== "number") return null;
  const denom = qualification.schema_version === "2.0" ? 100 : 50;
  return Math.round((q.total_score / denom) * 100);
}

/**
 * Blend the two halves. EITHER HALF ALONE IS STILL AN ANSWER: an inquiry that
 * has never been through the research agent still deserves a number off what
 * the customer told us, and a company we have researched but who filled in
 * almost nothing still deserves one off the research. Only a record with
 * neither returns null, and null must never be drawn as a zero.
 */
export function combinedScore(qualification, submission, now) {
  const fit = fitPct(qualification);
  const ask = askScore(submission, now);
  if (fit == null && ask.pct == null) {
    return { pct: null, fit: null, ask: ask.pct, basis: "none", detail: ask };
  }
  if (fit == null) return { pct: ask.pct, fit: null, ask: ask.pct, basis: "ask", detail: ask };
  if (ask.pct == null) return { pct: fit, fit, ask: null, basis: "fit", detail: ask };
  return {
    pct: Math.round(fit * FIT_WEIGHT + ask.pct * (1 - FIT_WEIGHT)),
    fit,
    ask: ask.pct,
    basis: "both",
    detail: ask,
  };
}

/**
 * Priority is the triage word, deliberately NOT the account tier. The tier
 * ("Strategic Account" and friends) answers how big a customer could become
 * and is stored on records already; overloading it with urgency would make one
 * label answer two questions, the same mistake that had BackBone and CrewCore
 * both calling their list a Roster.
 */
export function inquiryPriority(pct) {
  if (pct == null) return "Unscored";
  if (pct >= 75) return "Hot";
  if (pct >= 55) return "Strong";
  if (pct >= 35) return "Standard";
  return "Low";
}

/* ------------------------------------------------------------------ *
 * ADOPTION
 *
 * A submission from the public form and a worked inquiry used to be two
 * records on two screens, and moving between them was a button somebody had to
 * remember to press. They are one thing at two moments of its life, so the
 * screen shows one list and a submission becomes a full record the first time
 * anybody does anything to it.
 *
 * Adoption is deliberately NOT automatic on page load. Two account managers
 * opening the screen at the same moment would both write, and the second write
 * would land on a list built before the first one. Acting on an inquiry is a
 * thing one person does once, so that is where the write belongs.
 * ------------------------------------------------------------------ */

const SOURCE_BY_ENTRY = {
  no: "Website form",
  yes: "Existing account expansion",
  yes_new: "Existing account expansion",
  not_sure: "Website form",
  manual: "Inbound quote request",
};


/**
 * What the customer asked for, in a sentence, for the research agent to read as
 * CONTEXT. Built from the scored dimensions rather than written by hand so it
 * cannot describe something the score does not see, and vice versa.
 */
export function askSummary(record, projectTypeLabels) {
  const sub = (record && (record.intake_submission || record)) || {};
  const p = sub.project || {};
  const d = p.details || {};
  const bits = [];
  if (p.type) {
    bits.push((projectTypeLabels && projectTypeLabels[p.type]) || String(p.type).replace(/_/g, " "));
  }
  if (p.store_kind) bits.push("a " + String(p.store_kind).replace(/_/g, "-"));
  const qty = firstNumber(d.audience_size, d.quantity, d.fits_needed, p.quantity);
  if (qty != null) bits.push("around " + qty + " pieces or people");
  if (p.in_hands_date) bits.push("needed by " + p.in_hands_date);
  if (p.name) bits.push('project called "' + p.name + '"');
  if (p.description) bits.push("in their words: " + p.description);
  return bits.length ? bits.join("; ") : "";
}

/**
 * Build the inquiry record for a submission. THE WHOLE SUBMISSION RIDES ALONG
 * on the record rather than being flattened into notes: the ask score reads it
 * on every render, and a summary written once at adoption time would freeze
 * whatever the scoring rules were on the day somebody clicked.
 */
export function inquiryFromSubmission(submission, opts) {
  const s = submission || {};
  const co = s.company || {};
  const c = s.contact || {};
  const p = s.project || {};
  const o = opts || {};
  const nowIso = new Date(o.now || Date.now()).toISOString();

  const noteParts = [];
  if (p.name) noteParts.push("Project: " + p.name);
  if (p.type) {
    noteParts.push("Type: " + (((o.projectTypeLabels || {})[p.type]) || p.type) +
      (p.store_kind ? " (" + String(p.store_kind).replace(/_/g, "-") + ")" : ""));
  }
  if (p.in_hands_date) noteParts.push("In-hands: " + p.in_hands_date);
  if (p.description) noteParts.push(p.description);
  if (s.entry && s.entry.source && s.entry.source.channel) {
    noteParts.push("Heard about us: " + [s.entry.source.channel, s.entry.source.detail].filter(Boolean).join(", "));
  }
  const det = p.details || {};
  Object.keys(det).forEach((k) => {
    // The customer-supplied-goods waiver is a legal checkbox, not context an
    // account manager reads on a handoff.
    if (det[k] && k.indexOf("waiver") === -1) noteParts.push(k.replace(/_/g, " ") + ": " + det[k]);
  });

  const nameParts = String(c.name || "").trim().split(/\s+/).filter(Boolean);

  return {
    lead_id: o.id || ("lead_" + Date.now().toString(36)),
    company_name: co.name || "(from inquiry)",
    website_url: c.url || "",
    contact_name: c.name || "",
    contact_first_name: nameParts[0] || "",
    contact_last_name: nameParts.length > 1 ? nameParts.slice(1).join(" ") : "",
    contact_email: c.email || "",
    contact_phone: c.phone || "",
    source_type: SOURCE_BY_ENTRY[(s.entry && s.entry.existing_client) || "no"] || "Website form",
    intake_source: "intake_form",
    industry: co.industry || "",
    // An inquiry can be assigned to an account manager BEFORE anybody files it,
    // straight off the panel. That assignment has to survive into the record or
    // the AM column empties out the moment somebody acts on the row, and the
    // list starts routing it by industry again as though nobody had chosen.
    account_manager: s.assignedAM || "",
    assigned_at: s.assignedAMAt || null,
    inquiry_notes: noteParts.join("\n"),
    existing_crm_notes: "",
    status: "New",
    created_at: s.submitted_at || nowIso,
    // Kept whole and unmodified. See the note above.
    intake_submission: s,
    from_inquiry_id: s.id || null,
    qualification: null,
    promoted_customer_id: null,
    status_history: [],
  };
}
