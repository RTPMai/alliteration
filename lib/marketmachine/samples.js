// lib/marketmachine/samples.js — five sample campaigns for an empty app.
//
// WHY THIS EXISTS. An empty MarketMachine is five screens of blank tables, so
// nobody can tell what it is for by looking at it, and nobody wants to be the
// first person to type real numbers into something they have not seen work.
// These five campaigns fill every screen with plausible P&M work so the app
// can be looked at, argued with and handed to the team before a real campaign
// is entered.
//
// THEY ARE NOT REAL AND MUST NEVER BE MISTAKEN FOR REAL. Two guards:
//
//   1. Every name starts with SAMPLE_PREFIX, so they are obvious in any list,
//      any report and any export, without needing the app to know about this
//      file.
//   2. Every record carries `sample: true`, so removing them is exact rather
//      than a name match somebody could defeat by renaming one.
//
// Both, not either. The flag is what the clear action uses; the prefix is what
// a human sees. A flag alone would put unlabelled fiction in the spend totals.
//
// WHAT THEY DEMONSTRATE, on purpose. The samples are not five copies of a
// happy path. Between them they exercise the behaviours that are easy to
// disbelieve until you see them:
//
//   - A SKIPPED channel item is left out of the totals entirely, not counted
//     as reach of zero (SAMPLE 4's postcard).
//   - A MISSING number is reported as a gap, not folded in as a zero
//     (SAMPLE 2's mailer has no pieces-delivered figure).
//   - PLANNED and ACTUAL spend stay separate, and actual can exceed budget
//     (SAMPLE 3 ran over).
//   - DATED ROWS beat the single lump, and roll up by creative, so "the
//     carousel beat the static" is a number rather than an opinion
//     (SAMPLE 1's paid social).
//   - A campaign in PLANNING carries costs and no results at all (SAMPLE 5).
//
// Dependency-free like the rest of lib/marketmachine: no KV, no session, no
// network, so a test can check every row without standing anything up.
//
// ESM. Do NOT convert to module.exports.

export const SAMPLE_PREFIX = "SAMPLE: ";

/** Is this record one of ours? Flag first, prefix as the backstop. */
export function isSample(record) {
  if (!record || typeof record !== "object") return false;
  if (record.sample === true) return true;
  return String(record.name || "").startsWith(SAMPLE_PREFIX);
}

/**
 * The five campaigns.
 *
 * Channel item ids and creative ids are FIXED rather than generated, because
 * the performance rows below point at them. Generated ids would mean building
 * a lookup at load time, and a row whose channelItemId misses is a row that
 * never appears on any screen.
 *
 * Ids are prefixed `smp-` so they are as recognisable in stored data as the
 * names are on screen.
 */
export const SAMPLE_CAMPAIGNS = [
  {
    key: "fall-sports",
    name: SAMPLE_PREFIX + "Fall Sports Team Stores 2026",
    goal:
      "Get every fall sports program on an online team store instead of a " +
      "coach collecting sizes on a paper roster.",
    initiative: "Seasonal outreach",
    industry: "Schools & education",
    owner: "Abby Penton",
    status: "active",
    startDate: "2026-08-03",
    endDate: "2026-10-15",
    budget: 4200,
    notes:
      "The paid social here is entered as weekly rows rather than one lump, " +
      "which is what lets the two creatives be compared against each other.",
    creatives: [
      { id: "smp-cr-carousel", name: "Team store hero carousel", format: "Carousel",
        notes: "Five frames: store front page, sizing, delivery date, spirit wear, coach quote." },
      { id: "smp-cr-static", name: "Coach testimonial static", format: "Static image",
        notes: "Single image, quote from a Johnston coach." },
    ],
    channels: [
      { id: "smp-fs-mail", type: "direct_mail", name: "Athletic director postcard drop",
        status: "done", dueDate: "2026-08-07", plannedCost: 950, actualCost: 980,
        reach: 1850, responses: 31,
        notes: "One lump for the whole drop. A postcard lands once, so there is nothing weekly to split." },
      { id: "smp-fs-social", type: "social", name: "Facebook and Instagram team store push",
        status: "in_progress", funding: "paid", plannedCost: 1200,
        notes: "Numbers live in the dated rows on Data Entry, not here." },
      { id: "smp-fs-email", type: "email", name: "Coach list announcement",
        status: "planned", dueDate: "2026-08-24",
        notes: "Built and sent in MailMe. When it goes, its reach and clicks appear here automatically." },
    ],
  },

  {
    key: "dental",
    name: SAMPLE_PREFIX + "Dental Practice Uniform Push",
    goal:
      "Open twenty new dental and orthodontic practices on scrubs and " +
      "embroidered polos, starting with the ones inside forty miles.",
    initiative: "New lead welcome sequence",
    industry: "Dental & orthodontics",
    owner: "Jacob Whitman",
    status: "active",
    startDate: "2026-07-06",
    endDate: "2026-09-30",
    budget: 2500,
    notes:
      "The sample kit mailer is finished but nobody entered how many pieces " +
      "went out. That shows on the rollup as a gap rather than a zero, which " +
      "is the whole point: a total that quietly counts unknowns as nothing " +
      "looks authoritative and is wrong.",
    creatives: [
      { id: "smp-cr-samplekit", name: "Sample kit offer", format: "Single image",
        notes: "Free embroidered polo in the practice colours." },
    ],
    channels: [
      { id: "smp-dn-phone", type: "phone", name: "Practice manager call round",
        status: "done", actualCost: 0, reach: 140, responses: 38,
        notes: "Calls placed 140, conversations had 38. No spend, so zero is typed rather than left blank." },
      { id: "smp-dn-mail", type: "direct_mail", name: "Sample kit mailer",
        status: "done", plannedCost: 600, actualCost: 640, reach: null, responses: 9,
        notes: "DELIBERATE GAP in the sample: pieces delivered was never entered." },
      { id: "smp-dn-social", type: "social", name: "LinkedIn practice owners",
        status: "in_progress", funding: "organic", plannedCost: 0,
        notes: "Organic posting, no spend. Entered as two fortnightly rows." },
    ],
  },

  {
    key: "expo",
    name: SAMPLE_PREFIX + "Iowa Safety and Health Conference Booth",
    goal:
      "Two days in front of safety directors who buy high-visibility gear by " +
      "the pallet, and leave with a list worth calling.",
    initiative: "Event follow-up sequence",
    industry: "Construction & trades",
    owner: "Ryan Toney",
    status: "complete",
    startDate: "2026-06-09",
    endDate: "2026-06-11",
    budget: 6500,
    notes:
      "Came in over budget: 7,275 actual against 6,500 planned. Planned and " +
      "actual are kept as two numbers rather than one substituting for the " +
      "other, so the overrun is visible instead of averaged away.",
    creatives: [],
    channels: [
      { id: "smp-ex-event", type: "event", name: "Booth 214",
        status: "done", plannedCost: 6500, actualCost: 6890, reach: 210, responses: 44,
        notes: "Booth conversations 210, leads captured 44. Includes booth fee, freight and two nights of lodging." },
      { id: "smp-ex-mail", type: "direct_mail", name: "Pre-show invite postcard",
        status: "done", dueDate: "2026-05-26", plannedCost: 400, actualCost: 385,
        reach: 900, responses: 12,
        notes: "Mailed to the attendee list the show sold us." },
    ],
  },

  {
    key: "reorder",
    name: SAMPLE_PREFIX + "Spring Restaurant Reorder Nudge",
    goal:
      "Catch the restaurant accounts that reorder in spring before they go " +
      "shopping for a new shirt supplier.",
    initiative: "Reorder nudge",
    industry: "Restaurants & hospitality",
    owner: "Alexis Davis",
    status: "complete",
    startDate: "2026-03-02",
    endDate: "2026-04-30",
    budget: 900,
    notes:
      "The postcard was dropped mid-campaign and is marked skipped, not done " +
      "with zeros. A skipped item is left out of the totals entirely, so it " +
      "cannot drag the averages down for work that never happened.",
    creatives: [],
    channels: [
      { id: "smp-rn-phone", type: "phone", name: "Top forty accounts call round",
        status: "done", actualCost: 0, reach: 40, responses: 22,
        notes: "Calls placed 40, conversations had 22. Eleven turned into quotes." },
      { id: "smp-rn-mail", type: "direct_mail", name: "Menu season postcard",
        status: "skipped", plannedCost: 500,
        notes: "Cancelled once the call round filled the schedule. Planned cost stays on record, actual never existed." },
    ],
  },

  {
    key: "flyover",
    name: SAMPLE_PREFIX + "Flyover Con 2026 Awareness",
    goal:
      "Build attendance and merch pre-orders ahead of the November show.",
    initiative: "Seasonal outreach",
    industry: "Events & festivals",
    owner: "Hannah Posey",
    status: "planning",
    startDate: "2026-09-01",
    endDate: "2026-11-14",
    budget: 3000,
    notes:
      "Nothing has run yet. A campaign in planning carries its costs and no " +
      "results at all, which is what this one is here to show.",
    creatives: [
      { id: "smp-cr-lineup", name: "Lineup reveal video", format: "Short video" },
    ],
    channels: [
      { id: "smp-fc-social", type: "social", name: "Instagram and TikTok lineup reveal",
        status: "planned", funding: "paid", plannedCost: 1500, dueDate: "2026-09-15" },
      { id: "smp-fc-event", type: "event", name: "Ankeny street festival table",
        status: "planned", plannedCost: 1000, dueDate: "2026-09-19" },
      { id: "smp-fc-email", type: "email", name: "Last year's attendee list",
        status: "planned", dueDate: "2026-10-05" },
    ],
  },
];

/**
 * The dated performance rows, keyed by the campaign `key` above.
 *
 * Only two campaigns carry rows. That is deliberate: the other three show the
 * single-lump path, which is still how a postcard drop or a trade show gets
 * entered, and seeing both side by side is the fastest way to understand that
 * rows win over the lump wherever they exist.
 *
 * SAMPLE 1's three rows are the interesting ones. Same channel, same fortnight,
 * two creatives: the carousel pulls roughly three times the clicks of the
 * static on comparable spend. That comparison is the reason creatives are
 * records rather than a typed name.
 */
export const SAMPLE_ENTRIES = {
  "fall-sports": [
    { channelItemId: "smp-fs-social", channel: "social", platform: "Facebook",
      funding: "paid", creativeId: "smp-cr-carousel",
      startDate: "2026-08-03", endDate: "2026-08-09",
      metrics: { spend: 180, reach: 4200, impressions: 6100, likes: 84, comments: 11,
                 shares: 6, destinationClicks: 143, inboundInquiries: 7, responses24h: 6 },
      notes: "Opening week." },
    { channelItemId: "smp-fs-social", channel: "social", platform: "Instagram",
      funding: "paid", creativeId: "smp-cr-carousel",
      startDate: "2026-08-10", endDate: "2026-08-16",
      metrics: { spend: 180, reach: 3900, impressions: 5400, likes: 121, comments: 8,
                 shares: 4, destinationClicks: 128, inboundInquiries: 5, responses24h: 5 } },
    { channelItemId: "smp-fs-social", channel: "social", platform: "Facebook",
      funding: "paid", creativeId: "smp-cr-static",
      startDate: "2026-08-10", endDate: "2026-08-16",
      metrics: { spend: 140, reach: 3100, impressions: 4200, likes: 39, comments: 3,
                 shares: 1, destinationClicks: 44, inboundInquiries: 1, responses24h: 1 },
      notes: "Same fortnight as the carousel, a third of the clicks on 78 percent of the spend." },
  ],
  dental: [
    { channelItemId: "smp-dn-social", channel: "social", platform: "LinkedIn",
      funding: "organic", creativeId: "smp-cr-samplekit",
      startDate: "2026-07-06", endDate: "2026-07-19",
      metrics: { spend: 0, reach: 1100, impressions: 1600, likes: 27, comments: 4,
                 shares: 2, destinationClicks: 38, inboundInquiries: 3, responses24h: 3 } },
    { channelItemId: "smp-dn-social", channel: "social", platform: "LinkedIn",
      funding: "organic", creativeId: "smp-cr-samplekit",
      startDate: "2026-07-20", endDate: "2026-08-02",
      metrics: { spend: 0, reach: 1450, impressions: 2050, likes: 31, comments: 6,
                 shares: 3, destinationClicks: 52, inboundInquiries: 4, responses24h: 4 },
      notes: "Video views left blank on both rows. Nothing was video, so blank is the honest answer, not zero." },
  ],
};

/**
 * Campaign patches in the shape createCampaign expects, minus the key.
 *
 * The `sample: true` flag is NOT set here, because newCampaign() keeps only
 * the fields it declares and would drop it. The route stamps it immediately
 * after create. Putting it in the patch anyway would read as if it worked.
 */
export function sampleCampaignPatches() {
  return SAMPLE_CAMPAIGNS.map((c) => {
    const { key, ...patch } = c;
    return { key, patch };
  });
}

/**
 * Rows for one sample campaign, stamped with the real id once it exists.
 *
 * Rows carry no sample flag of their own. They live under their campaign's
 * own storage key, so clearing the campaign clears them; a flag would be a
 * second thing to keep true.
 */
export function sampleEntriesFor(key, campaignId) {
  return (SAMPLE_ENTRIES[key] || []).map((row) => ({
    ...row, campaignId: String(campaignId),
  }));
}
