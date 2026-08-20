// lib/marketmachine/entries.js — dated performance rows.
//
// WHAT CHANGED AND WHY. A channel item used to carry one lump: reach,
// responses and cost for the whole run. That answers "did the postcard drop
// work" and nothing else. An eight-week paid push entered as one row cannot
// tell you it worked for two weeks and then died, which is the only finding
// that would have changed what you did next.
//
// So performance is now a LIST of dated rows hanging off the channel item.
// Each row covers a period, names a platform and a creative, and carries only
// the raw counts somebody can actually observe. Everything else is arithmetic
// done at read time (see metrics.js).
//
// THE SAME SHAPE SERVES THREE INPUTS. A row typed by hand, a row parsed from
// a platform CSV export and a row written by a future connector are the same
// record with a different `source` stamp. That is the whole reason to declare
// the sourced revenue fields now while nothing fills them: when Printavo or
// GA4 is finally wired up, the history does not have a hole in it where the
// column did not exist yet, and no screen has to be rewritten.
//
// ROWS LIVE UNDER THEIR OWN KEY, not inside the campaign record. Two people
// entering last week's numbers for two different channels at the same time
// would otherwise each save a whole campaign blob and the second would erase
// the first. Separate keys make that collision impossible rather than rare.
//
// ESM. Do NOT convert to module.exports.

import {
  CHANNEL_KEYS, normalizeChannelKey, channelMetrics, isDelegated, isFunded, FUNDING,
} from "./schema.js";
import { TYPED_KEYS, SOURCED_KEYS, deriveMetrics } from "./metrics.js";

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 200);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/**
 * A typed number, or null.
 *
 * Blank must survive as null all the way to storage. The form deliberately
 * does not pre-fill these with 0, because a typed zero and an untouched zero
 * print identically and a month later nobody can tell which fields were
 * actually reported. Number("") is 0 and passes isFinite, so the empty check
 * has to come first.
 */
const count = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n);
};

const money = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};

const MONEY_KEYS = ["spend", "platformRevenue", "ga4Revenue", "verifiedRevenue"];
const asNumber = (key, v) => (MONEY_KEYS.includes(key) ? money(v) : count(v));

/** Where a row came from. Manual is the only one that exists today. */
export const ENTRY_SOURCES = ["manual", "csv", "connector"];

export function newEntry(partial, session) {
  const p = partial || {};
  const now = new Date().toISOString();
  const channel = CHANNEL_KEYS.includes(normalizeChannelKey(p.channel))
    ? normalizeChannelKey(p.channel) : "social";

  // Only the metrics this channel actually uses are kept. A trade show row
  // that somehow arrived carrying video views is not stored with them: the
  // number would be meaningless and would still total into a report.
  const allowed = channelMetrics(channel);
  const metrics = {};
  TYPED_KEYS.forEach((k) => {
    metrics[k] = allowed.includes(k) ? asNumber(k, (p.metrics || {})[k]) : null;
  });

  // Declared, and null until something fills them. Deliberately NOT typeable:
  // a revenue figure somebody remembers is not a revenue figure, and once it
  // sits in the same column as a real one nobody can separate them again.
  const sourced = {};
  SOURCED_KEYS.forEach((k) => { sourced[k] = asNumber(k, (p.sourced || {})[k]); });

  return {
    id: str(p.id, 40) || "pe" + Math.random().toString(36).slice(2, 10),
    campaignId: str(p.campaignId, 40),
    channelItemId: str(p.channelItemId, 40) || null,
    channel,
    platform: str(p.platform, 60) || null,
    // Organic and paid are the same platform with different economics, so
    // this is a flag rather than two channels. Channels without placed media
    // (a booth, a phone push) carry null instead of a meaningless "organic".
    funding: isFunded(channel)
      ? (FUNDING.includes(p.funding) ? p.funding : "organic") : null,
    creativeId: str(p.creativeId, 40) || null,
    startDate: isDate(p.startDate) ? p.startDate : null,
    endDate: isDate(p.endDate) ? p.endDate : null,
    metrics,
    sourced,
    source: ENTRY_SOURCES.includes(p.source) ? p.source : "manual",
    sourceDetail: str(p.sourceDetail, 200) || null,
    notes: str(p.notes, 1000),
    createdAt: str(p.createdAt, 40) || now,
    createdBy: str(p.createdBy, 80) || (session && session.username) || null,
    updatedAt: now,
  };
}

/**
 * Validate a row. Returns only the fields actually supplied, so a partial
 * save cannot blank a metric by leaving it out of the request.
 */
export function validateEntryPatch(body) {
  const errors = [];
  const patch = {};
  const b = body || {};

  if (b.campaignId !== undefined) {
    const s = str(b.campaignId, 40);
    if (!s) errors.push("A performance row must belong to a campaign");
    else patch.campaignId = s;
  }

  if (b.channel !== undefined) {
    const c = normalizeChannelKey(b.channel);
    if (!CHANNEL_KEYS.includes(c)) errors.push(`unknown channel: ${b.channel}`);
    else if (isDelegated(c)) {
      // Email numbers come back from MailMe, which knows exactly who received
      // what. A hand-typed email row would be a second set of numbers that
      // disagrees with the first, and the disagreement surfaces at the worst
      // possible moment.
      errors.push("Email results come from MailMe and cannot be entered by hand");
    } else patch.channel = c;
  }

  if (b.channelItemId !== undefined) patch.channelItemId = str(b.channelItemId, 40) || null;
  if (b.creativeId !== undefined) patch.creativeId = str(b.creativeId, 40) || null;
  if (b.platform !== undefined) patch.platform = str(b.platform, 60) || null;
  if (b.notes !== undefined) patch.notes = str(b.notes, 1000);

  if (b.funding !== undefined) {
    if (b.funding && !FUNDING.includes(String(b.funding))) {
      errors.push(`funding must be one of: ${FUNDING.join(", ")}`);
    } else patch.funding = b.funding || null;
  }

  if (b.source !== undefined) {
    if (!ENTRY_SOURCES.includes(String(b.source))) {
      errors.push(`source must be one of: ${ENTRY_SOURCES.join(", ")}`);
    } else patch.source = String(b.source);
  }
  if (b.sourceDetail !== undefined) patch.sourceDetail = str(b.sourceDetail, 200) || null;

  ["startDate", "endDate"].forEach((k) => {
    if (b[k] === undefined) return;
    if (b[k] && !isDate(b[k])) errors.push(`${k} must be YYYY-MM-DD`);
    else patch[k] = b[k] || null;
  });
  const start = patch.startDate !== undefined ? patch.startDate : b.startDate;
  const end = patch.endDate !== undefined ? patch.endDate : b.endDate;
  if (start && end && isDate(start) && isDate(end) && end < start) {
    errors.push("endDate cannot be before startDate");
  }

  if (b.metrics !== undefined) {
    if (!b.metrics || typeof b.metrics !== "object") errors.push("metrics must be an object");
    else {
      const out = {};
      Object.keys(b.metrics).forEach((k) => {
        if (!TYPED_KEYS.includes(k)) {
          // A derived name arriving in the metrics block means something is
          // trying to store an answer rather than the facts behind it. Refuse
          // loudly: a stored CTR is a CTR that can disagree with the data.
          errors.push(`${k} is calculated and cannot be entered`);
          return;
        }
        const v = b.metrics[k];
        if (v !== null && v !== undefined && v !== "" && asNumber(k, v) === null) {
          errors.push(`${k} must be a number, zero or more`);
          return;
        }
        out[k] = asNumber(k, v);
      });
      patch.metrics = out;
    }
  }

  if (b.sourced !== undefined) {
    if (!b.sourced || typeof b.sourced !== "object") errors.push("sourced must be an object");
    else {
      const out = {};
      Object.keys(b.sourced).forEach((k) => {
        if (!SOURCED_KEYS.includes(k)) { errors.push(`unknown sourced field: ${k}`); return; }
        out[k] = asNumber(k, b.sourced[k]);
      });
      patch.sourced = out;
    }
  }

  return { ok: errors.length === 0, errors, patch };
}

/** One row plus everything calculated from it. */
export function decorateEntry(entry) {
  const e = entry || {};
  return { ...e, derived: deriveMetrics(e.metrics, e.sourced) };
}

/**
 * Total a set of rows.
 *
 * Rates are recalculated from the summed raw counts, never averaged from the
 * per-row rates. Averaging a 10% CTR on 20 impressions with a 1% CTR on
 * 20,000 gives 5.5%, which is not close to true. Summing first and dividing
 * once gives the real figure.
 */
export function totalEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];

  // Sums a field across rows, returning null when NO row reported it. Null
  // has to survive the total or "nobody has entered ad spend yet" becomes
  // "this campaign was free", and the two look identical on a card.
  const sum = (block, key) => {
    let total = 0;
    let present = 0;
    rows.forEach((r) => {
      const v = ((r || {})[block] || {})[key];
      if (typeof v === "number" && isFinite(v)) { total += v; present++; }
    });
    return { value: present ? Math.round(total * 100) / 100 : null, present };
  };

  const metrics = {};
  const gaps = [];
  TYPED_KEYS.forEach((k) => {
    const s = sum("metrics", k);
    metrics[k] = s.value;
    // A metric some rows report and others leave blank is the real hazard:
    // the total looks authoritative and is quietly missing weeks. Named here
    // so a screen can caveat it rather than print it flat.
    if (s.present > 0 && s.present < rows.length) gaps.push(k);
  });

  const sourced = {};
  SOURCED_KEYS.forEach((k) => { sourced[k] = sum("sourced", k).value; });

  return {
    rowCount: rows.length,
    metrics,
    sourced,
    derived: deriveMetrics(metrics, sourced),
    partialMetrics: gaps,
  };
}

const groupBy = (rows, keyFn) => {
  const out = new Map();
  (rows || []).forEach((r) => {
    const k = keyFn(r);
    if (k == null) return;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  });
  return out;
};

/** Rows totalled per channel item, which is what the campaign rollup needs. */
export function totalsByChannelItem(entries) {
  const out = {};
  groupBy(entries, (r) => r.channelItemId || null)
    .forEach((rows, id) => { out[id] = totalEntries(rows); });
  return out;
}

/**
 * Rows totalled per creative, sorted by inbound inquiries.
 *
 * Sorted on inquiries rather than reach or engagement on purpose: the
 * question a creative comparison exists to answer is which one produced
 * people who wanted something, not which one was seen most.
 */
export function totalsByCreative(entries, creatives) {
  const named = {};
  (creatives || []).forEach((c) => { named[c.id] = c; });
  const rows = [];
  groupBy(entries, (r) => r.creativeId || "__none").forEach((group, id) => {
    const totals = totalEntries(group);
    rows.push({
      creativeId: id === "__none" ? null : id,
      name: id === "__none" ? "Not attributed to a creative" : ((named[id] || {}).name || id),
      missing: id !== "__none" && !named[id],
      ...totals,
    });
  });
  return rows.sort((a, b) =>
    (b.metrics.inboundInquiries || 0) - (a.metrics.inboundInquiries || 0));
}

/** Rows totalled per platform, then split organic against paid. */
export function totalsByPlatform(entries) {
  const rows = [];
  groupBy(entries, (r) => r.platform || "Unspecified").forEach((group, platform) => {
    rows.push({
      platform,
      ...totalEntries(group),
      organic: totalEntries(group.filter((r) => r.funding === "organic")),
      paid: totalEntries(group.filter((r) => r.funding !== "organic")),
    });
  });
  return rows.sort((a, b) => (b.metrics.spend || 0) - (a.metrics.spend || 0));
}
