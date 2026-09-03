// lib/giving-summary.js — what we gave, when, to whom, and for what.
//
// Rolls approved requests up several ways:
//
//   byMonth / byYear / allTime   spend over time
//   byCustomer                   spend per client, against what that client
//                                spends with us
//   byOrg                        spend per RECIPIENT, whether or not they buy
//                                anything from us. Most donations go to
//                                organisations that are not clients, so the
//                                client table alone never answered "who did we
//                                give to".
//   byCause / byMission          spend per organisation type and per mission
//                                fit: the "what causes" question. Both are
//                                human classifications, so anything nobody has
//                                classified is reported under `unclassified`
//                                rather than dropped, or the biggest bucket
//                                would be the invisible one.
//   ledger                       one row per recorded donation, newest first,
//                                for reading and exporting.
//
// THE RATIO IS THE POINT. A donation to an organisation that buys nothing from
// P&M is charity, and it should be. A donation to a client who spends fifty
// thousand a year is closer to a marketing cost. Both are legitimate; they are
// just different decisions, and the ratio is what tells them apart. It is
// deliberately shown as a share of revenue rather than a pass/fail threshold,
// because where the line sits is Ryan's call, not the software's.
//
// COST IS THE DEFAULT MEASURE. Retail value is what the goods would have sold
// for and is the right number for a donation receipt. Cost is what P&M
// actually gave up, and is the honest figure to weigh against revenue.

const money = (v) => {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};

/** YYYY-MM for a request's spend, preferring the recorded fulfilment date. */
function bucketMonth(row) {
  const f = row.fulfillment || {};
  const iso = f.fulfilledAt || row.decidedAt || row.updatedAt || row.submittedAt;
  if (!iso) return null;
  const s = String(iso).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

/**
 * Roll up every approved request that has a recorded amount.
 *
 * An approved request with nothing recorded yet is counted separately as
 * `unrecorded`, so a blank month reads as "nobody filled it in" rather than
 * "we gave nothing away".
 */
export function summarise(requests, opts) {
  const rows = Array.isArray(requests) ? requests : [];
  const options = opts || {};

  const byMonth = {};
  const byYear = {};
  const byCustomer = {};
  const byOrg = {};
  const byCause = {};
  const byMission = {};
  const ledger = [];
  const allTime = { retail: 0, cost: 0, count: 0 };

  let unrecorded = 0;

  // Add one donation to a named bucket. Used for orgs, org types and mission
  // fits, all of which are the same shape.
  const addTo = (map, key, label, retail, cost) => {
    if (!map[key]) map[key] = { key, label, retail: 0, cost: 0, count: 0 };
    map[key].retail += retail;
    map[key].cost += cost;
    map[key].count++;
  };

  rows.forEach((row) => {
    if (row.status !== "approved") return;

    const f = row.fulfillment || {};
    const retail = money(f.retailValue);
    const cost = money(f.cost);

    if (!f.retailValue && !f.cost) {
      unrecorded++;
      return;
    }

    const month = bucketMonth(row);
    const year = month ? month.slice(0, 4) : null;

    if (month) {
      if (!byMonth[month]) byMonth[month] = { retail: 0, cost: 0, count: 0 };
      byMonth[month].retail += retail;
      byMonth[month].cost += cost;
      byMonth[month].count++;
    }

    if (year) {
      if (!byYear[year]) byYear[year] = { retail: 0, cost: 0, count: 0 };
      byYear[year].retail += retail;
      byYear[year].cost += cost;
      byYear[year].count++;
    }

    allTime.retail += retail;
    allTime.cost += cost;
    allTime.count++;

    const req = row.request || {};
    const acctFor = row.account || {};

    // WHO GOT IT. Keyed on the organisation's own name, lowercased, so the
    // same org across two requests is one line. Not keyed on the matched
    // customer id: most recipients are not customers, and the ones that are
    // already have the client table.
    const orgName = String(req.orgName || "").trim();
    if (orgName) {
      addTo(byOrg, orgName.toLowerCase(), orgName, retail, cost);
      const o = byOrg[orgName.toLowerCase()];
      if (acctFor.found && acctFor.customerId) {
        o.customerId = String(acctFor.customerId);
        o.clientName = acctFor.name || orgName;
      }
    }

    // WHAT CAUSE. Both of these are set by a human in the app, and plenty of
    // older rows never were. Counting an unclassified row as nothing would
    // make the totals under each cause quietly disagree with the totals up
    // top, so they get their own bucket and the screen says how many.
    addTo(byCause, req.orgType || "unclassified", req.orgType || "unclassified", retail, cost);
    addTo(byMission, req.missionFit || "unclassified", req.missionFit || "unclassified", retail, cost);

    ledger.push({
      id: row.id,
      date: f.fulfilledAt || row.decidedAt || null,
      org: orgName,
      event: req.eventName || "",
      orgType: req.orgType || null,
      missionFit: req.missionFit || null,
      city: req.city || "",
      state: req.state || "",
      pieces: req.pieceCount == null ? null : req.pieceCount,
      client: acctFor.found ? (acctFor.name || orgName) : null,
      customerId: acctFor.found && acctFor.customerId ? String(acctFor.customerId) : null,
      retail: retail,
      cost: cost,
      notes: f.notes || "",
      recordedBy: f.recordedBy || "",
      source: row.source || ""
    });

    // Per client. Only matched requests can be attributed; an unmatched org is
    // not a customer, so it belongs in allTime but not in the client view.
    const acct = row.account || {};
    if (acct.found && acct.customerId) {
      const key = String(acct.customerId);
      if (!byCustomer[key]) {
        byCustomer[key] = {
          customerId: key,
          name: acct.name || row.request.orgName || "",
          tier: acct.tier || null,
          retail: 0,
          cost: 0,
          count: 0,
          lifetimeRevenue: money(acct.lifetimeRevenue),
          ytdRevenue: money(acct.ytdRevenue),
          requests: []
        };
      }
      const c = byCustomer[key];
      c.retail += retail;
      c.cost += cost;
      c.count++;
      c.requests.push({
        id: row.id,
        org: row.request.orgName,
        event: row.request.eventName || "",
        date: f.fulfilledAt || null,
        retail: retail,
        cost: cost,
        notes: f.notes || ""
      });
      // Keep the freshest revenue figures we have seen for this client.
      if (money(acct.lifetimeRevenue) > c.lifetimeRevenue) {
        c.lifetimeRevenue = money(acct.lifetimeRevenue);
      }
      if (money(acct.ytdRevenue) > c.ytdRevenue) {
        c.ytdRevenue = money(acct.ytdRevenue);
      }
    }
  });

  // Share of revenue, per client. Null rather than zero when there is no
  // revenue to divide by: "no basis to compare" is not "zero percent".
  const clients = Object.values(byCustomer).map((c) => {
    const basis = options.basis === "ytd" ? c.ytdRevenue : c.lifetimeRevenue;
    const spend = options.measure === "retail" ? c.retail : c.cost;
    return Object.assign({}, c, {
      revenueBasis: basis,
      shareOfRevenue: basis > 0 ? spend / basis : null
    });
  });

  const sortKey = options.measure === "retail" ? "retail" : "cost";
  clients.sort((a, b) => b[sortKey] - a[sortKey]);

  const biggestFirst = (map) =>
    Object.values(map).sort((a, b) => b[sortKey] - a[sortKey] || b.count - a.count);

  // Newest first, and rows with no date last rather than first: an undated row
  // sorted to the top reads as the most recent thing we did.
  ledger.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

  return {
    allTime,
    byMonth,
    byYear,
    clients,
    orgs: biggestFirst(byOrg),
    causes: biggestFirst(byCause),
    missions: biggestFirst(byMission),
    ledger,
    unclassified: (byCause.unclassified && byCause.unclassified.count) || 0,
    unrecorded,
    approved: rows.filter((r) => r.status === "approved").length
  };
}

/** Months in range, oldest first, with gaps filled so a chart has no holes. */
export function monthSeries(byMonth, months) {
  const keys = Object.keys(byMonth || {}).sort();
  if (!keys.length) return [];

  const out = [];
  const end = new Date(keys[keys.length - 1] + "-01T00:00:00Z");
  const count = months || 12;

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const v = byMonth[key] || { retail: 0, cost: 0, count: 0 };
    out.push({ month: key, retail: v.retail, cost: v.cost, count: v.count });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * EXPORT
 *
 * The ledger as a CSV, for a board report or an accountant who wants the
 * list rather than the screen. Built here rather than in the app so the
 * tests call the real thing, and so the same file comes out of any caller.
 * ------------------------------------------------------------------ */

export const LEDGER_COLUMNS = [
  "Date", "Organisation", "Event", "Org type", "Mission fit", "City", "State",
  "Pieces", "Client", "Retail value", "Our cost", "Recorded by", "Notes", "Request",
];

function csvCell(v) {
  const s = String(v == null ? "" : v);
  // A leading =, +, - or @ is run as a formula when Excel opens the file, and
  // organisation names and notes are typed by other people. Prefixed rather
  // than trusted.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * @param ledger   rows from summarise().ledger
 * @param labels   { orgType: {key:label}, missionFit: {key:label} } so the file
 *                 says "School or district" rather than "school". Optional:
 *                 without it the raw keys are written, which is still true.
 */
export function buildLedgerCsv(ledger, labels) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const l = labels || {};
  const orgLabels = l.orgType || {};
  const missionLabels = l.missionFit || {};

  const lines = [LEDGER_COLUMNS.join(",")];
  rows.forEach((r) => {
    lines.push([
      r.date ? String(r.date).slice(0, 10) : "",
      r.org || "",
      r.event || "",
      r.orgType ? (orgLabels[r.orgType] || r.orgType) : "Not classified",
      r.missionFit ? (missionLabels[r.missionFit] || r.missionFit) : "Not classified",
      r.city || "",
      r.state || "",
      r.pieces == null ? "" : r.pieces,
      // Blank, not "none": an org that is not a client has no client, and
      // writing a word there reads as a name.
      r.client || "",
      Number(r.retail || 0).toFixed(2),
      Number(r.cost || 0).toFixed(2),
      r.recordedBy || "",
      r.notes || "",
      r.id || "",
    ].map(csvCell).join(","));
  });

  return lines.join("\r\n") + "\r\n";
}
