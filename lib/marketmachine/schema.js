// lib/marketmachine/schema.js — shapes, validation and rollup maths.
//
// WHY THIS APP EXISTS. MailMe grew a Campaigns tab because email was the
// first channel P&M automated. But a real campaign is rarely only email: a
// spring school push is a postcard drop, a booth at a conference, a paid
// social run and an email, all aimed at the same people over the same weeks.
// Keeping the campaign of record inside the email tool made every other
// channel invisible, and made "did that campaign work" unanswerable, because
// only one sixth of it was being measured.
//
// So MarketMachine owns the CAMPAIGN. MailMe owns EMAIL. The split is not
// cosmetic: suppression, the cold ramp, domain reputation and CAN-SPAM are
// email-specific problems with no analogue in a postcard drop, and none of
// that belongs in a multi-channel planner.
//
// THE LINK IS ONE-WAY, AND MAILME HOLDS IT. A MailMe email carries
// `marketingCampaignId` and `marketingChannelId`; MarketMachine finds its
// emails by looking for them. The reverse (MarketMachine storing a list of
// email ids) would be a second copy of the same fact, and the two would drift
// the first time an email was deleted from MailMe. One pointer, one owner.
//
// Dependency-free on purpose, like lib/mailme/schema.js: every rule here can
// be called directly from a test without KV, a session or a network.
//
// ESM. Do NOT convert to module.exports.

/**
 * The channels a campaign can run on.
 *
 * `email` is special and is the reason for the `delegated` flag: it is the
 * only channel MarketMachine does not track by hand, because MailMe already
 * knows exactly who received what and what happened next. Asking someone to
 * retype that here would produce a second set of numbers that disagrees with
 * the first, and the disagreement would be discovered at the worst moment.
 *
 * Everything else is entered by hand, because there is no system to read it
 * from. That is not a gap to close later: a postcard drop genuinely has no
 * API, and pretending otherwise would mean an empty dashboard rather than an
 * honest one.
 */
export const CHANNELS = [
  { key: "email", label: "Email", delegated: true,
    note: "Built and sent in MailMe. Reach and results come back automatically." },
  { key: "direct_mail", label: "Direct mail / print", delegated: false,
    note: "Postcards, flyers, catalogs, anything physical." },
  { key: "social", label: "Social media", delegated: false,
    note: "Organic posts on your own channels." },
  { key: "paid_ads", label: "Paid ads", delegated: false,
    note: "Anything you paid to place: search, social, print, radio." },
  { key: "event", label: "Event / trade show", delegated: false,
    note: "Booths, conferences, sponsorships, open houses." },
  { key: "phone", label: "Phone / outreach calls", delegated: false,
    note: "Deliberate calling pushes, not day-to-day account calls." },
];

export const CHANNEL_KEYS = CHANNELS.map((c) => c.key);
export const channelMeta = (key) => CHANNELS.find((c) => c.key === key) || null;
export const isDelegated = (key) => !!(channelMeta(key) || {}).delegated;

/**
 * Campaign status.
 *
 * `complete` and `cancelled` are kept apart because they mean opposite things
 * when you look back: a completed campaign's cost bought something, a
 * cancelled one's did not. Rolling both into "closed" would quietly inflate
 * every spend-per-result figure the app produces.
 */
export const CAMPAIGN_STATUSES = ["planning", "active", "complete", "cancelled"];

/**
 * Channel item status. `skipped` exists for the same reason as `cancelled`
 * above: a planned postcard drop that never happened must not count as reach
 * of zero, it must not count at all.
 */
export const CHANNEL_STATUSES = ["planned", "in_progress", "done", "skipped"];

/** Statuses that mean the work happened and its numbers are real. */
export const COUNTED_CHANNEL_STATUSES = ["in_progress", "done"];

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 200);

// Number(null) and Number("") are both 0, which is finite and slips past a
// naive check. A blank cost field would then store a real zero and make a
// campaign look free.
const money = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};

const count = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n);
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/** A new campaign, with nothing invented beyond what was actually supplied. */
export function newCampaign(partial, session) {
  const now = new Date().toISOString();
  const p = partial || {};
  return {
    name: str(p.name, 120),
    goal: str(p.goal, 2000),
    initiative: str(p.initiative, 120) || null,
    status: CAMPAIGN_STATUSES.includes(p.status) ? p.status : "planning",
    startDate: isDate(p.startDate) ? p.startDate : null,
    endDate: isDate(p.endDate) ? p.endDate : null,
    budget: money(p.budget),
    owner: str(p.owner, 80) || (session && session.username) || null,
    notes: str(p.notes, 4000),
    channels: [],
    createdAt: now,
    createdBy: (session && session.username) || null,
    updatedAt: now,
  };
}

export function newChannelItem(partial) {
  const p = partial || {};
  const type = CHANNEL_KEYS.includes(p.type) ? p.type : "direct_mail";
  return {
    id: str(p.id, 40) || "ch" + Math.random().toString(36).slice(2, 9),
    type,
    name: str(p.name, 120) || (channelMeta(type) || {}).label || type,
    status: CHANNEL_STATUSES.includes(p.status) ? p.status : "planned",
    dueDate: isDate(p.dueDate) ? p.dueDate : null,
    plannedCost: money(p.plannedCost),
    // Delegated channels never carry hand-entered numbers. Storing them would
    // create a second answer to a question MailMe already answers, and the
    // rollup would have to pick one.
    actualCost: isDelegated(type) ? null : money(p.actualCost),
    reach: isDelegated(type) ? null : count(p.reach),
    responses: isDelegated(type) ? null : count(p.responses),
    notes: str(p.notes, 2000),
  };
}

/**
 * Validate a campaign patch. Returns only the fields actually present, so a
 * partial save cannot blank a field by omitting it.
 */
export function validateCampaignPatch(body) {
  const errors = [];
  const patch = {};
  const b = body || {};

  if (b.name !== undefined) {
    const s = str(b.name, 120);
    if (!s) errors.push("A campaign needs a name");
    else patch.name = s;
  }
  if (b.goal !== undefined) patch.goal = str(b.goal, 2000);
  if (b.notes !== undefined) patch.notes = str(b.notes, 4000);
  if (b.initiative !== undefined) patch.initiative = str(b.initiative, 120) || null;
  if (b.owner !== undefined) patch.owner = str(b.owner, 80) || null;

  if (b.status !== undefined) {
    if (!CAMPAIGN_STATUSES.includes(String(b.status))) {
      errors.push(`status must be one of: ${CAMPAIGN_STATUSES.join(", ")}`);
    } else patch.status = String(b.status);
  }

  if (b.startDate !== undefined) {
    if (b.startDate && !isDate(b.startDate)) errors.push("startDate must be YYYY-MM-DD");
    else patch.startDate = b.startDate || null;
  }
  if (b.endDate !== undefined) {
    if (b.endDate && !isDate(b.endDate)) errors.push("endDate must be YYYY-MM-DD");
    else patch.endDate = b.endDate || null;
  }
  // Checked against the INCOMING pair when both are present. A campaign that
  // ends before it starts makes every date-based rollup nonsense, and the
  // error is far cheaper here than as a negative duration on a report.
  const start = patch.startDate !== undefined ? patch.startDate : b.startDate;
  const end = patch.endDate !== undefined ? patch.endDate : b.endDate;
  if (start && end && isDate(start) && isDate(end) && end < start) {
    errors.push("endDate cannot be before startDate");
  }

  if (b.budget !== undefined) {
    if (b.budget !== null && b.budget !== "" && money(b.budget) === null) {
      errors.push("budget must be a number, zero or more");
    } else patch.budget = money(b.budget);
  }

  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels)) errors.push("channels must be an array");
    else {
      const bad = b.channels.find((c) => c && c.type && !CHANNEL_KEYS.includes(String(c.type)));
      if (bad) errors.push(`unknown channel type: ${bad.type}`);
      else patch.channels = b.channels.map((c) => newChannelItem(c));
    }
  }

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Roll a campaign up.
 *
 * `emails` is whatever MailMe reported for this campaign's delegated items,
 * keyed by channel item id. It is passed IN rather than fetched here so this
 * stays testable without a store, and so the caller decides how fresh those
 * numbers need to be.
 *
 * Three deliberate choices worth knowing:
 *
 *  1. SKIPPED ITEMS ARE EXCLUDED ENTIRELY, not counted as zero. A postcard
 *     drop that never happened should not drag the average down; it should
 *     not be in the average.
 *  2. PLANNED SPEND AND ACTUAL SPEND ARE SEPARATE NUMBERS. Substituting one
 *     for the other when the other is missing produces a total that looks
 *     authoritative and is a mixture of a guess and a fact.
 *  3. A MISSING NUMBER IS NOT A ZERO. `reach: null` on a done item means
 *     nobody entered it, which is reported as a gap rather than folded into
 *     the total, because a total that silently counts unknowns as nothing is
 *     worse than one that admits it is incomplete.
 */
export function rollup(campaign, emails) {
  const items = Array.isArray(campaign && campaign.channels) ? campaign.channels : [];
  const byId = emails || {};

  let plannedCost = 0;
  let actualCost = 0;
  let reach = 0;
  let responses = 0;
  let missingReach = 0;
  let missingCost = 0;
  const counted = [];

  items.forEach((it) => {
    if (it.plannedCost != null) plannedCost += it.plannedCost;

    if (!COUNTED_CHANNEL_STATUSES.includes(it.status)) return;
    counted.push(it);

    if (isDelegated(it.type)) {
      const e = byId[it.id];
      // No linked email yet is a gap, not a zero: the item says it is in
      // progress, so somebody expects numbers here.
      if (!e) { missingReach++; return; }
      reach += e.reach || 0;
      responses += e.responses || 0;
      // Email has no per-send cost to enter; the provider bill is not
      // attributable to one campaign, so it is deliberately not modelled.
      return;
    }

    if (it.reach == null) missingReach++; else reach += it.reach;
    if (it.responses != null) responses += it.responses;
    if (it.actualCost == null) missingCost++; else actualCost += it.actualCost;
  });

  const budget = campaign && campaign.budget != null ? campaign.budget : null;

  return {
    channelCount: items.length,
    countedCount: counted.length,
    skippedCount: items.filter((i) => i.status === "skipped").length,
    plannedCost: Math.round(plannedCost * 100) / 100,
    actualCost: Math.round(actualCost * 100) / 100,
    budget,
    // Null rather than a number when the budget is unset: "over by $NaN" and
    // "over by your whole spend" are both worse than saying nothing.
    budgetRemaining: budget == null ? null : Math.round((budget - actualCost) * 100) / 100,
    overBudget: budget != null && actualCost > budget,
    reach,
    responses,
    // Only meaningful when reach is actually known for everything counted.
    // A response rate computed over a partial reach reads as a real figure
    // and is not one.
    responseRate: (reach > 0 && !missingReach)
      ? Math.round((responses / reach) * 1000) / 10 : null,
    costPerResponse: (responses > 0 && actualCost > 0 && !missingCost)
      ? Math.round((actualCost / responses) * 100) / 100 : null,
    missingReach,
    missingCost,
    complete: missingReach === 0 && missingCost === 0,
  };
}

/** Channel items that MailMe is responsible for. */
export function delegatedItems(campaign) {
  const items = Array.isArray(campaign && campaign.channels) ? campaign.channels : [];
  return items.filter((i) => isDelegated(i.type));
}
