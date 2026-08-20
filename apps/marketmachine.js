/**
 * MarketMachine — campaigns across every channel, not just email.
 *
 * WHY IT EXISTS. MailMe grew a Campaigns tab because email was the first
 * channel P&M automated. But a real campaign is rarely only email: a spring
 * school push is a postcard drop, a booth at a conference, a paid social run
 * and an email, all aimed at the same people over the same weeks. Keeping the
 * campaign of record inside the email tool made every other channel
 * invisible, and made "did that work" unanswerable, because only one sixth of
 * it was being measured.
 *
 * THE SPLIT. MarketMachine owns the campaign: what it is for, when it runs,
 * what it costs, which channels it uses and what came back. MailMe owns
 * email: composing, suppression, the cold ramp, domain reputation, CAN-SPAM.
 * None of that second list has an analogue in a postcard drop, which is
 * exactly why it does not belong in a planner.
 *
 * HOW THEY TALK. One pointer, held by MailMe. An email there carries
 * `marketingCampaignId` and `marketingChannelId`; this app asks "which of
 * your emails say they belong to me". MarketMachine deliberately does NOT
 * keep its own list of email ids: two copies of one fact drift the first time
 * an email is deleted, and the drift shows up as reach that never happened.
 *
 * WHAT IS ENTERED BY HAND, AND WHY THAT IS FINE. Every channel except email
 * has its numbers typed in, because a postcard drop genuinely has no API.
 * That is not a gap waiting to be closed. The alternative is an empty
 * dashboard, and a number somebody wrote down beats a number nobody has.
 * Email is the exception precisely because MailMe already knows, and asking
 * anyone to retype it would create a second set of figures that disagrees
 * with the first.
 *
 * MISSING IS NOT ZERO. A "done" item with no reach entered is reported as a
 * gap, not folded into the total as nothing. A rollup that silently counts
 * unknowns as zero looks authoritative and is wrong, which is worse than one
 * that admits it is incomplete.
 *
 * No fetch() here: everything goes through ctx.api and ENDPOINTS, per the
 * seam rule. No hex colors: tokens.css owns theming via data-app.
 */

import { ENDPOINTS } from '../js/api.js';
import {
  CHANNELS, CHANNEL_KEYS, channelMeta, channelMetrics, metricLabel,
  isDelegated, isFunded, FUNDING, PLATFORMS
} from '../lib/marketmachine/schema.js';
import {
  TYPED_METRICS, DERIVED_METRICS, SOURCED_FIELDS, metricMeta, deriveMetrics
} from '../lib/marketmachine/metrics.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return isNaN(d) ? '' : d.toLocaleDateString();
}

// Money is shown whole. Cents on a $4,200 postcard drop are noise, and the
// stored value keeps them anyway for anything that needs to add up exactly.
function money(n) {
  if (n == null) return null;
  return '$' + Math.round(n).toLocaleString();
}

// CHANNELS, channelMeta and isDelegated are imported from the schema above.
//
// They used to be copied out into this file. That copy is exactly the kind of
// second definition this app was built to argue against: when `paid_ads` was
// folded into `social` in the schema, the screen would have gone on offering
// a channel the API had stopped accepting, and the failure would have shown
// up as a save that silently landed under the wrong channel.
//
// The imported channelMeta returns null for an unknown key rather than
// guessing, so this wrapper supplies the old fallback for render paths that
// assume an object. A stored record naming a channel the schema no longer has
// still draws, labelled with its raw key instead of blowing up the row.
const chanMeta = (k) => channelMeta(k) || { key: String(k || ''), label: String(k || 'Unknown'), note: '' };

const CAMPAIGN_STATUS = {
  planning:  { label: 'Planning',  cls: 'mute' },
  active:    { label: 'Active',    cls: 'ok' },
  complete:  { label: 'Complete',  cls: 'src' },
  cancelled: { label: 'Cancelled', cls: 'warn' }
};

const CHANNEL_STATUS = {
  planned:     { label: 'Planned',     cls: 'mute' },
  in_progress: { label: 'In progress', cls: 'warn' },
  done:        { label: 'Done',        cls: 'ok' },
  skipped:     { label: 'Skipped',     cls: 'mute' }
};

const MSG_TARGET = {
  campaigns: '#mkCampaignMsg',
  calendar: '#mkCalendarMsg',
  entry: '#mkEntryMsg',
  definitions: '#mkDefsMsg',
  settings: '#mkSettingsMsg'
};

// Shown under a number rather than the number itself when the number is null.
// Deliberately words, not a dash: "not reported" and "0" have to look
// different at a glance or every gap reads as a real zero.
const NOT_REPORTED = '<span class="mk-null">not reported</span>';

function fmtMetric(kind, v) {
  if (v == null) return NOT_REPORTED;
  if (kind === 'money') return '$' + Math.round(v).toLocaleString();
  if (kind === 'percent') return v + '%';
  if (kind === 'ratio') return String(v);
  return Math.round(v).toLocaleString();
}

export default {
  id: 'marketmachine',

  styles: `
  .mk-page{padding:24px 32px 60px}
  .mk-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .mk-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mk-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}
  .mk-refresh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .mk-refresh .stamp{font-size:11.5px;color:var(--faint);white-space:nowrap}

  .mk-btn{background:var(--accent);color:var(--on-accent);border:1px solid var(--accent);
    border-radius:var(--radius-sm);padding:7px 14px;font-size:13px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:var(--speed)}
  .mk-btn:hover{background:var(--accent-deep);border-color:var(--accent-deep)}
  .mk-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mk-btn[disabled]{opacity:.5;cursor:not-allowed}
  .mk-btn.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  .mk-btn.ghost:hover{color:var(--ink);background:var(--row-hover)}
  .mk-btn.sm{padding:4px 10px;font-size:12px}

  .mk-card{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:18px;overflow:hidden}
  .mk-card-hd{display:flex;justify-content:space-between;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);gap:12px;flex-wrap:wrap}
  .mk-card-hd h3{font-size:14px;font-weight:700}
  .mk-card-hd .meta{font-size:12px;color:var(--muted)}
  .mk-card-bd{padding:18px}
  .mk-card-bd.flush{padding:0}

  .pill{display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--success-tint);color:var(--success-dk)}
  .pill.warn{background:var(--warn-tint);color:var(--warn-dk)}
  .pill.bad{background:var(--danger-tint);color:var(--danger-dk)}
  .pill.src{background:var(--accent-tint);color:var(--accent-deep)}
  .pill.mute{background:var(--line-soft);color:var(--muted)}

  .mk-table{width:100%;border-collapse:collapse;font-size:13px}
  .mk-table th{text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mk-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  .mk-table tr.clickable{cursor:pointer}
  .mk-table tr:hover td{background:var(--row-hover)}
  .mk-table .co{font-weight:600;color:var(--ink)}
  .mk-table .who{color:var(--faint);font-size:12px}
  .mk-table td.num{text-align:right;font-variant-numeric:tabular-nums}

  .mk-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
    gap:12px;margin-bottom:16px}
  .mk-stat{background:var(--head-bg);border-radius:var(--radius-sm);padding:12px 14px}
  .mk-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .mk-stat .l{font-size:11px;color:var(--muted);margin-top:3px;font-weight:600}
  .mk-stat.warn .v{color:var(--warn-dk)}
  .mk-stat.bad .v{color:var(--danger-dk)}
  /* A figure nobody entered is dashed out rather than shown as zero. */
  .mk-stat .v.unknown{color:var(--faint);font-weight:600;font-size:16px}

  .mk-notice{background:var(--warn-tint);border-left:3px solid var(--warn);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:12.5px;
    color:var(--warn-dk);line-height:1.55;margin-bottom:16px}
  .mk-notice.good{background:var(--success-tint);border-left-color:var(--success);
    color:var(--success-dk)}
  .mk-notice.danger{background:var(--danger-tint);border-left-color:var(--danger);
    color:var(--danger-dk)}
  .mk-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:12.5px;
    color:var(--danger-dk);margin-bottom:14px}
  .mk-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--success-dk);
    margin-bottom:14px;font-weight:600}

  .mk-field{margin-bottom:14px}
  .mk-field label{display:block;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mk-field input,.mk-field textarea,.mk-field select{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mk-field textarea{min-height:80px;resize:vertical;line-height:1.6}
  .mk-field input:focus,.mk-field textarea:focus,.mk-field select:focus{
    outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .mk-field .hint{font-size:11.5px;color:var(--faint);margin-top:4px;line-height:1.5}
  .mk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
  .mk-grid .full{grid-column:1/-1}

  .mk-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .mk-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;line-height:1.6}
  .mk-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}

  /* A channel row. The email one looks different on purpose: its numbers are
     read-only because MailMe owns them, and that should be visible rather
     than discovered by clicking into a field that will not take input. */
  .mk-chan{border:1px solid var(--line-soft);border-radius:var(--radius-sm);
    padding:13px 15px;margin-bottom:10px}
  .mk-chan.delegated{background:var(--accent-tint);border-color:var(--accent-tint)}
  .mk-chan-hd{display:flex;justify-content:space-between;align-items:center;
    gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .mk-chan-hd .n{font-size:13.5px;font-weight:700}
  .mk-chan-hd .t{font-size:11.5px;color:var(--muted)}
  .mk-chan-nums{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
  .mk-chan-nums b{color:var(--ink);font-variant-numeric:tabular-nums}
  .mk-chan-nums .gap{color:var(--warn-dk);font-weight:700}

  .mk-null{color:var(--muted);font-style:italic;font-weight:400;font-size:12px}
  .mk-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .mk-sub-hd{font-size:13px;font-weight:700;color:var(--ink);margin:0 0 10px}
  .mk-await{background:var(--bg);border-radius:10px;padding:14px 16px;margin-top:6px}
  .mk-await .pill{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.06em;
    text-transform:uppercase;color:var(--warn-dk);background:var(--warn-bg);
    padding:3px 8px;border-radius:20px;margin-bottom:8px}
  .mk-await .slot{border:1px dashed var(--line);border-radius:8px;padding:9px 11px;
    font-size:12.5px;color:var(--muted);background:transparent}
  .mk-derived{display:flex;flex-wrap:wrap;gap:16px;margin-top:4px}
  .mk-derived .d{min-width:110px}
  .mk-derived .d .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .mk-derived .d .v{font-size:17px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
  .mk-defs dt{font-size:13.5px;font-weight:700;color:var(--ink);margin-top:14px}
  .mk-defs dd{margin:3px 0 0;font-size:12.5px;color:var(--muted);line-height:1.6}
  .mk-defs .calc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
    color:var(--ink);background:var(--bg);padding:2px 6px;border-radius:5px}
  .mk-rows{width:100%;border-collapse:collapse;font-size:12.5px}
  .mk-rows th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
    color:var(--muted);padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  .mk-rows td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  .mk-rows tr:last-child td{border-bottom:0}
  .mk-rows td.num{text-align:right;font-variant-numeric:tabular-nums}

  .mk-modal-back{position:fixed;inset:0;background:rgba(15,20,28,.55);
    z-index:400;overflow-y:auto;padding:40px 16px}
  .mk-modal{background:var(--card);border-radius:12px;width:100%;
    max-width:760px;margin:0 auto;box-shadow:0 18px 50px rgba(0,0,0,.3);position:relative}
  .mk-modal .mk-card{border:0;box-shadow:none;margin:0}
  .mk-modal-x{position:absolute;top:12px;right:14px;border:0;background:transparent;
    font-size:22px;line-height:1;cursor:pointer;color:var(--muted);padding:4px 8px}
  .mk-modal-x:hover{color:var(--ink)}
  `,

  template: `
    <div class="mk-page">
      <section id="mkCampaignsView" hidden>
        <div id="mkListPane">
          <div class="mk-hd">
            <div>
              <h1>MarketMachine<span class="dot">.</span></h1>
              <div class="sub">Every campaign, every channel, what it cost and what came back.</div>
            </div>
            <div class="mk-refresh">
              <span class="stamp" data-mk-stamp></span>
              <button class="mk-btn ghost sm" data-mk-refresh="campaigns">Refresh</button>
              <button class="mk-btn" id="mkNewCampaign">New campaign</button>
            </div>
          </div>
          <div id="mkCampaignMsg"></div>
          <div class="mk-stat-row" id="mkStrip"></div>
          <div class="mk-card">
            <div class="mk-card-hd">
              <h3>Campaigns</h3><span class="meta" id="mkCount"></span>
            </div>
            <div class="mk-card-bd flush"><div id="mkCampaignList"></div></div>
          </div>
        </div>
        <div id="mkDetailPane" hidden></div>
      </section>

      <section id="mkCalendarView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Calendar<span class="dot">.</span></h1>
            <div class="sub">What is due, and what has slipped.</div>
          </div>
          <div class="mk-refresh">
            <span class="stamp" data-mk-stamp></span>
            <button class="mk-btn ghost sm" data-mk-refresh="calendar">Refresh</button>
          </div>
        </div>
        <div id="mkCalendarMsg"></div>
        <div id="mkCalendarBody"></div>
      </section>

      <section id="mkEntryView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Add performance data<span class="dot">.</span></h1>
            <div class="sub">Type what happened. Everything that can be calculated is.</div>
          </div>
          <div class="mk-refresh">
            <span class="stamp" data-mk-stamp></span>
            <button class="mk-btn ghost sm" data-mk-refresh="entry">Refresh</button>
          </div>
        </div>
        <div id="mkEntryMsg"></div>
        <div id="mkEntryBody"></div>
      </section>

      <section id="mkDefinitionsView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Definitions<span class="dot">.</span></h1>
            <div class="sub">What every number on this screen means, and which ones nobody types.</div>
          </div>
        </div>
        <div id="mkDefsMsg"></div>
        <div id="mkDefsBody"></div>
      </section>

      <section id="mkSettingsView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Settings<span class="dot">.</span></h1>
            <div class="sub">The initiative list the whole shell reads.</div>
          </div>
          <div class="mk-refresh">
            <span class="stamp" data-mk-stamp></span>
            <button class="mk-btn ghost sm" data-mk-refresh="settings">Refresh</button>
          </div>
        </div>
        <div id="mkSettingsMsg"></div>
        <div id="mkSettingsBody"></div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    let modalCarrier = null;
    let modalKind = null;

    const $ = (sel) =>
      (modalCarrier && modalCarrier.querySelector(sel)) || root.querySelector(sel);
    const api = ctx.api;
    this._root = root;

    const state = {
      campaigns: [],
      detail: null,        // the open campaign, with its rollup and emails
      openId: null,
      initiatives: [],
      industries: [],
      // Data Entry keeps its own selection, separate from the campaign the
      // Campaigns screen has open. Somebody entering last week's numbers is
      // doing a different job from somebody reading a campaign, and sharing
      // one selection between the two screens means each one keeps yanking
      // the other somewhere it did not ask to go.
      entryCampaignId: null,
      entryChannel: 'social',
      entries: [],
      entryTotals: null,
      byCreative: [],
      byPlatform: [],
      lastSavedDerived: null,
      canEdit: true,
      canDelete: false,
      lastLoaded: null,
      refreshing: false
    };
    this._state = state;

    const msg = (sel, html, cls) => {
      const el = $(sel);
      if (el) el.innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
    };
    const detailMsg = (html, cls) => msg('#mkDetailMsg', html, cls);

    /* ---------------- data ---------------- */

    async function loadCampaigns() {
      const d = await api.get(ENDPOINTS.mkCampaigns);
      state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
      state.canEdit = d && d.canEdit !== false;
      state.canDelete = !!(d && d.canDelete);
    }

    async function loadInitiatives() {
      try {
        const d = await api.get(ENDPOINTS.mkInitiatives);
        state.initiatives = Array.isArray(d && d.initiatives) ? d.initiatives : [];
      } catch (e) {
        state.initiatives = [];
      }
    }

    async function loadIndustries() {
      try {
        const d = await api.get(ENDPOINTS.mkIndustries);
        state.industries = Array.isArray(d && d.industries) ? d.industries : [];
      } catch (e) {
        // Same reasoning as the initiative list: an empty dropdown reads as a
        // broken form and stops somebody filling anything in, so a failed
        // load leaves whatever was there rather than blanking it.
      }
    }

    async function loadEntries() {
      const id = state.entryCampaignId;
      if (!id) { state.entries = []; state.entryTotals = null; state.byCreative = []; state.byPlatform = []; return; }
      const d = await api.get(ENDPOINTS.mkEntries, { campaignId: id });
      state.entries = Array.isArray(d && d.entries) ? d.entries : [];
      state.entryTotals = (d && d.totals) || null;
      state.byCreative = Array.isArray(d && d.byCreative) ? d.byCreative : [];
      state.byPlatform = Array.isArray(d && d.byPlatform) ? d.byPlatform : [];
    }

    async function loadDetail(id) {
      if (!id) { state.detail = null; return; }
      state.detail = await api.get(ENDPOINTS.mkCampaigns, { id });
    }

    /* ---------------- list ---------------- */

    function renderStrip() {
      const box = $('#mkStrip');
      if (!box) return;
      const active = state.campaigns.filter((c) => c.status === 'active');
      const spend = state.campaigns.reduce(
        (s, c) => s + ((c.rollup && c.rollup.actualCost) || 0), 0);
      const reach = state.campaigns.reduce(
        (s, c) => s + ((c.rollup && c.rollup.reach) || 0), 0);
      // Campaigns still missing numbers somebody has to type in. Surfaced up
      // top because an incomplete rollup is invisible otherwise, and every
      // figure beside it is quietly understated.
      const gaps = state.campaigns.filter(
        (c) => c.rollup && !c.rollup.complete &&
          (c.status === 'active' || c.status === 'complete')).length;

      const tiles = [
        { v: active.length, l: 'Active now', cls: '' },
        { v: state.campaigns.length, l: 'Campaigns total', cls: '' },
        { v: money(spend) || '$0', l: 'Spend recorded', cls: '' },
        { v: reach.toLocaleString(), l: 'People reached', cls: '' },
        { v: gaps, l: 'Missing numbers', cls: gaps ? 'warn' : '' }
      ];
      box.innerHTML = tiles.map((t) => `
        <div class="mk-stat ${t.cls}">
          <div class="v">${esc(t.v)}</div><div class="l">${esc(t.l)}</div>
        </div>`).join('');
    }

    function channelSummary(c) {
      const items = c.channels || [];
      if (!items.length) return '<span class="who">no channels yet</span>';
      const counts = {};
      items.forEach((i) => { counts[i.type] = (counts[i.type] || 0) + 1; });
      return Object.keys(counts).map((k) => {
        const m = chanMeta(k);
        return `<span class="pill ${m.delegated ? 'src' : 'mute'}">${esc(m.label)}${
          counts[k] > 1 ? ' \u00d7' + counts[k] : ''}</span>`;
      }).join(' ');
    }

    function renderList() {
      const countEl = $('#mkCount');
      if (countEl) {
        countEl.textContent = state.campaigns.length
          ? state.campaigns.length + ' total' : 'none yet';
      }

      const box = $('#mkCampaignList');
      if (!box) return;

      if (!state.campaigns.length) {
        box.innerHTML = `
          <div class="mk-empty">
            <h4>No campaigns yet</h4>
            <div>A campaign is the whole push: the postcard, the booth, the ads and the
            email, together. Start one and add the channels as you plan them.</div>
          </div>`;
        return;
      }

      box.innerHTML = `
        <table class="mk-table">
          <thead><tr>
            <th>Campaign</th><th>Status</th><th>Runs</th><th>Channels</th>
            <th class="num">Spend</th><th class="num">Reach</th><th></th>
          </tr></thead>
          <tbody>
            ${state.campaigns.map((c) => {
              const st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.planning;
              const r = c.rollup || {};
              const dates = [c.startDate, c.endDate].filter(Boolean).map(fmtDate);
              return `
              <tr class="clickable" data-open="${esc(c.id)}">
                <td><div class="co">${esc(c.name)}</div>
                    <div class="who">${esc(c.id)}${c.initiative ? ' \u00b7 ' + esc(c.initiative) : ''}</div></td>
                <td><span class="pill ${st.cls}">${esc(st.label)}</span></td>
                <td class="who">${dates.length ? esc(dates.join(' to ')) : 'no dates set'}</td>
                <td>${channelSummary(c)}</td>
                <td class="num">${esc(money(r.actualCost) || '\u2014')}${
                  r.overBudget ? '<div class="who" style="color:var(--danger-dk)">over budget</div>' : ''}</td>
                <td class="num">${r.reach ? r.reach.toLocaleString() : '\u2014'}${
                  r.missingReach ? `<div class="who">${r.missingReach} not entered</div>` : ''}</td>
                <td style="text-align:right">
                  <button class="mk-btn ghost sm" data-open="${esc(c.id)}">Open</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      box.querySelectorAll('[data-open]').forEach((el) => {
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openCampaign(el.dataset.open);
        });
      });
    }

    async function openCampaign(id) {
      state.openId = id;
      state.detail = null;
      renderDetail();
      try {
        await loadDetail(id);
      } catch (e) {
        msg('#mkCampaignMsg', 'Could not open that campaign: ' + esc(e.message), 'mk-err');
        state.openId = null;
      }
      renderDetail();
    }

    function closeCampaign() {
      state.openId = null;
      state.detail = null;
      renderDetail();
      renderList();
    }

    /* ---------------- detail ---------------- */

    // A figure nobody entered renders as a dash, never a zero. "$0 spent" and
    // "nobody wrote down what it cost" look identical on a dashboard and mean
    // completely different things.
    function statTile(value, label, opts) {
      const o = opts || {};
      const unknown = value == null;
      return `
        <div class="mk-stat ${o.cls || ''}">
          <div class="v${unknown ? ' unknown' : ''}">${unknown ? 'not entered' : esc(value)}</div>
          <div class="l">${esc(label)}</div>
        </div>`;
    }

    function renderChannelRow(item, emails) {
      const m = chanMeta(item.type);
      const st = CHANNEL_STATUS[item.status] || CHANNEL_STATUS.planned;
      const linked = emails && emails.byChannel ? emails.byChannel[item.id] : null;
      const counted = item.status === 'in_progress' || item.status === 'done';

      let nums;
      if (m.delegated) {
        if (linked) {
          nums = `
            <span>Reach <b>${linked.reach.toLocaleString()}</b></span>
            <span>Clicks and replies <b>${linked.responses.toLocaleString()}</b></span>
            <span class="who">${linked.emails.length} email${linked.emails.length === 1 ? '' : 's'} in MailMe</span>`;
        } else {
          nums = counted
            ? '<span class="gap">No email in MailMe points at this yet</span>'
            : '<span class="who">Build the email in MailMe and attach it to this campaign</span>';
        }
      } else {
        const gap = (v) => v == null
          ? '<b class="gap">not entered</b>' : `<b>${v.toLocaleString()}</b>`;
        nums = `
          <span>Reach ${counted ? gap(item.reach) : '<b>\u2014</b>'}</span>
          <span>Responses ${counted ? gap(item.responses) : '<b>\u2014</b>'}</span>
          <span>Cost ${counted
            ? (item.actualCost == null ? '<b class="gap">not entered</b>' : `<b>${money(item.actualCost)}</b>`)
            : (item.plannedCost != null ? `<b>${money(item.plannedCost)} planned</b>` : '<b>\u2014</b>')}</span>`;
      }

      return `
        <div class="mk-chan${m.delegated ? ' delegated' : ''}">
          <div class="mk-chan-hd">
            <div>
              <div class="n">${esc(item.name)}</div>
              <div class="t">${esc(m.label)}${item.dueDate ? ' \u00b7 due ' + esc(fmtDate(item.dueDate)) : ''}</div>
            </div>
            <div class="mk-actions">
              <span class="pill ${st.cls}">${esc(st.label)}</span>
              ${state.canEdit ? `<button class="mk-btn ghost sm" data-editch="${esc(item.id)}">Edit</button>` : ''}
              ${state.canEdit ? `<button class="mk-btn ghost sm" data-delch="${esc(item.id)}">Remove</button>` : ''}
            </div>
          </div>
          <div class="mk-chan-nums">${nums}</div>
          ${item.notes ? `<div class="who" style="margin-top:8px">${esc(item.notes)}</div>` : ''}
        </div>`;
    }

    function renderDetail() {
      const listPane = $('#mkListPane');
      const pane = $('#mkDetailPane');
      if (!listPane || !pane) return;

      if (!state.openId) {
        pane.hidden = true; pane.innerHTML = '';
        listPane.hidden = false;
        return;
      }
      listPane.hidden = true;
      pane.hidden = false;

      if (!state.detail) {
        pane.innerHTML = '<div class="mk-card"><div class="mk-card-bd">Loading...</div></div>';
        return;
      }

      const c = state.detail.campaign;
      const r = state.detail.rollup || {};
      const emails = state.detail.emails || {};
      const st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.planning;
      const dates = [c.startDate, c.endDate].filter(Boolean).map(fmtDate);

      // The honest-numbers banner. It is the first thing on the page when it
      // applies, because everything below it is understated by exactly the
      // amount nobody typed in.
      const gapNote = (r.missingReach || r.missingCost) ? `
        <div class="mk-notice">
          <b>These numbers are incomplete.</b>
          ${r.missingReach ? `${r.missingReach} channel${r.missingReach === 1 ? ' has' : 's have'} no reach entered. ` : ''}
          ${r.missingCost ? `${r.missingCost} ${r.missingCost === 1 ? 'has' : 'have'} no cost entered. ` : ''}
          Everything below counts only what was filled in, so the totals are a floor,
          not the real figure.
        </div>` : '';

      const budgetNote = r.overBudget ? `
        <div class="mk-notice danger">
          <b>Over budget.</b> ${esc(money(r.actualCost))} spent against a
          ${esc(money(r.budget))} budget.
        </div>` : '';

      const emailNote = emails.unavailable ? `
        <div class="mk-notice">
          <b>MailMe is not answering right now.</b> Email reach is missing from these
          totals. Everything else on this page is unaffected.
        </div>` : '';

      pane.innerHTML = `
        <div class="mk-hd">
          <div>
            <h1>${esc(c.name)}<span class="dot">.</span></h1>
            <div class="sub">${esc(c.id)}
              ${dates.length ? ' \u00b7 ' + esc(dates.join(' to ')) : ''}
              ${c.owner ? ' \u00b7 ' + esc(c.owner) : ''}</div>
          </div>
          <div class="mk-refresh">
            <span class="pill ${st.cls}">${esc(st.label)}</span>
            <button class="mk-btn ghost" id="mkBack">Back</button>
            ${state.canEdit ? '<button class="mk-btn ghost" id="mkEditCampaign">Edit</button>' : ''}
            ${state.canEdit ? '<button class="mk-btn" id="mkAddChannel">Add a channel</button>' : ''}
          </div>
        </div>
        <div id="mkDetailMsg"></div>
        ${gapNote}${budgetNote}${emailNote}

        ${c.goal ? `<div class="mk-card"><div class="mk-card-bd">
          <div class="mk-field" style="margin:0"><label>Goal</label>
          <div style="font-size:13px;line-height:1.6">${esc(c.goal)}</div></div>
        </div></div>` : ''}

        <div class="mk-stat-row">
          ${statTile(r.reach ? r.reach.toLocaleString() : (r.countedCount ? '0' : null), 'People reached')}
          ${statTile(r.responses ? r.responses.toLocaleString() : (r.countedCount ? '0' : null), 'Responses')}
          ${statTile(r.responseRate != null ? r.responseRate + '%' : null, 'Response rate')}
          ${statTile(money(r.actualCost) || (r.countedCount ? '$0' : null), 'Spent',
            { cls: r.overBudget ? 'bad' : '' })}
          ${statTile(money(r.budget), 'Budget')}
          ${statTile(r.costPerResponse != null ? money(r.costPerResponse) : null, 'Cost per response')}
        </div>

        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>Channels</h3>
            <span class="meta">${(c.channels || []).length} planned${
              r.skippedCount ? `, ${r.skippedCount} skipped` : ''}</span>
          </div>
          <div class="mk-card-bd">
            ${(c.channels || []).length
              ? (c.channels || []).map((i) => renderChannelRow(i, emails)).join('')
              : `<div class="mk-empty"><h4>No channels yet</h4>
                   <div>Add the postcard drop, the booth, the ads, the email. Each one
                   carries its own cost and its own result.</div></div>`}
          </div>
        </div>

        ${c.notes ? `<div class="mk-card">
          <div class="mk-card-hd"><h3>Notes</h3></div>
          <div class="mk-card-bd" style="font-size:13px;line-height:1.6;white-space:pre-wrap">${esc(c.notes)}</div>
        </div>` : ''}

        ${state.canDelete ? `<div class="mk-actions">
          <button class="mk-btn ghost" id="mkDeleteCampaign">Delete this campaign</button>
        </div>` : ''}`;

      const wire = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
      wire('#mkBack', closeCampaign);
      wire('#mkEditCampaign', () => openCampaignForm(c));
      wire('#mkAddChannel', () => openChannelForm(null));
      wire('#mkDeleteCampaign', deleteCampaign);

      pane.querySelectorAll('[data-editch]').forEach((b) => {
        b.addEventListener('click', () => {
          const item = (c.channels || []).find((x) => x.id === b.dataset.editch);
          if (item) openChannelForm(item);
        });
      });
      pane.querySelectorAll('[data-delch]').forEach((b) => {
        b.addEventListener('click', () => removeChannel(b.dataset.delch));
      });
    }

    /* ---------------- campaign form ---------------- */

    function openCampaignForm(existing) {
      const c = existing || {};
      const inits = state.initiatives || [];
      openModal(`
        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>${c.id ? 'Edit campaign' : 'New campaign'}</h3>
            ${c.id ? `<span class="meta">${esc(c.id)}</span>` : ''}
          </div>
          <div class="mk-card-bd">
            <div id="mkFormMsg"></div>
            <div class="mk-grid">
              <div class="mk-field full">
                <label for="mkName">Name</label>
                <input id="mkName" type="text" value="${esc(c.name || '')}"
                       placeholder="Spring school spirit wear push">
              </div>
              <div class="mk-field full">
                <label for="mkGoal">Goal</label>
                <textarea id="mkGoal" placeholder="What is this campaign supposed to achieve?">${esc(c.goal || '')}</textarea>
                <div class="hint">Worth writing plainly. In six months this is the only
                  record of what you were trying to do, and it is what makes the numbers
                  below mean anything.</div>
              </div>
              <div class="mk-field">
                <label for="mkStatus">Status</label>
                <select id="mkStatus">
                  ${Object.keys(CAMPAIGN_STATUS).map((k) => `
                    <option value="${k}"${(c.status || 'planning') === k ? ' selected' : ''}
                      >${esc(CAMPAIGN_STATUS[k].label)}</option>`).join('')}
                </select>
              </div>
              <div class="mk-field">
                <label for="mkInitiative">Initiative</label>
                <input id="mkInitiative" type="text" list="mkInitOpts"
                       value="${esc(c.initiative || '')}" placeholder="Optional">
                <datalist id="mkInitOpts">
                  ${inits.map((i) => `<option value="${esc(i)}"></option>`).join('')}
                </datalist>
                <div class="hint">The same list BackBone tags leads with, so a campaign
                  and the leads it produced can be matched up later.</div>
              </div>
              <div class="mk-field">
                <label for="mkIndustry">Industry</label>
                <select id="mkIndustry">
                  <option value="">Not set</option>
                  ${(state.industries || []).map((i) => `<option value="${esc(i)}"${
                    String(c.industry || '') === i ? ' selected' : ''
                  }>${esc(i)}</option>`).join('')}
                </select>
                <div class="hint">Who this campaign was aimed at. It sits on the campaign
                  rather than on each week's numbers, because a campaign has one audience
                  by definition: a push going to schools and to dental practices is two
                  campaigns with two budgets and two answers to whether it worked.</div>
              </div>
              <div class="mk-field">
                <label for="mkStart">Starts</label>
                <input id="mkStart" type="date" value="${esc(c.startDate || '')}">
              </div>
              <div class="mk-field">
                <label for="mkEnd">Ends</label>
                <input id="mkEnd" type="date" value="${esc(c.endDate || '')}">
              </div>
              <div class="mk-field">
                <label for="mkBudget">Budget</label>
                <input id="mkBudget" type="number" min="0" step="1"
                       value="${c.budget != null ? c.budget : ''}" placeholder="Optional">
              </div>
              <div class="mk-field">
                <label for="mkOwner">Owner</label>
                <input id="mkOwner" type="text" value="${esc(c.owner || '')}"
                       placeholder="Who is running this">
              </div>
              <div class="mk-field full">
                <label for="mkNotes">Notes</label>
                <textarea id="mkNotes">${esc(c.notes || '')}</textarea>
              </div>
            </div>
            <div class="mk-actions">
              <button class="mk-btn" id="mkSaveCampaign">Save</button>
              <button class="mk-btn ghost" id="mkCancelCampaign">Cancel</button>
            </div>
          </div>
        </div>`, 'campaign');

      $('#mkSaveCampaign').addEventListener('click', () => saveCampaign(c.id));
      $('#mkCancelCampaign').addEventListener('click', () => closeModalIf('campaign'));
      $('#mkName').focus();
    }

    async function saveCampaign(id) {
      const val = (sel) => ($(sel) ? $(sel).value.trim() : '');
      const payload = {
        name: val('#mkName'),
        goal: val('#mkGoal'),
        status: val('#mkStatus'),
        initiative: val('#mkInitiative'),
        industry: val('#mkIndustry') || null,
        startDate: val('#mkStart') || null,
        endDate: val('#mkEnd') || null,
        budget: val('#mkBudget') === '' ? null : val('#mkBudget'),
        owner: val('#mkOwner'),
        notes: val('#mkNotes')
      };
      if (!payload.name) {
        msg('#mkFormMsg', 'A campaign needs a name.', 'mk-err');
        return;
      }
      try {
        const res = id
          ? await api.patch(ENDPOINTS.mkCampaigns, { id, ...payload })
          : await api.post(ENDPOINTS.mkCampaigns, payload);
        closeModalIf('campaign');
        await loadCampaigns();
        // Land on the campaign that was just saved rather than back on the
        // list looking for it.
        await openCampaign((res.campaign && res.campaign.id) || id);
        renderStrip(); renderList();
      } catch (e) {
        msg('#mkFormMsg', esc(e.message), 'mk-err');
      }
    }

    async function deleteCampaign() {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      if (!window.confirm(
        `Delete ${c.name}?\n\nThis holds the spend record for work that actually ` +
        'happened, and it is the only place it was written down. This cannot be undone.')) return;
      try {
        await api.del(ENDPOINTS.mkCampaigns, { query: { id: c.id } });
        await loadCampaigns();
        closeCampaign();
        renderStrip(); renderList();
        msg('#mkCampaignMsg', 'Campaign deleted.', 'mk-ok');
      } catch (e) {
        detailMsg('Could not delete: ' + esc(e.message), 'mk-err');
      }
    }

    /* ---------------- channel form ---------------- */

    function openChannelForm(existing) {
      const it = existing || {};
      const type = it.type || 'direct_mail';
      const delegated = isDelegated(type);

      openModal(`
        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>${it.id ? 'Edit channel' : 'Add a channel'}</h3>
          </div>
          <div class="mk-card-bd">
            <div id="mkChanMsg"></div>
            <div class="mk-grid">
              <div class="mk-field">
                <label for="mkChanType">Channel</label>
                <select id="mkChanType"${it.id ? ' disabled' : ''}>
                  ${CHANNELS.map((ch) => `
                    <option value="${ch.key}"${type === ch.key ? ' selected' : ''}
                      >${esc(ch.label)}</option>`).join('')}
                </select>
                <div class="hint" id="mkChanNote"></div>
              </div>
              <div class="mk-field">
                <label for="mkChanName">Name it</label>
                <input id="mkChanName" type="text" value="${esc(it.name || '')}"
                       placeholder="e.g. 5,000 postcard drop">
              </div>
              <div class="mk-field">
                <label for="mkChanStatus">Status</label>
                <select id="mkChanStatus">
                  ${Object.keys(CHANNEL_STATUS).map((k) => `
                    <option value="${k}"${(it.status || 'planned') === k ? ' selected' : ''}
                      >${esc(CHANNEL_STATUS[k].label)}</option>`).join('')}
                </select>
                <div class="hint">Skipped means it never happened, and it is left out of
                  the totals entirely rather than counted as a zero.</div>
              </div>
              <div class="mk-field">
                <label for="mkChanDue">Due</label>
                <input id="mkChanDue" type="date" value="${esc(it.dueDate || '')}">
              </div>
              <div class="mk-field">
                <label for="mkChanPlanned">Planned cost</label>
                <input id="mkChanPlanned" type="number" min="0" step="1"
                       value="${it.plannedCost != null ? it.plannedCost : ''}">
              </div>
            </div>

            <div id="mkChanActuals" ${delegated ? 'hidden' : ''}>
              <div class="mk-grid">
                <div class="mk-field">
                  <label for="mkChanActual">Actual cost</label>
                  <input id="mkChanActual" type="number" min="0" step="1"
                         value="${it.actualCost != null ? it.actualCost : ''}">
                </div>
                <div class="mk-field">
                  <label for="mkChanReach">Reach</label>
                  <input id="mkChanReach" type="number" min="0" step="1"
                         value="${it.reach != null ? it.reach : ''}"
                         placeholder="How many people saw it">
                </div>
                <div class="mk-field">
                  <label for="mkChanResponses">Responses</label>
                  <input id="mkChanResponses" type="number" min="0" step="1"
                         value="${it.responses != null ? it.responses : ''}"
                         placeholder="Calls, quotes, orders">
                </div>
              </div>
              <div class="hint" style="margin:-4px 0 14px">
                Leave a box blank if nobody knows the number. Blank is reported as a gap;
                typing a zero says it genuinely reached nobody, which is a different claim.
              </div>
            </div>

            <div id="mkChanDelegatedNote" ${delegated ? '' : 'hidden'}>
              <div class="mk-notice good" style="margin-bottom:14px">
                <b>Email numbers come from MailMe.</b> There is nothing to type in here.
                Build the email in MailMe, attach it to this campaign, and its delivered
                count and click-throughs appear against this channel automatically.
              </div>
            </div>

            <div class="mk-field">
              <label for="mkChanNotes">Notes</label>
              <textarea id="mkChanNotes">${esc(it.notes || '')}</textarea>
            </div>

            <div class="mk-actions">
              <button class="mk-btn" id="mkSaveChan">Save</button>
              <button class="mk-btn ghost" id="mkCancelChan">Cancel</button>
            </div>
          </div>
        </div>`, 'channel');

      const typeSel = $('#mkChanType');
      const paintType = () => {
        const meta = chanMeta(typeSel.value);
        const note = $('#mkChanNote');
        if (note) note.textContent = meta.note;
        const actuals = $('#mkChanActuals');
        const deleg = $('#mkChanDelegatedNote');
        if (actuals) actuals.hidden = !!meta.delegated;
        if (deleg) deleg.hidden = !meta.delegated;
        const nameEl = $('#mkChanName');
        if (nameEl && !nameEl.value) nameEl.placeholder = meta.label;
      };
      typeSel.addEventListener('change', paintType);
      paintType();

      $('#mkSaveChan').addEventListener('click', () => saveChannel(it.id));
      $('#mkCancelChan').addEventListener('click', () => closeModalIf('channel'));
    }

    // Channels are saved by writing the WHOLE array back, which is how the
    // API models them. The array is rebuilt from the currently loaded
    // campaign, so a stale copy cannot resurrect a channel someone else
    // removed in between.
    async function saveChannel(id) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      const val = (sel) => ($(sel) ? $(sel).value.trim() : '');
      const numOrNull = (sel) => (val(sel) === '' ? null : Number(val(sel)));

      const type = val('#mkChanType');
      const item = {
        id: id || undefined,
        type,
        name: val('#mkChanName') || chanMeta(type).label,
        status: val('#mkChanStatus'),
        dueDate: val('#mkChanDue') || null,
        plannedCost: numOrNull('#mkChanPlanned'),
        actualCost: isDelegated(type) ? null : numOrNull('#mkChanActual'),
        reach: isDelegated(type) ? null : numOrNull('#mkChanReach'),
        responses: isDelegated(type) ? null : numOrNull('#mkChanResponses'),
        notes: val('#mkChanNotes')
      };

      const channels = (c.channels || []).slice();
      const idx = id ? channels.findIndex((x) => x.id === id) : -1;
      if (idx >= 0) channels[idx] = { ...channels[idx], ...item };
      else channels.push(item);

      try {
        await api.patch(ENDPOINTS.mkCampaigns, { id: c.id, channels });
        closeModalIf('channel');
        await loadDetail(c.id);
        await loadCampaigns();
        renderDetail(); renderStrip();
      } catch (e) {
        msg('#mkChanMsg', esc(e.message), 'mk-err');
      }
    }

    async function removeChannel(chId) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      const item = (c.channels || []).find((x) => x.id === chId);
      if (!item) return;
      if (!window.confirm(
        `Remove "${item.name}" from this campaign?\n\n` +
        'If it was planned and never happened, setting it to Skipped is usually better: ' +
        'that keeps the record that it was considered.')) return;
      try {
        const channels = (c.channels || []).filter((x) => x.id !== chId);
        await api.patch(ENDPOINTS.mkCampaigns, { id: c.id, channels });
        await loadDetail(c.id);
        await loadCampaigns();
        renderDetail(); renderStrip();
      } catch (e) {
        detailMsg('Could not remove that channel: ' + esc(e.message), 'mk-err');
      }
    }

    /* ---------------- calendar ----------------
     *
     * Every channel item with a due date, across every campaign, in one list.
     * The point is the overdue block at the top: a postcard drop that quietly
     * slipped three weeks is invisible inside its own campaign and obvious
     * here.
     */

    function renderCalendar() {
      const box = $('#mkCalendarBody');
      if (!box) return;

      const today = new Date().toISOString().slice(0, 10);
      const rows = [];
      state.campaigns.forEach((c) => {
        if (c.status === 'cancelled') return;
        (c.channels || []).forEach((it) => {
          if (!it.dueDate) return;
          if (it.status === 'done' || it.status === 'skipped') return;
          rows.push({ campaign: c, item: it, overdue: it.dueDate < today });
        });
      });
      rows.sort((a, b) => a.item.dueDate.localeCompare(b.item.dueDate));

      if (!rows.length) {
        box.innerHTML = `
          <div class="mk-card"><div class="mk-card-bd">
            <div class="mk-empty"><h4>Nothing scheduled</h4>
              <div>Channel items with a due date show up here until they are marked done
              or skipped. Nothing is outstanding right now.</div></div>
          </div></div>`;
        return;
      }

      const overdue = rows.filter((r) => r.overdue);
      const upcoming = rows.filter((r) => !r.overdue);

      const table = (list) => `
        <table class="mk-table">
          <thead><tr><th>Due</th><th>What</th><th>Campaign</th><th>Status</th></tr></thead>
          <tbody>${list.map((r) => `
            <tr class="clickable" data-goto="${esc(r.campaign.id)}">
              <td class="who">${esc(fmtDate(r.item.dueDate))}</td>
              <td><div class="co">${esc(r.item.name)}</div>
                  <div class="who">${esc(chanMeta(r.item.type).label)}</div></td>
              <td>${esc(r.campaign.name)}</td>
              <td><span class="pill ${(CHANNEL_STATUS[r.item.status] || CHANNEL_STATUS.planned).cls}"
                    >${esc((CHANNEL_STATUS[r.item.status] || CHANNEL_STATUS.planned).label)}</span></td>
            </tr>`).join('')}</tbody>
        </table>`;

      box.innerHTML = `
        ${overdue.length ? `
          <div class="mk-card">
            <div class="mk-card-hd"><h3>Overdue</h3>
              <span class="meta">${overdue.length} past due</span></div>
            <div class="mk-card-bd flush">${table(overdue)}</div>
          </div>` : ''}
        ${upcoming.length ? `
          <div class="mk-card">
            <div class="mk-card-hd"><h3>Coming up</h3>
              <span class="meta">${upcoming.length} scheduled</span></div>
            <div class="mk-card-bd flush">${table(upcoming)}</div>
          </div>` : ''}`;

      box.querySelectorAll('[data-goto]').forEach((tr) => {
        tr.addEventListener('click', () => {
          ctx.go('campaigns');
          openCampaign(tr.dataset.goto);
        });
      });
    }

    /* ---------------- settings ---------------- */

    function renderSettings() {
      const box = $('#mkSettingsBody');
      if (!box) return;
      const list = state.initiatives || [];

      box.innerHTML = `
        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>Marketing initiatives</h3>
            <span class="meta">${list.length} in the list</span>
          </div>
          <div class="mk-card-bd">
            <div class="hint" style="font-size:12.5px;color:var(--muted);line-height:1.55;margin-bottom:14px">
              This is the Step Library list. BackBone tags every lead with one of these,
              and campaigns here use the same names, so a campaign and the leads it
              produced can be matched up later. It used to be five placeholder values
              hardcoded in BackBone; editing it here changes it everywhere, with no deploy.
            </div>
            <div class="mk-field">
              <label for="mkInitList">One per line</label>
              <textarea id="mkInitList" style="min-height:180px"${state.canEdit ? '' : ' disabled'}
                >${esc(list.join('\n'))}</textarea>
              <div class="hint">Renaming an entry changes what every lead already tagged
                with it appears to say. Adding and removing is safe; renaming is worth a
                moment's thought.</div>
            </div>
            ${state.canEdit ? `<div class="mk-actions">
              <button class="mk-btn" id="mkSaveInits">Save the list</button>
            </div>` : '<div class="hint">Your role is read-only here.</div>'}
          </div>
        </div>`;

      const inds = state.industries || [];
      box.insertAdjacentHTML('beforeend', `
        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>Industries</h3>
            <span class="meta">${inds.length} in the list</span>
          </div>
          <div class="mk-card-bd">
            <div class="hint" style="font-size:12.5px;color:var(--muted);line-height:1.55;margin-bottom:14px">
              The segments campaigns are aimed at. A picked list rather than a typed one,
              because "Dental", "dental" and "Dental &amp; Ortho" typed into three campaigns
              are three segments as far as any rollup is concerned.
            </div>
            <div class="mk-field">
              <label for="mkIndList">One per line</label>
              <textarea id="mkIndList" style="min-height:150px"${state.canEdit ? '' : ' disabled'}
                >${esc(inds.join('\n'))}</textarea>
            </div>
            ${state.canEdit ? `<div class="mk-actions">
              <button class="mk-btn" id="mkSaveInds">Save the list</button>
            </div>` : ''}
          </div>
        </div>`);

      const b = $('#mkSaveInits');
      if (b) b.addEventListener('click', saveInitiatives);
      const b2 = $('#mkSaveInds');
      if (b2) b2.addEventListener('click', saveIndustries);
    }

    async function saveIndustries() {
      const el = $('#mkIndList');
      if (!el) return;
      const industries = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      try {
        const d = await api.put(ENDPOINTS.mkIndustries, { industries });
        state.industries = d.industries || industries;
        renderSettings();
        msg('#mkSettingsMsg', 'Saved.', 'mk-ok');
      } catch (e) {
        msg('#mkSettingsMsg', 'Could not save: ' + esc(e.message), 'mk-err');
      }
    }

    async function saveInitiatives() {
      const el = $('#mkInitList');
      if (!el) return;
      const initiatives = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      try {
        const d = await api.put(ENDPOINTS.mkInitiatives, { initiatives });
        state.initiatives = d.initiatives || initiatives;
        renderSettings();
        msg('#mkSettingsMsg', 'Saved. BackBone picks this up on its next load.', 'mk-ok');
      } catch (e) {
        msg('#mkSettingsMsg', 'Could not save: ' + esc(e.message), 'mk-err');
      }
    }

    /* ---------------- modal machinery ---------------- */

    function openModal(innerHtml, kind) {
      closeModal();
      const back = document.createElement('div');
      back.className = 'mk-modal-back';
      back.innerHTML = `<div class="mk-modal" role="dialog" aria-modal="true">
        <button class="mk-modal-x" id="mkModalX" aria-label="Close">&times;</button>
        <div id="mkModalBody">${innerHtml}</div></div>`;
      back.addEventListener('click', (ev) => { if (ev.target === back) closeModal(); });
      back.querySelector('#mkModalX').addEventListener('click', closeModal);
      document.addEventListener('keydown', escClose);
      // App styles are scoped to the app root, so a bare body child would
      // render unstyled. The carrier holds the attribute that keeps every
      // .mk-* rule matching while still escaping the app root's stacking
      // context.
      const carrier = document.createElement('div');
      carrier.dataset.appRoot = 'marketmachine';
      carrier.appendChild(back);
      document.body.appendChild(carrier);
      modalCarrier = carrier;
      modalKind = kind || null;
      document.body.style.overflow = 'hidden';
    }

    function escClose(ev) { if (ev.key === 'Escape') closeModal(); }

    function closeModal() {
      if (modalCarrier) { modalCarrier.remove(); modalCarrier = null; }
      modalKind = null;
      document.removeEventListener('keydown', escClose);
      document.body.style.overflow = '';
    }
    this._closeModal = closeModal;

    // Close only if what is on screen is what the caller thinks it is, so a
    // background repaint cannot tear down an unrelated modal.
    function closeModalIf(kind) { if (modalKind === kind) closeModal(); }

    /* ---------------- data entry ---------------- */

    // Channels that take hand-entered numbers. Email is excluded at the
    // source rather than hidden in the dropdown, because MailMe already knows
    // exactly who received what, and a typed email row would be a second set
    // of numbers guaranteed to disagree with the first.
    const ENTERABLE = CHANNELS.filter((c) => !c.delegated);

    function entryCampaign() {
      return state.campaigns.find((c) => String(c.id) === String(state.entryCampaignId)) || null;
    }

    function renderEntry() {
      const box = $('#mkEntryBody');
      if (!box) return;

      if (!state.campaigns.length) {
        box.innerHTML = `<div class="mk-card"><div class="mk-card-bd">
          <div class="hint">There are no campaigns yet. Numbers have to belong to
          something, so create a campaign first and the rows will have somewhere
          to go.</div></div></div>`;
        return;
      }
      if (!state.entryCampaignId) state.entryCampaignId = String(state.campaigns[0].id);

      const camp = entryCampaign() || {};
      const channel = CHANNEL_KEYS.includes(state.entryChannel) && !isDelegated(state.entryChannel)
        ? state.entryChannel : 'social';
      const meta = chanMeta(channel);
      const keys = channelMetrics(channel);
      const creatives = Array.isArray(camp.creatives) ? camp.creatives : [];

      const metricInputs = keys.map((k) => {
        const m = metricMeta(k) || { label: k, kind: 'count' };
        return `<div class="mk-field">
          <label for="mkM_${k}">${esc(metricLabel(channel, k, m.label))}</label>
          <input id="mkM_${k}" data-metric="${k}" type="number" min="0"
            ${m.kind === 'money' ? 'step="0.01"' : 'step="1"'}
            placeholder="not reported" inputmode="decimal">
        </div>`;
      }).join('');

      box.innerHTML = `
        <div class="mk-card">
          <div class="mk-card-hd">
            <h3>Record identity</h3>
            <span class="meta">Manual now, CSV and connectors later, same fields</span>
          </div>
          <div class="mk-card-bd">
            <div class="mk-grid">
              <div class="mk-field">
                <label for="mkEntryCampaign">Campaign</label>
                <select id="mkEntryCampaign">
                  ${state.campaigns.map((c) => `<option value="${esc(c.id)}"${
                    String(c.id) === String(state.entryCampaignId) ? ' selected' : ''
                  }>${esc(c.name)}</option>`).join('')}
                </select>
                <div class="hint">Picked from the real list, never typed. Two spellings
                  of one campaign name would split every total it appears in.</div>
              </div>
              <div class="mk-field">
                <label for="mkEntryChannel">Channel</label>
                <select id="mkEntryChannel">
                  ${ENTERABLE.map((c) => `<option value="${esc(c.key)}"${
                    c.key === channel ? ' selected' : ''
                  }>${esc(c.label)}</option>`).join('')}
                </select>
                <div class="hint">${esc(meta.note || '')}</div>
              </div>
              <div class="mk-field">
                <label for="mkEntryPlatform">Platform</label>
                <input id="mkEntryPlatform" list="mkPlatformList" placeholder="Facebook, radio, county fair...">
                <datalist id="mkPlatformList">
                  ${PLATFORMS.map((pl) => `<option value="${esc(pl)}"></option>`).join('')}
                </datalist>
              </div>
              ${isFunded(channel) ? `<div class="mk-field">
                <label for="mkEntryFunding">Organic or paid</label>
                <select id="mkEntryFunding">
                  ${FUNDING.map((f) => `<option value="${f}">${f === 'organic' ? 'Organic' : 'Paid'}</option>`).join('')}
                </select>
                <div class="hint">A flag, not a separate channel: the same Facebook push
                  often runs both, and splitting it in two made neither half comparable.</div>
              </div>` : ''}
              <div class="mk-field">
                <label for="mkEntryCreative">Content / ad name</label>
                <input id="mkEntryCreative" list="mkCreativeList" placeholder="Dental sample kit - carousel A">
                <datalist id="mkCreativeList">
                  ${creatives.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}
                </datalist>
                <div class="hint">Matched to an existing name on this campaign, or added
                  as a new one. That is what makes carousel A comparable to carousel B
                  across every week they both ran.</div>
              </div>
              <div class="mk-field">
                <label for="mkEntryStart">Start date</label>
                <input id="mkEntryStart" type="date">
              </div>
              <div class="mk-field">
                <label for="mkEntryEnd">End date</label>
                <input id="mkEntryEnd" type="date">
                <div class="hint">One row per week or per flight, not one row for the
                  whole run. A single lump cannot show you it stopped working.</div>
              </div>
            </div>

            <div class="mk-sub-hd" style="margin-top:8px">What was measured</div>
            <div class="mk-metrics">${metricInputs}</div>
            <div class="hint" style="margin-top:10px">
              Leave a box empty if nobody reported it. Empty means not reported and
              stays out of every total; a typed 0 means it really was zero. They are
              different facts and the app keeps them apart.
            </div>
            <div class="hint" style="margin-top:6px">
              ${esc(DERIVED_METRICS.map((d) => d.label).join(', '))} are calculated and
              are never typed by hand.
            </div>

            <div class="mk-await">
              <span class="pill">Awaiting sources</span>
              <div class="mk-sub-hd">Conversions and revenue</div>
              <div class="hint" style="margin-bottom:10px">These are already part of every
                row and stay empty until GA4, Printavo or an ad account is connected.
                They are deliberately not typeable: a revenue figure somebody remembers
                is not a revenue figure, and once it sits in the same column as a real
                one nobody can tell them apart again.</div>
              <div class="mk-metrics">
                ${SOURCED_FIELDS.map((f) => `<div class="slot">${esc(f.label)}
                  <div style="font-size:11px;margin-top:2px">waiting on ${esc(f.awaiting)}</div>
                </div>`).join('')}
              </div>
            </div>

            <div class="mk-actions">
              <button class="mk-btn ghost" id="mkEntryClear">Clear</button>
              <button class="mk-btn" id="mkEntrySave"${state.canEdit ? '' : ' disabled'}>Save and calculate</button>
            </div>
            ${state.canEdit ? '' : '<div class="hint">Your role is read-only in MarketMachine.</div>'}
            <div id="mkEntryCalc"></div>
          </div>
        </div>

        ${renderEntryTotals()}
        ${renderBreakdown('By creative', state.byCreative, (r) => r.name)}
        ${renderBreakdown('By platform', state.byPlatform, (r) => r.platform)}
        ${renderEntryRows()}`;

      wireEntry();
    }

    function derivedStrip(derived) {
      if (!derived) return '';
      const flags = derived._flags || {};
      const cells = DERIVED_METRICS.filter((d) => d.key !== 'revenue' || derived.revenue != null)
        .map((d) => `<div class="d"><div class="k">${esc(d.label)}</div>
          <div class="v">${fmtMetric(d.kind, derived[d.key])}</div></div>`).join('');
      const notes = [];
      if (flags.engagementPartial) {
        notes.push('Engagement is partial: only some of likes, comments and shares were entered, ' +
          'so the total is what was reported and the rate is withheld rather than understated.');
      }
      if (flags.responseRateImpossible) {
        notes.push('More responses than inquiries were recorded, which cannot happen. ' +
          'That usually means the two figures cover different date ranges.');
      }
      if (derived.revenueSourceLabel) {
        notes.push('Revenue is taken from ' + derived.revenueSourceLabel + '.');
      }
      return `<div class="mk-derived">${cells}</div>` +
        (notes.length ? `<div class="hint" style="margin-top:10px">${esc(notes.join(' '))}</div>` : '');
    }

    function renderEntryTotals() {
      const t = state.entryTotals;
      if (!t || !t.rowCount) return '';
      const gaps = (t.partialMetrics || []).map((k) => (metricMeta(k) || {}).label || k);
      return `<div class="mk-card">
        <div class="mk-card-hd">
          <h3>Campaign totals</h3>
          <span class="meta">${t.rowCount} row${t.rowCount === 1 ? '' : 's'}</span>
        </div>
        <div class="mk-card-bd">
          <div class="mk-derived">
            ${TYPED_METRICS.map((m) => `<div class="d"><div class="k">${esc(m.label)}</div>
              <div class="v">${fmtMetric(m.kind, t.metrics[m.key])}</div></div>`).join('')}
          </div>
          <div style="margin-top:16px">${derivedStrip(t.derived)}</div>
          ${gaps.length ? `<div class="hint" style="margin-top:10px">
            Reported on some rows and left blank on others: ${esc(gaps.join(', '))}.
            The totals above are what was actually reported, not an estimate of the rest.
          </div>` : ''}
        </div>
      </div>`;
    }

    function renderBreakdown(title, rows, nameFn) {
      if (!rows || !rows.length) return '';
      return `<div class="mk-card">
        <div class="mk-card-hd"><h3>${esc(title)}</h3>
          <span class="meta">sorted by what produced inquiries</span></div>
        <div class="mk-card-bd flush">
          <table class="mk-rows">
            <thead><tr>
              <th>Name</th><th class="num">Spend</th><th class="num">Reach</th>
              <th class="num">Inquiries</th><th class="num">Cost per inquiry</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => {
                const inq = r.metrics.inboundInquiries;
                const spend = r.metrics.spend;
                // Computed here rather than stored, and null unless BOTH sides
                // are real: spend with no inquiries is not an infinite cost, it
                // is an unanswered question.
                const cpi = (spend != null && inq != null && inq > 0)
                  ? Math.round((spend / inq) * 100) / 100 : null;
                return `<tr>
                  <td>${esc(nameFn(r))}${r.missing ? ' <span class="mk-null">(deleted creative)</span>' : ''}</td>
                  <td class="num">${fmtMetric('money', spend)}</td>
                  <td class="num">${fmtMetric('count', r.metrics.reach)}</td>
                  <td class="num">${fmtMetric('count', inq)}</td>
                  <td class="num">${fmtMetric('money', cpi)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }

    function renderEntryRows() {
      if (!state.entries.length) {
        return `<div class="mk-card"><div class="mk-card-bd">
          <div class="hint">No rows for this campaign yet.</div></div></div>`;
      }
      return `<div class="mk-card">
        <div class="mk-card-hd"><h3>Rows</h3>
          <span class="meta">${state.entries.length} entered</span></div>
        <div class="mk-card-bd flush">
          <table class="mk-rows">
            <thead><tr>
              <th>Period</th><th>Channel</th><th>Platform</th><th>Creative</th>
              <th class="num">Spend</th><th class="num">Reach</th><th class="num">Inquiries</th>
              <th>Source</th><th></th>
            </tr></thead>
            <tbody>
              ${state.entries.map((e) => {
                const cr = (entryCampaign() || {}).creatives || [];
                const name = (cr.find((c) => c.id === e.creativeId) || {}).name;
                const period = e.startDate
                  ? fmtDate(e.startDate) + (e.endDate && e.endDate !== e.startDate ? ' to ' + fmtDate(e.endDate) : '')
                  : '<span class="mk-null">undated</span>';
                return `<tr>
                  <td>${period}</td>
                  <td>${esc(chanMeta(e.channel).label)}${
                    e.funding ? ' <span class="mk-null">' + esc(e.funding) + '</span>' : ''}</td>
                  <td>${e.platform ? esc(e.platform) : NOT_REPORTED}</td>
                  <td>${name ? esc(name) : NOT_REPORTED}</td>
                  <td class="num">${fmtMetric('money', e.metrics.spend)}</td>
                  <td class="num">${fmtMetric('count', e.metrics.reach)}</td>
                  <td class="num">${fmtMetric('count', e.metrics.inboundInquiries)}</td>
                  <td>${esc(e.source)}</td>
                  <td class="num">${state.canEdit
                    ? `<button class="mk-btn ghost sm" data-del-entry="${esc(e.id)}">Remove</button>` : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }

    /**
     * Turn a typed creative name into a real creative on the campaign.
     *
     * Matching is case-insensitive and whitespace-trimmed, because "Carousel
     * A" and "carousel a" are one piece of artwork and treating them as two
     * defeats the entire point of rolling up by creative.
     */
    async function ensureCreative(campaign, typed) {
      const name = String(typed || '').trim();
      if (!name || !campaign) return null;
      const existing = (campaign.creatives || [])
        .find((c) => String(c.name).trim().toLowerCase() === name.toLowerCase());
      if (existing) return existing.id;
      const creatives = (campaign.creatives || []).concat([{ name }]);
      const d = await api.patch(ENDPOINTS.mkCampaigns, { id: campaign.id, creatives });
      const saved = ((d && d.campaign && d.campaign.creatives) || [])
        .find((c) => String(c.name).trim().toLowerCase() === name.toLowerCase());
      // The campaign in local state is replaced so the datalist offers the new
      // name immediately, without a round trip nobody asked for.
      if (d && d.campaign) {
        const i = state.campaigns.findIndex((c) => String(c.id) === String(campaign.id));
        if (i >= 0) state.campaigns[i] = { ...state.campaigns[i], creatives: d.campaign.creatives };
      }
      return saved ? saved.id : null;
    }

    function wireEntry() {
      const campSel = $('#mkEntryCampaign');
      if (campSel) campSel.addEventListener('change', async () => {
        state.entryCampaignId = campSel.value;
        state.lastSavedDerived = null;
        try { await loadEntries(); } catch (e) { /* stale beats blank */ }
        renderEntry();
      });

      const chanSel = $('#mkEntryChannel');
      // Re-rendered on change rather than showing every field and hiding some:
      // a trade show row asked for video views gets a zero typed in to make the
      // form go away, and that zero is then indistinguishable from a real one.
      if (chanSel) chanSel.addEventListener('change', () => {
        state.entryChannel = chanSel.value;
        renderEntry();
      });

      const clear = $('#mkEntryClear');
      if (clear) clear.addEventListener('click', () => {
        state.lastSavedDerived = null;
        renderEntry();
      });

      const save = $('#mkEntrySave');
      if (save) save.addEventListener('click', saveEntry);

      root.querySelectorAll('[data-del-entry]').forEach((b) => {
        b.addEventListener('click', () => removeEntry(b.dataset.delEntry));
      });
    }

    async function saveEntry() {
      const btn = $('#mkEntrySave');
      const camp = entryCampaign();
      if (!camp) return;

      const metrics = {};
      let anyEntered = false;
      root.querySelectorAll('#mkEntryBody [data-metric]').forEach((el) => {
        const raw = String(el.value == null ? '' : el.value).trim();
        // Blank stays blank all the way down. Coercing it to 0 here would be
        // the single easiest way to undo the whole point of this screen.
        metrics[el.dataset.metric] = raw === '' ? null : Number(raw);
        if (raw !== '') anyEntered = true;
      });

      if (!anyEntered) {
        msg('#mkEntryMsg', 'Nothing was entered, so there is nothing to save.', 'mk-err');
        return;
      }

      const val = (sel) => { const el = $(sel); return el ? String(el.value || '').trim() : ''; };
      const start = val('#mkEntryStart');
      const end = val('#mkEntryEnd');
      if (start && end && end < start) {
        msg('#mkEntryMsg', 'The end date is before the start date.', 'mk-err');
        return;
      }

      if (btn) btn.disabled = true;
      try {
        const creativeId = await ensureCreative(camp, val('#mkEntryCreative'));
        const payload = {
          campaignId: camp.id,
          channel: state.entryChannel,
          platform: val('#mkEntryPlatform') || null,
          funding: isFunded(state.entryChannel) ? (val('#mkEntryFunding') || 'organic') : null,
          creativeId,
          startDate: start || null,
          endDate: end || start || null,
          metrics,
          source: 'manual'
        };
        const d = await api.post(ENDPOINTS.mkEntries, payload);
        state.lastSavedDerived = (d && d.entry && d.entry.derived) || null;
        await loadEntries();
        // The campaign list carries the rollup, and a row that just changed a
        // campaign's spend has to be reflected there or the two screens
        // disagree the moment somebody switches between them.
        try { await loadCampaigns(); } catch (e) { /* the row still saved */ }
        renderEntry();
        const calc = $('#mkEntryCalc');
        if (calc && state.lastSavedDerived) {
          calc.innerHTML = `<div class="mk-sub-hd" style="margin-top:18px">Calculated from what you just entered</div>`
            + derivedStrip(state.lastSavedDerived);
        }
        msg('#mkEntryMsg', 'Saved.', 'mk-ok');
      } catch (e) {
        msg('#mkEntryMsg', 'Could not save: ' + esc(e.message), 'mk-err');
      } finally {
        const b2 = $('#mkEntrySave');
        if (b2) b2.disabled = !state.canEdit;
      }
    }

    async function removeEntry(id) {
      if (!id) return;
      try {
        await api.del(ENDPOINTS.mkEntries, { query: { campaignId: state.entryCampaignId, id } });
        await loadEntries();
        try { await loadCampaigns(); } catch (e) { /* the row is still gone */ }
        renderEntry();
        msg('#mkEntryMsg', 'Row removed.', 'mk-ok');
      } catch (e) {
        msg('#mkEntryMsg', 'Could not remove that row: ' + esc(e.message), 'mk-err');
      }
    }

    /* ---------------- definitions ---------------- */

    /**
     * Built from the metric catalog rather than written out here.
     *
     * A definitions page maintained by hand is a definitions page that is
     * wrong within a month, and a wrong one is worse than none: it settles
     * arguments in the wrong direction with an air of authority. Generating it
     * from the same constants the maths uses means it cannot drift.
     */
    function renderDefinitions() {
      const box = $('#mkDefsBody');
      if (!box) return;

      const section = (title, blurb, items) => `<div class="mk-card">
        <div class="mk-card-hd"><h3>${esc(title)}</h3></div>
        <div class="mk-card-bd">
          <div class="hint" style="margin-bottom:6px">${blurb}</div>
          <dl class="mk-defs">${items}</dl>
        </div>
      </div>`;

      const typed = TYPED_METRICS.map((m) => `<dt>${esc(m.label)}</dt>
        <dd>${esc(m.def)}</dd>`).join('');

      const derived = DERIVED_METRICS.map((m) => `<dt>${esc(m.label)}
        <span class="calc">${esc(m.formula)}</span></dt>
        <dd>${esc(m.def)}</dd>`).join('');

      const sourced = SOURCED_FIELDS.map((f) => `<dt>${esc(f.label)}</dt>
        <dd>${esc(f.def)} Currently empty on every row, waiting on ${esc(f.awaiting)}.</dd>`).join('');

      const channels = CHANNELS.map((c) => {
        const ks = channelMetrics(c.key);
        return `<dt>${esc(c.label)}</dt><dd>${esc(c.note)}${
          c.delegated
            ? ' Numbers come back from MailMe and cannot be entered by hand here.'
            : ' Fields on this channel: ' + esc(ks.map((k) => metricLabel(c.key, k, (metricMeta(k) || {}).label)).join(', ')) + '.'
        }</dd>`;
      }).join('');

      box.innerHTML = `
        <div class="mk-card">
          <div class="mk-card-hd"><h3>The two rules everything else follows</h3></div>
          <div class="mk-card-bd">
            <dl class="mk-defs">
              <dt>A number is either typed or calculated, never both</dt>
              <dd>Spend, reach and impressions are things somebody observed, so a person
                types them. Rates are arithmetic on those facts, so nobody types them.
                If two people could type two different click-through rates for the same
                week, this app would have two answers to one question and no way to say
                which was right.</dd>
              <dt>Missing is not zero</dt>
              <dd>An empty box means nobody reported it, and it stays out of every total.
                A typed 0 means it really was zero. A response rate of 0% says we reached
                people and none answered; a blank says nobody has entered the numbers.
                Folding the second into the first makes every report quietly pessimistic,
                and the mistake is invisible because both print the same width.</dd>
              <dt>Revenue has an order of precedence</dt>
              <dd>Verified revenue first, then GA4, then whatever the ad platform claims.
                The three will disagree, so the app fixes the order in advance and always
                names which one a figure came from.</dd>
            </dl>
          </div>
        </div>
        ${section('Typed by hand', 'Observed facts. Somebody counted these or read them off a platform.', typed)}
        ${section('Calculated', 'Never typed, never stored. Recalculated every time from the raw counts above, so they cannot fall out of step with them.', derived)}
        ${section('Waiting on a source', 'Already part of every record, deliberately empty until something real fills them.', sourced)}
        ${section('Channels', 'Which fields each channel asks for, and why the list is different for each.', channels)}`;
    }

    /* ---------------- refresh ---------------- */

    const VIEW_LOADERS = {
      // The campaign form offers the initiative list, so it loads here too.
      campaigns: [loadCampaigns, loadInitiatives],
      calendar: [loadCampaigns],
      // Data Entry needs the campaign list for its picker and the rows for the
      // campaign currently chosen. Definitions needs nothing: it is generated
      // from constants, so there is nothing to go stale.
      entry: [loadCampaigns, loadEntries],
      settings: [loadInitiatives, loadIndustries]
    };

    const REPAINT = {
      campaigns: () => {
        renderStrip();
        renderList();
        // Do not rebuild the detail pane while a modal over it is open: it
        // would rebuild inputs from state and wipe anything half-typed.
        if (!modalCarrier) renderDetail();
      },
      calendar: () => renderCalendar(),
      entry: () => renderEntry(),
      definitions: () => renderDefinitions(),
      settings: () => renderSettings()
    };

    function stampText() {
      if (!state.lastLoaded) return '';
      const secs = Math.round((Date.now() - state.lastLoaded) / 1000);
      if (secs < 45) return 'Updated just now';
      const mins = Math.round(secs / 60);
      if (mins < 60) return 'Updated ' + mins + ' min ago';
      return 'Updated ' + new Date(state.lastLoaded).toLocaleTimeString();
    }

    function paintStamps() {
      root.querySelectorAll('[data-mk-stamp]').forEach((el) => {
        el.textContent = state.refreshing ? 'Refreshing...' : stampText();
      });
      root.querySelectorAll('[data-mk-refresh]').forEach((b) => { b.disabled = state.refreshing; });
    }

    async function refreshView(view, opts) {
      const loaders = VIEW_LOADERS[view] || [];
      if (REPAINT[view]) REPAINT[view]();
      if (!loaders.length || state.refreshing) { paintStamps(); return; }

      state.refreshing = true;
      paintStamps();
      try {
        await Promise.all(loaders.map((fn) => fn()));
        // An open campaign is refetched too, or its rollup silently lags the
        // list it was opened from.
        if (view === 'campaigns' && state.openId) await loadDetail(state.openId);
        state.lastLoaded = Date.now();
        if (REPAINT[view]) REPAINT[view]();
        if (opts && opts.announce) msg(opts.announce, 'Refreshed.', 'mk-ok');
      } catch (e) {
        // A failed refresh keeps the previous numbers. Stale beats blank, and
        // the stamp says which it is.
        if (opts && opts.announce) {
          msg(opts.announce, 'Could not refresh: ' + esc(e.message), 'mk-err');
        }
      } finally {
        state.refreshing = false;
        paintStamps();
      }
    }

    /* ---------------- boot ---------------- */

    const newBtn = $('#mkNewCampaign');
    if (newBtn) newBtn.addEventListener('click', () => openCampaignForm(null));

    root.querySelectorAll('[data-mk-refresh]').forEach((b) => {
      b.addEventListener('click', () => {
        const view = b.dataset.mkRefresh;
        refreshView(view, { announce: MSG_TARGET[view] });
      });
    });

    try {
      await Promise.all([loadCampaigns(), loadInitiatives(), loadIndustries()]);
    } catch (e) {
      msg('#mkCampaignMsg', 'Could not load MarketMachine: ' + esc(e.message), 'mk-err');
    }

    renderStrip();
    renderList();
    renderDetail();
    renderCalendar();
    renderEntry();
    renderDefinitions();
    renderSettings();

    if (newBtn) newBtn.disabled = !state.canEdit;

    this._stampTimer = setInterval(paintStamps, 30000);
    state.lastLoaded = Date.now();
    paintStamps();

    this._renders = {
      campaigns: () => refreshView('campaigns'),
      calendar: () => refreshView('calendar'),
      entry: () => refreshView('entry'),
      definitions: () => renderDefinitions(),
      settings: () => refreshView('settings')
    };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    // Modals attach to <body>, so they do not vanish on their own when the
    // view changes and would otherwise be stranded over an unrelated screen.
    if (this._closeModal) this._closeModal();
    const ids = {
      campaigns: 'mkCampaignsView',
      calendar: 'mkCalendarView',
      entry: 'mkEntryView',
      definitions: 'mkDefinitionsView',
      settings: 'mkSettingsView'
    };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    if (this._stampTimer) { clearInterval(this._stampTimer); this._stampTimer = null; }
    if (this._closeModal) { this._closeModal(); this._closeModal = null; }
  }
};
