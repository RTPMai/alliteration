// lib/giving-summary.js — what we gave, when, and to whom.
//
// Rolls approved requests up three ways:
//
//   byMonth / byYear / allTime   spend over time
//   byCustomer                   spend per client, against what that client
//                                spends with us
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
  const allTime = { retail: 0, cost: 0, count: 0 };

  let unrecorded = 0;

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

  return {
    allTime,
    byMonth,
    byYear,
    clients,
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
