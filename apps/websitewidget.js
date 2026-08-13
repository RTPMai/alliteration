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

    .ww-sitetabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 18px; }

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
    .ww-noaccess { text-align: center; color: var(--muted); font-size: 13px; padding: 40px 0; }
  `,

  template: `
    <div class="ww-page" id="wwDashPage">
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
      <div class="ww-sitetabs" id="wwSiteTabs"></div>
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
      const params = { range: String(ctx.days), site: ctx.activeSiteId };
      if (fresh) params.fresh = '1';
      ctx.data = await ctx.api.get(ENDPOINTS.wwStats, params);
      renderDashboard();
    }

    function renderDashboard() {
      const body = $('#wwBody');
      const meta = $('#wwMeta');
      const data = ctx.data;

      if (!data) { body.innerHTML = 'Loading…'; return; }

      if (!data.configured) {
        meta.textContent = '';
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
                '<button data-act="edit">Edit</button>' +
                '<button data-act="remove" class="danger">Remove</button>' +
              '</div>' +
            '</div>'
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
          </div>
        </div>
      `;

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
