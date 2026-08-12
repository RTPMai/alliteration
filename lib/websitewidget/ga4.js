// lib/websitewidget/ga4.js — Google Analytics 4 Data API client.
//
// No npm dependency for this. A service-account login is just a signed JWT
// traded for an access token, and Node's built-in crypto module can sign
// RS256 without pulling in googleapis (which would drag in a lot of weight
// for three fields we actually read). Same "no build step, few real
// dependencies" rule the rest of the repo follows.
//
// THREE ENV VARS, all set in Vercel, none of them touch Settings or KV:
//   GA4_PROPERTY_ID              numeric GA4 property id, e.g. "123456789"
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
//   3. In GA4 (analytics.google.com) -> Admin -> Property Access Management
//      for the PMApparel.com property -> add the service account's email
//      as a Viewer.
//   4. Put the property id, client_email, and private_key from the JSON key
//      into the three Vercel env vars above.
//
// Until those are set, isConfigured() returns false and the app shows a
// plain "not connected yet" state instead of any invented numbers.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

function creds() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const clientEmail = process.env.GA4_CLIENT_EMAIL;
  let privateKey = process.env.GA4_PRIVATE_KEY;
  if (!propertyId || !clientEmail || !privateKey) return null;
  if (privateKey.indexOf("\\n") !== -1) privateKey = privateKey.replace(/\\n/g, "\n");
  return { propertyId, clientEmail, privateKey };
}

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
// hot loop.
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

async function runReport(body) {
  const { propertyId } = creds();
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
    throw new Error(`GA4 runReport failed (${res.status}): ${text.slice(0, 300)}`);
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
 * Pulls everything the WebsiteWidget dashboard needs in four small reports:
 * totals, a daily trend, traffic channels, and top pages. Four calls instead
 * of one wide one because GA4's Data API caps dimensions per request and
 * mixing a date-series with a breakdown produces an awkward cross-product;
 * four narrow reports are easier to read and to test than one wide one.
 *
 * `days` controls the date range (site defaults to 30).
 */
export async function fetchSiteStats(days = 30) {
  const dateRange = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  const [totalsReport, trendReport, channelReport, pagesReport] = await Promise.all([
    runReport({
      dateRanges: dateRange,
      metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "screenPageViews" }]
    }),
    runReport({
      dateRanges: dateRange,
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }]
    }),
    runReport({
      dateRanges: dateRange,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8
    }),
    runReport({
      dateRanges: dateRange,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10
    })
  ]);

  const totalsRow = rowsToObjects(totalsReport)[0] || {};
  const trend = rowsToObjects(trendReport).map((r) => ({
    date: r.date, // YYYYMMDD, formatted client-side
    sessions: r.sessions || 0,
    users: r.activeUsers || 0
  }));
  const channels = rowsToObjects(channelReport).map((r) => ({
    channel: r.sessionDefaultChannelGroup || "(unassigned)",
    sessions: r.sessions || 0
  }));
  const topPages = rowsToObjects(pagesReport).map((r) => ({
    path: r.pagePath || "/",
    views: r.screenPageViews || 0
  }));

  return {
    days,
    totals: {
      activeUsers: totalsRow.activeUsers || 0,
      newUsers: totalsRow.newUsers || 0,
      sessions: totalsRow.sessions || 0,
      pageViews: totalsRow.screenPageViews || 0
    },
    trend,
    channels,
    topPages
  };
}
