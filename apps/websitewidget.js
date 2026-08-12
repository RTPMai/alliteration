// PUT IN: apps/websitewidget.js (new)
// (this banner line is for verification only, delete it after checking the path)

/**
 * WebsiteWidget — web analytics for PMApparel.com.
 *
 * Real build, Aug 2026. One view (Dashboard): visitors, sessions, traffic
 * source breakdown, top pages, and a daily trend, all pulled from GA4 via
 * api/websitewidget.js -> lib/websitewidget/ga4.js.
 *
 * NOT CONFIGURED state: the API always answers 200, never an error, even
 * before the GA4 service account is wired up (see lib/websitewidget/ga4.js
 * for the three env vars needed). When `configured` comes back false, this
 * view shows a plain setup notice instead of guessing at numbers.
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
    .ww-hd { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
    .ww-hd h1 { font-size: 28px; font-weight: 800; letter-spacing: -.02em; }
    .ww-hd .sub { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .ww-range { display: flex; gap: 6px; }
    .ww-range button {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: 13px; font-weight: 600; color: var(--muted);
      cursor: pointer; font-family: inherit; transition: .12s;
    }
    .ww-range button:hover { color: var(--ink); }
    .ww-range button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

    .ww-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .ww-kpi { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 16px 18px; }
    .ww-kpi .lbl { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .ww-kpi .val { font-size: 28px; font-weight: 800; letter-spacing: -.01em; margin-top: 4px; }

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
  `,

  template: `
    <div class="ww-page" id="wwPage">
      <div class="ww-hd">
        <div>
          <h1>WebsiteWidget.</h1>
          <div class="sub" id="wwMeta"></div>
        </div>
        <div class="ww-range" id="wwRange">
          <button data-days="7">7 days</button>
          <button data-days="30" aria-pressed="true">30 days</button>
          <button data-days="90">90 days</button>
        </div>
      </div>
      <div id="wwBody">Loading…</div>
    </div>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    ctx.data = null;
    ctx.days = 30;

    async function load(days, fresh) {
      const params = { range: String(days) };
      if (fresh) params.fresh = '1';
      const payload = await ctx.api.get(ENDPOINTS.wwStats, params);
      ctx.data = payload;
      ctx.days = days;
      render();
    }

    function render() {
      const body = $('#wwBody');
      const meta = $('#wwMeta');
      const data = ctx.data;

      if (!data) { body.innerHTML = 'Loading…'; return; }

      if (!data.configured) {
        meta.textContent = '';
        body.innerHTML = `
          <div class="ww-setup">
            <span class="badge">Not connected yet</span>
            <h2>GA4 isn't wired up</h2>
            <p>Once this is connected it will show visitors, sessions, traffic
              sources, top pages, and trends for PMApparel.com. It needs
              three things set in Vercel, from a Google Analytics service
              account for the site's GA4 property:</p>
            <ul>
              <li><code>GA4_PROPERTY_ID</code></li>
              <li><code>GA4_CLIENT_EMAIL</code></li>
              <li><code>GA4_PRIVATE_KEY</code></li>
            </ul>
            <p>No changes needed here once those are set. This page will
              start showing real numbers the next time it loads.</p>
          </div>
        `;
        return;
      }

      const t = data.totals || {};
      const genAt = data.generatedAt ? new Date(data.generatedAt) : null;
      meta.textContent = genAt
        ? 'Last updated ' + genAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '';
      if (data.error) meta.textContent += ' — showing an empty read, GA4 did not respond';

      const trendMax = Math.max(1, ...((data.trend || []).map((d) => d.sessions)));
      const trendHtml = (data.trend || []).length
        ? '<div class="ww-trend">' + data.trend.map((d) =>
            '<div class="col" title="' + esc(fmtDate(d.date)) + ': ' + fmtNum(d.sessions) + ' sessions">' +
              '<div class="bar" style="height:' + Math.max(2, (d.sessions / trendMax) * 100) + '%"></div>' +
              '<div class="lbl">' + esc(fmtDate(d.date)) + '</div>' +
            '</div>'
          ).join('') + '</div>'
        : '<div class="ww-empty">No trend data for this range yet.</div>';

      const chanMax = Math.max(1, ...((data.channels || []).map((c) => c.sessions)));
      const chanHtml = (data.channels || []).length
        ? data.channels.map((c) =>
            '<div class="bar-row"><div class="k" title="' + esc(CHANNEL_LABELS[c.channel] || c.channel) + '">' +
              esc(CHANNEL_LABELS[c.channel] || c.channel) + '</div>' +
              '<div class="track"><div class="fill" style="width:' + (c.sessions / chanMax) * 100 + '%"></div></div>' +
              '<div class="v">' + fmtNum(c.sessions) + '</div></div>'
          ).join('')
        : '<div class="ww-empty">No traffic yet in this range.</div>';

      const pageMax = Math.max(1, ...((data.topPages || []).map((p) => p.views)));
      const pagesHtml = (data.topPages || []).length
        ? data.topPages.map((p) =>
            '<div class="bar-row"><div class="k" title="' + esc(p.path) + '">' + esc(p.path) + '</div>' +
              '<div class="track"><div class="fill" style="width:' + (p.views / pageMax) * 100 + '%"></div></div>' +
              '<div class="v">' + fmtNum(p.views) + '</div></div>'
          ).join('')
        : '<div class="ww-empty">No page views yet in this range.</div>';

      body.innerHTML = `
        <div class="ww-kpis">
          <div class="ww-kpi"><div class="lbl">Visitors</div><div class="val">${fmtNum(t.activeUsers)}</div></div>
          <div class="ww-kpi"><div class="lbl">New visitors</div><div class="val">${fmtNum(t.newUsers)}</div></div>
          <div class="ww-kpi"><div class="lbl">Sessions</div><div class="val">${fmtNum(t.sessions)}</div></div>
          <div class="ww-kpi"><div class="lbl">Page views</div><div class="val">${fmtNum(t.pageViews)}</div></div>
        </div>
        <div class="ww-grid">
          <div>
            <div class="ww-card"><h2>Sessions, daily</h2>${trendHtml}</div>
          </div>
          <div>
            <div class="ww-card"><h2>Traffic source</h2>${chanHtml}</div>
            <div class="ww-card"><h2>Top pages</h2>${pagesHtml}</div>
          </div>
        </div>
      `;
    }

    $('#wwRange').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      const days = parseInt(btn.dataset.days, 10);
      root.querySelectorAll('#wwRange button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      load(days, false);
    });

    await load(30, false);
  },

  showView() {
    // Single view; nothing to switch.
  }
};
