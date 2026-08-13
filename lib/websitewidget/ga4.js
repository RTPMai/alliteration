// PUT IN: lib/websitewidget/ga4.js (REPLACES the current one)
// (this banner line is for verification only, delete it after checking the path)

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
 * Pulls everything the WebsiteWidget dashboard needs for ONE site's GA4
 * property, in four small reports: totals, a daily trend, traffic channels,
 * and top pages. Four calls instead of one wide one because GA4's Data API
 * caps dimensions per request and mixing a date-series with a breakdown
 * produces an awkward cross-product; four narrow reports are easier to read
 * and to test than one wide one.
 *
 * `propertyId` selects which site (see lib/websitewidget/sites-store.js).
 * `days` controls the date range (default 30).
 */
export async function fetchSiteStats(propertyId, days = 30) {
  if (!propertyId) throw new Error("fetchSiteStats requires a propertyId");
  const dateRange = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  const [totalsReport, trendReport, channelReport, pagesReport] = await Promise.all([
    runReport(propertyId, {
      dateRanges: dateRange,
      metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "screenPageViews" }]
    }),
    runReport(propertyId, {
      dateRanges: dateRange,
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }]
    }),
    runReport(propertyId, {
      dateRanges: dateRange,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8
    }),
    runReport(propertyId, {
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
