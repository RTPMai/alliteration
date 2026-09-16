// PUT IN: apps/marketmachine.js
/**
 * MarketMachine — every campaign, run as an ordered checklist.
 *
 * REBUILT Sept 2026, phase 1 of the plan Ryan approved from Jacob's handoff.
 * The old app recorded campaigns and hand-typed channel numbers. This one
 * runs the work: pick a campaign type, and the type lays out its steps in the
 * order they really happen, across six stages. Every step shows who owns it,
 * when it is due, a done box, the date it was done, and notes.
 *
 * WHAT A PERSON SEES FIRST on a campaign is the handoff's rule: where it
 * stands, the next step, its owner, its due date, and anything blocking it.
 * The checklist sits underneath, top to bottom, in the order the team works.
 *
 * WHAT LIVES ELSEWHERE, deliberately:
 *   - the rules (what can be marked done, when a campaign can close, what a
 *     connected campaign inherits) are in lib/marketmachine/campaign.js, and
 *     the server enforces them. This screen reads the same file so it never
 *     offers a button the server will refuse.
 *   - the campaign types and their steps are in lib/marketmachine/catalog.js.
 *
 * Admin only for now (Ryan's call). The server enforces it; this screen just
 * explains it when somebody else opens the app.
 *
 * No fetch() here: everything goes through ctx.api and ENDPOINTS, per the
 * seam rule. No hex colors: tokens.css owns theming via data-app.
 */

import { ENDPOINTS } from '../js/api.js';
import {
  STAGES, CAMPAIGN_TYPES, FAMILIES, typeMeta, connectableTypes, typesByUse
} from '../lib/marketmachine/catalog.js';
import {
  progress, headerDates, ownerFor, unmetDependencies, PARTICIPATION
} from '../lib/marketmachine/campaign.js';
import { dueDateFor, timingLabel, todayCentral } from '../lib/marketmachine/dates.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const PARTICIPATION_LABEL = {
  exhibitor: 'Exhibitor', attendee: 'Attendee', hybrid: 'Hybrid', not_attending: 'Do not attend'
};

function statusClass(label) {
  if (label === 'Complete') return 'ok';
  if (label === 'Cancelled') return 'mute';
  if (label === 'Not started') return 'mute';
  if (label === 'Ready to close') return 'ok';
  if (label === 'In prelaunch review') return 'src';
  return 'warn';
}

export default {
  id: 'marketmachine',

  styles: `
  .mk-page{padding:24px 32px 60px;max-width:1280px}
  .mk-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:18px;flex-wrap:wrap;gap:12px}
  .mk-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mk-hd .sub{font-size:13px;color:var(--muted);margin-top:3px;max-width:62ch}

  .mk-btn{background:var(--accent);color:var(--on-accent);border:1px solid var(--accent);
    border-radius:var(--radius-sm);padding:7px 14px;font-size:13px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:var(--speed)}
  .mk-btn:hover{background:var(--accent-deep);border-color:var(--accent-deep)}
  .mk-btn:focus-visible,.mk-link:focus-visible,.mk-check:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mk-btn[disabled]{opacity:.5;cursor:not-allowed}
  .mk-btn.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  .mk-btn.ghost:hover{color:var(--ink);background:var(--row-hover)}
  .mk-btn.sm{padding:4px 10px;font-size:12px}
  .mk-btn.danger{background:transparent;color:var(--danger-dk);border-color:var(--danger-line)}
  .mk-btn.danger:hover{background:var(--danger-tint)}
  .mk-link{background:none;border:0;padding:0;color:var(--accent-deep);font:inherit;
    cursor:pointer;text-decoration:underline;text-underline-offset:2px}

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
  .mk-table th{text-align:left;font-size:12px;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mk-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
  .mk-table tr.clickable{cursor:pointer}
  .mk-table tr.clickable:hover td{background:var(--row-hover)}
  .mk-table .co{font-weight:600;color:var(--ink)}
  .mk-table .who{color:var(--faint);font-size:12px;margin-top:2px}
  .mk-table .late{color:var(--danger-dk);font-weight:600}
  .mk-wrap{overflow-x:auto}

  .mk-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
    gap:12px;margin-bottom:16px}
  .mk-stat{background:var(--head-bg);border-radius:var(--radius-sm);padding:12px 14px}
  .mk-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .mk-stat .l{font-size:12px;color:var(--muted);margin-top:3px;font-weight:600}
  .mk-stat.bad .v{color:var(--danger-dk)}
  .mk-stat.warn .v{color:var(--warn-dk)}

  .mk-notice{background:var(--warn-tint);border-left:3px solid var(--warn);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:13px;
    color:var(--warn-dk);line-height:1.55;margin-bottom:16px}
  .mk-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:13px;
    color:var(--danger-dk);margin-bottom:14px}
  .mk-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:13px;color:var(--success-dk);margin-bottom:14px;font-weight:600}

  .mk-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
  .mk-filters label{display:block;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:4px}
  .mk-filters select{padding:7px 9px;border:1px solid var(--line);border-radius:var(--radius-sm);
    font:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mk-seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden}
  .mk-seg button{background:var(--card);border:0;padding:7px 12px;font:inherit;font-size:13px;
    color:var(--muted);cursor:pointer}
  .mk-seg button+button{border-left:1px solid var(--line)}
  .mk-seg button[aria-pressed="true"]{background:var(--accent-tint);color:var(--accent-deep);font-weight:700}

  .mk-field{margin-bottom:14px}
  .mk-field label,.mk-field .lbl{display:block;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mk-field .hint{font-size:12px;color:var(--faint);margin:-2px 0 6px;line-height:1.5}
  .mk-field input[type=text],.mk-field input[type=date],.mk-field input[type=url],
  .mk-field textarea,.mk-field select{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mk-field textarea{min-height:72px;resize:vertical;line-height:1.6}
  .mk-field input:focus,.mk-field textarea:focus,.mk-field select:focus{
    outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .mk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 16px}
  .mk-grid .full{grid-column:1/-1}
  .mk-radio{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:8px}
  .mk-radio label{display:flex;gap:6px;align-items:center;font-weight:500;color:var(--ink);margin:0}

  .mk-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .mk-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;line-height:1.6}
  .mk-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}

  /* New campaign: type picker */
  .mk-types{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
  .mk-type{text-align:left;background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-sm);padding:12px 14px;cursor:pointer;font:inherit;color:var(--ink)}
  .mk-type:hover{border-color:var(--accent);background:var(--accent-tint)}
  .mk-type .n{font-weight:700;font-size:13.5px}
  .mk-type .s{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45}
  .mk-type .u{font-size:11.5px;color:var(--faint);margin-top:6px}
  .mk-type-group{font-size:12px;font-weight:700;color:var(--muted);margin:16px 0 8px}

  /* Campaign header */
  .mk-head{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px 22px}
  .mk-head .k{font-size:12px;color:var(--muted);font-weight:700}
  .mk-head .v{font-size:13.5px;color:var(--ink);margin-top:2px}
  .mk-head .v.none{color:var(--faint);font-style:italic}

  .mk-now{border-left:4px solid var(--accent);background:var(--accent-tint);
    border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:18px}
  .mk-now .k{font-size:12px;font-weight:700;color:var(--accent-deep)}
  .mk-now .step{font-size:16px;font-weight:700;color:var(--ink);margin:3px 0 6px}
  .mk-now .facts{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
  .mk-now .facts b{color:var(--ink)}
  .mk-now .late{color:var(--danger-dk);font-weight:700}
  .mk-now.done{border-left-color:var(--success);background:var(--success-tint)}

  /* The six stages: the one strong element on the page. It is a real
     sequence, so it is numbered. */
  .mk-stages{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;
    margin-bottom:20px;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;background:var(--card)}
  .mk-stage-tab{position:relative;padding:12px 12px 12px 14px;text-align:left;background:var(--card);
    border:0;border-right:1px solid var(--line-soft);font:inherit;cursor:pointer;color:var(--ink)}
  .mk-stage-tab:last-child{border-right:0}
  .mk-stage-tab .num{font-size:22px;font-weight:800;letter-spacing:-.03em;color:var(--faint);line-height:1}
  .mk-stage-tab .nm{font-size:12.5px;font-weight:700;margin-top:6px}
  .mk-stage-tab .ct{font-size:12px;color:var(--muted);margin-top:2px}
  .mk-stage-tab .bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--line-soft)}
  .mk-stage-tab .bar i{display:block;height:100%;background:var(--accent)}
  .mk-stage-tab.done .num{color:var(--success)}
  .mk-stage-tab.done .bar i{background:var(--success)}
  .mk-stage-tab.current{background:var(--accent-tint)}
  .mk-stage-tab.current .num{color:var(--accent)}
  .mk-stage-tab:hover{background:var(--row-hover)}
  @media (max-width:860px){.mk-stages{grid-template-columns:repeat(3,minmax(0,1fr))}
    .mk-stage-tab:nth-child(3){border-right:0}.mk-stage-tab:nth-child(-n+3){border-bottom:1px solid var(--line-soft)}}
  @media (max-width:480px){.mk-stages{grid-template-columns:repeat(2,minmax(0,1fr))}}

  .mk-stage{margin-bottom:22px;scroll-margin-top:80px}
  .mk-stage-hd{display:flex;gap:12px;align-items:baseline;margin-bottom:4px}
  .mk-stage-hd h2{font-size:17px;font-weight:800;letter-spacing:-.01em}
  .mk-stage-hd .ct{font-size:12.5px;color:var(--muted)}
  .mk-stage .about{font-size:13px;color:var(--muted);margin-bottom:10px;max-width:72ch}
  .mk-stage .nothing{font-size:13px;color:var(--faint);font-style:italic;padding:6px 0 4px}

  .mk-step{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);margin-bottom:8px}
  .mk-step.is-done{background:var(--head-bg)}
  .mk-step.is-done .lbl{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--faint)}
  .mk-step.is-na .lbl{color:var(--faint)}
  .mk-step.is-late{border-color:var(--danger-line)}
  .mk-step-row{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:start;padding:11px 12px}
  .mk-check{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent);cursor:pointer}
  .mk-check[disabled]{cursor:not-allowed}
  .mk-step .lbl{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.4}
  .mk-step .help{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5;max-width:78ch}
  .mk-step .facts{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:6px}
  .mk-step .facts b{color:var(--ink);font-weight:600}
  .mk-step .facts .late{color:var(--danger-dk);font-weight:700}
  .mk-step .wait{font-size:12.5px;color:var(--warn-dk);margin-top:6px}
  .mk-step .blocker{font-size:12.5px;color:var(--danger-dk);margin-top:6px;font-weight:600}
  .mk-step .noted{font-size:12.5px;color:var(--ink);margin-top:6px;white-space:pre-wrap;
    background:var(--head-bg);border-radius:var(--radius-sm);padding:6px 9px}
  .mk-step-side{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .mk-step-more{border-top:1px solid var(--line-soft);padding:12px 12px 4px 50px}
  @media (max-width:640px){.mk-step-row{grid-template-columns:28px 1fr}.mk-step-side{grid-column:2;justify-content:flex-start}
    .mk-step-more{padding-left:12px}}

  .mk-history{font-size:12.5px;color:var(--muted);line-height:1.6;max-height:280px;overflow:auto}
  .mk-history div{padding:3px 0;border-bottom:1px solid var(--line-soft)}
  .mk-history b{color:var(--ink);font-weight:600}

  .mk-steps-ref{font-size:13px}
  .mk-steps-ref details{border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:8px;background:var(--card)}
  .mk-steps-ref summary{padding:10px 14px;cursor:pointer;font-weight:700}
  .mk-steps-ref summary span{color:var(--muted);font-weight:500;margin-left:8px}
  .mk-steps-ref ol{margin:0;padding:4px 18px 12px 40px}
  .mk-steps-ref li{padding:3px 0;line-height:1.45}
  .mk-steps-ref .st{font-size:12px;font-weight:700;color:var(--muted);margin:10px 14px 2px}
  .mk-steps-ref .o{color:var(--muted);font-size:12px}

  .mk-tl-month{margin-bottom:18px}
  .mk-tl-month h3{font-size:14px;font-weight:800;margin-bottom:8px}
  .mk-tl-row{display:grid;grid-template-columns:110px 170px 1fr auto;gap:10px;align-items:baseline;
    padding:8px 12px;border-bottom:1px solid var(--line-soft);font-size:13px;cursor:pointer}
  .mk-tl-row:hover{background:var(--row-hover)}
  .mk-tl-row .d{font-variant-numeric:tabular-nums;color:var(--muted)}
  .mk-tl-row .w{font-weight:600;color:var(--accent-deep)}
  @media (max-width:640px){.mk-tl-row{grid-template-columns:1fr}}
  `,

  template: `
    <div class="mk-page">
      <section id="mkCampaignsView" hidden>
        <div id="mkListPane"></div>
        <div id="mkNewPane" hidden></div>
        <div id="mkDetailPane" hidden></div>
      </section>
      <section id="mkCalendarView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Timeline<span class="dot">.</span></h1>
            <div class="sub">Launch dates and review dates across every campaign, by month, quarter, or year.</div>
          </div>
        </div>
        <div id="mkTimelineBody"></div>
      </section>
      <section id="mkSettingsView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Settings<span class="dot">.</span></h1>
            <div class="sub">The campaign types and their steps, the BackBone lead list, and old sample data.</div>
          </div>
        </div>
        <div id="mkSettingsBody"></div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const api = ctx.api;
    const $ = (sel) => root.querySelector(sel);
    this._root = root;

    const state = {
      campaigns: [],
      accountManagers: [],
      amUnavailable: false,
      me: null,
      legacyCount: 0,
      limited: false,
      limitedMessage: '',
      loadError: '',
      today: todayCentral(),

      filters: { show: 'open', whose: 'all', type: '', am: '' },

      pane: 'list',          // list | new | detail
      detail: null,          // { campaign, parent, children, emails }
      openStep: null,        // step key whose details are expanded
      stepMsg: {},           // step key -> { cls, text }
      detailMsg: null,
      editingHeader: false,

      newParentId: null,
      newType: null,
      newMsg: null,

      tl: { span: 'month', anchor: todayCentral().slice(0, 7) + '-01', type: '', am: '' },

      initiatives: [],
      settingsMsg: null,
    };
    this._state = state;

    /* ---------------- data ---------------- */

    async function loadList() {
      try {
        const d = await api.get(ENDPOINTS.mkCampaigns);
        if (d && d.limited) {
          state.limited = true;
          state.limitedMessage = d.message || 'MarketMachine is admin only for now.';
          state.campaigns = [];
          return;
        }
        state.limited = false;
        state.loadError = '';
        state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
        state.accountManagers = Array.isArray(d && d.accountManagers) ? d.accountManagers : [];
        state.amUnavailable = !!(d && d.accountManagersUnavailable);
        state.me = (d && d.me) || null;
        state.legacyCount = Number((d && d.legacyCount) || 0);
        if (d && d.today) state.today = d.today;
      } catch (e) {
        state.loadError = e.message || 'Campaigns did not load.';
      }
    }

    async function loadDetail(id) {
      const d = await api.get(ENDPOINTS.mkCampaigns, { id });
      state.detail = {
        campaign: d.campaign,
        parent: d.parent || null,
        children: Array.isArray(d.children) ? d.children : [],
        emails: d.emails || { emails: [], unavailable: false },
      };
      if (Array.isArray(d.accountManagers)) state.accountManagers = d.accountManagers;
      if (d.today) state.today = d.today;
    }

    async function loadInitiatives() {
      try {
        const d = await api.get(ENDPOINTS.mkInitiatives);
        state.initiatives = Array.isArray(d && d.initiatives) ? d.initiatives : [];
      } catch (e) {
        state.initiatives = [];
      }
    }

    const msgBox = (m) => m ? `<div class="${m.cls === 'ok' ? 'mk-ok' : 'mk-err'}">${esc(m.text)}</div>` : '';

    function limitedScreen() {
      return `
        <div class="mk-hd"><div><h1>MarketMachine<span class="dot">.</span></h1></div></div>
        <div class="mk-notice">${esc(state.limitedMessage)} An Admin can open campaigns and their checklists.
          Emails in MailMe can still be attached to a campaign by name.</div>`;
    }

    /* ---------------- list ---------------- */

    function filtered() {
      const f = state.filters;
      return state.campaigns.filter((c) => {
        if (f.show === 'open' && c.status !== 'open') return false;
        if (f.show === 'closed' && c.status === 'open') return false;
        if (f.whose === 'mine' && !c.mine) return false;
        if (f.type && c.type !== f.type) return false;
        if (f.am && String(c.accountManagerId || '') !== f.am) return false;
        return true;
      }).sort((a, b) => {
        if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
        const ad = (a.progress && a.progress.next && a.progress.next.due) || '9999';
        const bd = (b.progress && b.progress.next && b.progress.next.due) || '9999';
        if (ad !== bd) return ad < bd ? -1 : 1;
        return String(a.controlDate || '9999').localeCompare(String(b.controlDate || '9999'));
      });
    }

    function nameOf(id) {
      const c = state.campaigns.find((x) => x.id === id);
      return c ? c.name : id;
    }

    function amOptions(selected, blankLabel) {
      const opts = state.accountManagers.slice();
      if (selected && !opts.some((a) => a.id === selected)) {
        const known = state.campaigns.find((c) => c.accountManagerId === selected);
        opts.push({ id: selected, name: (known && known.accountManagerName) || 'Former Account Manager' });
      }
      return `<option value="">${esc(blankLabel || 'Nobody yet')}</option>` +
        opts.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    }

    function renderList() {
      const pane = $('#mkListPane');
      if (!pane) return;
      if (state.limited) { pane.innerHTML = limitedScreen(); return; }

      const open = state.campaigns.filter((c) => c.status === 'open');
      const overdue = open.reduce((n, c) => n + ((c.progress && c.progress.overdue) || 0), 0);
      const blocked = open.filter((c) => c.progress && c.progress.blocked).length;
      const inReview = open.filter((c) => c.progress && c.progress.next && c.progress.next.key === 'prelaunch_review').length;
      const rows = filtered();
      const f = state.filters;
      const typeOptions = CAMPAIGN_TYPES.map((t) =>
        `<option value="${esc(t.key)}"${f.type === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('');

      pane.innerHTML = `
        <div class="mk-hd">
          <div>
            <h1>Campaigns<span class="dot">.</span></h1>
            <div class="sub">Every campaign, its next step, who owns it, and when it is due.</div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn ghost sm" data-act="refresh">Refresh</button>
            <button class="mk-btn" data-act="new">New campaign</button>
          </div>
        </div>
        ${state.loadError ? `<div class="mk-err">${esc(state.loadError)}</div>` : ''}
        <div class="mk-stat-row">
          <div class="mk-stat"><div class="v">${open.length}</div><div class="l">Open campaigns</div></div>
          <div class="mk-stat${overdue ? ' bad' : ''}"><div class="v">${overdue}</div><div class="l">Overdue steps</div></div>
          <div class="mk-stat${blocked ? ' warn' : ''}"><div class="v">${blocked}</div><div class="l">Campaigns with a blocker</div></div>
          <div class="mk-stat"><div class="v">${inReview}</div><div class="l">Waiting on prelaunch review</div></div>
        </div>
        <div class="mk-filters">
          <div><label>Show</label>
            <div class="mk-seg" role="group" aria-label="Show">
              ${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) =>
                `<button data-show="${k}" aria-pressed="${f.show === k}">${l}</button>`).join('')}
            </div></div>
          <div><label>Whose</label>
            <div class="mk-seg" role="group" aria-label="Whose">
              ${[['all', 'Everyone'], ['mine', 'Mine']].map(([k, l]) =>
                `<button data-whose="${k}" aria-pressed="${f.whose === k}">${l}</button>`).join('')}
            </div></div>
          <div><label for="mkFType">Campaign type</label>
            <select id="mkFType"><option value="">All types</option>${typeOptions}</select></div>
          <div><label for="mkFAm">Account Manager</label>
            <select id="mkFAm">${amOptions(f.am, 'Everyone')}</select></div>
        </div>
        ${f.whose === 'mine' && !state.me ? `<div class="mk-notice">Mine shows campaigns you created.
          Your account is not linked to a CrewCore employee record, so campaigns where you are the
          Account Manager cannot be matched to you yet.</div>` : ''}
        <div class="mk-card">
          <div class="mk-card-bd flush mk-wrap">
            ${rows.length ? `
              <table class="mk-table">
                <thead><tr>
                  <th>Campaign</th><th>Account Manager</th><th>Date</th>
                  <th>Where it stands</th><th>Next step</th><th>Steps done</th>
                </tr></thead>
                <tbody>
                  ${rows.map((c) => {
                    const meta = typeMeta(c.type) || {};
                    const p = c.progress || {};
                    const nx = p.next;
                    const late = nx && nx.due && nx.due < state.today;
                    return `
                      <tr class="clickable" data-open="${esc(c.id)}" tabindex="0">
                        <td><div class="co">${esc(c.name)}</div>
                          <div class="who">${esc(meta.label || c.type)}${c.parentId ? `, connected to ${esc(nameOf(c.parentId))}` : ''}${c.childCount ? `, ${c.childCount} connected` : ''}</div></td>
                        <td>${c.accountManagerName ? esc(c.accountManagerName) : '<span class="who">Not set</span>'}</td>
                        <td>${c.controlDate ? esc(fmtDate(c.controlDate)) : '<span class="who">No date</span>'}
                          <div class="who">${esc(meta.controlLabel || '')}</div></td>
                        <td><span class="pill ${statusClass(p.label)}">${esc(p.label || '')}</span>
                          ${p.overdue ? `<div class="who late">${p.overdue} overdue</div>` : ''}
                          ${p.blocked ? `<div class="who late">Blocked</div>` : ''}</td>
                        <td>${nx ? `<div>${esc(nx.label)}</div>
                          <div class="who">${esc(nx.owner)}${nx.due ? `, due <span class="${late ? 'late' : ''}">${esc(fmtDate(nx.due))}</span>` : ''}</div>` : '<span class="who">Nothing open</span>'}</td>
                        <td>${p.done || 0} of ${p.total || 0}</td>
                      </tr>`;
                  }).join('')}
                </tbody>
              </table>` : `
              <div class="mk-empty">
                <h4>${state.campaigns.length ? 'No campaigns match these filters' : 'No campaigns yet'}</h4>
                ${state.campaigns.length ? 'Change the filters above to see more.' : 'Start one with New campaign. Pick the type and its checklist is laid out for you.'}
              </div>`}
          </div>
        </div>`;
    }

    /* ---------------- new campaign ---------------- */

    function renderNew() {
      const pane = $('#mkNewPane');
      if (!pane) return;
      const parent = state.newParentId ? state.campaigns.find((c) => c.id === state.newParentId) : null;
      const allowed = parent ? connectableTypes(parent.type) : null;

      if (!state.newType) {
        const ranked = typesByUse(state.campaigns).filter((t) => !allowed || allowed.includes(t.key));
        const used = ranked.filter((t) => t.uses > 0);
        const card = (t) => {
          const meta = typeMeta(t.key);
          return `<button class="mk-type" data-type="${esc(t.key)}">
            <div class="n">${esc(t.label)}</div>
            <div class="s">${esc(meta.summary)}</div>
            ${t.uses ? `<div class="u">Used ${t.uses} time${t.uses === 1 ? '' : 's'}</div>` : ''}
          </button>`;
        };
        let body;
        if (used.length || parent) {
          body = `<div class="mk-types">${ranked.map(card).join('')}</div>`;
        } else {
          body = FAMILIES.map((fam) => {
            const group = ranked.filter((t) => t.family === fam.key);
            return group.length ? `<div class="mk-type-group">${esc(fam.label)}</div>
              <div class="mk-types">${group.map(card).join('')}</div>` : '';
          }).join('');
        }
        pane.innerHTML = `
          <div class="mk-hd">
            <div>
              <h1>${parent ? 'Add a connected campaign' : 'New campaign'}<span class="dot">.</span></h1>
              <div class="sub">${parent
                ? `Connected campaigns under ${esc(parent.name)} keep their own owner, dates, audience, and checklist.`
                : 'Pick the type. Its steps are laid out in order once it is created.'}</div>
            </div>
            <div class="mk-actions"><button class="mk-btn ghost sm" data-act="cancel-new">Cancel</button></div>
          </div>
          ${body}`;
        return;
      }

      const meta = typeMeta(state.newType);
      const defaults = parent ? {
        name: `${parent.name}: ${meta.label}`,
        date: parent.controlDate || '',
        am: parent.accountManagerId || '',
      } : { name: '', date: '', am: '' };

      pane.innerHTML = `
        <div class="mk-hd">
          <div>
            <h1>${esc(meta.label)}<span class="dot">.</span></h1>
            <div class="sub">${esc(meta.summary)}</div>
          </div>
          <div class="mk-actions"><button class="mk-btn ghost sm" data-act="back-types">Pick a different type</button></div>
        </div>
        ${msgBox(state.newMsg)}
        <div class="mk-card"><div class="mk-card-bd">
          ${parent ? `<div class="mk-notice">Connected to <b>${esc(parent.name)}</b>. The name, date, and
            Account Manager start from the event. Change any of them here; later changes to the event do
            not overwrite this campaign.</div>` : ''}
          <div class="mk-grid">
            <div class="mk-field full">
              <label for="mkNName">Campaign name</label>
              <input type="text" id="mkNName" maxlength="120" value="${esc(defaults.name)}">
            </div>
            <div class="mk-field">
              <label for="mkNAm">Account Manager</label>
              <div class="hint">Required when a client, recipient, or sales follow-up is involved.</div>
              <select id="mkNAm">${amOptions(defaults.am)}</select>
              ${state.amUnavailable ? '<div class="hint">The account manager list could not be read from CrewCore just now.</div>' : ''}
            </div>
            <div class="mk-field">
              <label for="mkNDate">${esc(meta.controlLabel)}</label>
              <div class="hint">Due dates are suggested from this date. You can still move any of them.</div>
              <input type="date" id="mkNDate" value="${esc(defaults.date)}">
            </div>
            <div class="mk-field full">
              <span class="lbl">Audience</span>
              <div class="mk-radio">
                <label><input type="radio" name="mkNAudKind" value="list" checked> An exact list</label>
                <label><input type="radio" name="mkNAudKind" value="public"> A public audience</label>
              </div>
              <div class="hint">For a list, give the list or file name. For a public audience, describe who it is meant to reach.</div>
              <input type="text" id="mkNAudience" maxlength="500">
            </div>
            ${meta.parent ? `
              <div class="mk-field">
                <label for="mkNPart">Participation</label>
                <select id="mkNPart"><option value="">Not decided yet</option>
                  ${PARTICIPATION.map((p) => `<option value="${p}">${esc(PARTICIPATION_LABEL[p])}</option>`).join('')}
                </select>
              </div>
              <div class="mk-field">
                <label for="mkNBudget">Total budget</label>
                <input type="text" id="mkNBudget" inputmode="decimal" placeholder="Leave blank until approved">
              </div>` : ''}
            <div class="mk-field full">
              <label for="mkNNotes">Notes</label>
              <textarea id="mkNNotes" maxlength="4000"></textarea>
            </div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn" data-act="create">Create campaign</button>
            <button class="mk-btn ghost" data-act="cancel-new">Cancel</button>
          </div>
        </div></div>`;
    }

    async function createFromForm() {
      const val = (id) => { const el = $('#' + id); return el ? el.value : ''; };
      const kind = root.querySelector('input[name="mkNAudKind"]:checked');
      const amId = val('mkNAm');
      const am = state.accountManagers.find((a) => a.id === amId);
      const body = {
        type: state.newType,
        parentId: state.newParentId || undefined,
        name: val('mkNName'),
        accountManagerId: amId || null,
        accountManagerName: am ? am.name : null,
        controlDate: val('mkNDate') || null,
        audienceKind: kind ? kind.value : 'list',
        audience: val('mkNAudience'),
        notes: val('mkNNotes'),
      };
      if ($('#mkNPart')) body.participation = val('mkNPart') || null;
      if ($('#mkNBudget')) body.budget = val('mkNBudget');
      try {
        const d = await api.post(ENDPOINTS.mkCampaigns, body);
        state.newMsg = null;
        await loadList();
        await openCampaign(d.campaign.id);
      } catch (e) {
        state.newMsg = { cls: 'err', text: e.message || 'The campaign was not created.' };
        renderNew();
      }
    }

    /* ---------------- detail ---------------- */

    function showPane(which) {
      state.pane = which;
      const list = $('#mkListPane'), neu = $('#mkNewPane'), det = $('#mkDetailPane');
      if (list) list.hidden = which !== 'list';
      if (neu) neu.hidden = which !== 'new';
      if (det) det.hidden = which !== 'detail';
    }

    async function openCampaign(id) {
      state.openStep = null;
      state.stepMsg = {};
      state.detailMsg = null;
      state.editingHeader = false;
      showPane('detail');
      const det = $('#mkDetailPane');
      if (det) det.innerHTML = '<div class="mk-empty">Loading the campaign.</div>';
      try {
        await loadDetail(id);
        renderDetail();
        window.scrollTo(0, 0);
      } catch (e) {
        if (det) det.innerHTML = `<div class="mk-err">${esc(e.message || 'The campaign did not load.')}</div>
          <button class="mk-btn ghost" data-act="to-list">Back to campaigns</button>`;
      }
    }

    function headerView(c, meta, dates) {
      const v = (x) => x ? `<div class="v">${x}</div>` : '<div class="v none">Not set</div>';
      const audience = c.audience
        ? (c.audienceKind === 'public' ? 'Public audience: ' + esc(c.audience) : esc(c.audience))
        : '';
      return `
        <div class="mk-head">
          <div><div class="k">Campaign name and project number</div>${v(esc(c.name) + ' <span class="who">' + esc(c.id) + '</span>')}</div>
          <div><div class="k">Campaign type</div>${v(esc(meta.label || c.type))}</div>
          <div><div class="k">Account Manager</div>${v(esc(c.accountManagerName || ''))}</div>
          <div><div class="k">Approver</div>${v('Ryan or Megan')}</div>
          <div><div class="k">Audience</div>${v(audience)}</div>
          <div><div class="k">Working start date</div>${v(esc(fmtDate(dates.workingStart)))}</div>
          <div><div class="k">Prelaunch review date</div>${v(esc(fmtDate(dates.prelaunchReview)))}</div>
          <div><div class="k">${esc(meta.controlLabel || 'Launch date')}</div>${v(esc(fmtDate(dates.control)))}</div>
          <div><div class="k">Post-launch review date</div>${v(esc(fmtDate(dates.postLaunchReview)))}</div>
          ${meta.parent ? `
            <div><div class="k">Participation</div>${v(esc(PARTICIPATION_LABEL[c.participation] || ''))}</div>
            <div><div class="k">Total budget</div>${v(c.budget != null ? '$' + Number(c.budget).toLocaleString() : '')}</div>` : ''}
          ${c.notes ? `<div style="grid-column:1/-1"><div class="k">Notes</div><div class="v" style="white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}
        </div>`;
    }

    function headerForm(c, meta) {
      return `
        <div class="mk-grid">
          <div class="mk-field full"><label for="mkHName">Campaign name</label>
            <input type="text" id="mkHName" maxlength="120" value="${esc(c.name)}"></div>
          <div class="mk-field"><label for="mkHAm">Account Manager</label>
            <select id="mkHAm">${amOptions(c.accountManagerId || '')}</select></div>
          <div class="mk-field"><label for="mkHDate">${esc(meta.controlLabel)}</label>
            <div class="hint">Moving this moves every suggested due date. Dates somebody set by hand stay put.</div>
            <input type="date" id="mkHDate" value="${esc(c.controlDate || '')}"></div>
          <div class="mk-field full"><span class="lbl">Audience</span>
            <div class="mk-radio">
              <label><input type="radio" name="mkHAudKind" value="list"${c.audienceKind !== 'public' ? ' checked' : ''}> An exact list</label>
              <label><input type="radio" name="mkHAudKind" value="public"${c.audienceKind === 'public' ? ' checked' : ''}> A public audience</label>
            </div>
            <input type="text" id="mkHAudience" maxlength="500" value="${esc(c.audience || '')}"></div>
          ${meta.parent ? `
            <div class="mk-field"><label for="mkHPart">Participation</label>
              <select id="mkHPart"><option value="">Not decided yet</option>
                ${PARTICIPATION.map((p) => `<option value="${p}"${c.participation === p ? ' selected' : ''}>${esc(PARTICIPATION_LABEL[p])}</option>`).join('')}
              </select></div>
            <div class="mk-field"><label for="mkHBudget">Total budget</label>
              <input type="text" id="mkHBudget" inputmode="decimal" value="${c.budget != null ? esc(c.budget) : ''}"></div>` : ''}
          <div class="mk-field full"><label for="mkHNotes">Notes</label>
            <textarea id="mkHNotes" maxlength="4000">${esc(c.notes || '')}</textarea></div>
        </div>
        <div class="mk-actions">
          <button class="mk-btn" data-act="save-header">Save</button>
          <button class="mk-btn ghost" data-act="cancel-header">Cancel</button>
        </div>`;
    }

    function stepRow(c, s, today) {
      const due = dueDateFor(s, c.controlDate);
      const clear = s.done || s.notApplicable;
      const late = !clear && due && due < today;
      const unmet = clear ? [] : unmetDependencies(c, s.key);
      const locked = unmet.length > 0;
      const open = state.openStep === s.key;
      const m = state.stepMsg[s.key];
      const cls = ['mk-step', s.done ? 'is-done' : '', s.notApplicable ? 'is-na' : '', late ? 'is-late' : ''].join(' ');
      const timing = timingLabel(s.timing, (typeMeta(c.type) || {}).controlLabel);
      const editable = c.status === 'open';

      const control = s.approval && !s.done && !s.notApplicable
        ? `<button class="mk-btn sm" data-approve="${esc(s.key)}"${locked || !editable ? ' disabled' : ''}>Approve</button>`
        : '';

      return `
        <div class="${cls}" data-step="${esc(s.key)}">
          <div class="mk-step-row">
            <input type="checkbox" class="mk-check" data-done="${esc(s.key)}" aria-label="Done: ${esc(s.label)}"
              ${s.done ? 'checked' : ''}${(locked && !s.done) || s.notApplicable || !editable || (s.approval && !s.done) ? ' disabled' : ''}>
            <div>
              <div class="lbl">${esc(s.label)}</div>
              ${s.help ? `<div class="help">${esc(s.help)}</div>` : ''}
              <div class="facts">
                <span>Owner: <b>${esc(ownerFor(s, c))}</b></span>
                <span>Due: ${due ? `<b class="${late ? 'late' : ''}">${esc(fmtDate(due))}</b>` : '<b>No date</b>'}${s.dueOverride ? ' (set by hand)' : ''}</span>
                <span>Timing: ${esc(timing)}</span>
                ${s.done ? `<span>${s.approval ? 'Approved' : 'Done'} ${esc(fmtDate(s.doneAt))}${s.doneBy ? ' by ' + esc(s.doneBy) : ''}</span>` : ''}
                ${s.notApplicable ? '<span><b>Not applicable</b></span>' : ''}
              </div>
              ${locked ? `<div class="wait">Waiting on: ${esc(unmet[0].label)}</div>` : ''}
              ${s.blocked ? `<div class="blocker">Blocked: ${esc(s.blocked)}</div>` : ''}
              ${s.notes && !open ? `<div class="noted">${esc(s.notes)}</div>` : ''}
              ${(s.links || []).length && !open ? `<div class="facts">${s.links.map((l) =>
                `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join('')}</div>` : ''}
              ${m ? `<div class="${m.cls === 'ok' ? 'mk-ok' : 'mk-err'}" style="margin:8px 0 0">${esc(m.text)}</div>` : ''}
            </div>
            <div class="mk-step-side">
              ${control}
              <button class="mk-btn ghost sm" data-more="${esc(s.key)}" aria-expanded="${open}">${open ? 'Close' : 'Details'}</button>
            </div>
          </div>
          ${open ? stepDetails(c, s, due) : ''}
        </div>`;
    }

    function stepDetails(c, s, due) {
      const editable = c.status === 'open';
      const dis = editable ? '' : ' disabled';
      const links = (s.links || []).map((l) => `${l.label ? l.label + ' ' : ''}${l.url}`).join('\n');
      return `
        <div class="mk-step-more">
          <div class="mk-grid">
            <div class="mk-field">
              <label for="mkSDue-${esc(s.key)}">Due date</label>
              <div class="hint">${s.dueOverride ? 'Set by hand. Clear it to go back to the suggested date.' : 'Suggested from the campaign date. Change it to set it by hand.'}</div>
              <input type="date" id="mkSDue-${esc(s.key)}" value="${esc(due || '')}"${dis}>
            </div>
            ${s.done ? `
              <div class="mk-field">
                <label for="mkSDoneAt-${esc(s.key)}">Date completed</label>
                <div class="hint">Change it if the work was done on an earlier day.</div>
                <input type="date" id="mkSDoneAt-${esc(s.key)}" value="${esc(s.doneAt || '')}" max="${esc(state.today)}"${dis}>
              </div>` : ''}
            ${!s.done ? `
              <div class="mk-field full">
                <label for="mkSBlock-${esc(s.key)}">What is blocking this</label>
                <div class="hint">Leave blank when nothing is.</div>
                <input type="text" id="mkSBlock-${esc(s.key)}" maxlength="500" value="${esc(s.blocked || '')}"${dis}>
              </div>` : ''}
            <div class="mk-field full">
              <label for="mkSNotes-${esc(s.key)}">Details and notes</label>
              <textarea id="mkSNotes-${esc(s.key)}" maxlength="4000"${dis}>${esc(s.notes || '')}</textarea>
            </div>
            <div class="mk-field full">
              <label for="mkSLinks-${esc(s.key)}">Files and links</label>
              <div class="hint">One per line: an optional name, then the web address. Printavo invoices, artwork, and receipts go here.</div>
              <textarea id="mkSLinks-${esc(s.key)}"${dis} placeholder="Printavo invoice https://www.printavo.com/invoices/12345">${esc(links)}</textarea>
            </div>
          </div>
          <div class="mk-actions" style="margin-bottom:10px">
            <button class="mk-btn sm" data-save-step="${esc(s.key)}"${dis}>Save details</button>
            ${s.na ? (s.notApplicable
              ? `<button class="mk-btn ghost sm" data-na="${esc(s.key)}" data-na-to="0"${dis}>This step applies after all</button>`
              : (!s.done ? `<button class="mk-btn ghost sm" data-na="${esc(s.key)}" data-na-to="1"${dis}>Mark not applicable</button>` : ''))
              : ''}
            ${s.done ? `<button class="mk-btn ghost sm" data-undo="${esc(s.key)}"${dis}>Mark not done</button>` : ''}
          </div>
        </div>`;
    }

    function parseLinks(text) {
      return String(text || '').split('\n').map((line) => {
        const t = line.trim();
        if (!t) return null;
        const m = t.match(/(https?:\/\/\S+)\s*$/i);
        if (!m) return { label: t, url: '' };
        return { label: t.slice(0, m.index).trim(), url: m[1] };
      }).filter(Boolean);
    }

    function renderDetail() {
      const det = $('#mkDetailPane');
      if (!det || !state.detail) return;
      const { campaign: c, parent, children, emails } = state.detail;
      const meta = typeMeta(c.type) || { label: c.type, controlLabel: 'Launch date' };
      const today = state.today;
      const p = progress(c, today);
      const dates = headerDates(c);
      const steps = Array.isArray(c.steps) ? c.steps : [];
      const connectable = connectableTypes(c.type);

      const stageTabs = STAGES.map((st, i) => {
        const inStage = steps.filter((s) => s.stage === st.key);
        const clear = inStage.filter((s) => s.done || s.notApplicable).length;
        const pct = inStage.length ? Math.round((clear / inStage.length) * 100) : 100;
        const isDone = inStage.length > 0 && clear === inStage.length;
        const current = p.stage === st.key && c.status === 'open';
        return `<button class="mk-stage-tab${isDone ? ' done' : ''}${current ? ' current' : ''}" data-jump="${st.key}"
            aria-label="${esc(st.label)}: ${clear} of ${inStage.length} done">
          <div class="num">${i + 1}</div>
          <div class="nm">${esc(st.label)}</div>
          <div class="ct">${inStage.length ? `${clear} of ${inStage.length}` : 'No steps'}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </button>`;
      }).join('');

      const stageSections = STAGES.map((st, i) => {
        const inStage = steps.filter((s) => s.stage === st.key);
        const clear = inStage.filter((s) => s.done || s.notApplicable).length;
        return `
          <section class="mk-stage" id="mkStage-${st.key}">
            <div class="mk-stage-hd"><h2>${i + 1}. ${esc(st.label.toLowerCase())}.</h2>
              <span class="ct">${inStage.length ? `${clear} of ${inStage.length} done` : ''}</span></div>
            <div class="about">${esc(st.about)}</div>
            ${inStage.length ? inStage.map((s) => stepRow(c, s, today)).join('')
              : `<div class="nothing">${esc(meta.label)} has no steps in this stage.</div>`}
          </section>`;
      }).join('');

      let now;
      if (c.status !== 'open') {
        now = `<div class="mk-now done"><div class="k">This campaign is ${esc(c.status)}</div>
          <div class="facts">Reopen it to change steps.</div></div>`;
      } else if (!p.next) {
        now = `<div class="mk-now done"><div class="k">Every step is finished</div>
          <div class="step">Ready to close</div>
          <div class="facts">Mark it complete below when the results are in.</div></div>`;
      } else {
        const late = p.next.due && p.next.due < today;
        now = `<div class="mk-now">
          <div class="k">Next step, ${esc((STAGES.find((s) => s.key === p.stage) || {}).label || '')}</div>
          <div class="step">${esc(p.next.label)}</div>
          <div class="facts">
            <span>Owner: <b>${esc(p.next.owner)}</b></span>
            <span>Due: ${p.next.due ? `<b class="${late ? 'late' : ''}">${esc(fmtDate(p.next.due))}${late ? ', overdue' : ''}</b>` : '<b>No date</b>'}</span>
            <span>Done: <b>${p.done} of ${p.total}</b></span>
            ${p.overdue ? `<span class="late">${p.overdue} step${p.overdue === 1 ? '' : 's'} overdue</span>` : ''}
          </div>
          ${p.firstBlocker ? `<div class="facts" style="margin-top:6px"><span class="late">Blocked: ${esc(p.firstBlocker.label)}: ${esc(p.firstBlocker.blocked)}</span></div>` : ''}
          ${p.missingDate ? `<div class="facts" style="margin-top:6px"><span>Set the ${esc((meta.controlLabel || 'launch date').toLowerCase())} to get suggested due dates.</span></div>` : ''}
        </div>`;
      }

      const childrenCard = meta.parent ? `
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Connected campaigns</h3>
            ${c.status === 'open' ? '<button class="mk-btn sm" data-act="add-child">Add a connected campaign</button>' : ''}</div>
          <div class="mk-card-bd flush mk-wrap">
            ${children.length ? `<table class="mk-table"><thead><tr>
                <th>Campaign</th><th>Account Manager</th><th>Where it stands</th><th>Next step</th><th>Blocker</th>
              </tr></thead><tbody>
              ${children.map((k) => {
                const kp = k.progress || {};
                const nx = kp.next;
                const late = nx && nx.due && nx.due < today;
                return `<tr class="clickable" data-open="${esc(k.id)}" tabindex="0">
                  <td><div class="co">${esc(k.name)}</div><div class="who">${esc(k.typeLabel)}</div></td>
                  <td>${esc(k.accountManagerName || 'Not set')}</td>
                  <td><span class="pill ${statusClass(kp.label)}">${esc(kp.label || '')}</span>
                    ${kp.overdue ? `<div class="who late">${kp.overdue} overdue</div>` : ''}</td>
                  <td>${nx ? `${esc(nx.label)}<div class="who">${esc(nx.owner)}${nx.due ? `, due <span class="${late ? 'late' : ''}">${esc(fmtDate(nx.due))}</span>` : ''}</div>` : '<span class="who">Nothing open</span>'}</td>
                  <td>${kp.firstBlocker ? `<span class="late">${esc(kp.firstBlocker.blocked)}</span>` : '<span class="who">None</span>'}</td>
                </tr>`;
              }).join('')}</tbody></table>`
              : `<div class="mk-empty">No connected campaigns yet. Postal, Digital Platform, Live Screen Printing,
                  Live Customization, and Sampling can each run under this event with their own checklist.</div>`}
          </div>
        </div>` : '';

      const emailList = emails && emails.emails ? emails.emails : [];
      const emailCard = `
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Emails attached in MailMe</h3></div>
          <div class="mk-card-bd">
            ${emails && emails.unavailable ? '<div class="mk-notice">MailMe did not answer, so attached emails cannot be shown right now.</div>'
              : (emailList.length ? `<table class="mk-table"><tbody>${emailList.map((e) =>
                  `<tr><td class="co">${esc(e.subject || 'Untitled send')}</td><td>${esc(e.status)}</td><td>${e.sentAt ? esc(fmtStamp(e.sentAt)) : ''}</td></tr>`).join('')}</tbody></table>`
                : '<div class="who">None yet. An email is attached from its own screen in MailMe.</div>')}
          </div>
        </div>`;

      const history = (c.history || []).slice().reverse().slice(0, 40);

      det.innerHTML = `
        <div class="mk-actions" style="margin-bottom:12px">
          <button class="mk-link" data-act="to-list">Back to campaigns</button>
          ${parent ? `<span class="who">Connected to</span> <button class="mk-link" data-open="${esc(parent.id)}">${esc(parent.name)}</button>` : ''}
        </div>
        <div class="mk-hd">
          <div>
            <h1>${esc(c.name)}<span class="dot">.</span></h1>
            <div class="sub">${esc(meta.label)} <span class="pill ${statusClass(p.label)}">${esc(p.label)}</span></div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn ghost sm" data-act="reload">Refresh</button>
            ${!state.editingHeader ? '<button class="mk-btn ghost sm" data-act="edit-header">Edit details</button>' : ''}
          </div>
        </div>
        ${msgBox(state.detailMsg)}
        ${now}
        <div class="mk-card"><div class="mk-card-bd">
          ${state.editingHeader ? headerForm(c, meta) : headerView(c, meta, dates)}
        </div></div>
        <nav class="mk-stages" aria-label="Stages">${stageTabs}</nav>
        ${stageSections}
        ${childrenCard}
        ${emailCard}
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Close out</h3></div>
          <div class="mk-card-bd">
            <div class="mk-actions">
              ${c.status === 'open' ? `
                <button class="mk-btn" data-status="complete"${p.next ? ' disabled' : ''}>Mark complete</button>
                <button class="mk-btn ghost" data-status="cancelled">Cancel this campaign</button>`
                : '<button class="mk-btn ghost" data-status="open">Reopen</button>'}
              <button class="mk-btn danger" data-act="delete">Delete</button>
            </div>
            ${c.status === 'open' && p.next ? '<div class="who" style="margin-top:8px">Complete becomes available when every step is done or not applicable.</div>' : ''}
          </div>
        </div>
        <div class="mk-card">
          <div class="mk-card-hd"><h3>History</h3><span class="meta">Who changed what, newest first</span></div>
          <div class="mk-card-bd"><div class="mk-history">
            ${history.length ? history.map((h) => `<div><b>${esc(h.by || 'Someone')}</b> ${esc(h.what)} <span>${esc(fmtStamp(h.at))}</span></div>`).join('') : 'Nothing yet.'}
          </div></div>
        </div>`;
    }

    async function patchStep(key, body, okText) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      try {
        const d = await api.patch(ENDPOINTS.mkCampaigns, body, { query: { id: c.id, step: key } });
        state.detail.campaign = d.campaign;
        state.stepMsg = okText ? { [key]: { cls: 'ok', text: okText } } : {};
        const listRow = state.campaigns.find((x) => x.id === c.id);
        if (listRow && d.progress) listRow.progress = d.progress;
      } catch (e) {
        state.stepMsg = { [key]: { cls: 'err', text: e.message || 'That change was not saved.' } };
      }
      renderDetail();
    }

    async function patchHeader(body) {
      const c = state.detail && state.detail.campaign;
      if (!c) return false;
      try {
        const d = await api.patch(ENDPOINTS.mkCampaigns, body, { query: { id: c.id } });
        state.detail.campaign = d.campaign;
        state.detailMsg = null;
        await loadList();
        return true;
      } catch (e) {
        state.detailMsg = { cls: 'err', text: e.message || 'That change was not saved.' };
        return false;
      }
    }

    /* ---------------- timeline ---------------- */

    function periodMonths() {
      const [y, m] = state.tl.anchor.split('-').map(Number);
      const count = state.tl.span === 'year' ? 12 : state.tl.span === 'quarter' ? 3 : 1;
      const startMonth = state.tl.span === 'year' ? 0 : state.tl.span === 'quarter' ? Math.floor((m - 1) / 3) * 3 : m - 1;
      return Array.from({ length: count }, (_, i) => {
        const mm = startMonth + i;
        return { y: y + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 };
      });
    }

    function shiftPeriod(dir) {
      const [y, m] = state.tl.anchor.split('-').map(Number);
      const step = state.tl.span === 'year' ? 12 : state.tl.span === 'quarter' ? 3 : 1;
      const total = (y * 12 + (m - 1)) + dir * step;
      state.tl.anchor = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
    }

    function renderTimeline() {
      const body = $('#mkTimelineBody');
      if (!body) return;
      if (state.limited) { body.innerHTML = `<div class="mk-notice">${esc(state.limitedMessage)}</div>`; return; }
      const tl = state.tl;
      const months = periodMonths();
      const first = months[0], last = months[months.length - 1];
      const title = tl.span === 'year' ? String(first.y)
        : tl.span === 'quarter' ? `${MONTHS_LONG[first.m]} to ${MONTHS_LONG[last.m]} ${last.y}`
          : `${MONTHS_LONG[first.m]} ${first.y}`;

      const events = [];
      state.campaigns.forEach((c) => {
        if (c.status === 'cancelled') return;
        if (tl.type && c.type !== tl.type) return;
        if (tl.am && String(c.accountManagerId || '') !== tl.am) return;
        const meta = typeMeta(c.type) || {};
        const d = c.dates || {};
        if (d.control) events.push({ date: d.control, what: meta.controlLabel || 'Launch date', c });
        if (d.prelaunchReview) events.push({ date: d.prelaunchReview, what: 'Prelaunch review', c });
        if (d.postLaunchReview) events.push({ date: d.postLaunchReview, what: 'Post-launch review', c });
      });

      const typeOptions = CAMPAIGN_TYPES.map((t) =>
        `<option value="${esc(t.key)}"${tl.type === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('');

      body.innerHTML = `
        <div class="mk-filters">
          <div><label>View</label><div class="mk-seg" role="group" aria-label="View">
            ${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, l]) =>
              `<button data-span="${k}" aria-pressed="${tl.span === k}">${l}</button>`).join('')}
          </div></div>
          <div><label>Period</label><div class="mk-seg" role="group" aria-label="Period">
            <button data-shift="-1" aria-label="Earlier">Earlier</button>
            <button data-shift="0">This ${tl.span}</button>
            <button data-shift="1" aria-label="Later">Later</button>
          </div></div>
          <div><label for="mkTlType">Campaign type</label>
            <select id="mkTlType"><option value="">All types</option>${typeOptions}</select></div>
          <div><label for="mkTlAm">Account Manager</label>
            <select id="mkTlAm">${amOptions(tl.am, 'Everyone')}</select></div>
        </div>
        <h2 style="font-size:18px;font-weight:800;margin:4px 0 14px">${esc(title)}</h2>
        ${months.map(({ y, m }) => {
          const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
          const inMonth = events.filter((e) => e.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
          return `<div class="mk-tl-month mk-card"><div class="mk-card-hd"><h3>${esc(MONTHS_LONG[m])} ${y}</h3>
              <span class="meta">${inMonth.length ? inMonth.length + ' date' + (inMonth.length === 1 ? '' : 's') : 'Nothing scheduled'}</span></div>
            ${inMonth.map((e) => {
              const meta = typeMeta(e.c.type) || {};
              return `<div class="mk-tl-row" data-open="${esc(e.c.id)}" tabindex="0">
                <span class="d">${esc(fmtDate(e.date))}</span>
                <span class="w">${esc(e.what)}</span>
                <span><b>${esc(e.c.name)}</b> <span class="who">${esc(meta.label || '')}${e.c.accountManagerName ? ', ' + esc(e.c.accountManagerName) : ''}</span></span>
                <span class="pill ${statusClass((e.c.progress || {}).label)}">${esc((e.c.progress || {}).label || '')}</span>
              </div>`;
            }).join('')}
          </div>`;
        }).join('')}`;
    }

    /* ---------------- settings ---------------- */

    function renderSettings() {
      const body = $('#mkSettingsBody');
      if (!body) return;
      if (state.limited) { body.innerHTML = `<div class="mk-notice">${esc(state.limitedMessage)}</div>`; return; }

      const typesRef = CAMPAIGN_TYPES.map((t) => `
        <details>
          <summary>${esc(t.label)}<span>${t.steps.length} steps, dated from the ${esc(t.controlLabel.toLowerCase())}</span></summary>
          ${STAGES.map((st) => {
            const inStage = t.steps.filter((s) => s.stage === st.key);
            if (!inStage.length) return '';
            return `<div class="st">${esc(st.label)}</div><ol>${inStage.map((s) =>
              `<li>${esc(s.label)} <span class="o">Owner: ${esc(s.owner)}. ${esc(timingLabel(s.timing, t.controlLabel))}.${s.na ? ' Can be marked not applicable.' : ''}${s.approval ? ' Approval.' : ''}</span></li>`).join('')}</ol>`;
          }).join('')}
        </details>`).join('');

      body.innerHTML = `
        ${msgBox(state.settingsMsg)}
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Campaign types and their steps</h3>
            <span class="meta">From Jacob's handoff. Read only.</span></div>
          <div class="mk-card-bd">
            <div class="who" style="margin-bottom:12px;max-width:78ch">These are the starter checklists a new campaign
              copies when it is created. A campaign already running keeps the checklist it started with. The detailed
              campaign master documents will add to these once they arrive.</div>
            <div class="mk-steps-ref">${typesRef}</div>
          </div>
        </div>
        <div class="mk-card">
          <div class="mk-card-hd"><h3>BackBone lead list</h3>
            <span class="meta">The dropdown on BackBone's lead form</span></div>
          <div class="mk-card-bd">
            <div class="mk-field">
              <label for="mkInitiatives">One per line</label>
              <div class="hint">BackBone still labels this "Marketing initiative". Renaming it there is a later step.</div>
              <textarea id="mkInitiatives" style="min-height:140px">${esc(state.initiatives.join('\n'))}</textarea>
            </div>
            <button class="mk-btn" data-act="save-initiatives">Save the list</button>
          </div>
        </div>
        ${state.legacyCount ? `
          <div class="mk-card">
            <div class="mk-card-hd"><h3>Old sample campaigns</h3></div>
            <div class="mk-card-bd">
              <div class="mk-notice">${state.legacyCount} campaign${state.legacyCount === 1 ? '' : 's'} from before the rebuild
                ${state.legacyCount === 1 ? 'is' : 'are'} still in storage. Nothing shows them any more. Deleting removes them
                and their typed-in numbers for good.</div>
              <button class="mk-btn danger" data-act="clear-legacy">Delete the old sample campaigns</button>
            </div>
          </div>` : ''}`;
    }

    /* ---------------- events ---------------- */

    const onClick = async (ev) => {
      const t = ev.target.closest('button, [data-open], input.mk-check');
      if (!t || !root.contains(t)) return;

      if (t.matches('input.mk-check')) {
        const key = t.getAttribute('data-done');
        await patchStep(key, { done: t.checked }, null);
        return;
      }

      const d = t.dataset;
      if (d.open) { ev.preventDefault(); await openCampaign(d.open); return; }
      if (d.show) { state.filters.show = d.show; renderList(); return; }
      if (d.whose) { state.filters.whose = d.whose; renderList(); return; }
      if (d.type) { state.newType = d.type; state.newMsg = null; renderNew(); return; }
      if (d.jump) {
        const el = root.querySelector('#mkStage-' + d.jump);
        if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return;
      }
      if (d.more) { state.openStep = state.openStep === d.more ? null : d.more; state.stepMsg = {}; renderDetail(); return; }
      if (d.approve) { await patchStep(d.approve, { done: true }, 'Approved.'); return; }
      if (d.undo) { await patchStep(d.undo, { done: false }, 'Marked not done.'); return; }
      if (d.na) { await patchStep(d.na, { notApplicable: d.naTo === '1' }, d.naTo === '1' ? 'Marked not applicable.' : 'This step applies again.'); return; }
      if (d.saveStep) {
        const k = d.saveStep;
        const s = state.detail.campaign.steps.find((x) => x.key === k);
        const val = (id) => { const el = root.querySelector('#' + id); return el ? el.value : undefined; };
        const due = val('mkSDue-' + k);
        const suggested = s && s.timing ? dueDateFor({ timing: s.timing }, state.detail.campaign.controlDate) : null;
        const body = {
          notes: val('mkSNotes-' + k),
          links: parseLinks(val('mkSLinks-' + k)).filter((l) => l.url),
        };
        if (due !== undefined) {
          // Only a date that differs from the suggestion is a person's date.
          // Sent only when it changes, so saving notes does not log a due date.
          const wanted = due && due !== suggested ? due : null;
          if (wanted !== ((s && s.dueOverride) || null)) body.dueDate = wanted;
        }
        const block = val('mkSBlock-' + k);
        if (block !== undefined) body.blocked = block;
        const doneAt = val('mkSDoneAt-' + k);
        if (doneAt !== undefined && s && s.done && doneAt && doneAt !== s.doneAt) body.doneAt = doneAt;
        const bad = parseLinks(val('mkSLinks-' + k)).filter((l) => !l.url);
        await patchStep(k, body, bad.length ? 'Saved. Lines without a web address were left out.' : 'Saved.');
        return;
      }
      if (d.status) {
        const label = d.status === 'cancelled' ? 'Cancel this campaign? It can be reopened later.' : null;
        if (label && !window.confirm(label)) return;
        await patchHeader({ status: d.status });
        renderDetail();
        return;
      }
      if (d.span) { state.tl.span = d.span; renderTimeline(); return; }
      if (d.shift !== undefined) {
        if (d.shift === '0') state.tl.anchor = state.today.slice(0, 7) + '-01';
        else shiftPeriod(Number(d.shift));
        renderTimeline();
        return;
      }

      switch (d.act) {
        case 'refresh': await loadList(); renderList(); break;
        case 'new':
          state.newParentId = null; state.newType = null; state.newMsg = null;
          showPane('new'); renderNew(); break;
        case 'add-child':
          state.newParentId = state.detail.campaign.id; state.newType = null; state.newMsg = null;
          showPane('new'); renderNew(); break;
        case 'cancel-new':
          if (state.newParentId) await openCampaign(state.newParentId);
          else { showPane('list'); renderList(); }
          break;
        case 'back-types': state.newType = null; renderNew(); break;
        case 'create': t.disabled = true; await createFromForm(); break;
        case 'to-list': showPane('list'); await loadList(); renderList(); break;
        case 'reload': await openCampaign(state.detail.campaign.id); break;
        case 'edit-header': state.editingHeader = true; renderDetail(); break;
        case 'cancel-header': state.editingHeader = false; renderDetail(); break;
        case 'save-header': {
          const c = state.detail.campaign;
          const val = (id) => { const el = root.querySelector('#' + id); return el ? el.value : undefined; };
          const amId = val('mkHAm');
          const am = state.accountManagers.find((a) => a.id === amId);
          const kind = root.querySelector('input[name="mkHAudKind"]:checked');
          const body = {
            name: val('mkHName'),
            accountManagerId: amId || null,
            accountManagerName: am ? am.name : (amId === c.accountManagerId ? c.accountManagerName : null),
            controlDate: val('mkHDate') || null,
            audienceKind: kind ? kind.value : c.audienceKind,
            audience: val('mkHAudience'),
            notes: val('mkHNotes'),
          };
          if (val('mkHPart') !== undefined) body.participation = val('mkHPart') || null;
          if (val('mkHBudget') !== undefined) body.budget = val('mkHBudget');
          if (await patchHeader(body)) state.editingHeader = false;
          renderDetail();
          break;
        }
        case 'delete': {
          const c = state.detail.campaign;
          if (!window.confirm(`Delete "${c.name}" and its whole checklist? This cannot be undone. Cancelling keeps the record instead.`)) return;
          try {
            await api.del(ENDPOINTS.mkCampaigns, { query: { id: c.id } });
            showPane('list'); await loadList(); renderList();
          } catch (e) {
            state.detailMsg = { cls: 'err', text: e.message || 'The campaign was not deleted.' };
            renderDetail();
          }
          break;
        }
        case 'save-initiatives': {
          const list = ($('#mkInitiatives').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
          try {
            const r = await api.put(ENDPOINTS.mkInitiatives, { initiatives: list });
            state.initiatives = r.initiatives || list;
            state.settingsMsg = { cls: 'ok', text: 'Saved. BackBone shows the new list the next time a lead form opens.' };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The list was not saved.' };
          }
          renderSettings();
          break;
        }
        case 'clear-legacy': {
          if (!window.confirm('Delete every old sample campaign and its numbers for good?')) return;
          try {
            const r = await api.del(ENDPOINTS.mkCampaigns, { query: { legacy: 'all' } });
            state.legacyCount = 0;
            state.settingsMsg = { cls: 'ok', text: `Deleted ${r.removed || 0} old sample campaign${r.removed === 1 ? '' : 's'}.` };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The old campaigns were not deleted.' };
          }
          renderSettings();
          break;
        }
        default: break;
      }
    };

    const onChange = (ev) => {
      const t = ev.target;
      if (t.id === 'mkFType') { state.filters.type = t.value; renderList(); }
      else if (t.id === 'mkFAm') { state.filters.am = t.value; renderList(); }
      else if (t.id === 'mkTlType') { state.tl.type = t.value; renderTimeline(); }
      else if (t.id === 'mkTlAm') { state.tl.am = t.value; renderTimeline(); }
    };

    const onKey = (ev) => {
      if (ev.key !== 'Enter') return;
      const row = ev.target.closest && ev.target.closest('[data-open]');
      if (row && row.tagName !== 'BUTTON') { ev.preventDefault(); openCampaign(row.getAttribute('data-open')); }
    };

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
    this._off = () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('keydown', onKey);
    };

    await Promise.all([loadList(), loadInitiatives()]);
    showPane('list');
    renderList();

    this._renders = {
      campaigns: async () => { if (state.pane === 'list') { await loadList(); renderList(); } },
      calendar: async () => { await loadList(); renderTimeline(); },
      settings: async () => { await Promise.all([loadList(), loadInitiatives()]); renderSettings(); },
    };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const ids = { campaigns: 'mkCampaignsView', calendar: 'mkCalendarView', settings: 'mkSettingsView' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    if (this._off) { this._off(); this._off = null; }
  }
};
