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
    note: "Built and sent in MailMe. Reach and results come back automatically.",
    metrics: [] },
  { key: "direct_mail", label: "Direct mail / print", delegated: false,
    note: "Postcards, flyers, catalogs, anything physical.",
    metrics: ["spend", "reach", "destinationClicks", "inboundInquiries", "responses24h"],
    labels: { reach: "Pieces delivered", destinationClicks: "QR / URL visits",
              inboundInquiries: "Replies received" } },
  { key: "social", label: "Social & advertising", delegated: false,
    note: "Anything placed on a platform, organic or paid: social posts, boosted " +
          "posts, search ads, display, radio, print placements.",
    funded: true,
    metrics: ["spend", "reach", "impressions", "videoViews", "likes", "comments",
              "shares", "destinationClicks", "inboundInquiries", "responses24h"] },
  { key: "event", label: "Event / trade show", delegated: false,
    note: "Booths, conferences, sponsorships, open houses.",
    metrics: ["spend", "reach", "inboundInquiries", "responses24h"],
    labels: { reach: "Booth conversations", inboundInquiries: "Leads captured" } },
  { key: "phone", label: "Phone / outreach calls", delegated: false,
    note: "Deliberate calling pushes, not day-to-day account calls.",
    metrics: ["spend", "reach", "inboundInquiries", "responses24h"],
    labels: { reach: "Calls placed", inboundInquiries: "Conversations had",
              responses24h: "Follow-ups sent within 24h" } },
];

export const CHANNEL_KEYS = CHANNELS.map((c) => c.key);

/**
 * `paid_ads` used to be its own channel, alongside `social`.
 *
 * That was the wrong cut. A Facebook push that runs organic posts and boosted
 * posts is one piece of work on one platform, and splitting it across two
 * channels meant the campaign screen showed it twice and neither half could
 * be compared to the other. Paid versus organic is a property of the spend,
 * not a different kind of marketing, so it is now a flag on the row.
 *
 * Old records keep working: anything still typed `paid_ads` is read as
 * `social` with paid funding. Nothing is rewritten in storage, because a
 * migration that runs on read cannot half-finish.
 */
export const LEGACY_CHANNEL_ALIASES = { paid_ads: "social" };

export function normalizeChannelKey(key) {
  const k = String(key || "");
  return LEGACY_CHANNEL_ALIASES[k] || k;
}

export const channelMeta = (key) =>
  CHANNELS.find((c) => c.key === normalizeChannelKey(key)) || null;
export const isDelegated = (key) => !!(channelMeta(key) || {}).delegated;

/** Metric keys this channel actually uses. */
export const channelMetrics = (key) => ((channelMeta(key) || {}).metrics || []).slice();

/**
 * The label to show for a metric on a given channel.
 *
 * "Reach" means people who saw a post, pieces that landed in a mailbox, and
 * conversations at a booth. One stored field, because they answer the same
 * question and totalling them is the point; three labels, because asking
 * someone logging a trade show for "impressions" gets a zero typed in to make
 * the form go away, and that zero is then indistinguishable from a real one.
 */
export function metricLabel(channelKey, metricKey, fallback) {
  const meta = channelMeta(channelKey) || {};
  return (meta.labels && meta.labels[metricKey]) || fallback || metricKey;
}

/** Whether organic/paid applies. Only placed media has the distinction. */
export const isFunded = (key) => !!(channelMeta(key) || {}).funded;

export const FUNDING = ["organic", "paid"];

/**
 * Where a row ran.
 *
 * Kept as a suggestion list rather than a closed set: a radio buy or a county
 * fair program is a real placement and refusing to record it because it is
 * not on a list would push the whole thing into a notes field where nothing
 * can total it. Unknown values are accepted and stored as typed.
 */
export const PLATFORMS = [
  "Facebook", "Instagram", "LinkedIn", "TikTok", "YouTube",
  "Google Search", "Google Display", "Nextdoor",
  "Radio", "Print", "Billboard", "Direct mail", "In person", "Other",
];

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
    // WHO this campaign was aimed at, on the campaign rather than on every
    // performance row. A campaign has one audience by definition: if a push
    // is going to schools and dental practices, those are two campaigns with
    // two budgets and two answers to "did it work". Putting it on the row
    // instead would let one campaign carry three industries, and every
    // industry rollup would then be built on rows that contradict each other.
    industry: str(p.industry, 80) || null,
    // Creatives are real records, not a text field, because the whole point
    // is to roll up by them: carousel A against carousel B across every week
    // they both ran. A typed name would give "Carousel A", "carousel a" and
    // "Dental carousel A" as three different answers.
    creatives: [],
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

/**
 * A creative: one piece of artwork or copy that ran.
 *
 * This is the level below the channel. "We ran Facebook in April" is not a
 * finding; "the sample-kit carousel beat the price-led static three to one"
 * is. Because performance rows point at a creative id rather than repeating
 * its name, the same creative can run in two channels across six weeks and
 * still total as one thing.
 */
export function newCreative(partial) {
  const p = partial || {};
  return {
    id: str(p.id, 40) || "cr" + Math.random().toString(36).slice(2, 9),
    name: str(p.name, 120),
    format: str(p.format, 60) || null,
    notes: str(p.notes, 1000),
    retiredAt: isDate(p.retiredAt) ? p.retiredAt : null,
  };
}

export function newChannelItem(partial) {
  const p = partial || {};
  const asked = normalizeChannelKey(p.type);
  const type = CHANNEL_KEYS.includes(asked) ? asked : "direct_mail";
  return {
    id: str(p.id, 40) || "ch" + Math.random().toString(36).slice(2, 9),
    type,
    name: str(p.name, 120) || (channelMeta(type) || {}).label || type,
    status: CHANNEL_STATUSES.includes(p.status) ? p.status : "planned",
    // A channel item that arrived as the retired `paid_ads` type was paid by
    // definition, so the fact survives the rename instead of every historic
    // ad silently becoming an organic post.
    funding: !isFunded(type) ? null
      : (FUNDING.includes(p.funding) ? p.funding
        : (String(p.type || "") === "paid_ads" ? "paid" : "organic")),
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
  if (b.industry !== undefined) patch.industry = str(b.industry, 80) || null;
  if (b.owner !== undefined) patch.owner = str(b.owner, 80) || null;

  if (b.creatives !== undefined) {
    if (!Array.isArray(b.creatives)) errors.push("creatives must be an array");
    else patch.creatives = b.creatives.map((c) => newCreative(c)).filter((c) => c.name);
  }

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
      const bad = b.channels.find(
        (c) => c && c.type && !CHANNEL_KEYS.includes(normalizeChannelKey(c.type)));
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
export function rollup(campaign, emails, entryTotals) {
  const items = Array.isArray(campaign && campaign.channels) ? campaign.channels : [];
  const byId = emails || {};
  // Dated rows WIN over the single lump when they exist.
  //
  // Both cannot be added: the lump was somebody's total for the same work, so
  // summing them double-counts every dollar. Both cannot be averaged either.
  // Rows are the better record because they carry dates, a platform and a
  // creative, so they take precedence and the old lump stays untouched in
  // storage as the pre-rows history. Nothing is migrated, so nothing is lost
  // if this call is ever reverted.
  const rows = entryTotals || {};

  let plannedCost = 0;
  let actualCost = 0;
  let reach = 0;
  let responses = 0;
  let missingReach = 0;
  let missingCost = 0;
  let fromRows = 0;
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

    const rowed = rows[it.id];
    if (rowed && rowed.rowCount) {
      fromRows++;
      const m = rowed.metrics || {};
      if (m.reach == null) missingReach++; else reach += m.reach;
      if (m.inboundInquiries != null) responses += m.inboundInquiries;
      if (m.spend == null) missingCost++; else actualCost += m.spend;
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
    // How many counted channels are backed by dated rows rather than a single
    // typed total. A screen showing a campaign that is half rows and half
    // lumps should say so, because only the rowed half can be broken down.
    fromRows,
    complete: missingReach === 0 && missingCost === 0,
  };
}

/** Channel items that MailMe is responsible for. */
export function delegatedItems(campaign) {
  const items = Array.isArray(campaign && campaign.channels) ? campaign.channels : [];
  return items.filter((i) => isDelegated(i.type));
}
