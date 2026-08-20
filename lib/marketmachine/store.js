// lib/marketmachine/store.js — persistence, plus the one cross-app read.
//
// STORAGE SHAPE. All campaigns live under a single key as { [id]: Campaign }.
// That is a deliberate departure from MailMe's per-campaign event keys: those
// grow without bound (thousands of open/click rows per send), whereas a
// marketing campaign is one small record and P&M will have dozens a year, not
// thousands. One key means a list read is one round trip.
//
// THE CROSS-APP READ. resolveEmails() reaches into MailMe's store to find the
// emails belonging to a campaign. This is the only place the two apps touch,
// and it goes in this direction on purpose: MailMe holds the pointer
// (marketingCampaignId on its own campaign records), so MarketMachine asks
// "which of your emails say they belong to me" rather than keeping its own
// list that would drift the first time an email was deleted.
//
// lib/ importing lib/ is fine. lib/ importing api/ is not, and this does not.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { rollup, delegatedItems, newCampaign, newChannelItem } from "./schema.js";
import {
  newEntry, decorateEntry, totalEntries, totalsByChannelItem,
  totalsByCreative, totalsByPlatform,
} from "./entries.js";
import { listCampaigns as listMailmeCampaigns } from "../mailme/store.js";
import { computeRates } from "../mailme/schema.js";

const PREFIX = "marketmachine";

export const mmKeys = {
  campaigns: () => `${PREFIX}:campaigns`,
  // The Marketing Initiative Step Library, previously a hardcoded placeholder
  // list inside BackBone's leads pipeline. It describes marketing, so it
  // belongs to the marketing app; BackBone reads it.
  initiatives: () => `${PREFIX}:initiatives`,
  // The industry list, edited in Settings. Same pattern as initiatives: a
  // free-text industry field would give "Dental", "dental" and "Dental &
  // Ortho" as three different segments and every segment rollup would split.
  industries: () => `${PREFIX}:industries`,
  // Performance rows live PER CAMPAIGN rather than in one map.
  //
  // Rows are the only thing here that grows without bound: a campaign entered
  // weekly across six channels for a year is a few hundred rows, and loading
  // every campaign's rows to read one campaign's would get slower every month.
  // Per-campaign keys also mean two people entering numbers for two different
  // campaigns can never overwrite each other, which a single shared blob
  // cannot promise.
  entries: (campaignId) => `${PREFIX}:entries:${String(campaignId)}`,
};

async function readMap(key) {
  const raw = await getRaw(key);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function getAllCampaigns() {
  return readMap(mmKeys.campaigns());
}

export async function getCampaign(id) {
  const all = await getAllCampaigns();
  return all[String(id)] || null;
}

// Derived from the records already in hand rather than a separate counter
// key. Campaigns live in ONE map, so createCampaign has the whole set loaded
// anyway, and a counter would be a second thing that can fall out of step
// with reality (an INCR that succeeds while the write behind it fails leaves
// a permanent hole). Max-plus-one cannot collide as long as ids are never
// reused, and deleteCampaign does not reuse them.
function nextCampaignId(all) {
  const highest = Object.keys(all || {}).reduce((max, id) => {
    const n = Number(String(id).replace(/^MC-/, ""));
    return isFinite(n) && n > max ? n : max;
  }, 0);
  return `MC-${String(highest + 1).padStart(5, "0")}`;
}

export async function createCampaign(patch, session) {
  const all = await getAllCampaigns();
  const id = nextCampaignId(all);
  const record = { id, ...newCampaign(patch, session) };
  // Channels can arrive with the create, so a campaign planned in one sitting
  // does not need a second save to hold its plan.
  if (Array.isArray(patch && patch.channels)) {
    record.channels = patch.channels.map((c) => newChannelItem(c));
  }
  all[id] = record;
  await setRaw(mmKeys.campaigns(), all);
  return record;
}

export async function updateCampaign(id, patch) {
  const all = await getAllCampaigns();
  const key = String(id);
  const current = all[key];
  if (!current) return null;
  const next = { ...current, ...patch, id: key, updatedAt: new Date().toISOString() };
  all[key] = next;
  await setRaw(mmKeys.campaigns(), all);
  return next;
}

export async function deleteCampaign(id) {
  const all = await getAllCampaigns();
  const key = String(id);
  if (!all[key]) return false;
  delete all[key];
  await setRaw(mmKeys.campaigns(), all);
  return true;
}

/**
 * Find MailMe's emails for a campaign, keyed by the channel item they belong
 * to.
 *
 * Reads MailMe's own campaign records and filters on the pointer they carry.
 * Deliberately tolerant: if MailMe is unreachable or its data is missing, the
 * caller gets an empty map and the campaign still renders with its other
 * channels intact. A marketing dashboard that goes blank because the email
 * app hiccuped would be worse than one that says "email numbers unavailable".
 *
 * The stats reported here are MailMe's, unmodified. Recomputing them would be
 * a second implementation of open/click rates that could disagree with the
 * ones MailMe shows on its own Reports screen for the same send.
 */
export async function resolveEmails(campaignId) {
  let emails = [];
  try {
    emails = await listMailmeCampaigns();
  } catch (e) {
    return { byChannel: {}, all: [], unavailable: true };
  }

  const mine = (Array.isArray(emails) ? emails : [])
    .filter((e) => e && String(e.marketingCampaignId || "") === String(campaignId));

  const byChannel = {};
  mine.forEach((e) => {
    const stats = e.stats || {};
    const rates = computeRates(stats);
    // Reach is DELIVERED, not queued. A campaign that bounced half its list
    // did not reach half its list, and using the recipient count here would
    // quietly overstate every rollup that includes an email.
    const reach = stats.delivered || 0;
    const entry = {
      id: e.id,
      subject: e.subject || "",
      status: e.status,
      sentAt: e.sentAt || null,
      reach,
      // Clicks and replies are the two that mean a human did something.
      // Opens are deliberately excluded from "responses": image-proxy
      // prefetching inflates them, so counting them as engagement would make
      // every campaign look better than it was.
      responses: (stats.uniqueClicks || 0) + (stats.replies || 0),
      stats,
      rates,
    };
    const chId = String(e.marketingChannelId || "");
    // An email pointing at the campaign but not at a specific channel item
    // still counts. Dropping it would lose real reach because of a missing
    // sub-pointer.
    if (chId) {
      if (!byChannel[chId]) byChannel[chId] = { ...entry, emails: [entry] };
      else {
        byChannel[chId].reach += entry.reach;
        byChannel[chId].responses += entry.responses;
        byChannel[chId].emails.push(entry);
      }
    }
  });

  return { byChannel, all: mine.map((e) => ({ id: e.id, subject: e.subject, status: e.status })), unavailable: false };
}

/** A campaign plus its rolled-up numbers and its linked emails. */
export async function campaignDetail(id) {
  const campaign = await getCampaign(id);
  if (!campaign) return null;
  const linked = await resolveEmails(id);
  const rows = await listEntries(id);
  const byItem = totalsByChannelItem(rows);
  return {
    campaign,
    rollup: rollup(campaign, linked.byChannel, byItem),
    emails: linked,
    delegated: delegatedItems(campaign),
    entries: rows.map(decorateEntry),
    entryTotals: totalEntries(rows),
    byChannelItem: byItem,
    byCreative: totalsByCreative(rows, campaign.creatives || []),
    byPlatform: totalsByPlatform(rows),
  };
}

/** Every campaign with a light rollup, for the list screen. */
export async function listCampaigns() {
  const all = await getAllCampaigns();
  const records = Object.values(all);
  // One MailMe read for the whole list rather than one per campaign: a dozen
  // campaigns would otherwise be a dozen full reads of the same data.
  let emails = [];
  try {
    emails = await listMailmeCampaigns();
  } catch (e) {
    emails = [];
  }

  const byCampaign = {};
  (Array.isArray(emails) ? emails : []).forEach((e) => {
    const cid = String((e && e.marketingCampaignId) || "");
    if (!cid) return;
    const chId = String(e.marketingChannelId || "");
    if (!chId) return;
    const stats = e.stats || {};
    if (!byCampaign[cid]) byCampaign[cid] = {};
    const slot = byCampaign[cid][chId] || { reach: 0, responses: 0 };
    slot.reach += stats.delivered || 0;
    slot.responses += (stats.uniqueClicks || 0) + (stats.replies || 0);
    byCampaign[cid][chId] = slot;
  });

  // One read per campaign for its performance rows, run in parallel.
  //
  // This is the one place the per-campaign key shape costs something: the
  // list screen needs every campaign's totals, so it needs every key. Reading
  // them in parallel keeps it to a single round of latency rather than a
  // chain, and P&M runs dozens of campaigns a year, not thousands. If that
  // ever stops being true, the answer is a stored per-campaign summary, not
  // moving the rows back into one blob that two people can clobber.
  //
  // A failed row read degrades to the typed lump rather than throwing: a
  // campaign list that will not render because one key hiccuped is worse than
  // one showing slightly older figures.
  const rowTotals = await Promise.all(records.map(async (c) => {
    try {
      const rows = await readList(mmKeys.entries(c.id));
      return totalsByChannelItem(rows);
    } catch (e) { return {}; }
  }));

  return records
    .map((c, i) => ({ ...c, rollup: rollup(c, byCampaign[String(c.id)] || {}, rowTotals[i]) }))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

/* ---- performance rows -------------------------------------------------- */

async function readList(key) {
  const raw = await getRaw(key);
  return Array.isArray(raw) ? raw : [];
}

/** Every row for a campaign, newest period first. */
export async function listEntries(campaignId) {
  const rows = await readList(mmKeys.entries(campaignId));
  return rows.slice().sort((a, b) =>
    String(b.startDate || b.createdAt || "").localeCompare(String(a.startDate || a.createdAt || "")));
}

export async function createEntry(patch, session) {
  const campaignId = String((patch && patch.campaignId) || "");
  // A row that does not belong to a campaign cannot be found again, cannot be
  // rolled up and cannot be deleted from any screen. Refused rather than
  // orphaned.
  if (!campaignId) return null;
  const campaign = await getCampaign(campaignId);
  if (!campaign) return null;

  const rows = await readList(mmKeys.entries(campaignId));
  const record = newEntry({ ...patch, campaignId }, session);
  rows.push(record);
  await setRaw(mmKeys.entries(campaignId), rows);
  return record;
}

export async function updateEntry(campaignId, id, patch) {
  const key = mmKeys.entries(campaignId);
  const rows = await readList(key);
  const i = rows.findIndex((r) => String(r.id) === String(id));
  if (i < 0) return null;
  // Rebuilt through newEntry so a channel change re-applies that channel's
  // allowed metric set. Patching fields in place would leave video views on a
  // row somebody just switched to a trade show.
  const merged = {
    ...rows[i],
    ...patch,
    metrics: { ...(rows[i].metrics || {}), ...(patch.metrics || {}) },
    sourced: { ...(rows[i].sourced || {}), ...(patch.sourced || {}) },
    id: rows[i].id,
    campaignId: String(campaignId),
    createdAt: rows[i].createdAt,
    createdBy: rows[i].createdBy,
  };
  rows[i] = newEntry(merged);
  await setRaw(key, rows);
  return rows[i];
}

export async function deleteEntry(campaignId, id) {
  const key = mmKeys.entries(campaignId);
  const rows = await readList(key);
  const next = rows.filter((r) => String(r.id) !== String(id));
  if (next.length === rows.length) return false;
  await setRaw(key, next);
  return true;
}

/* ---- the initiative library ------------------------------------------- */

// Seeded from the placeholder set BackBone was carrying, so the dropdown
// there keeps working from the moment this ships. These are meant to be
// replaced with the real names off the Monday "Marketing Initiative
// Templates - Step Library" board.
export const DEFAULT_INITIATIVES = [
  "New lead welcome sequence",
  "Event follow-up sequence",
  "Reorder nudge",
  "Seasonal outreach",
  "Win-back campaign",
];

export async function getInitiatives() {
  const raw = await getRaw(mmKeys.initiatives());
  if (Array.isArray(raw) && raw.length) return raw.map(String);
  return DEFAULT_INITIATIVES.slice();
}

/**
 * The industry list.
 *
 * Seeded with the segments P&M actually sells into, so the dropdown is usable
 * the moment this ships rather than an empty box somebody skips past. Edited
 * in Settings, not in code.
 */
export const DEFAULT_INDUSTRIES = [
  "Schools & education",
  "Dental & orthodontics",
  "Healthcare",
  "Corporate",
  "Construction & trades",
  "Restaurants & hospitality",
  "Sports & recreation",
  "Nonprofit & church",
  "Events & festivals",
  "Other",
];

export async function getIndustries() {
  const raw = await getRaw(mmKeys.industries());
  if (Array.isArray(raw) && raw.length) return raw.map(String);
  return DEFAULT_INDUSTRIES.slice();
}

export async function saveIndustries(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 100);
  await setRaw(mmKeys.industries(), clean);
  return clean;
}

export async function saveInitiatives(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 100);
  await setRaw(mmKeys.initiatives(), clean);
  return clean;
}
