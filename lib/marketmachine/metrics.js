// lib/marketmachine/metrics.js — the metric catalog.
//
// WHY THIS IS ITS OWN FILE. Three screens need to agree about what a number
// means: the Data Entry form (which fields to show), the Definitions screen
// (what each one means in plain words) and the rollup maths (how the derived
// ones are calculated). When those lived in three places they drifted, and a
// dashboard that quietly redefines "engagement rate" is worse than one that
// does not have it. One catalog, read by all three.
//
// THE CENTRAL RULE: A NUMBER IS EITHER TYPED OR DERIVED, NEVER BOTH.
// Spend, reach and impressions are observed facts, so a human types them.
// Frequency, engagement rate, CTR and response rate are arithmetic on those
// facts, so nobody types them, ever. If two people can type two different
// CTRs for the same week, the app has two answers to one question and no way
// to tell which is right. Derived fields therefore have no input, no storage
// slot and no setter: they are computed on read and thrown away.
//
// THE SECOND RULE: MISSING IS NOT ZERO.
// Every derivation below returns null when an input is missing. A response
// rate of 0% means we reached people and none of them answered. A response
// rate of null means nobody has entered the numbers. Folding the second into
// the first makes every rollup that touches it quietly pessimistic, and the
// mistake is invisible because null and zero print the same width.
//
// ESM. Do NOT convert to module.exports.

/* ---- helpers ---------------------------------------------------------- */

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Sum a set of fields, returning null when NONE of them were entered.
 *
 * The half-way case is the interesting one. Someone who enters 12 likes and
 * leaves comments and shares blank has told us about likes and nothing about
 * the rest. Treating the blanks as zero understates the total; refusing to
 * total at all throws away the one real number. We total what we have and
 * flag the row as partial, so the screen can say so rather than pretend.
 */
export function sumPresent(obj, keys) {
  let total = 0;
  let present = 0;
  keys.forEach((k) => {
    const v = num(obj && obj[k]);
    if (v != null) { total += v; present++; }
  });
  if (!present) return { value: null, partial: false, present: 0 };
  return { value: total, partial: present < keys.length, present };
}

/* ---- typed metrics ---------------------------------------------------- */

/**
 * Fields a person types. `kind` drives the input and the formatting; `def` is
 * the Definitions screen text and is deliberately written for someone who
 * does not run ads for a living.
 */
export const TYPED_METRICS = [
  {
    key: "spend", label: "Spend", kind: "money",
    def: "Money that left the building for this piece of work. Ad spend, postage, " +
         "printing, booth fee. Not staff time.",
  },
  {
    key: "reach", label: "Reach", kind: "count",
    def: "How many different people saw it at least once. One person who saw it " +
         "six times is one, not six.",
  },
  {
    key: "impressions", label: "Impressions", kind: "count",
    def: "How many times it was shown in total. The same person seeing it six " +
         "times is six impressions.",
  },
  {
    key: "videoViews", label: "Video views", kind: "count",
    def: "Plays counted by the platform. Every platform counts a view at a " +
         "different number of seconds, so compare this against itself over time " +
         "rather than against another platform.",
  },
  {
    key: "likes", label: "Likes / reactions", kind: "count",
    def: "The cheapest possible signal. Worth recording, worth weighting lightly.",
  },
  { key: "comments", label: "Comments", kind: "count", def: "Someone wrote something back." },
  { key: "shares", label: "Shares", kind: "count", def: "Someone put it in front of their own people. The strongest of the three engagement signals." },
  {
    key: "destinationClicks", label: "Destination clicks", kind: "count",
    def: "Clicks that went somewhere we own: the site, a form, a landing page. " +
         "Not clicks that expanded the post or opened the photo.",
  },
  {
    key: "inboundInquiries", label: "Inbound inquiries", kind: "count",
    def: "Somebody asked us for something because of this. A form, a call, a " +
         "reply, a booth conversation that produced a name. This is the number " +
         "that actually matters.",
  },
  {
    key: "responses24h", label: "Responses within 24 hours", kind: "count",
    def: "How many of those inquiries we answered inside a day. This measures " +
         "us, not the campaign, and it is the fastest thing on this page to fix.",
  },
];

export const TYPED_KEYS = TYPED_METRICS.map((m) => m.key);
export const metricMeta = (key) => TYPED_METRICS.find((m) => m.key === key) || null;

/* ---- source-fed fields ------------------------------------------------ */

/**
 * Fields that exist in the record but stay null until something is wired to
 * fill them. They are declared now, rather than added later, so that the day
 * GA4 or Printavo is connected the shape does not change and the history does
 * not have a hole in it where the column used to be missing.
 *
 * They are NOT typed by hand on purpose. A revenue figure someone remembers
 * is not a revenue figure, and once it is in the same column as a real one
 * nobody can tell them apart.
 */
export const SOURCED_FIELDS = [
  {
    key: "conversions", label: "Conversions", kind: "count", awaiting: "GA4",
    def: "A tracked action completed on our site. Waiting on GA4.",
  },
  {
    key: "platformRevenue", label: "Platform revenue", kind: "money", awaiting: "the ad platform",
    def: "What Facebook or Google says the campaign earned, using their own " +
         "attribution window. Generous by design, because it flatters them.",
  },
  {
    key: "ga4Revenue", label: "GA4 revenue", kind: "money", awaiting: "GA4",
    def: "What Google Analytics attributes to the campaign. Stricter than the " +
         "platform's own number and usually lower.",
  },
  {
    key: "verifiedRevenue", label: "Verified revenue", kind: "money", awaiting: "Printavo",
    def: "Orders we actually invoiced and can point at. The only one of the " +
         "three that is a fact rather than a model.",
  },
];

export const SOURCED_KEYS = SOURCED_FIELDS.map((f) => f.key);

/**
 * Revenue precedence, strongest evidence first.
 *
 * Three revenue numbers WILL disagree, and a dashboard that silently picks
 * one is a dashboard nobody can defend in a meeting. So the order is fixed
 * here, and whatever consumes it also reports WHICH one it used.
 */
export const REVENUE_PRECEDENCE = ["verifiedRevenue", "ga4Revenue", "platformRevenue"];

export function pickRevenue(sourced) {
  const s = sourced || {};
  for (const key of REVENUE_PRECEDENCE) {
    const v = num(s[key]);
    if (v != null) {
      const meta = SOURCED_FIELDS.find((f) => f.key === key);
      return { value: v, source: key, sourceLabel: (meta || {}).label || key };
    }
  }
  return { value: null, source: null, sourceLabel: null };
}

/* ---- derived metrics -------------------------------------------------- */

/**
 * The calculated set. `def` explains the arithmetic in words, because the
 * arguments this app is meant to end are almost always about definition
 * rather than about the numbers themselves.
 */
export const DERIVED_METRICS = [
  {
    key: "totalEngagements", label: "Total engagements", kind: "count",
    formula: "likes + comments + shares",
    def: "The three engagement signals added together. Shown as partial when " +
         "only some of the three were entered.",
  },
  {
    key: "frequency", label: "Frequency", kind: "ratio",
    formula: "impressions / reach",
    def: "How many times the average person saw it. Climbing past about three " +
         "on a small audience usually means the same people are being worn out " +
         "rather than new people being found.",
  },
  {
    key: "engagementRate", label: "Engagement rate", kind: "percent",
    formula: "total engagements / reach",
    def: "Of the people who saw it, how many did something. Measured against " +
         "reach rather than impressions, so showing the same post to the same " +
         "person twenty times cannot improve the rate.",
  },
  {
    key: "ctr", label: "Click-through rate", kind: "percent",
    formula: "destination clicks / impressions",
    def: "How often being shown turned into a click through to something we own.",
  },
  {
    key: "responseRate", label: "Response rate", kind: "percent",
    formula: "responses within 24 hours / inbound inquiries",
    def: "How many of the people who asked us something got an answer inside a " +
         "day. Above 100 is impossible, so it is capped and flagged instead of " +
         "printed, which usually means the two numbers came from different weeks.",
  },
  {
    key: "revenue", label: "Revenue", kind: "money",
    formula: "verified, else GA4, else platform",
    def: "The best revenue figure available for this row, and the app always " +
         "says which of the three it used.",
  },
  {
    key: "costPerResult", label: "Cost per result", kind: "money",
    formula: "spend / conversions",
    def: "What one tracked conversion cost. Null until conversions are being " +
         "counted, because spend divided by nothing is not zero.",
  },
  {
    key: "roas", label: "ROAS", kind: "ratio",
    formula: "revenue / spend",
    def: "Return on ad spend. 3.0 means three dollars back for every one out. " +
         "Only as trustworthy as the revenue source named next to it.",
  },
];

export const DERIVED_KEYS = DERIVED_METRICS.map((m) => m.key);

/**
 * Compute every derived figure for one entry.
 *
 * Returns null for anything whose inputs are missing, never zero. The
 * `_flags` block carries the things a screen needs to caveat rather than
 * hide: a partial engagement total, or a response rate above 100 that means
 * the two inputs describe different periods.
 */
export function deriveMetrics(metrics, sourced) {
  const m = metrics || {};
  const spend = num(m.spend);
  const reach = num(m.reach);
  const impressions = num(m.impressions);
  const clicks = num(m.destinationClicks);
  const inquiries = num(m.inboundInquiries);
  const answered = num(m.responses24h);

  const eng = sumPresent(m, ["likes", "comments", "shares"]);
  const rev = pickRevenue(sourced);
  const conversions = num((sourced || {}).conversions);

  const flags = {};
  if (eng.partial) flags.engagementPartial = true;

  let responseRate = null;
  if (inquiries != null && inquiries > 0 && answered != null) {
    const raw = (answered / inquiries) * 100;
    // Over 100 is arithmetically possible and factually impossible: you
    // cannot answer more inquiries than you received. It almost always means
    // the two figures cover different date ranges, so the app says that
    // instead of printing a number that would be repeated in a meeting.
    if (raw > 100) flags.responseRateImpossible = true;
    else responseRate = r1(raw);
  }

  return {
    totalEngagements: eng.value,
    frequency: (impressions != null && reach != null && reach > 0) ? r2(impressions / reach) : null,
    engagementRate: (eng.value != null && reach != null && reach > 0 && !eng.partial)
      ? r1((eng.value / reach) * 100) : null,
    ctr: (clicks != null && impressions != null && impressions > 0)
      ? r1((clicks / impressions) * 100) : null,
    responseRate,
    revenue: rev.value,
    revenueSource: rev.source,
    revenueSourceLabel: rev.sourceLabel,
    costPerResult: (spend != null && conversions != null && conversions > 0)
      ? r2(spend / conversions) : null,
    roas: (rev.value != null && spend != null && spend > 0) ? r2(rev.value / spend) : null,
    _flags: flags,
  };
}
