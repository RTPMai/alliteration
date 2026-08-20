// lib/websitewidget/ga4.js — Google Analytics 4 Data API client.
//
// No npm dependency for this. A service-account login is just a signed JWT
// traded for an access token, and Node's built-in crypto module can sign
// RS256 without pulling in googleapis (which would drag in a lot of weight
// for three fields we actually read). Same "no build step, few real
// dependencies" rule the rest of the repo follows.
//
// ONE SERVICE ACCOUNT, MANY SITES. A single Google Cloud service account can
// read any number of GA4 properties, as long as it is added as a Viewer on
// each one separately (in that property's Admin -> Property Access
// Management, in analytics.google.com). So the service account's own login
// stays a pair of env vars, but WHICH property to read is no longer one of
// them — it is looked up per request from the sites list in
// lib/websitewidget/sites-store.js, which is admin-editable from the app's
// Settings view without a redeploy.
//
// TWO ENV VARS, set once in Vercel, cover every site:
//   GA4_CLIENT_EMAIL             the service account's client_email
//   GA4_PRIVATE_KEY              the service account's private_key (PEM).
//                                Paste it with real newlines in Vercel's env
//                                var editor; if it ends up escaped as \n
//                                (common when pasted as a single line), this
//                                file unescapes it.
//
// Setup, once, outside this codebase:
//   1. Google Cloud Console -> new (or existing) project -> enable the
//      "Google Analytics Data API".
//   2. Create a service account, create a JSON key for it.
//   3. Put client_email and private_key from that JSON key into the two
//      Vercel env vars above.
//   4. For EACH site you want data for: in that site's GA4 property, under
//      Admin -> Property Access Management, add the service account's
//      email as a Viewer. Then add the site (its property id) from the
//      WebsiteWidget Settings view in the app — no further deploy needed.
//
// Until the two env vars are set, isConfigured() returns false and the app
// shows a plain "not connected yet" state instead of any invented numbers,
// regardless of how many sites are on the list.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

// Every date sent to GA4 is a plain YYYY-MM-DD read in the property's own
// reporting timezone. All three P&M properties are Iowa businesses, so we
// compute windows in America/Chicago rather than the server's UTC. Same
// reasoning as CrewCore's time clock: store UTC, decide in Central. At
// 00:30 UTC it is still the previous afternoon in Iowa, and asking GA4 for
// "yesterday" off a UTC clock would land on a day that is still in progress.
const REPORT_TZ = "America/Chicago";

export const COMPARE_MODES = ["none", "previous", "year"];

// Today's date in the reporting timezone, as YYYY-MM-DD. en-CA formats that
// way natively, which avoids hand-assembling the parts.
function todayInReportTz(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now || new Date());
}

// Day arithmetic anchored at UTC noon. Anchoring at midnight would let a
// daylight-saving shift push a date across a boundary and silently drop or
// repeat a day in the middle of a range; noon leaves twelve hours of slack
// in both directions, so no DST change can reach it.
function shiftDays(ymd, delta) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const anchored = new Date(Date.UTC(y, m - 1, d, 12));
  return new Date(anchored.getTime() + delta * 86400000).toISOString().slice(0, 10);
}

/**
 * The date windows a comparison report runs over.
 *
 * TODAY IS DELIBERATELY EXCLUDED. A window ending "today" is a part-day: at
 * 9 AM it holds maybe a tenth of a day's traffic. Measured against a full
 * prior period that reads as a double-digit drop that is not real, and on a
 * 7-day range a missing day is a seventh of the total. Both sides of a
 * comparison have to be whole days or the percentage is fiction. GA4 also
 * keeps reprocessing the current day for hours after the fact, so today's
 * figure is not final anyway.
 *
 * LAST YEAR SHIFTS BACK 364 DAYS, NOT 365. 364 is exactly 52 weeks, so
 * every day lands on the same weekday it is being compared with. Web
 * traffic is strongly weekly (a B2B apparel site is quiet at weekends), and
 * a 365-day shift slides the window by one weekday, which quietly swaps a
 * Saturday into the window for a Monday. The date labels move by a day; the
 * shape of the week does not.
 *
 * @param {number} days      length of the window (7, 30, 90)
 * @param {string} compare   "none" | "previous" | "year"
 * @param {Date}   now       injectable for tests
 */
export function periodWindows(days, compare = "none", now = undefined) {
  const n = Number(days) > 0 ? Math.floor(Number(days)) : 30;
  const mode = COMPARE_MODES.includes(compare) ? compare : "none";

  const endDate = shiftDays(todayInReportTz(now), -1); // yesterday, last complete day
  const startDate = shiftDays(endDate, -(n - 1));
  const current = { startDate, endDate };

  if (mode === "none") return { days: n, compare: mode, current, prior: null };

  let prior;
  if (mode === "previous") {
    const priorEnd = shiftDays(startDate, -1);
    prior = { startDate: shiftDays(priorEnd, -(n - 1)), endDate: priorEnd };
  } else {
    prior = { startDate: shiftDays(startDate, -364), endDate: shiftDays(endDate, -364) };
  }

  return { days: n, compare: mode, current, prior };
}

/**
 * One metric's movement between two periods.
 *
 * A zero baseline returns pct: null, not a number. Dividing by zero gives
 * either infinity or a fabricated 100%, and on a dashboard both read as a
 * measured fact. "No baseline" is the true answer and the screen can say so.
 */
export function deltaOf(current, prior) {
  const c = Number(current || 0);
  const p = Number(prior || 0);
  const diff = c - p;
  if (p === 0) {
    return { current: c, prior: p, diff, pct: null, basis: c === 0 ? "flat" : "no-baseline" };
  }
  return { current: c, prior: p, diff, pct: (diff / p) * 100, basis: "ok" };
}

/**
 * Attaches prior-period figures to a breakdown (channels, top pages).
 *
 * A key with no prior row gets prior: null and delta: null, NOT prior zero.
 * The prior pull is filtered to the keys the current period surfaced, so a
 * missing row means GA4 returned nothing for that key in that window, which
 * for a page created last month is genuinely "did not exist", not "had zero
 * views". Folding unknowns in as zero produces a confident -100% that is
 * wrong, the same trap MarketMachine's rollups avoid.
 */
export function compareSeries(currentRows, priorRows, keyField, valueField) {
  const priorMap = new Map();
  (priorRows || []).forEach((r) => { priorMap.set(r[keyField], Number(r[valueField] || 0)); });

  return (currentRows || []).map((row) => {
    if (!priorMap.has(row[keyField])) return { ...row, prior: null, delta: null };
    const priorValue = priorMap.get(row[keyField]);
    return { ...row, prior: priorValue, delta: deltaOf(row[valueField], priorValue) };
  });
}

function creds() {
  const clientEmail = process.env.GA4_CLIENT_EMAIL;
  let privateKey = process.env.GA4_PRIVATE_KEY;
  if (!clientEmail || !privateKey) return null;
  if (privateKey.indexOf("\\n") !== -1) privateKey = privateKey.replace(/\\n/g, "\n");
  return { clientEmail, privateKey };
}

// True once the shared service account is set up. Says nothing about
// whether any particular site's property id has been added yet or granted
// that account Viewer access — those are per-site concerns, checked by
// runReport() actually trying the call.
export function isConfigured() {
  return creds() !== null;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Builds and signs the JWT assertion, trades it for a bearer token. Tokens
// last an hour; callers get a fresh one per cold start rather than caching
// across invocations, since a dashboard load is a handful of calls, not a
// hot loop. One token is valid for every property the service account can
// see, so this is not repeated per site.
async function getAccessToken() {
  const { clientEmail, privateKey } = creds();
  const crypto = await import("crypto");

  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };

  const signingInput = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claim));
  const signature = crypto.default
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const assertion = signingInput + "." + signature;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GA4 auth failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  if (!body.access_token) throw new Error("GA4 auth response had no access_token");
  return body.access_token;
}

async function runReport(propertyId, body) {
  const token = await getAccessToken();

  const res = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A very common first-time mistake is adding a site's property id before
    // granting the service account Viewer access on it. Surface that
    // distinctly since "403" alone is not a clear enough message to act on.
    if (res.status === 403) {
      throw new Error(
        `GA4 denied access to property ${propertyId} (403). The service account ` +
        `most likely has not been added as a Viewer on this property yet.`
      );
    }
    throw new Error(`GA4 runReport failed (${res.status}) for property ${propertyId}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

function rowsToObjects(report) {
  const dimHeaders = (report.dimensionHeaders || []).map((h) => h.name);
  const metHeaders = (report.metricHeaders || []).map((h) => h.name);
  return (report.rows || []).map((row) => {
    const out = {};
    (row.dimensionValues || []).forEach((v, i) => { out[dimHeaders[i]] = v.value; });
    (row.metricValues || []).forEach((v, i) => { out[metHeaders[i]] = Number(v.value); });
    return out;
  });
}

/**
 * GA4 returns NO ROW for a day with no sessions. A quiet Sunday does not come
 * back as zero, it simply is not in the response.
 *
 * Left alone that does two bad things. The chart silently drops the day, so a
 * seven day window draws six bars and the flat spot that is the actual news
 * becomes invisible. Worse, the comparison overlay pairs the two periods by
 * position, so one missing day shifts every bar after it and a Monday ends up
 * measured against a Sunday. That defeats the 364-day weekday alignment the
 * year comparison goes to the trouble of getting right.
 *
 * So the series is made dense here, at the seam with GA4, rather than patched
 * over in the view. A zero we filled in is a real fact: GA4 was asked about
 * that date and had nothing, which for a traffic count does mean none. That is
 * different from the top-pages case, where an absent row means "not in the top
 * ten", not "zero", and is deliberately left null.
 */
export function fillTrendGaps(rows, window) {
  const byDate = new Map();
  (rows || []).forEach((r) => { byDate.set(r.date, r); });

  const out = [];
  const [ey, em, ed] = window.endDate.split("-").map(Number);
  const end = Date.UTC(ey, em - 1, ed, 12);
  const [sy, sm, sd] = window.startDate.split("-").map(Number);

  for (let t = Date.UTC(sy, sm - 1, sd, 12); t <= end; t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const compact = iso.replace(/-/g, ""); // GA4's row keys are YYYYMMDD
    const hit = byDate.get(compact);
    out.push(hit || { date: compact, sessions: 0, users: 0 });
  }
  return out;
}

/**
 * THE BREAKDOWN CATALOGUE.
 *
 * Every "dimension against a metric" card on the dashboard is one entry here
 * rather than a hand-written report, so adding a card is a row in this table
 * and the fetching, comparison and error handling come for free.
 *
 *   dims   GA4 dimension names. Two of them (city + region) when the first is
 *          ambiguous on its own.
 *   metric the GA4 metric to rank and show.
 *   key    what the shaped row calls its label field.
 *   value  what the shaped row calls its number field.
 *   label  the card heading in the UI.
 *
 * A NOTE ON THE NAMES. These were written against Google's published
 * dimension list, not against a live call, because this codebase has no way
 * to reach GA4 from a test. If Google has renamed one, that single card
 * reports itself as failed and everything else on the page still works. See
 * runSection below for why that is not the same as the old behaviour.
 */
export const BREAKDOWNS = {
  channels: {
    dims: ["sessionDefaultChannelGroup"], metric: "sessions",
    key: "channel", value: "sessions", limit: 8, label: "Traffic source"
  },
  topPages: {
    dims: ["pagePath"], metric: "screenPageViews",
    key: "path", value: "views", limit: 10, label: "Top pages"
  },
  landingPages: {
    dims: ["landingPage"], metric: "sessions",
    key: "path", value: "sessions", limit: 10, label: "Where visits start"
  },
  devices: {
    dims: ["deviceCategory"], metric: "sessions",
    key: "device", value: "sessions", limit: 5, label: "Phone or computer"
  },
  visitorType: {
    dims: ["newVsReturning"], metric: "sessions",
    key: "type", value: "sessions", limit: 4, label: "New or returning"
  },
  places: {
    dims: ["city", "region"], metric: "sessions",
    key: "place", value: "sessions", limit: 10, label: "Where visitors are"
  },
  events: {
    dims: ["eventName"], metric: "eventCount",
    key: "event", value: "count", limit: 12, label: "What people do"
  }
};

// Engagement figures live in their own small report rather than being bolted
// onto the main totals. If one of these metric names is wrong the four
// headline numbers still render; folding them in would have taken the whole
// KPI row down with them.
const ENGAGEMENT_METRICS = ["engagementRate", "averageSessionDuration", "screenPageViewsPerSession"];

/**
 * Runs one report and returns an OUTCOME, never throws.
 *
 * This is the whole reason the dashboard can carry cards built on dimension
 * names nobody here can verify. Previously all four reports went through
 * Promise.all, which rejects the moment any one of them does, so a single
 * bad name blanked the entire page and the error said nothing about which
 * report caused it. Now a failed section is a labelled hole in an otherwise
 * working dashboard, and the message names the section.
 */
async function runSection(propertyId, body) {
  try {
    return { ok: true, report: await runReport(propertyId, body) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// GA4 allows a limited number of concurrent requests per property, and this
// now fires ten reports per window, twenty when comparing. Firing them all at
// once risks being throttled into failures that look like bugs, so they go in
// small waves instead. The ten minute cache means this runs rarely enough
// that the extra round trips cost nothing anyone will notice.
async function inWaves(tasks, size = 4) {
  const out = [];
  for (let i = 0; i < tasks.length; i += size) {
    out.push(...(await Promise.all(tasks.slice(i, i + size).map((t) => t()))));
  }
  return out;
}

function shapeBreakdown(spec, report) {
  return rowsToObjects(report).map((r) => {
    // Multi-dimension rows join their parts into one label, so "Ankeny" and
    // "Iowa" read as "Ankeny, Iowa" and two Springfields stay distinguishable.
    const label = spec.dims
      .map((d) => r[d])
      .filter((v) => v && v !== "(not set)")
      .join(", ");
    return { [spec.key]: label || "(not set)", [spec.value]: r[spec.metric] || 0 };
  });
}

/**
 * One window's worth of dashboard data.
 *
 * `keyFilters` narrows each breakdown to a named set of keys. The prior
 * period uses it so the comparison lines up row for row with what the current
 * period actually surfaced, instead of pulling its own separate top ten and
 * leaving half the rows with nothing to compare against.
 */
async function fetchWindow(propertyId, window, keyFilters = null) {
  const dateRanges = [{ startDate: window.startDate, endDate: window.endDate }];

  const totalsTask = () => runSection(propertyId, {
    dateRanges,
    metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "screenPageViews" }]
  });

  const trendTask = () => runSection(propertyId, {
    dateRanges,
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }],
    orderBys: [{ dimension: { dimensionName: "date" } }]
  });

  const engagementTask = () => runSection(propertyId, {
    dateRanges,
    metrics: ENGAGEMENT_METRICS.map((name) => ({ name }))
  });

  const names = Object.keys(BREAKDOWNS);
  const breakdownTasks = names.map((name) => () => {
    const spec = BREAKDOWNS[name];
    const body = {
      dateRanges,
      dimensions: spec.dims.map((d) => ({ name: d })),
      metrics: [{ name: spec.metric }],
      orderBys: [{ metric: { metricName: spec.metric }, desc: true }],
      limit: spec.limit
    };
    // Only the FIRST dimension is filtered. Filtering on a joined label would
    // need a filter GA4 has no expression for, and the first dimension is the
    // identifying one in every entry above.
    const wanted = keyFilters && keyFilters[name];
    if (wanted && wanted.length) {
      body.dimensionFilter = { filter: { fieldName: spec.dims[0], inListFilter: { values: wanted } } };
      body.limit = Math.max(wanted.length, 1);
    }
    return runSection(propertyId, body);
  });

  const results = await inWaves([totalsTask, trendTask, engagementTask, ...breakdownTasks]);
  const [totalsRes, trendRes, engagementRes, ...breakdownRes] = results;

  const totalsRow = totalsRes.ok ? (rowsToObjects(totalsRes.report)[0] || {}) : {};
  const engRow = engagementRes.ok ? (rowsToObjects(engagementRes.report)[0] || {}) : {};

  const out = {
    totals: {
      activeUsers: totalsRow.activeUsers || 0,
      newUsers: totalsRow.newUsers || 0,
      sessions: totalsRow.sessions || 0,
      pageViews: totalsRow.screenPageViews || 0
    },
    engagement: engagementRes.ok
      ? {
          engagementRate: engRow.engagementRate || 0,
          avgSessionSeconds: engRow.averageSessionDuration || 0,
          pagesPerSession: engRow.screenPageViewsPerSession || 0
        }
      : null,
    trend: trendRes.ok
      ? fillTrendGaps(
          rowsToObjects(trendRes.report).map((r) => ({
            date: r.date, // YYYYMMDD, formatted client-side
            sessions: r.sessions || 0,
            users: r.activeUsers || 0
          })),
          window
        )
      : [],
    // Which sections could not be read, so the view can show a labelled hole
    // rather than an empty card that looks like "no traffic".
    failed: {}
  };

  if (!totalsRes.ok) out.failed.totals = totalsRes.error;
  if (!trendRes.ok) out.failed.trend = trendRes.error;
  if (!engagementRes.ok) out.failed.engagement = engagementRes.error;

  names.forEach((name, i) => {
    const res = breakdownRes[i];
    if (res.ok) {
      out[name] = shapeBreakdown(BREAKDOWNS[name], res.report);
    } else {
      out[name] = [];
      out.failed[name] = res.error;
    }
  });

  return out;
}

/**
 * Everything the WebsiteWidget dashboard needs for ONE site's GA4 property,
 * optionally alongside a comparison period.
 *
 * `compare` is "none", "previous" (the matching window immediately before)
 * or "year" (the same window 52 weeks back). When it is not "none" the
 * prior window is fetched SECOND, not in parallel, because its channel and
 * page reports are filtered to the keys the current window returned. One
 * extra round trip buys a row-for-row comparison instead of two unrelated
 * top-ten lists.
 */
export async function fetchSiteStats(propertyId, days = 30, compare = "none") {
  if (!propertyId) throw new Error("fetchSiteStats requires a propertyId");

  const windows = periodWindows(days, compare);
  const current = await fetchWindow(propertyId, windows.current);
  const names = Object.keys(BREAKDOWNS);

  const base = {
    days: windows.days,
    compare: windows.compare,
    period: windows.current,
    priorPeriod: windows.prior,
    totals: current.totals,
    engagement: current.engagement,
    trend: current.trend,
    priorTotals: null,
    priorEngagement: null,
    priorTrend: null,
    deltas: null,
    engagementDeltas: null,
    failed: current.failed
  };
  names.forEach((n) => { base[n] = current[n]; });

  if (!windows.prior) return base;

  // Ask the prior window only about the keys this window actually surfaced,
  // so every row has something real to compare against.
  const keyFilters = {};
  names.forEach((n) => { keyFilters[n] = (current[n] || []).map((r) => r[BREAKDOWNS[n].key]); });

  const prior = await fetchWindow(propertyId, windows.prior, keyFilters);

  const out = {
    ...base,
    priorTotals: prior.totals,
    priorEngagement: prior.engagement,
    priorTrend: prior.trend,
    deltas: {
      activeUsers: deltaOf(current.totals.activeUsers, prior.totals.activeUsers),
      newUsers: deltaOf(current.totals.newUsers, prior.totals.newUsers),
      sessions: deltaOf(current.totals.sessions, prior.totals.sessions),
      pageViews: deltaOf(current.totals.pageViews, prior.totals.pageViews)
    },
    // Engagement compares only when BOTH windows returned it. Measuring a
    // real rate against a missing one would read as a collapse to zero.
    engagementDeltas: current.engagement && prior.engagement
      ? {
          engagementRate: deltaOf(current.engagement.engagementRate, prior.engagement.engagementRate),
          avgSessionSeconds: deltaOf(current.engagement.avgSessionSeconds, prior.engagement.avgSessionSeconds),
          pagesPerSession: deltaOf(current.engagement.pagesPerSession, prior.engagement.pagesPerSession)
        }
      : null
  };

  names.forEach((n) => {
    const spec = BREAKDOWNS[n];
    out[n] = compareSeries(current[n], prior[n], spec.key, spec.value);
  });

  return out;
}

/**
 * Tests one property id without touching the sites list, so a property can
 * be checked before or after it is saved.
 *
 * Returns a STATUS, never throws. The three failures worth telling apart:
 * the shared service account is not set up at all, the property id does not
 * exist, and the property exists but has not granted this service account
 * Viewer access. They look identical on a dashboard that only says "error",
 * and each one is a different fix in a different place.
 *
 * On success it reports the property's own reporting timezone and 28 days
 * of sessions, which is how you confirm the id points at the site you meant
 * rather than at some other property the account can also read.
 */
export async function probeProperty(propertyId) {
  if (!isConfigured()) {
    return {
      ok: false,
      status: "no-credentials",
      message: "GA4_CLIENT_EMAIL and GA4_PRIVATE_KEY are not set in Vercel yet, so no property can be read."
    };
  }
  if (!propertyId || !String(propertyId).trim()) {
    return { ok: false, status: "no-property-id", message: "Enter a GA4 property ID first." };
  }

  const id = String(propertyId).trim();
  try {
    const report = await runReport(id, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }]
    });
    const row = rowsToObjects(report)[0] || {};
    return {
      ok: true,
      status: "connected",
      propertyId: id,
      sessions28d: row.sessions || 0,
      timeZone: (report.metadata && report.metadata.timeZone) || null,
      serviceAccount: process.env.GA4_CLIENT_EMAIL || null,
      message: `Connected. ${Number(row.sessions || 0).toLocaleString("en-US")} sessions in the last 28 days.`
    };
  } catch (e) {
    const text = String(e && e.message ? e.message : e);
    if (text.includes("(403)") || text.includes("denied access")) {
      return {
        ok: false,
        status: "no-access",
        propertyId: id,
        serviceAccount: process.env.GA4_CLIENT_EMAIL || null,
        // The address is carried in serviceAccount and rendered on its own
        // line by the settings view, so repeating it mid-sentence just reads
        // as a stutter.
        message:
          `Property ${id} exists but has not granted access yet. In analytics.google.com ` +
          `open Admin, then Property Access Management, and add this address as a Viewer:`
      };
    }
    if (text.includes("(404)")) {
      return {
        ok: false,
        status: "not-found",
        propertyId: id,
        message: `No GA4 property with ID ${id}. Check Admin, then Property details, for the right number.`
      };
    }
    return { ok: false, status: "error", propertyId: id, message: text };
  }
}
