// PUT IN: lib/marketmachine/connections.js
//
// lib/marketmachine/connections.js — what a campaign is connected to, counted once.
//
// PHASE 2 of the MarketMachine rebuild (Sept 2026). Jacob's handoff, section 2:
// "each fact is counted once. Store the source record ID and roll it up by
// reference rather than copying totals into new records."
//
// So a campaign stores IDS ONLY:
//   - TravelTrack trip ids. The trip, and the money spent on it, stay in
//     TravelTrack and are read live. Copying an expense total here would be
//     wrong the moment somebody approved or rejected a receipt.
//   - BackBone lead ids. The lead's status and Account Manager stay in BackBone.
//   - Printavo invoice numbers. Printavo is read, never written; people create
//     the invoice there and paste the number here (Ryan's call).
//   - MailMe emails are NOT stored here at all. MailMe holds the pointer on
//     the email, and has since the original build, because two copies of one
//     link drift the first time an email is deleted.
//
// ROLLUPS dedupe by source id. A trade show and its Postal campaign can both
// list the same invoice; the show's totals count it once. A lead linked to
// the show and to a connected campaign counts once, credited to the campaign
// it was linked to first (primary) with the others shown as assisting.
//
// Pure, no storage and no network: tests call every rule here directly, and
// the browser imports it to draw the same numbers the server would.
//
// ESM. Do NOT convert to module.exports.

export const LINK_KINDS = ["trips", "leads", "invoices"];
export const LINK_LIMIT = 500;

const KIND_LABEL = { trips: "trip", leads: "lead", invoices: "Printavo invoice" };

const REF_PATTERN = {
  trips: /^[A-Za-z0-9_:.-]{1,80}$/,
  leads: /^[A-Za-z0-9_:.-]{1,80}$/,
  // Printavo's visible invoice number. Digits only: "#66608" and "66608 " are
  // accepted and cleaned; anything else is a typo, not an invoice.
  invoices: /^\d{1,12}$/,
};

export function cleanRef(kind, ref) {
  const s = String(ref == null ? "" : ref).trim();
  return kind === "invoices" ? s.replace(/^#/, "").trim() : s;
}

/** The links block of a campaign, always in full shape, never mutated. */
export function linksOf(campaign) {
  const raw = (campaign && campaign.links) || {};
  const out = {};
  LINK_KINDS.forEach((k) => {
    out[k] = (Array.isArray(raw[k]) ? raw[k] : [])
      .filter((e) => e && typeof e.ref === "string" && e.ref)
      .map((e) => ({ ref: e.ref, at: e.at || null, by: e.by || null }));
  });
  return out;
}

/**
 * Add or remove one link. Returns { ok, errors, campaign } with a NEW record.
 *
 * `exists` is decided by the caller, who can reach the other app: false means
 * the trip or lead is not there, and the link is refused rather than stored
 * pointing at nothing. Invoices are not checked, because Printavo being slow
 * or down must not stop somebody recording the number they are holding.
 *
 * Links can change on a closed campaign. Results keep arriving for 60 days
 * after launch, and an order that shows up in week six still belongs to the
 * campaign that earned it.
 */
export function applyLinkPatch(current, body, session, exists) {
  const b = body || {};
  const kind = String(b.kind || "");
  if (!LINK_KINDS.includes(kind)) return { ok: false, errors: ["Unknown kind of connection"], campaign: current };
  const ref = cleanRef(kind, b.ref);
  if (!REF_PATTERN[kind].test(ref)) {
    return { ok: false, errors: [kind === "invoices" ? "An invoice number is digits only" : `That is not a ${KIND_LABEL[kind]} id`], campaign: current };
  }

  const next = JSON.parse(JSON.stringify(current || {}));
  const links = linksOf(next);
  const list = links[kind];
  const at = list.findIndex((e) => e.ref === ref);
  const who = (session && (session.name || session.username)) || null;
  const label = KIND_LABEL[kind];
  let what;

  if (b.remove) {
    if (at === -1) return { ok: false, errors: [`That ${label} is not connected to this campaign`], campaign: current };
    list.splice(at, 1);
    what = `Disconnected ${label} ${ref}`;
  } else {
    if (at !== -1) return { ok: false, errors: [`That ${label} is already connected`], campaign: current };
    if (exists === false) return { ok: false, errors: [`No ${label} ${ref} was found`], campaign: current };
    if (list.length >= LINK_LIMIT) return { ok: false, errors: [`A campaign can hold ${LINK_LIMIT} of these`], campaign: current };
    list.push({ ref, at: new Date().toISOString(), by: who });
    what = `Connected ${label} ${ref}`;
  }

  next.links = links;
  const history = Array.isArray(next.history) ? next.history : [];
  history.push({ at: new Date().toISOString(), by: who, what });
  next.history = history.slice(-200);
  next.updatedAt = new Date().toISOString();
  return { ok: true, errors: [], campaign: next };
}

/* ----------------------------------------------------------------------- *
 * ROLLUPS
 * ----------------------------------------------------------------------- */

/**
 * Which campaigns a rollup covers: the campaign itself, plus its connected
 * campaigns when it is an event. Never grandchildren; events do not nest.
 */
export function scopeOf(campaign, allCampaigns) {
  if (!campaign) return [];
  const kids = (Array.isArray(allCampaigns) ? allCampaigns : [])
    .filter((c) => c && String(c.parentId || "") === String(campaign.id));
  return [campaign].concat(kids);
}

/**
 * Every distinct source id of one kind across a scope, each once, with the
 * campaign that linked it first as primary and the rest as assisting.
 */
export function distinctLinks(kind, scope) {
  const byRef = new Map();
  (Array.isArray(scope) ? scope : []).forEach((c) => {
    linksOf(c)[kind].forEach((e) => {
      const entry = byRef.get(e.ref) || { ref: e.ref, credits: [] };
      entry.credits.push({ campaignId: c.id, at: e.at || "" });
      byRef.set(e.ref, entry);
    });
  });
  return Array.from(byRef.values()).map((entry) => {
    const credits = entry.credits.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return {
      ref: entry.ref,
      primary: credits[0].campaignId,
      assisting: Array.from(new Set(credits.slice(1).map((x) => x.campaignId).filter((id) => id !== credits[0].campaignId))),
    };
  });
}

/**
 * Email results across a scope. Each MailMe email once, by id.
 *
 * Unique click rate is the headline, per the handoff. Its denominator is
 * delivered, and when nothing has been delivered the rate is null with a
 * plain status, never 0%: "0% of nothing" reads as a campaign that failed.
 *
 * Unique clicks are unique WITHIN each email. Somebody who clicked in two
 * emails of the same campaign counts in both, and the label says so rather
 * than implying a head count MailMe does not keep across sends.
 */
export function emailTotals(emails, scope) {
  const ids = new Set((Array.isArray(scope) ? scope : []).map((c) => String(c.id)));
  const seen = new Set();
  const rows = [];
  (Array.isArray(emails) ? emails : []).forEach((e) => {
    if (!e || !e.id || seen.has(e.id)) return;
    if (!ids.has(String(e.marketingCampaignId || ""))) return;
    seen.add(e.id);
    rows.push(e);
  });

  const sum = (field) => rows.reduce((n, e) => n + (Number(e.stats && e.stats[field]) || 0), 0);
  const delivered = sum("delivered");
  const uniqueClicks = sum("uniqueClicks");
  const sent = rows.filter((e) => e.status === "sent" || e.sentAt).length;

  return {
    emails: rows.map((e) => ({
      id: e.id,
      campaignId: e.marketingCampaignId,
      subject: e.subject || "",
      status: e.status || "",
      sentAt: e.sentAt || null,
      delivered: Number(e.stats && e.stats.delivered) || 0,
      uniqueClicks: Number(e.stats && e.stats.uniqueClicks) || 0,
      uniqueOpens: Number(e.stats && e.stats.uniqueOpens) || 0,
    })),
    count: rows.length,
    sent,
    recipients: sum("recipients"),
    delivered,
    uniqueClicks,
    clicks: sum("clicks"),
    uniqueOpens: sum("uniqueOpens"),
    uniqueClickRate: delivered > 0 ? Math.round((uniqueClicks / delivered) * 1000) / 10 : null,
    rateStatus: delivered > 0 ? null : (rows.length ? "Nothing delivered yet" : "No emails attached"),
  };
}

const COUNTED_EXPENSE = ["pending", "approved", "reimbursed"];

/**
 * Travel across a scope: each trip once, each expense once, money read from
 * TravelTrack at the moment of asking. Rejected expenses are listed in the
 * count of receipts but never in the money, because a rejected receipt was
 * not spent on P&M's behalf.
 */
export function travelTotals(scope, trips, expenses) {
  const linked = distinctLinks("trips", scope);
  const tripById = new Map((Array.isArray(trips) ? trips : []).filter(Boolean).map((t) => [String(t.id), t]));
  const tripIds = new Set(linked.map((l) => l.ref));

  const seenExpense = new Set();
  const perTrip = new Map();
  const money = { pending: 0, approved: 0, reimbursed: 0 };
  let rejected = 0;

  (Array.isArray(expenses) ? expenses : []).forEach((x) => {
    if (!x || !x.id || seenExpense.has(x.id)) return;
    const tripId = String(x.trip_id || "");
    if (!tripIds.has(tripId)) return;
    seenExpense.add(x.id);
    const amount = Math.round((Number(x.amount) || 0) * 100);
    const status = String(x.status || "pending");
    const row = perTrip.get(tripId) || { receipts: 0, cents: 0 };
    row.receipts++;
    if (COUNTED_EXPENSE.includes(status)) {
      money[status] += amount;
      row.cents += amount;
    } else if (status === "rejected") {
      rejected++;
    }
    perTrip.set(tripId, row);
  });

  const cents = (n) => Math.round(n) / 100;
  return {
    trips: linked.map((l) => {
      const t = tripById.get(l.ref);
      const row = perTrip.get(l.ref) || { receipts: 0, cents: 0 };
      return {
        ref: l.ref,
        primary: l.primary,
        assisting: l.assisting,
        missing: !t,
        title: t ? t.title || "" : "",
        destination: t ? t.destination || "" : "",
        start_date: t ? t.start_date || "" : "",
        end_date: t ? t.end_date || "" : "",
        status: t ? t.status || "" : "",
        receipts: row.receipts,
        total: cents(row.cents),
      };
    }),
    receipts: seenExpense.size,
    rejected,
    pending: cents(money.pending),
    approved: cents(money.approved),
    reimbursed: cents(money.reimbursed),
    total: cents(money.pending + money.approved + money.reimbursed),
  };
}

/** A lead's stable id: lead_id when BackBone gave one, else its lead number. */
export function leadRef(lead) {
  if (!lead) return "";
  return String(lead.lead_id || lead.lead_no || "").trim();
}

/** Leads across a scope, each once, with who gets the credit. */
export function leadTotals(scope, leads) {
  const linked = distinctLinks("leads", scope);
  const byRef = new Map();
  (Array.isArray(leads) ? leads : []).forEach((l) => {
    if (!l) return;
    if (l.lead_id) byRef.set(String(l.lead_id), l);
    if (l.lead_no) byRef.set(String(l.lead_no), l);
  });
  const rows = linked.map((x) => {
    const l = byRef.get(x.ref);
    return {
      ref: x.ref,
      primary: x.primary,
      assisting: x.assisting,
      missing: !l,
      leadNo: l ? l.lead_no || "" : "",
      company: l ? l.company_name || "" : "",
      contact: l ? l.contact_name || [l.contact_first_name, l.contact_last_name].filter(Boolean).join(" ") : "",
      status: l ? l.status || "" : "",
      accountManager: l ? l.account_manager || "" : "",
      won: !!(l && (String(l.status || "").toLowerCase() === "won" || l.promoted_customer_id)),
    };
  });
  return { leads: rows, count: rows.length, won: rows.filter((r) => r.won).length };
}

/** Invoice numbers across a scope, each once. Status comes from a separate Printavo check. */
export function invoiceTotals(scope) {
  const rows = distinctLinks("invoices", scope);
  return { invoices: rows, count: rows.length };
}

/**
 * Pick the Printavo row for an invoice number out of a search result.
 * An invoice beats a quote with the same number, and a near match is never
 * accepted: search is free text, so "6660" can bring back 66608.
 */
export function matchPrintavo(number, results) {
  const n = String(number);
  const exact = (Array.isArray(results) ? results : []).filter((r) => r && String(r.invoiceNumber) === n);
  return exact.find((r) => r.kind === "invoice") || exact[0] || null;
}
