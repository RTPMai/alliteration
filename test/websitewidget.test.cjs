// apps/websitewidget.js
/**
 * WebsiteWidget — web analytics across every site P&M tracks.
 *
 * Real build, Aug 2026, extended the same month to support more than one
 * site: PMApparel.com, IowaOnDemand.com, and Flyover Con all read from the
 * same shared GA4 service account (one login can read many properties, as
 * long as it's granted Viewer on each). Which sites exist lives in
 * lib/websitewidget/sites-store.js, editable from the Manage Sites view
 * below — adding a new site is a Settings action, not a redeploy.
 *
 * Two views:
 *   dashboard      site tabs across the top, then the same visitor/session/
 *                  channel/top-pages dashboard as before, per selected site.
 *   settings       add, rename, or remove sites. Admin/superuser only —
 *                  this changes what the whole team's dashboard reads from.
 *
 * NOT CONFIGURED state: the API always answers 200, never an error, even
 * before the GA4 service account is wired up (see lib/websitewidget/ga4.js
 * for the two env vars needed) or before any site has been added. When
 * `configured` comes back false, this view shows a plain setup notice
 * instead of guessing at numbers.
 *
 * No fetch() here — everything goes through ctx.api and ENDPOINTS, per the
 * seam rule. No hex colors — tokens.css owns theming via data-app="websitewidget".
 */

import { ENDPOINTS } from '../js/api.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || '';
  const y = yyyymmdd.slice(0, 4), m = yyyymmdd.slice(4, 6), d = yyyymmdd.slice(6, 8);
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "2026-08-19" to "Aug 19". Separate from fmtDate, which takes GA4's
// compact YYYYMMDD row keys; these come off the period bounds, which are
// real ISO dates.
function fmtIso(iso) {
  if (!iso || iso.length !== 10) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtIsoYear(iso) {
  if (!iso || iso.length !== 10) return iso || '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// A delta renders as direction + magnitude. `basis` carries why a
// percentage might be absent: nothing to divide by, or nothing comparable
// found at all. Neither gets dressed up as a number.
function deltaClass(delta) {
  if (!delta || delta.pct === null) return 'unknown';
  if (Math.abs(delta.pct) < 0.05) return 'flat';
  return delta.pct > 0 ? 'up' : 'down';
}

function deltaText(delta) {
  if (!delta) return 'no comparison';
  if (delta.pct === null) return delta.basis === 'flat' ? 'none either way' : 'no baseline';
  if (Math.abs(delta.pct) < 0.05) return 'flat';
  const arrow = delta.pct > 0 ? '\u25B2' : '\u25BC';
  return arrow + ' ' + Math.abs(delta.pct).toFixed(1) + '%';
}

// GA4 gives engagement rate as a 0-1 fraction and session duration in
// seconds with a long decimal tail. Neither is readable raw.
function fmtPct(v) {
  return (Number(v || 0) * 100).toFixed(1) + '%';
}

function fmtDuration(seconds) {
  const s = Math.round(Number(seconds || 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

function fmtDecimal(v) {
  return Number(v || 0).toFixed(1);
}

// GA4's own event names are machine-shaped. These are the ones Enhanced
// Measurement turns on by default, given plain-English names. Anything not
// listed is shown as GA4 named it rather than guessed at.
const EVENT_LABELS = {
  page_view: 'Page views',
  session_start: 'Visits started',
  first_visit: 'First-time visits',
  user_engagement: 'Engaged with a page',
  scroll: 'Scrolled to the bottom',
  click: 'Clicked a link off-site',
  form_start: 'Started a form',
  form_submit: 'Submitted a form',
  file_download: 'Downloaded a file',
  video_start: 'Started a video',
  view_search_results: 'Searched the site'
};

const VISITOR_LABELS = { new: 'First time here', returning: 'Been here before' };
const DEVICE_LABELS = { desktop: 'Computer', mobile: 'Phone', tablet: 'Tablet', smart_tv: 'TV' };

const CHANNEL_LABELS = {
  'Organic Search': 'Organic search',
  'Direct': 'Direct',
  'Referral': 'Referral',
  'Organic Social': 'Social',
  'Paid Search': 'Paid search',
  'Email': 'Email',
  'Unassigned': 'Unassigned',
  '(unassigned)': 'Unassigned'
};

export default {
  id: 'websitewidget',

  styles: `
    .ww-page { padding: 24px 32px 60px; max-width: 1200px; }
    .ww-hd { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
    .ww-hd h1 { font-size: 28px; font-weight: 800; letter-spacing: -.02em; }
    .ww-hd .sub { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .ww-range { display: flex; gap: 6px; }
    .ww-range button, .ww-sitetabs button {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: 13px; font-weight: 600; color: var(--muted);
      cursor: pointer; font-family: inherit; transition: .12s;
    }
    .ww-range button:hover, .ww-sitetabs button:hover { color: var(--ink); }
    .ww-range button[aria-pressed="true"], .ww-sitetabs button[aria-pressed="true"] {
      background: var(--accent); border-color: var(--accent); color: var(--on-accent);
    }

    .ww-range button[data-busy="1"] { opacity: .55; cursor: default; }

    .ww-sitetabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 18px; }

    .ww-compare { display: flex; gap: 6px; }
    .ww-compare button {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: 13px; font-weight: 600; color: var(--muted);
      cursor: pointer; font-family: inherit; transition: .12s;
    }
    .ww-compare button:hover { color: var(--ink); }
    .ww-compare button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

    .ww-basis { font-size: 12px; color: var(--muted); margin-bottom: 16px; line-height: 1.5; }
    .ww-basis strong { color: var(--ink); font-weight: 600; }

    .ww-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .ww-kpi { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 16px 18px; }
    .ww-kpi .lbl { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .ww-kpi .val { font-size: 28px; font-weight: 800; letter-spacing: -.01em; margin-top: 4px; }

    /* Movement against the comparison period. Colour is a second signal, not
       the only one: the arrow carries the direction on its own for anyone who
       reads the two greens and reds the same way. */
    .ww-delta { display: flex; align-items: baseline; gap: 6px; margin-top: 8px; font-size: 12px; flex-wrap: wrap; }
    .ww-delta .pill {
      display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px;
      border-radius: var(--radius-pill); font-weight: 700; font-size: 11.5px;
    }
    .ww-delta .pill.up { background: var(--success-tint); color: var(--success-dk); }
    .ww-delta .pill.down { background: var(--danger-tint); color: var(--danger-dk); }
    .ww-delta .pill.flat, .ww-delta .pill.unknown { background: var(--bg); color: var(--muted); }
    .ww-delta .was { color: var(--muted); }

    .ww-trend-legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--muted); margin-bottom: 10px; align-items: center; }
    .ww-trend-legend .key { display: inline-flex; align-items: center; gap: 5px; }
    .ww-trend-legend .swatch { width: 10px; height: 10px; border-radius: 2px; }
    .ww-trend-legend .swatch.now { background: var(--accent); }
    .ww-trend-legend .swatch.was { background: var(--line); }

    /* The ghost sits behind the live bar and both scale to the same maximum,
       so the height difference on screen is the real difference. */
    .ww-trend .stack { position: relative; width: 100%; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .ww-trend .ghost {
      position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
      width: 100%; max-width: 18px; background: var(--line);
      border-radius: 3px 3px 0 0; min-height: 2px;
    }
    .ww-trend .bar { position: relative; z-index: 1; }

    .bar-row .cmp { width: 62px; text-align: right; font-size: 11.5px; font-weight: 700; flex: none; }
    .bar-row .cmp.up { color: var(--success-dk); }
    .bar-row .cmp.down { color: var(--danger-dk); }
    .bar-row .cmp.flat, .bar-row .cmp.unknown { color: var(--faint); }

    .ww-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; align-items: start; }
    @media (max-width: 860px) { .ww-grid { grid-template-columns: 1fr; } }

    .ww-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 18px 20px; margin-bottom: 16px; }
    .ww-card h2 { font-size: 15px; font-weight: 700; margin-bottom: 14px; }

    .ww-trend { display: flex; align-items: flex-end; gap: 3px; height: 110px; }
    .ww-trend .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
    .ww-trend .bar { width: 100%; max-width: 18px; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
    .ww-trend .lbl { font-size: 9px; color: var(--muted); margin-top: 4px; white-space: nowrap; }

    .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13px; }
    .bar-row .k { width: 140px; color: var(--muted); flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-row .track { flex: 1; height: 8px; background: var(--bg); border-radius: 5px; overflow: hidden; }
    .bar-row .fill { height: 100%; background: var(--accent); border-radius: 5px; }
    .bar-row .v { width: 44px; text-align: right; font-weight: 600; flex: none; }

    .ww-empty { text-align: center; color: var(--muted); font-size: 13px; padding: 24px 0; }
    .ww-cardfail {
      font-size: 12px; color: var(--danger-dk); background: var(--danger-tint);
      border: 1px solid var(--danger-line); border-radius: var(--radius-sm);
      padding: 9px 11px; line-height: 1.5;
    }
    .ww-cardfail .why { color: var(--muted); display: block; margin-top: 4px; font-size: 11px; word-break: break-word; }

    /* Secondary stats. Smaller than the four headline cards on purpose:
       they explain the traffic rather than count it. */
    .ww-sub { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .ww-sub .ww-kpi { padding: 13px 15px; }
    .ww-sub .ww-kpi .val { font-size: 20px; }
    .ww-error { color: var(--danger); font-size: 12.5px; margin-top: 4px; }

    .ww-setup { max-width: 620px; margin: 40px auto; text-align: center; }
    .ww-setup .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .ww-setup h2 { color: var(--ink); font-size: 18px; margin: 0 0 10px; }
    .ww-setup p { line-height: 1.6; margin: 0 0 14px; }
    .ww-setup ul { text-align: left; display: inline-block; margin: 0 0 4px; padding-left: 20px; line-height: 1.7; }
    .ww-setup code { background: var(--bg); border-radius: 4px; padding: 1px 6px; font-size: 12px; }

    /* ---- settings ---- */
    .ww-settings { max-width: 720px; }
    .ww-sitelist { margin-bottom: 24px; }
    .ww-siterow {
      display: flex; align-items: center; gap: 12px; background: var(--card);
      border: 1px solid var(--line); border-radius: var(--radius-md);
      padding: 12px 16px; margin-bottom: 8px;
    }
    .ww-siterow .info { flex: 1; min-width: 0; }
    .ww-siterow .name { font-weight: 700; font-size: 14px; }
    .ww-siterow .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .ww-siterow .actions { display: flex; gap: 6px; flex: none; }
    .ww-siterow button {
      background: transparent; border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 5px 10px; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer;
    }
    .ww-siterow button:hover { color: var(--ink); }
    .ww-siterow button.danger:hover { color: var(--danger); border-color: var(--danger); }

    .ww-form { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 18px 20px; }
    .ww-form h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
    .ww-form .row { margin-bottom: 12px; }
    .ww-form label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
    .ww-form input {
      width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--line);
      border-radius: var(--radius-sm); font-size: 13px; font-family: inherit; background: var(--bg);
    }
    .ww-form .hint { font-size: 11.5px; color: var(--muted); margin-top: 4px; line-height: 1.5; }
    .ww-form .save-btn {
      background: var(--accent); color: var(--on-accent); border: none; border-radius: var(--radius-sm);
      padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit;
    }
    .ww-form .ghost-btn {
      background: transparent; color: var(--muted); border: 1px solid var(--line);
      border-radius: var(--radius-sm); padding: 8px 14px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit; margin-left: 8px;
    }
    .ww-form .ghost-btn:hover { color: var(--ink); }
    .ww-noaccess { text-align: center; color: var(--muted); font-size: 13px; padding: 40px 0; }

    .ww-check {
      margin-top: 12px; padding: 11px 14px; border-radius: var(--radius-sm);
      font-size: 12.5px; line-height: 1.55; border: 1px solid var(--line); background: var(--bg);
    }
    .ww-check.ok { background: var(--success-tint); border-color: var(--success); color: var(--success-dk); }
    .ww-check.bad { background: var(--danger-tint); border-color: var(--danger-line); color: var(--danger-dk); }
    .ww-check.busy { color: var(--muted); }
    .ww-check .who { display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 11.5px; word-break: break-all; }
  `,

  template: `
    <div class="ww-page" id="wwDashPage">
      <div class="ww-hd">
        <div>
          <h1>WebsiteWidget.</h1>
          <div class="sub" id="wwMeta"></div>
        </div>
        <div style="display:flex; gap:16px; flex-wrap:wrap;">
          <div class="ww-range" id="wwRange">
            <button data-days="7">7 days</button>
            <button data-days="30" aria-pressed="true">30 days</button>
            <button data-days="90">90 days</button>
          </div>
          <div class="ww-compare" id="wwCompare">
            <button data-cmp="none" aria-pressed="true">No compare</button>
            <button data-cmp="previous">vs previous</button>
            <button data-cmp="year">vs last year</button>
          </div>
          <div class="ww-range">
            <button id="wwRefresh" type="button" title="Ignore the 10 minute cache and pull from GA4 now">Refresh</button>
          </div>
        </div>
      </div>
      <div class="ww-sitetabs" id="wwSiteTabs"></div>
      <div class="ww-basis" id="wwBasis"></div>
      <div id="wwBody">Loading…</div>
    </div>

    <div class="ww-page" id="wwSettingsPage" hidden>
      <div class="ww-hd">
        <div>
          <h1>Manage Sites.</h1>
          <div class="sub">Which GA4 properties WebsiteWidget shows.</div>
        </div>
      </div>
      <div id="wwSettingsBody">Loading…</div>
    </div>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    const isAdmin = !!(ctx.perms && (ctx.perms.data_scope === 'all' || ctx.perms.superuser));

    ctx.sites = [];
    ctx.activeSiteId = null;
    ctx.data = null;
    ctx.days = 30;
    ctx.compare = 'none';

    async function loadSites() {
      const payload = await ctx.api.get(ENDPOINTS.wwSites);
      ctx.sites = (payload && payload.sites) || [];
      if (!ctx.activeSiteId || !ctx.sites.some((s) => s.id === ctx.activeSiteId)) {
        ctx.activeSiteId = ctx.sites.length ? ctx.sites[0].id : null;
      }
    }

    function renderSiteTabs() {
      const wrap = $('#wwSiteTabs');
      if (!ctx.sites.length) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = ctx.sites.map((s) =>
        '<button data-site="' + esc(s.id) + '" aria-pressed="' + (s.id === ctx.activeSiteId) + '">' +
          esc(s.label) + '</button>'
      ).join('');
    }

    async function loadStats(fresh) {
      if (!ctx.activeSiteId) {
        ctx.data = { configured: ctx.sites.__configured !== false, siteId: null, totals: {}, trend: [], channels: [], topPages: [] };
        renderDashboard();
        return;
      }
      const params = { range: String(ctx.days), site: ctx.activeSiteId, compare: ctx.compare };
      if (fresh) params.fresh = '1';
      ctx.data = await ctx.api.get(ENDPOINTS.wwStats, params);
      renderDashboard();
    }

    // The window every number on screen covers, spelled out. Two things
    // people would otherwise have to guess at and would guess wrong: that
    // today is not in it, and, for a year comparison, that the window was
    // shifted a day off the calendar date to keep the weekdays lined up.
    function renderBasis() {
      const el = $('#wwBasis');
      const data = ctx.data;
      if (!data || !data.configured || !data.period) { el.innerHTML = ''; return; }

      const p = data.period;
      let html = '<strong>' + esc(fmtIso(p.startDate)) + ' to ' + esc(fmtIso(p.endDate)) + '</strong>' +
        ', ' + data.days + ' complete days. Today is not included, so it can be measured against a full period.';

      if (data.priorPeriod) {
        html += ' Compared with <strong>' + esc(fmtIsoYear(data.priorPeriod.startDate)) +
          ' to ' + esc(fmtIsoYear(data.priorPeriod.endDate)) + '</strong>';
        html += data.compare === 'year'
          ? ', the same 52 weeks back, so each day lands on the same weekday it is being compared with.'
          : ', the ' + data.days + ' days immediately before.';
      }

      el.innerHTML = html;
    }

    function renderDashboard() {
      const body = $('#wwBody');
      const meta = $('#wwMeta');
      const data = ctx.data;

      if (!data) { body.innerHTML = 'Loading…'; return; }

      renderBasis();

      if (!data.configured) {
        meta.textContent = '';
        $('#wwBasis').innerHTML = '';
        const noSites = ctx.sites.length === 0;
        body.innerHTML = `
          <div class="ww-setup">
            <span class="badge">Not connected yet</span>
            <h2>${noSites ? "No sites added yet" : "GA4 isn't wired up"}</h2>
            ${noSites
              ? `<p>Once a site is added${isAdmin ? ' (use Manage Sites above)' : ', an admin can add one from Manage Sites'}, it will show visitors, sessions, traffic sources, top pages, and trends here.</p>`
              : `<p>Once this is connected it will show visitors, sessions, traffic
                  sources, top pages, and trends for every site added. It needs
                  two things set in Vercel, from a single Google service
                  account that can be granted access to any number of GA4
                  properties:</p>
                <ul>
                  <li><code>GA4_CLIENT_EMAIL</code></li>
                  <li><code>GA4_PRIVATE_KEY</code></li>
                </ul>
                <p>No changes needed here once those are set. This page will
                  start showing real numbers the next time it loads.</p>`}
          </div>
        `;
        return;
      }

      const t = data.totals || {};
      const genAt = data.generatedAt ? new Date(data.generatedAt) : null;
      meta.textContent = genAt
        ? 'Last updated ' + genAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';

      if (data.error) {
        $('#wwBasis').innerHTML = '';
        body.innerHTML = `
          <div class="ww-setup">
            <span class="badge">Needs attention</span>
            <h2>Couldn't read this site's data</h2>
            <p class="ww-error">${esc(data.error)}</p>
            <p>The most common cause: the service account hasn't been added
              as a Viewer on this site's GA4 property yet (Admin ->
              Property Access Management, in analytics.google.com).</p>
          </div>
        `;
        return;
      }

      const priorTrend = data.priorTrend || null;
      // Both series scale to the SAME maximum. Scaling each to its own would
      // make two very different weeks draw identical charts, which is the
      // one thing a comparison chart must never do.
      const trendMax = Math.max(
        1,
        ...((data.trend || []).map((d) => d.sessions)),
        ...((priorTrend || []).map((d) => d.sessions))
      );

      const trendLegend = priorTrend
        ? '<div class="ww-trend-legend">' +
            '<span class="key"><span class="swatch now"></span>' + esc(fmtIso(data.period.startDate)) + ' to ' + esc(fmtIso(data.period.endDate)) + '</span>' +
            '<span class="key"><span class="swatch was"></span>' + esc(fmtIsoYear(data.priorPeriod.startDate)) + ' to ' + esc(fmtIsoYear(data.priorPeriod.endDate)) + '</span>' +
          '</div>'
        : '';

      const trendHtml = (data.trend || []).length
        ? trendLegend + '<div class="ww-trend">' + data.trend.map((d, i) => {
            // Aligned by position, not by date: day one against day one,
            // which is what a year comparison needs since the dates differ.
            // Safe only because the server fills GA4's missing zero-session
            // days before this runs (fillTrendGaps in lib/websitewidget/ga4.js).
            // Without that a single quiet Sunday shifts every bar after it.
            const was = priorTrend && priorTrend[i] ? priorTrend[i] : null;
            const tip = fmtDate(d.date) + ': ' + fmtNum(d.sessions) + ' sessions' +
              (was ? ' (was ' + fmtNum(was.sessions) + ' on ' + fmtDate(was.date) + ')' : '');
            const ghost = was
              ? '<div class="ghost" style="height:' + Math.max(2, (was.sessions / trendMax) * 100) + '%"></div>'
              : '';
            return '<div class="col" title="' + esc(tip) + '">' +
              '<div class="stack">' + ghost +
                '<div class="bar" style="height:' + Math.max(2, (d.sessions / trendMax) * 100) + '%"></div>' +
              '</div>' +
              '<div class="lbl">' + esc(fmtDate(d.date)) + '</div>' +
            '</div>';
          }).join('') + '</div>'
        : '<div class="ww-empty">No trend data for this range yet.</div>';

      // A row with no prior figure shows a dash, not a minus sign. The prior
      // pull is filtered to the keys this period surfaced, so a missing row
      // means GA4 had nothing for that key back then, which for a page that
      // did not exist yet is not a 100% drop.
      function cmpCell(delta) {
        if (!data.priorPeriod) return '';
        if (!delta) return '<div class="cmp unknown" title="Nothing to compare against in that period">&mdash;</div>';
        return '<div class="cmp ' + deltaClass(delta) + '" title="was ' + fmtNum(delta.prior) + '">' +
          esc(deltaText(delta)) + '</div>';
      }

      // One builder for every breakdown card. Each card renders from the
      // catalogue on the server (BREAKDOWNS in lib/websitewidget/ga4.js), so
      // the bar rows, the comparison column, the empty state and the failure
      // state are written once rather than per card.
      function barCard(heading, rows, keyField, valueField, labels, emptyMsg) {
        const failure = (data.failed || {})[heading.section];
        if (failure) {
          return '<div class="ww-card"><h2>' + esc(heading.title) + '</h2>' +
            '<div class="ww-cardfail">This section could not be read from Google.' +
            '<span class="why">' + esc(failure) + '</span></div></div>';
        }
        const list = rows || [];
        if (!list.length) {
          return '<div class="ww-card"><h2>' + esc(heading.title) + '</h2>' +
            '<div class="ww-empty">' + esc(emptyMsg) + '</div></div>';
        }
        const max = Math.max(1, ...list.map((r) => r[valueField] || 0));
        const body = list.map((r) => {
          const raw = r[keyField];
          const label = (labels && labels[raw]) || raw;
          return '<div class="bar-row"><div class="k" title="' + esc(label) + '">' + esc(label) + '</div>' +
            '<div class="track"><div class="fill" style="width:' + ((r[valueField] || 0) / max) * 100 + '%"></div></div>' +
            '<div class="v">' + fmtNum(r[valueField]) + '</div>' + cmpCell(r.delta) + '</div>';
        }).join('');
        return '<div class="ww-card"><h2>' + esc(heading.title) + '</h2>' + body + '</div>';
      }

      const d = data.deltas || {};
      // The prior figure sits next to the percentage on purpose. "Up 40%"
      // means one thing off a base of 2,000 and nothing at all off a base
      // of 5, and the percentage alone does not say which you are looking at.
      function kpi(label, value, delta, fmt) {
        const render = fmt || fmtNum;
        const pill = delta
          ? '<div class="ww-delta">' +
              '<span class="pill ' + deltaClass(delta) + '">' + esc(deltaText(delta)) + '</span>' +
              '<span class="was">was ' + esc(render(delta.prior)) + '</span>' +
            '</div>'
          : '';
        return '<div class="ww-kpi"><div class="lbl">' + esc(label) + '</div>' +
          '<div class="val">' + esc(render(value)) + '</div>' + pill + '</div>';
      }

      // Engagement is its own small row. It answers "was the traffic any
      // good", which is a different question from "how much was there", and
      // it is absent rather than zero when GA4 would not give it up.
      const eng = data.engagement;
      const ed = data.engagementDeltas || {};
      const engRow = eng
        ? `<div class="ww-sub">
             ${kpi('Engaged visits', eng.engagementRate, ed.engagementRate, fmtPct)}
             ${kpi('Avg time on site', eng.avgSessionSeconds, ed.avgSessionSeconds, fmtDuration)}
             ${kpi('Pages per visit', eng.pagesPerSession, ed.pagesPerSession, fmtDecimal)}
           </div>`
        : (data.failed && data.failed.engagement
            ? '<div class="ww-sub"><div class="ww-cardfail">Engagement figures could not be read.' +
              '<span class="why">' + esc(data.failed.engagement) + '</span></div></div>'
            : '');

      body.innerHTML = `
        <div class="ww-kpis">
          ${kpi('Visitors', t.activeUsers, d.activeUsers)}
          ${kpi('New visitors', t.newUsers, d.newUsers)}
          ${kpi('Sessions', t.sessions, d.sessions)}
          ${kpi('Page views', t.pageViews, d.pageViews)}
        </div>
        ${engRow}
        <div class="ww-grid">
          <div>
            <div class="ww-card"><h2>Sessions, daily</h2>${trendHtml}</div>
            ${barCard({ title: 'Where visits start', section: 'landingPages' }, data.landingPages, 'path', 'sessions', null, 'No landing pages in this range yet.')}
            ${barCard({ title: 'Top pages', section: 'topPages' }, data.topPages, 'path', 'views', null, 'No page views yet in this range.')}
            ${barCard({ title: 'What people do', section: 'events' }, data.events, 'event', 'count', EVENT_LABELS, 'No events recorded in this range yet.')}
          </div>
          <div>
            ${barCard({ title: 'Traffic source', section: 'channels' }, data.channels, 'channel', 'sessions', CHANNEL_LABELS, 'No traffic yet in this range.')}
            ${barCard({ title: 'Phone or computer', section: 'devices' }, data.devices, 'device', 'sessions', DEVICE_LABELS, 'No device data in this range yet.')}
            ${barCard({ title: 'New or returning', section: 'visitorType' }, data.visitorType, 'type', 'sessions', VISITOR_LABELS, 'No visitor data in this range yet.')}
            ${barCard({ title: 'Where visitors are', section: 'places' }, data.places, 'place', 'sessions', null, 'No location data in this range yet.')}
          </div>
        </div>
      `;
    }

    /* ---- settings view ---- */

    function renderSettings() {
      const body = $('#wwSettingsBody');

      if (!isAdmin) {
        body.innerHTML = '<div class="ww-noaccess">Managing sites is limited to admins.</div>';
        return;
      }

      const listHtml = ctx.sites.length
        ? ctx.sites.map((s) =>
            '<div class="ww-siterow" data-id="' + esc(s.id) + '">' +
              '<div class="info"><div class="name">' + esc(s.label) + '</div>' +
                '<div class="meta">' + esc(s.domain || 'no domain set') + ' · property ' + esc(s.propertyId) + '</div></div>' +
              '<div class="actions">' +
                '<button data-act="check">Check</button>' +
                '<button data-act="edit">Edit</button>' +
                '<button data-act="remove" class="danger">Remove</button>' +
              '</div>' +
            '</div>' +
            '<div class="ww-check" data-check-for="' + esc(s.id) + '" hidden></div>'
          ).join('')
        : '<div class="ww-empty">No sites added yet.</div>';

      body.innerHTML = `
        <div class="ww-settings">
          <div class="ww-sitelist">${listHtml}</div>
          <div class="ww-form">
            <h2 id="wwFormTitle">Add a site</h2>
            <input type="hidden" id="wwEditId" value="">
            <div class="row"><label>Label</label><input id="wwFLabel" placeholder="e.g. IowaOnDemand.com"></div>
            <div class="row"><label>Domain (optional, for your reference)</label><input id="wwFDomain" placeholder="e.g. iowaondemand.com"></div>
            <div class="row">
              <label>GA4 property ID</label>
              <input id="wwFPropertyId" placeholder="e.g. 321263577">
              <div class="hint">Find this in analytics.google.com under Admin -> Property details
                for this site. Remember to also add the service account as a
                Viewer under Property Access Management for this property,
                or the dashboard will show an access error for it.</div>
            </div>
            <button class="save-btn" id="wwFSave">Save site</button>
            <button class="ghost-btn" id="wwFCheck">Test connection</button>
            <div class="ww-check" id="wwFCheckResult" hidden></div>
          </div>
        </div>
      `;

      // Ask GA4 whether one property id actually works, and say which of the
      // three ways it can fail this is. Without this the only way to find out
      // a property was never granted access is to save it, switch to its
      // dashboard tab, and read an error there.
      async function runCheck(propertyId, target) {
        if (!target) return;
        target.hidden = false;
        target.className = 'ww-check busy';
        target.textContent = 'Checking with Google…';
        try {
          const r = await ctx.api.get(ENDPOINTS.wwSites, { check: propertyId });
          target.className = 'ww-check ' + (r.ok ? 'ok' : 'bad');
          let html = esc(r.message || (r.ok ? 'Connected.' : 'Could not connect.'));
          if (r.ok && r.timeZone) {
            html += ' Property timezone ' + esc(r.timeZone) + '.';
          }
          if (!r.ok && r.status === 'no-access' && r.serviceAccount) {
            html += '<span class="who">' + esc(r.serviceAccount) + '</span>';
          }
          target.innerHTML = html;
        } catch (e) {
          target.className = 'ww-check bad';
          target.textContent = 'Check failed: ' + (e && e.message ? e.message : 'unknown error');
        }
      }

      body.querySelectorAll('.ww-siterow button[data-act="check"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.ww-siterow');
          const id = row.dataset.id;
          const site = ctx.sites.find((s) => s.id === id);
          if (!site) return;
          runCheck(site.propertyId, body.querySelector('[data-check-for="' + CSS.escape(id) + '"]'));
        });
      });

      $('#wwFCheck').addEventListener('click', () => {
        const propertyId = $('#wwFPropertyId').value.trim();
        const target = $('#wwFCheckResult');
        if (!propertyId) {
          target.hidden = false;
          target.className = 'ww-check bad';
          target.textContent = 'Enter a GA4 property ID first.';
          return;
        }
        runCheck(propertyId, target);
      });

      body.querySelectorAll('.ww-siterow button[data-act="remove"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.closest('.ww-siterow').dataset.id;
          if (!confirm('Remove this site? Its cached stats stay, but it will no longer be tracked.')) return;
          await ctx.api.request(ENDPOINTS.wwSites + '?id=' + encodeURIComponent(id), { method: 'DELETE' });
          await loadSites();
          renderSiteTabs();
          renderSettings();
        });
      });

      body.querySelectorAll('.ww-siterow button[data-act="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.closest('.ww-siterow').dataset.id;
          const site = ctx.sites.find((s) => s.id === id);
          if (!site) return;
          $('#wwFormTitle').textContent = 'Edit ' + site.label;
          $('#wwEditId').value = site.id;
          $('#wwFLabel').value = site.label;
          $('#wwFDomain').value = site.domain || '';
          $('#wwFPropertyId').value = site.propertyId;
        });
      });

      $('#wwFSave').addEventListener('click', async () => {
        const id = $('#wwEditId').value;
        const label = $('#wwFLabel').value.trim();
        const domain = $('#wwFDomain').value.trim();
        const propertyId = $('#wwFPropertyId').value.trim();
        if (!label || !propertyId) { alert('Label and GA4 property ID are both required.'); return; }

        if (id) {
          await ctx.api.request(ENDPOINTS.wwSites, {
            method: 'PATCH',
            body: JSON.stringify({ id, label, domain, propertyId })
          });
        } else {
          await ctx.api.post(ENDPOINTS.wwSites, { label, domain, propertyId });
        }
        await loadSites();
        renderSiteTabs();
        renderSettings();
      });
    }

    /* ---- wiring ---- */

    $('#wwRange').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      ctx.days = parseInt(btn.dataset.days, 10);
      root.querySelectorAll('#wwRange button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      loadStats(false);
    });

    $('#wwCompare').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmp]');
      if (!btn) return;
      ctx.compare = btn.dataset.cmp;
      root.querySelectorAll('#wwCompare button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      loadStats(false);
    });

    // The cache holds a shaped GA4 pull for ten minutes, keyed per site, range
    // and compare mode. That is right nearly all the time, and wrong in one
    // specific case: a site's property id has just been corrected, so the
    // stored copy is an answer to a question that is no longer being asked.
    // Before this button there was no way out of that from the screen. The
    // API already honoured fresh=1 and loadStats already took the flag; there
    // was simply nothing that passed true.
    $('#wwRefresh').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.busy === '1') return;   // a second click would race the first
      btn.dataset.busy = '1';
      const label = btn.textContent;
      btn.textContent = 'Refreshing…';
      try {
        await loadStats(true);
      } finally {
        // Restore in a finally: a failed pull that leaves the button stuck on
        // "Refreshing…" reads as a hung app rather than a failed request, and
        // the error itself is already reported in the dashboard body.
        btn.dataset.busy = '';
        btn.textContent = label;
      }
    });

    $('#wwSiteTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-site]');
      if (!btn) return;
      ctx.activeSiteId = btn.dataset.site;
      root.querySelectorAll('#wwSiteTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      loadStats(false);
    });

    await loadSites();
    renderSiteTabs();
    await loadStats(false);
    renderSettings();
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const dash = root.querySelector('#wwDashPage');
    const settings = root.querySelector('#wwSettingsPage');
    if (view === 'settings') {
      dash.hidden = true;
      settings.hidden = false;
    } else {
      dash.hidden = false;
      settings.hidden = true;
    }
  }
};
