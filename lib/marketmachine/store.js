// PUT IN: lib/marketmachine/store.js
//
// lib/marketmachine/store.js — where campaigns live, plus the cross-app reads.
//
// REWRITTEN Sept 2026 for the campaign checklist rebuild (phase 1).
//
// ONE KEY PER CAMPAIGN, plus an index of ids. The old store kept every
// campaign in one blob, which was fine when a campaign was edited once a week.
// A checklist is edited constantly and by several people at once: Jacob ticks
// a step on the trade show while an Account Manager ticks one on a Postal
// campaign. With one blob, the second save would silently undo the first.
// Separate keys mean two people on two campaigns can never collide.
//
// NEW IDS START WITH "CP-", NOT "MC-". MailMe emails point at campaigns by id,
// and some point at the old MC- sample campaigns. Reusing MC-00001 for a new
// campaign would quietly attach an old test email to it.
//
// THE OLD SAMPLE CAMPAIGNS are left where they were and are not read by
// anything except legacyCount() and clearLegacy(), which the Settings screen
// uses to delete them for good (Ryan's call: they were sample data).
//
// lib/ importing lib/ is fine. lib/ importing api/ is not, and this does not.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { validateNew, buildCampaign, applyHeaderPatch, applyStepPatch } from "./campaign.js";
import { listCampaigns as listMailmeCampaigns } from "../mailme/store.js";
import { listEmployees } from "../crewcore/store.js";
import { getSettings as getPromoProSettings } from "../promopro/store.js";
import {
  effectiveAccountManagerIds, resolveAccountManagers, identifyAccountManager,
} from "../promopro/account-managers.js";

const PREFIX = "marketmachine";

export const mmKeys = {
  index: () => `${PREFIX}:v2:index`,
  campaign: (id) => `${PREFIX}:v2:campaign:${String(id)}`,
  // Pre-rebuild data. Read only to count and delete it.
  legacyCampaigns: () => `${PREFIX}:campaigns`,
  legacyEntries: (id) => `${PREFIX}:entries:${String(id)}`,
  // The list BackBone's lead form reads. Unchanged by the rebuild: BackBone
  // still calls it, and renaming what it holds is a later, BackBone-side step.
  initiatives: () => `${PREFIX}:initiatives`,
  industries: () => `${PREFIX}:industries`,
};

async function readIndex() {
  const raw = await getRaw(mmKeys.index());
  return Array.isArray(raw) ? raw.map(String) : [];
}

export async function getCampaign(id) {
  const raw = await getRaw(mmKeys.campaign(id));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

/** Every campaign. An index entry whose record is gone is skipped, not fatal. */
export async function listCampaigns() {
  const ids = await readIndex();
  const records = await Promise.all(ids.map((id) => getCampaign(id).catch(() => null)));
  return records.filter(Boolean);
}

export function nextCampaignId(ids) {
  const highest = (Array.isArray(ids) ? ids : []).reduce((max, id) => {
    const n = Number(String(id).replace(/^CP-/, ""));
    return isFinite(n) && n > max ? n : max;
  }, 0);
  return `CP-${String(highest + 1).padStart(5, "0")}`;
}

/**
 * Create a campaign. Returns { ok, errors, campaign }.
 *
 * The record is written BEFORE the index. If the second write fails, the
 * campaign exists but is not listed, and the next create cannot reuse its id
 * because the id check reads the record as well as the index. The other order
 * would list an id with nothing behind it.
 */
export async function createCampaign(body, session) {
  const b = body || {};
  let parent = null;
  if (b.parentId) parent = await getCampaign(b.parentId);

  const verdict = validateNew(b, parent);
  if (!verdict.ok) return { ok: false, errors: verdict.errors, campaign: null };

  const ids = await readIndex();
  let id = nextCampaignId(ids);
  while (await getCampaign(id)) id = nextCampaignId(ids.concat(id));

  const record = { id, ...buildCampaign(b, session, parent) };
  await setRaw(mmKeys.campaign(id), record);
  await setRaw(mmKeys.index(), ids.concat(id));
  return { ok: true, errors: [], campaign: record };
}

async function save(record) {
  await setRaw(mmKeys.campaign(record.id), record);
  return record;
}

export async function updateHeader(id, body, session) {
  const current = await getCampaign(id);
  if (!current) return { ok: false, notFound: true, errors: ["Campaign not found"] };
  const out = applyHeaderPatch(current, body, session);
  if (!out.ok) return out;
  await save(out.campaign);
  return out;
}

export async function updateStep(id, stepKey, body, session, today) {
  const current = await getCampaign(id);
  if (!current) return { ok: false, notFound: true, errors: ["Campaign not found"] };
  const out = applyStepPatch(current, stepKey, body, session, today);
  if (!out.ok) return out;
  await save(out.campaign);
  return out;
}

export function childrenOf(parentId, campaigns) {
  return (Array.isArray(campaigns) ? campaigns : [])
    .filter((c) => c && String(c.parentId || "") === String(parentId));
}

/**
 * Delete a campaign. An event with connected campaigns is refused: deleting
 * it would leave those campaigns pointing at nothing, and their results would
 * stop rolling up anywhere.
 */
export async function deleteCampaign(id) {
  const current = await getCampaign(id);
  if (!current) return { ok: false, notFound: true, errors: ["Campaign not found"] };
  const kids = childrenOf(id, await listCampaigns());
  if (kids.length) {
    return { ok: false, errors: [`${kids.length} connected campaign${kids.length === 1 ? " is" : "s are"} still under this event. Delete or cancel those first.`] };
  }
  const ids = await readIndex();
  await setRaw(mmKeys.index(), ids.filter((x) => x !== String(id)));
  await setRaw(mmKeys.campaign(id), null);
  return { ok: true, errors: [] };
}

/* ---- the old sample campaigns ------------------------------------------ */

async function legacyMap() {
  const raw = await getRaw(mmKeys.legacyCampaigns());
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function legacyCount() {
  return Object.keys(await legacyMap()).length;
}

/** Delete every pre-rebuild campaign and its performance rows. */
export async function clearLegacy() {
  const map = await legacyMap();
  const ids = Object.keys(map);
  await Promise.all(ids.map((id) => setRaw(mmKeys.legacyEntries(id), [])));
  await setRaw(mmKeys.legacyCampaigns(), {});
  return ids.length;
}

/* ---- cross-app reads ---------------------------------------------------- */

/**
 * MailMe emails that say they belong to this campaign. Read-only and
 * tolerant: MailMe having a bad moment shows "unavailable", it does not stop
 * the campaign opening.
 */
export async function linkedEmails(id) {
  try {
    const emails = await listMailmeCampaigns();
    return {
      unavailable: false,
      emails: (Array.isArray(emails) ? emails : [])
        .filter((e) => e && String(e.marketingCampaignId || "") === String(id))
        .map((e) => ({ id: e.id, subject: e.subject || "", status: e.status || "", sentAt: e.sentAt || null })),
    };
  } catch (e) {
    return { unavailable: true, emails: [] };
  }
}

/**
 * The Account Manager choices, and which one (if any) is the person asking.
 *
 * ONE list of account managers for the platform: the people PromoPro Settings
 * already names, resolved against the CrewCore roster. A second list kept in
 * MarketMachine would be the same people typed twice, and the two would stop
 * agreeing the first time somebody joined or left.
 */
export async function accountManagers(account) {
  let employees;
  try {
    employees = await listEmployees();
  } catch (e) {
    return { options: [], me: null, unavailable: true };
  }
  let settings = {};
  try { settings = await getPromoProSettings(); } catch (e) { settings = {}; }
  const ids = effectiveAccountManagerIds(settings, employees);
  const options = resolveAccountManagers(ids, employees).map((a) => ({ id: a.id, name: a.name }));
  const me = account ? identifyAccountManager(account, employees, ids) : null;
  return { options, me: me ? { id: me.id, name: me.name } : null, unavailable: false };
}

/* ---- the lead dropdown list BackBone reads (unchanged) ------------------ */

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

export async function saveInitiatives(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 100);
  await setRaw(mmKeys.initiatives(), clean);
  return clean;
}

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
