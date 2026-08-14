// PUT IN: apps/crewcore.js (REPLACES the current one)
/**
 * CrewCore — employee management for the whole team.
 *
 * v2, Aug 2026. No standalone to port from: the closest prior art was the
 * P&M internal Wix site (ryan7339.wixsite.com/pminternal), specifically
 * Company Structure (org chart) and Contact List (roster seed).
 *
 * PTO REMOVED this version — Ryan's call. Time off tracking stays in
 * QuickBooks, not duplicated here. There is no 'pto' view anymore; it isn't
 * hidden, it's gone, along with api/crewcore/pto.js.
 *
 * ADDED this version: apparel STIPEND tracking (an allotment per employee,
 * defaulted by department per the Handbook's Dress Code policy — $250
 * Front Office, $150 Production — plus a spend log an admin maintains), and
 * a read-only HANDBOOK view sourced from lib/crewcore/handbook-content.js,
 * itself sourced from the real Employee_Handbook.docx.
 *
 * SELF-SERVE, decided Aug 3 2026: an "employee" role (data_scope "own") can
 * see their own roster entry (minus hourly rate and admin notes), their own
 * stipend allotment and spend history, their own review history read-only,
 * and the full Handbook (open to everyone with CrewCore access, not scoped).
 * Everyone else with the app granted (data_scope "all", or any superuser
 * account) gets the full admin views. The split is enforced server-side in
 * api/crewcore/*.js — this file adapts what it RENDERS based on ctx.perms,
 * but never trusts the client to be the actual gate.
 *
 * Six views: Dashboard (admin only; anniversaries + headline numbers —
 * self-serve callers land on Roster instead, see showView), Roster (admin:
 * full list + add/edit; self-serve: your own profile card), Stipend (both:
 * your allotment, spend log, and remaining balance; admin also logs new
 * spend entries for anyone), Reviews (admin: full history + add; self-serve:
 * read-only own history), Handbook (everyone; read-only), Settings
 * (admin only; hidden from self-serve rails by lib/users.js's per-view tabs).
 */

import { ENDPOINTS } from '../js/api.js';

const DEPARTMENTS = ['Screen Printing', 'Embroidery', 'Sales', 'Art', 'Office'];
const STIPEND_CATEGORIES = ['apparel', 'other'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function daysUntilAnniversary(startDate) {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  const next = new Date(now.getFullYear(), start.getMonth(), start.getDate());
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    next.setFullYear(next.getFullYear() + 1);
  }
  const days = Math.round((next - now) / 86400000);
  const years = next.getFullYear() - start.getFullYear();
  return { days, years };
}

export default {
  id: 'crewcore',

  styles: `
  .cc-wrap{padding:24px 32px 60px;max-width:1200px}
  .cc-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .cc-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .cc-hd .sub{font-size:13px;color:var(--muted);margin-top:2px}

  .cc-btn{
    background:var(--accent);color:var(--on-accent);border:none;border-radius:var(--radius-sm);
    padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;
  }
  .cc-btn:hover{filter:brightness(0.95)}
  .cc-btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
  .cc-btn.sm{padding:6px 11px;font-size:12px}
  .cc-btn:disabled{opacity:.5;cursor:not-allowed}

  .cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:22px}
  .cc-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:16px 18px}
  .cc-card h3{font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
  .cc-card .big{font-size:26px;font-weight:800;letter-spacing:-.01em}
  .cc-card .note{font-size:12px;color:var(--muted);margin-top:4px}

  .cc-section{margin-bottom:26px}
  .cc-section h2{font-size:15px;font-weight:700;margin-bottom:10px}

  .cc-list{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .cc-row{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:12px 16px;border-bottom:1px solid var(--line);
  }
  .cc-row:last-child{border-bottom:none}
  .cc-row .who{font-weight:600;font-size:13.5px}
  .cc-row .meta{font-size:12px;color:var(--muted)}
  .cc-empty{padding:30px;text-align:center;color:var(--muted);font-size:13px}

  .chip{display:inline-flex;align-items:center;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;background:var(--line-soft);color:var(--ink)}
  .chip.terminated{background:var(--danger-tint);color:var(--danger)}
  .chip.on_leave{background:var(--line-soft);color:var(--muted)}

  .cc-table{width:100%;border-collapse:collapse;font-size:13px}
  .cc-table th{text-align:left;color:var(--muted);font-weight:600;padding:9px 14px;border-bottom:1px solid var(--line);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
  .cc-table td{padding:11px 14px;border-bottom:1px solid var(--line)}
  .cc-table tr:last-child td{border-bottom:none}
  .cc-table tr.clickable{cursor:pointer}
  .cc-table tr.clickable:hover{background:var(--line-soft)}

  .cc-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .cc-search{
    flex:1 1 200px;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:8px 12px;font-size:13px;font-family:inherit;background:var(--card);color:var(--ink);
  }
  .cc-filt{
    border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);
    padding:8px 10px;font-size:13px;font-family:inherit;color:var(--ink);
  }

  .cc-profile{max-width:560px}
  .cc-profile-hd{display:flex;align-items:center;gap:14px;margin-bottom:18px}
  .cc-avatar{
    width:56px;height:56px;border-radius:50%;background:var(--accent-tint);color:var(--accent-deep);
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;flex-shrink:0;
  }
  .cc-profile-hd h2{font-size:19px;font-weight:800}
  .cc-profile-hd .sub{font-size:13px;color:var(--muted)}
  .cc-field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 20px}
  .cc-field{padding:10px 0;border-bottom:1px solid var(--line-soft)}
  .cc-field label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px}
  .cc-field .v{font-size:14px;font-weight:600}

  .cc-form{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px 20px;margin-bottom:18px}
  .cc-form h3{font-size:14px;font-weight:700;margin-bottom:12px}
  .cc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
  .cc-form-grid label{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-bottom:4px}
  .cc-form-grid input,.cc-form-grid select,.cc-form-grid textarea{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 10px;
    font-size:13px;font-family:inherit;background:var(--bg);color:var(--ink);box-sizing:border-box;
  }
  .cc-form-grid .full{grid-column:1/-1}
  .cc-form-actions{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
  .cc-err{color:var(--danger);font-size:12.5px;margin-top:8px}

  .cc-locked{padding:60px 20px;text-align:center;color:var(--muted)}
  .cc-locked h2{color:var(--ink);font-size:17px;margin-bottom:8px}

  .cc-balance-bar{
    height:8px;border-radius:99px;background:var(--line-soft);overflow:hidden;margin-top:6px;
  }
  .cc-balance-bar .fill{height:100%;background:var(--accent);border-radius:99px}

  .cc-hb-cover{
    text-align:center;padding:36px 20px 30px;margin-bottom:28px;
    border-bottom:1px solid var(--line);
  }
  .cc-hb-cover-mark{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:14px}
  .cc-hb-cover-mark .w1{color:var(--accent)}
  .cc-hb-cover-mark .w2{color:var(--wordmark-ink)}
  .cc-hb-cover-mark .dot{color:var(--accent)}
  .cc-hb-cover-title{font-size:26px;font-weight:800;letter-spacing:-.015em;margin-bottom:8px}
  .cc-hb-cover-sub{font-size:12.5px;color:var(--muted);font-weight:600;letter-spacing:.02em}

  .cc-hb-nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--line)}
  .cc-hb-navbtn{
    display:inline-flex;align-items:center;gap:7px;
    border:1px solid var(--line);background:var(--card);border-radius:var(--radius-pill);
    padding:5px 12px 5px 8px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;
    transition:border-color .15s,color .15s;
  }
  .cc-hb-navbtn:hover{color:var(--ink);border-color:var(--accent)}
  .cc-hb-navbtn-story{padding-left:12px}
  .cc-hb-navnum{
    display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;
    background:var(--accent-tint);color:var(--accent-deep);font-size:9.5px;font-weight:800;flex-shrink:0;
  }

  .cc-hb-story-rule{
    display:flex;align-items:center;gap:12px;margin:0 0 20px;
    font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-deep);
  }
  .cc-hb-story-rule::before{content:'';flex:1 1 auto;height:1px;background:var(--line)}
  .cc-hb-story-rule::after{content:'';flex:1 1 auto;height:1px;background:var(--line)}

  .cc-hb-story{
    background:var(--accent-tint);border-radius:var(--radius-md);
    padding:8px 24px 4px;margin-bottom:36px;
  }
  .cc-hb-story .cc-hb-story-rule{color:var(--accent-deep);padding-top:16px}
  .cc-hb-story .cc-hb-story-rule::before,.cc-hb-story .cc-hb-story-rule::after{background:var(--accent-deep);opacity:.25}
  .cc-hb-story-section h2{color:var(--accent-deep)}

  .cc-hb-section{margin-bottom:36px;scroll-margin-top:16px;position:relative}
  .cc-hb-chapnum{
    font-size:34px;font-weight:800;color:var(--accent-tint);line-height:1;
    position:absolute;top:-4px;right:0;letter-spacing:-.02em;user-select:none;
    -webkit-text-stroke:1px var(--accent);
  }
  .cc-hb-section h2{
    font-size:19px;font-weight:800;margin-bottom:14px;letter-spacing:-.015em;
    padding-bottom:10px;border-bottom:2px solid var(--accent);display:inline-block;
  }
  .cc-hb-section h3{font-size:13.5px;font-weight:700;margin:18px 0 6px;color:var(--accent-deep)}
  .cc-hb-section p{font-size:13.5px;line-height:1.7;color:var(--ink);margin-bottom:10px;max-width:640px}
  .cc-hb-section ul{margin:0 0 10px 20px;padding:0;max-width:640px}
  .cc-hb-section li{font-size:13.5px;line-height:1.7;margin-bottom:5px}
  .cc-hb-updated{font-size:12px;color:var(--muted);margin-top:10px}

  .cc-hb-ack{
    display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
    border-radius:var(--radius-md);padding:16px 20px;margin-bottom:28px;
  }
  .cc-hb-ack-pending{background:var(--accent-tint);border:1px solid var(--accent)}
  .cc-hb-ack-done{background:var(--success-tint);border:1px solid var(--success)}
  .cc-hb-ack-text{font-size:13px;line-height:1.5;color:var(--ink)}
  .cc-hb-ack-text strong{display:block;font-size:14px;margin-bottom:2px}
  .cc-hb-ack-pending .cc-hb-ack-text strong{color:var(--accent-deep)}
  .cc-hb-ack-done .cc-hb-ack-text strong{color:var(--success-dk)}
  .cc-hb-ack-bottom{margin-top:8px;margin-bottom:0}

  /* ---- Time Clock ---- */
  .tc-weeknav{display:flex;align-items:center;gap:8px}
  .tc-weeklabel{font-size:13px;font-weight:700;min-width:190px;text-align:center}
  .tc-spacer{flex:1 1 auto}

  .tc-now{
    display:flex;flex-wrap:wrap;gap:8px;align-items:center;
    background:var(--success-tint);border:1px solid var(--success);
    border-radius:var(--radius-md);padding:11px 14px;margin-bottom:16px;
  }
  .tc-now .lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--success-dk);margin-right:4px}
  .tc-now .pill{
    display:inline-flex;align-items:center;gap:6px;background:var(--card);
    border-radius:var(--radius-pill);padding:4px 11px;font-size:12.5px;font-weight:600;
  }
  .tc-now .pill .t{color:var(--muted);font-weight:600}

  .tc-alert{
    background:var(--warn-tint);border:1px solid var(--warn);
    border-radius:var(--radius-md);padding:11px 14px;margin-bottom:16px;font-size:12.5px;
  }
  .tc-alert strong{display:block;font-size:13px;margin-bottom:3px;color:var(--warn-dk)}
  .tc-alert ul{margin:4px 0 0 18px;padding:0}
  .tc-alert li{margin-bottom:2px}

  .tc-grid{width:100%;border-collapse:collapse;font-size:13px;background:var(--card)}
  .tc-grid th{
    text-align:right;color:var(--muted);font-weight:600;padding:9px 10px;
    border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.03em;
  }
  .tc-grid th.who,.tc-grid td.who{text-align:left}
  .tc-grid th .dnum{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:none;letter-spacing:0}
  .tc-grid td{padding:10px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
  .tc-grid tbody tr{cursor:pointer}
  .tc-grid tbody tr.emprow:hover{background:var(--line-soft)}
  .tc-grid td.who{font-weight:600}
  .tc-grid td.who .dept{display:block;font-size:11.5px;color:var(--muted);font-weight:500}
  .tc-grid td.zero{color:var(--line)}
  .tc-grid td.total{font-weight:800}
  .tc-grid td.ot{color:var(--warn-dk);font-weight:700}
  .tc-grid tr.today-col td{background:var(--accent-tint)}
  .tc-grid tfoot td{font-weight:800;border-top:2px solid var(--line);border-bottom:none;padding-top:12px}
  .tc-flagdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn);margin-left:6px;vertical-align:middle}

  .tc-detail{background:var(--bg)}
  .tc-detail td{padding:0;text-align:left}
  .tc-shifts{padding:10px 14px 14px}
  .tc-shift{
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;
    padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px;
  }
  .tc-shift:last-child{border-bottom:none}
  .tc-shift .d{font-weight:700;min-width:104px}
  .tc-shift .times{font-variant-numeric:tabular-nums}
  .tc-shift .h{font-weight:700;min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
  .tc-shift .grow{flex:1 1 auto}
  .tc-shift .note{color:var(--muted);font-style:italic}
  .tc-miss{color:var(--danger);font-weight:700}

  .tc-mine{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:20px}
  .tc-day{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:10px 8px;text-align:center;
  }
  .tc-day.today{border-color:var(--accent);background:var(--accent-tint)}
  .tc-day .dl{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .tc-day .dn{font-size:11px;color:var(--muted);margin-bottom:5px}
  .tc-day .dh{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
  .tc-day .dh.none{color:var(--line)}
  @media (max-width:720px){.tc-mine{grid-template-columns:repeat(4,1fr)}}

  .tc-kiosk{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:14px 16px;margin-bottom:18px;font-size:12.5px;color:var(--muted);
  }
  .tc-kiosk code{
    display:inline-block;background:var(--line-soft);border-radius:var(--radius-sm);
    padding:3px 8px;font-size:12.5px;color:var(--ink);font-weight:600;
  }
  .tc-pinstate{font-size:11.5px;font-weight:700;margin-top:5px}
  .tc-pinstate.set{color:var(--success-dk)}
  .tc-pinstate.unset{color:var(--warn-dk)}
  `,

  template: `
    <div class="cc-wrap">
      <div class="cc-hd">
        <div>
          <h1 id="ccTitle">CrewCore.</h1>
          <div class="sub" id="ccSub"></div>
        </div>
        <div id="ccHdActions"></div>
      </div>
      <div id="ccBody"></div>
    </div>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    this._ctx = ctx;
    const isAdmin = !!(ctx.perms && (ctx.perms.data_scope === 'all' || ctx.perms.superuser));
    this._isAdmin = isAdmin;

    // Employees list (admin) or own record (self-serve) — same endpoint,
    // server decides the shape.
    const empPayload = await ctx.api.get(ENDPOINTS.ccEmployees);
    this._employees = isAdmin ? (empPayload.employees || []) : [];
    this._own = isAdmin ? null : (empPayload.employee || null);

    this._stipendSpends = [];
    this._stipendBalance = null;
    this._reviews = [];
    this._handbook = null;

    // Self-serve callers with a linked employee record need to know their
    // acknowledgment status up front, before routing to any view — that's
    // what the showView() gate below checks. Admins and unlinked self-serve
    // callers (no employee record yet) skip this: an admin isn't gated, and
    // an unlinked caller already sees the "ask an admin to link you" screen
    // on Roster, which takes priority over a handbook prompt they can't
    // meaningfully act on differently.
    if (!isAdmin && this._own) {
      await this._loadHandbook();
    }
  },

  async _loadStipend() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccStipend);
    this._stipendSpends = payload.spends || [];
    this._stipendBalance = payload.balance || null;
  },

  async _loadReviews() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccReviews);
    this._reviews = payload.reviews || [];
  },

  async _loadHandbook() {
    if (this._handbook) return; // static content, fetch once per mount
    const payload = await this._ctx.api.get(ENDPOINTS.ccHandbook);
    this._handbook = payload;
  },

  async _loadSettings() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccSettings);
    this._settings = payload.settings || {
      default_stipend_front_office: 250, default_stipend_production: 150, self_serve_enabled: true
    };
  },

  async showView(view) {
    const root = this._root;
    if (!root) return;
    const $ = (sel) => root.querySelector(sel);
    const title = $('#ccTitle');
    const sub = $('#ccSub');
    const actions = $('#ccHdActions');
    const body = $('#ccBody');
    const isAdmin = this._isAdmin;

    actions.innerHTML = '';

    // GATE: a self-serve caller with a linked record who hasn't agreed to
    // the CURRENT handbook version gets sent here regardless of which view
    // they asked for, with one deliberate exception — 'handbook' itself,
    // since they need to be able to read it in order to agree to it. This
    // mirrors the "unlinked record" screen's precedent (apps/crewcore.js
    // _renderProfileSelf): block, but don't leave the person stuck with no
    // path forward.
    if (!isAdmin && this._own && this._handbook && this._handbook.acknowledged === false && view !== 'handbook') {
      view = 'handbook';
    }

    // Self-serve callers have no meaningful admin Dashboard — send them to
    // their own Roster/profile view instead of an empty screen.
    if (!isAdmin && view === 'dashboard') {
      view = 'roster';
    }

    if (view === 'dashboard') {
      title.textContent = 'Dashboard.';
      sub.textContent = 'Anniversaries and headline numbers.';
      body.innerHTML = this._renderDashboard();
      return;
    }

    if (view === 'roster') {
      title.textContent = 'Roster.';
      if (isAdmin) {
        sub.textContent = this._employees.length + ' ' + (this._employees.length === 1 ? 'person' : 'people');
        actions.innerHTML = `<button class="cc-btn" id="ccAddBtn">Add employee</button>`;
        const addBtn = $('#ccAddBtn');
        if (addBtn) addBtn.onclick = () => this._openEmployeeForm(null);
        body.innerHTML = this._renderRosterAdmin();
        this._wireRosterAdmin();
      } else {
        sub.textContent = 'Your profile.';
        body.innerHTML = this._renderProfileSelf();
      }
      return;
    }

    if (view === 'timeclock') {
      title.textContent = 'Time Clock.';
      sub.textContent = isAdmin ? 'Hours by employee and pay week.' : 'Your hours.';
      if (!this._tcWeek) this._tcWeek = '';   // '' means "whatever week today is in"
      await this._loadTimecards();
      if (isAdmin) {
        actions.innerHTML = `
          <button class="cc-btn ghost" id="tcExport">Export CSV</button>
          <button class="cc-btn" id="tcAdd">Add a shift</button>`;
        const ex = $('#tcExport');
        if (ex) ex.onclick = () => this._exportTimecards();
        const add = $('#tcAdd');
        if (add) add.onclick = () => this._openShiftForm(null);
        body.innerHTML = this._renderTimeclockAdmin();
        this._wireTimeclockAdmin();
      } else {
        body.innerHTML = this._renderTimeclockSelf();
        this._wireTimeclockSelf();
      }
      return;
    }

    if (view === 'stipend') {
      title.textContent = 'Stipend.';
      sub.textContent = isAdmin ? 'Apparel allotments and spend across the team.' : 'Your apparel allotment and spend.';
      await this._loadStipend();
      if (isAdmin) {
        actions.innerHTML = `<button class="cc-btn" id="ccLogSpendBtn">Log a purchase</button>`;
        const btn = $('#ccLogSpendBtn');
        if (btn) btn.onclick = () => this._openStipendForm();
      }
      body.innerHTML = this._renderStipend();
      this._wireStipend();
      return;
    }

    if (view === 'reviews') {
      title.textContent = 'Reviews.';
      sub.textContent = isAdmin ? 'One-on-one review history for the team.' : 'Your review history.';
      await this._loadReviews();
      if (isAdmin) {
        actions.innerHTML = `<button class="cc-btn" id="ccAddReviewBtn">Log a review</button>`;
        const btn = $('#ccAddReviewBtn');
        if (btn) btn.onclick = () => this._openReviewForm();
      }
      body.innerHTML = this._renderReviews();
      return;
    }

    if (view === 'handbook') {
      title.textContent = 'Handbook.';
      sub.textContent = 'P&M Apparel Employee Handbook.';
      await this._loadHandbook();
      body.innerHTML = this._renderHandbook();
      this._wireHandbook();
      return;
    }

    if (view === 'settings') {
      // Not reachable by a self-serve caller — allowedViews() in
      // js/registry.js scopes the "employee" role to dashboard/roster/
      // stipend/reviews/handbook only, so this view never appears in their
      // rail. Still guard here rather than trust the rail alone, same as
      // every other app.
      if (!isAdmin) {
        title.textContent = 'Settings.';
        sub.textContent = '';
        body.innerHTML = `<div class="cc-locked"><h2>Admin access required</h2></div>`;
        return;
      }
      title.textContent = 'Settings.';
      sub.textContent = 'Shop-wide CrewCore defaults.';
      await this._loadSettings();
      body.innerHTML = this._renderSettings();
      this._wireSettings();
      return;
    }
  },

  /* ---------------- Dashboard (admin) ---------------- */

  _renderDashboard() {
    const upcoming = this._employees
      .map((e) => ({ e, ann: daysUntilAnniversary(e.start_date) }))
      .filter((x) => x.ann && x.ann.days <= 60)
      .sort((a, b) => a.ann.days - b.ann.days);

    const active = this._employees.filter((e) => e.status === 'active');
    const totalStipendAllotted = active.reduce((sum, e) => sum + (Number(e.apparel_stipend) || 0), 0);

    return `
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Team</h3>
          <div class="big">${active.length}</div>
          <div class="note">active employees</div>
        </div>
        <div class="cc-card">
          <h3>Apparel stipends</h3>
          <div class="big">${fmtMoney(totalStipendAllotted)}</div>
          <div class="note">total allotted this year</div>
        </div>
        <div class="cc-card">
          <h3>Upcoming anniversaries</h3>
          <div class="big">${upcoming.length}</div>
          <div class="note">within 60 days</div>
        </div>
      </div>

      <div class="cc-section">
        <h2>Upcoming anniversaries</h2>
        <div class="cc-list">
          ${upcoming.length ? upcoming.map((x) => `
            <div class="cc-row">
              <div>
                <div class="who">${esc(x.e.name)}</div>
                <div class="meta">${esc(x.e.title || x.e.department || '')}</div>
              </div>
              <div class="meta">${x.ann.years + 1} ${x.ann.years + 1 === 1 ? 'year' : 'years'} · ${x.ann.days === 0 ? 'today' : x.ann.days + 'd'}</div>
            </div>
          `).join('') : `<div class="cc-empty">Nothing in the next 60 days.</div>`}
        </div>
      </div>
    `;
  },

  /* ---------------- Roster: admin list ---------------- */

  _renderRosterAdmin() {
    return `
      <div class="cc-toolbar">
        <input class="cc-search" id="ccSearch" type="text" placeholder="Search by name...">
        <select class="cc-filt" id="ccDeptFilter">
          <option value="">All departments</option>
          ${DEPARTMENTS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
        </select>
      </div>
      <div class="cc-list" id="ccRosterList"></div>
    `;
  },

  _wireRosterAdmin() {
    const root = this._root;
    const $ = (sel) => root.querySelector(sel);
    const search = $('#ccSearch');
    const deptFilter = $('#ccDeptFilter');

    const render = () => {
      const q = (search.value || '').trim().toLowerCase();
      const dept = deptFilter.value;
      const rows = this._employees.filter((e) => {
        if (dept && e.department !== dept) return false;
        if (q && !String(e.name || '').toLowerCase().includes(q)) return false;
        return true;
      });
      const list = $('#ccRosterList');
      if (!rows.length) {
        list.innerHTML = `<div class="cc-empty">No employees match.</div>`;
        return;
      }
      list.innerHTML = `
        <table class="cc-table">
          <thead><tr><th>Name</th><th>Department</th><th>Title</th><th>Start</th><th>Status</th><th>Rate</th><th>Stipend</th><th>Kiosk</th></tr></thead>
          <tbody>
            ${rows.map((e) => `
              <tr class="clickable" data-id="${esc(e.id)}">
                <td>${esc(e.name)}</td>
                <td>${esc(e.department || '')}</td>
                <td>${esc(e.title || '')}</td>
                <td>${fmtDate(e.start_date)}</td>
                <td><span class="chip ${esc(e.status)}">${esc(e.status)}</span></td>
                <td>${e.hourly_rate != null ? fmtMoney(e.hourly_rate) + '/hr' : '—'}</td>
                <td>${fmtMoney(e.apparel_stipend)}/yr</td>
                <td>${e.clock_enabled === false ? '<span class="chip on_leave">salary</span>'
                  : (e.has_clock_pin ? '<span class="chip">set</span>' : '<span class="chip terminated">no code</span>')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('tr.clickable').forEach((tr) => {
        tr.onclick = () => {
          const emp = this._employees.find((e) => e.id === tr.dataset.id);
          if (emp) this._openEmployeeForm(emp);
        };
      });
    };

    search.oninput = render;
    deptFilter.onchange = render;
    render();
  },

  _openEmployeeForm(emp) {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const isEdit = !!emp;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${isEdit ? 'Edit ' + esc(emp.name) : 'Add employee'}</h3>
        <div class="cc-form-grid">
          <div><label>Name</label><input id="fName" value="${esc(emp ? emp.name : '')}"></div>
          <div><label>Department</label>
            <select id="fDept">${DEPARTMENTS.map((d) => `<option value="${esc(d)}" ${emp && emp.department === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
          </div>
          <div><label>Title</label><input id="fTitle" value="${esc(emp ? emp.title : '')}"></div>
          <div><label>Start date</label><input id="fStart" type="date" value="${esc(emp ? emp.start_date : '')}"></div>
          <div><label>Status</label>
            <select id="fStatus">
              <option value="active" ${emp && emp.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="on_leave" ${emp && emp.status === 'on_leave' ? 'selected' : ''}>On leave</option>
              <option value="terminated" ${emp && emp.status === 'terminated' ? 'selected' : ''}>Terminated</option>
            </select>
          </div>
          <div><label>Phone</label><input id="fPhone" value="${esc(emp ? emp.phone : '')}"></div>
          <div><label>Email</label><input id="fEmail" value="${esc(emp ? emp.email : '')}"></div>
          <div><label>Shell username (optional)</label><input id="fUsername" value="${esc(emp && emp.username ? emp.username : '')}" placeholder="links self-serve login"></div>
          <div><label>Hourly rate</label><input id="fRate" type="number" step="0.01" value="${emp && emp.hourly_rate != null ? emp.hourly_rate : ''}"></div>
          <div>
            <label>Apparel stipend / year</label>
            <input id="fStipend" type="number" step="0.01" value="${emp && emp.apparel_stipend != null ? emp.apparel_stipend : ''}" placeholder="defaults by department">
          </div>
          <div>
            <label>Pay type</label>
            <select id="fClockOn">
              <option value="true" ${!emp || emp.clock_enabled !== false ? 'selected' : ''}>Hourly, punches the clock</option>
              <option value="false" ${emp && emp.clock_enabled === false ? 'selected' : ''}>Salary, does not punch</option>
            </select>
          </div>
          <div>
            <label>Kiosk passcode</label>
            <input id="fPin" type="text" inputmode="numeric" autocomplete="off" maxlength="6"
                   placeholder="${isEdit && emp.has_clock_pin ? 'leave blank to keep current' : '4 to 6 digits'}">
            <div class="tc-pinstate ${isEdit && emp.has_clock_pin ? 'set' : 'unset'}">
              ${isEdit && emp.has_clock_pin
                ? 'Passcode is set. Type a new one to replace it, or type CLEAR to remove it.'
                : 'No passcode yet. Without one this person cannot use the clock kiosk.'}
            </div>
          </div>
          <div class="full"><label>Notes</label><textarea id="fNotes" rows="2">${esc(emp ? emp.notes : '')}</textarea></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          ${isEdit ? '<button class="cc-btn ghost" id="fDelete">Delete</button>' : ''}
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSave">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();

    if (isEdit) {
      $('#fDelete').onclick = async () => {
        if (!confirm('Delete ' + emp.name + '? This cannot be undone.')) return;
        try {
          await this._ctx.api.request(ENDPOINTS.ccEmployees + '?id=' + encodeURIComponent(emp.id), { method: 'DELETE' });
          this._employees = this._employees.filter((e) => e.id !== emp.id);
          wrap.remove();
          this.showView('roster');
        } catch (e) {
          err.hidden = false; err.textContent = e.message || 'Could not delete.';
        }
      };
    }

    $('#fSave').onclick = async () => {
      const stipendRaw = $('#fStipend').value;
      const payload = {
        name: $('#fName').value,
        department: $('#fDept').value,
        title: $('#fTitle').value,
        start_date: $('#fStart').value,
        status: $('#fStatus').value,
        phone: $('#fPhone').value,
        email: $('#fEmail').value,
        username: $('#fUsername').value || null,
        hourly_rate: $('#fRate').value === '' ? null : Number($('#fRate').value),
        notes: $('#fNotes').value
      };
      payload.clock_enabled = $('#fClockOn').value === 'true';

      // The passcode field is write-only and blank by default. Blank means
      // "leave whatever is stored alone", which is why it is only added to
      // the payload when something was actually typed. The literal word
      // CLEAR is the explicit way to remove a code, so that clearing is
      // never something an empty field does by accident.
      const pinRaw = ($('#fPin').value || '').trim();
      if (pinRaw) payload.clock_pin = /^clear$/i.test(pinRaw) ? '' : pinRaw;

      // Only send apparel_stipend if the admin actually typed something —
      // leaving it blank on a NEW employee lets the server apply the
      // department default (see lib/crewcore/store.js saveEmployee); on an
      // EDIT, omitting it here means "leave whatever is already stored."
      if (stipendRaw !== '') payload.apparel_stipend = Number(stipendRaw);

      try {
        if (isEdit) {
          const out = await this._ctx.api.request(ENDPOINTS.ccEmployees + '?id=' + encodeURIComponent(emp.id), { method: 'PATCH', body: payload });
          const idx = this._employees.findIndex((e) => e.id === emp.id);
          if (idx >= 0) this._employees[idx] = out.employee;
        } else {
          const out = await this._ctx.api.request(ENDPOINTS.ccEmployees, { method: 'POST', body: payload });
          this._employees.push(out.employee);
        }
        wrap.remove();
        this.showView('roster');
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Roster: self-serve profile ---------------- */

  _renderProfileSelf() {
    const e = this._own;
    if (!e) {
      return `
        <div class="cc-locked">
          <h2>No profile linked yet</h2>
          <p>Your login isn't linked to an employee record. Ask an admin to add your username in CrewCore's Roster.</p>
        </div>
      `;
    }
    const initials = String(e.name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    return `
      <div class="cc-profile">
        <div class="cc-profile-hd">
          <div class="cc-avatar">${esc(initials)}</div>
          <div>
            <h2>${esc(e.name)}</h2>
            <div class="sub">${esc(e.title || '')}${e.title && e.department ? ' · ' : ''}${esc(e.department || '')}</div>
          </div>
        </div>
        <div class="cc-field-grid">
          <div class="cc-field"><label>Start date</label><div class="v">${fmtDate(e.start_date)}</div></div>
          <div class="cc-field"><label>Status</label><div class="v"><span class="chip ${esc(e.status)}">${esc(e.status)}</span></div></div>
          <div class="cc-field"><label>Phone</label><div class="v">${esc(e.phone || '—')}</div></div>
          <div class="cc-field"><label>Email</label><div class="v">${esc(e.email || '—')}</div></div>
        </div>
      </div>
    `;
  },

  /* ---------------- Stipend ---------------- */

  _renderStipend() {
    const isAdmin = this._isAdmin;
    const nameFor = (id) => {
      const e = this._employees.find((x) => x.id === id);
      return e ? e.name : id;
    };

    if (isAdmin) {
      if (!this._employees.length) {
        return `<div class="cc-empty">No employees on the roster yet.</div>`;
      }
      return `
        <div class="cc-grid">
          ${this._employees.map((e) => {
            const spent = this._stipendSpends
              .filter((s) => s.employee_id === e.id)
              .filter((s) => String(s.date || '').slice(0, 4) === String(new Date().getFullYear()))
              .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
            const allotted = Number(e.apparel_stipend) || 0;
            const pct = allotted > 0 ? Math.min(100, Math.round((spent / allotted) * 100)) : 0;
            return `
              <div class="cc-card">
                <h3>${esc(e.name)}</h3>
                <div class="big">${fmtMoney(Math.max(0, allotted - spent))}</div>
                <div class="note">of ${fmtMoney(allotted)} remaining</div>
                <div class="cc-balance-bar"><div class="fill" style="width:${pct}%"></div></div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="cc-section">
          <h2>Spend log</h2>
          <div class="cc-list">
            ${this._stipendSpends.length ? this._stipendSpends.map((s) => `
              <div class="cc-row" data-id="${esc(s.id)}">
                <div>
                  <div class="who">${esc(nameFor(s.employee_id))}</div>
                  <div class="meta">${fmtDate(s.date)} · ${esc(s.category)}${s.description ? ' · ' + esc(s.description) : ''}</div>
                </div>
                <div>
                  <span class="meta">${fmtMoney(s.amount)}</span>
                  <button class="cc-btn sm ghost" data-act="delete">Remove</button>
                </div>
              </div>
            `).join('') : `<div class="cc-empty">Nothing logged yet.</div>`}
          </div>
        </div>
      `;
    }

    const bal = this._stipendBalance;
    const pct = bal && bal.allotted > 0 ? Math.min(100, Math.round((bal.used / bal.allotted) * 100)) : 0;
    return `
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Allotted (${bal ? bal.year : ''})</h3>
          <div class="big">${bal ? fmtMoney(bal.allotted) : '—'}</div>
        </div>
        <div class="cc-card">
          <h3>Used</h3>
          <div class="big">${bal ? fmtMoney(bal.used) : '—'}</div>
        </div>
        <div class="cc-card">
          <h3>Remaining</h3>
          <div class="big">${bal ? fmtMoney(bal.remaining) : '—'}</div>
          ${bal ? `<div class="cc-balance-bar"><div class="fill" style="width:${pct}%"></div></div>` : ''}
        </div>
      </div>
      <div class="cc-section">
        <h2>Your purchases</h2>
        <div class="cc-list">
          ${this._stipendSpends.length ? this._stipendSpends.map((s) => `
            <div class="cc-row">
              <div>
                <div class="who">${esc(s.category)}</div>
                <div class="meta">${fmtDate(s.date)}${s.description ? ' · ' + esc(s.description) : ''}</div>
              </div>
              <span class="meta">${fmtMoney(s.amount)}</span>
            </div>
          `).join('') : `<div class="cc-empty">Nothing logged yet.</div>`}
        </div>
      </div>
    `;
  },

  _wireStipend() {
    if (!this._isAdmin) return;
    const root = this._root;
    const body = root.querySelector('#ccBody');
    body.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest('.cc-row');
        const id = row.dataset.id;
        if (!confirm('Remove this spend entry?')) return;
        try {
          await this._ctx.api.request(ENDPOINTS.ccStipend + '?id=' + encodeURIComponent(id), { method: 'DELETE' });
          this.showView('stipend');
        } catch (e) {
          alert(e.message || 'Could not remove the entry.');
        }
      };
    });
  },

  _openStipendForm() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>Log a purchase</h3>
        <div class="cc-form-grid">
          <div class="full"><label>Employee</label>
            <select id="fEmp">${this._employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>
          </div>
          <div><label>Date</label><input id="fDate" type="date"></div>
          <div><label>Amount</label><input id="fAmount" type="number" step="0.01"></div>
          <div><label>Category</label>
            <select id="fCategory">${STIPEND_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </div>
          <div class="full"><label>Description</label><input id="fDescription" placeholder="e.g. branded quarter-zip"></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSubmit">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();
    $('#fSubmit').onclick = async () => {
      const payload = {
        employee_id: $('#fEmp').value,
        date: $('#fDate').value,
        amount: Number($('#fAmount').value),
        category: $('#fCategory').value,
        description: $('#fDescription').value
      };
      try {
        await this._ctx.api.request(ENDPOINTS.ccStipend, { method: 'POST', body: payload });
        wrap.remove();
        this.showView('stipend');
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Reviews ---------------- */

  _renderReviews() {
    const isAdmin = this._isAdmin;
    const nameFor = (id) => {
      const e = this._employees.find((x) => x.id === id);
      return e ? e.name : id;
    };
    if (!this._reviews.length) {
      return `<div class="cc-empty">No reviews logged yet.</div>`;
    }
    return `
      <div class="cc-list">
        ${this._reviews.map((r) => `
          <div class="cc-row">
            <div>
              ${isAdmin ? `<div class="who">${esc(nameFor(r.employee_id))}</div>` : ''}
              <div class="meta">${fmtDate(r.review_date)} · with ${esc(r.reviewer_name)}</div>
              ${r.summary ? `<div class="meta" style="margin-top:4px">${esc(r.summary)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  },

  _openReviewForm() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>Log a review</h3>
        <div class="cc-form-grid">
          <div class="full"><label>Employee</label>
            <select id="fEmp">${this._employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>
          </div>
          <div><label>Review date</label><input id="fDate" type="date"></div>
          <div><label>Reviewer</label><input id="fReviewer" value="${esc(this._ctx.user ? this._ctx.user.name : '')}"></div>
          <div class="full"><label>Summary</label><textarea id="fSummary" rows="2"></textarea></div>
          <div><label>Strengths</label><textarea id="fStrengths" rows="2"></textarea></div>
          <div><label>Growth areas</label><textarea id="fGrowth" rows="2"></textarea></div>
          <div><label>Next review date</label><input id="fNext" type="date"></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSubmit">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();
    $('#fSubmit').onclick = async () => {
      const payload = {
        employee_id: $('#fEmp').value,
        review_date: $('#fDate').value,
        reviewer_name: $('#fReviewer').value,
        summary: $('#fSummary').value,
        strengths: $('#fStrengths').value,
        growth_areas: $('#fGrowth').value,
        next_review_date: $('#fNext').value
      };
      try {
        await this._ctx.api.request(ENDPOINTS.ccReviews, { method: 'POST', body: payload });
        wrap.remove();
        this.showView('reviews');
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Handbook ---------------- */

  _renderHandbook() {
    const hb = this._handbook;
    if (!hb || !Array.isArray(hb.sections)) {
      return `<div class="cc-empty">Handbook content isn't available right now.</div>`;
    }
    const blockHtml = (b) => {
      if (b.h) return `<h3>${esc(b.h)}</h3>`;
      if (b.p) return `<p>${esc(b.p)}</p>`;
      if (b.list) return `<ul>${b.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`;
      return '';
    };

    // The handbook's own content has two different characters: the first
    // three sections are the founding story (About Us / Our Purpose / Our
    // Niche), everything after is policy. STORY_IDS below is how the split
    // is made without needing a new field on the content itself — if the
    // handbook content ever grows a real "kind" field this can read that
    // instead, but for now the three ids are stable (see
    // lib/crewcore/handbook-content.js).
    const STORY_IDS = new Set(['about-us', 'our-purpose', 'our-niche']);
    const story = hb.sections.filter((s) => STORY_IDS.has(s.id));
    const policy = hb.sections.filter((s) => !STORY_IDS.has(s.id));

    // Numbering only applies to the policy chapters. They ARE a sequence an
    // employee reads in order (basics, then pay, then conduct, then what
    // happens if it ends) — the story sections aren't a sequence, they're
    // one origin story told in three parts, so they don't get chapter
    // numbers.
    const policyNumbered = policy.map((s, i) => ({ ...s, num: i + 1 }));

    // Acknowledgment banner: only rendered for a self-serve caller (hb.
    // acknowledged is only ever present in the self-serve response shape —
    // see api/crewcore/handbook.js GET, which omits it entirely for admins).
    // Admins reading the handbook never see this at all.
    let ackHtml = '';
    if (hb.acknowledged === false) {
      ackHtml = `
        <div class="cc-hb-ack cc-hb-ack-pending">
          <div class="cc-hb-ack-text">
            <strong>Please read and agree to the handbook.</strong>
            You'll need to agree before you can use the rest of CrewCore.
          </div>
          <button class="cc-btn" id="ccHbAckBtn">I've read and agree</button>
        </div>
      `;
    } else if (hb.acknowledged === true) {
      const when = hb.ack_at ? new Date(hb.ack_at).toLocaleDateString() : '';
      ackHtml = `
        <div class="cc-hb-ack cc-hb-ack-done">
          <div class="cc-hb-ack-text">
            <strong>You're up to date.</strong>
            Agreed to this version${when ? ' on ' + esc(when) : ''}.
          </div>
        </div>
      `;
    }

    return `
      <div class="cc-hb-cover">
        <div class="cc-hb-cover-mark">
          <span class="w1">Crew</span><span class="w2">Core</span><span class="dot">.</span>
        </div>
        <h1 class="cc-hb-cover-title">Employee Handbook</h1>
        <div class="cc-hb-cover-sub">P&amp;M Apparel &middot; est. 1987 &middot; Polk City, Iowa</div>
        <div class="cc-hb-updated">Last updated ${esc(hb.updated || '')}</div>
      </div>

      ${ackHtml}

      <div class="cc-hb-nav">
        ${story.map((s) => `<button class="cc-hb-navbtn cc-hb-navbtn-story" data-jump="${esc(s.id)}">${esc(s.title)}</button>`).join('')}
        ${policyNumbered.map((s) => `<button class="cc-hb-navbtn" data-jump="${esc(s.id)}"><span class="cc-hb-navnum">${s.num}</span>${esc(s.title)}</button>`).join('')}
      </div>

      ${story.length ? `
        <div class="cc-hb-story">
          <div class="cc-hb-story-rule"><span>Our Story</span></div>
          ${story.map((s) => `
            <div class="cc-hb-section cc-hb-story-section" id="hb-${esc(s.id)}">
              <h2>${esc(s.title)}</h2>
              ${s.blocks.map(blockHtml).join('')}
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${policyNumbered.length ? `
        <div class="cc-hb-story-rule"><span>Policies &amp; Procedures</span></div>
        ${policyNumbered.map((s) => `
          <div class="cc-hb-section" id="hb-${esc(s.id)}">
            <div class="cc-hb-chapnum">${String(s.num).padStart(2, '0')}</div>
            <h2>${esc(s.title)}</h2>
            ${s.blocks.map(blockHtml).join('')}
          </div>
        `).join('')}
      ` : ''}

      ${hb.acknowledged === false ? `
        <div class="cc-hb-ack cc-hb-ack-pending cc-hb-ack-bottom">
          <div class="cc-hb-ack-text">
            <strong>That's the whole handbook.</strong>
            If you've read it, agree below to continue.
          </div>
          <button class="cc-btn" id="ccHbAckBtnBottom">I've read and agree</button>
        </div>
      ` : ''}
    `;
  },

  _wireHandbook() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    body.querySelectorAll('button[data-jump]').forEach((btn) => {
      btn.onclick = () => {
        const target = body.querySelector('#hb-' + btn.dataset.jump);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    const ackBtns = [body.querySelector('#ccHbAckBtn'), body.querySelector('#ccHbAckBtnBottom')].filter(Boolean);
    ackBtns.forEach((btn) => {
      btn.onclick = async () => {
        ackBtns.forEach((b) => { b.disabled = true; b.textContent = 'Saving\u2026'; });
        try {
          const out = await this._ctx.api.request(ENDPOINTS.ccHandbook, { method: 'POST', body: {} });
          this._handbook = {
            ...this._handbook,
            acknowledged: true,
            ack_version: out.ack_version,
            ack_at: out.ack_at,
          };
          // Re-render the handbook view in place so the banner flips to
          // "You're up to date" — the person stays right where they were
          // reading rather than being bounced anywhere.
          body.innerHTML = this._renderHandbook();
          this._wireHandbook();
        } catch (e) {
          ackBtns.forEach((b) => { b.disabled = false; b.textContent = "I've read and agree"; });
          alert('Could not save your agreement: ' + (e.message || 'unknown error') + '. Please try again.');
        }
      };
    });
  },

  /* ---------------- Settings (admin only) ---------------- */

  _renderSettings() {
    const s = this._settings || {};
    return `
      <div class="cc-form" style="max-width:480px">
        <h3>Apparel stipend defaults</h3>
        <div class="cc-form-grid">
          <div>
            <label>Front Office ($/year)</label>
            <input id="sFrontOffice" type="number" step="0.01" value="${s.default_stipend_front_office != null ? s.default_stipend_front_office : 250}">
          </div>
          <div>
            <label>Production ($/year)</label>
            <input id="sProduction" type="number" step="0.01" value="${s.default_stipend_production != null ? s.default_stipend_production : 150}">
          </div>
          <div class="full">
            <label>Self-serve</label>
            <select id="sSelfServe">
              <option value="true" ${s.self_serve_enabled !== false ? 'selected' : ''}>Enabled</option>
              <option value="false" ${s.self_serve_enabled === false ? 'selected' : ''}>Disabled (admin enters everything)</option>
            </select>
          </div>
        </div>
        <div class="cc-err" id="sErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn" id="sSave">Save</button>
        </div>
      </div>

      <div class="cc-form" style="max-width:480px">
        <h3>Time clock</h3>
        <div class="cc-form-grid">
          <div class="full">
            <label>Kiosk</label>
            <select id="sClockOn">
              <option value="true" ${s.clock_enabled !== false ? 'selected' : ''}>On</option>
              <option value="false" ${s.clock_enabled === false ? 'selected' : ''}>Off (nobody can punch)</option>
            </select>
          </div>
          <div>
            <label>Pay week starts</label>
            <select id="sWeekStart">
              ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
                .map((d, i) => `<option value="${i}" ${Number(s.week_start_day || 0) === i ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Overtime after (hours)</label>
            <input id="sOt" type="number" step="0.5" value="${s.overtime_after_hours != null ? s.overtime_after_hours : 40}">
          </div>
          <div>
            <label>Round totals to</label>
            <select id="sRound">
              ${[[0, 'Exact, no rounding'], [5, '5 minutes'], [6, '6 minutes (tenth of an hour)'], [10, '10 minutes'], [15, '15 minutes']]
                .map(([v, l]) => `<option value="${v}" ${Number(s.clock_round_minutes || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Kiosk link word (optional)</label>
            <input id="sKioskToken" value="${esc(s.clock_kiosk_token || '')}" placeholder="blank = open link">
          </div>
        </div>
        <div class="cc-err" id="sErr2" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn" id="sSaveClock">Save</button>
        </div>
      </div>
      <p style="font-size:12.5px;color:var(--muted);max-width:480px">
        The kiosk lives at <code>${esc(location.origin)}/clock</code>. Bookmark
        it on the shop tablet. Rounding only shapes the totals that get
        reported and exported, never the punch times themselves, so the
        record of what someone actually clocked stays exact. Setting a link
        word means the kiosk needs
        <code>${esc(location.origin)}/clock?k=YOURWORD</code> and the name
        list won't load without it.
      </p>
      <p style="font-size:12.5px;color:var(--muted);max-width:480px">
        These figures set the default when a NEW employee is added — they
        don't retroactively change anyone already on the roster. Per the
        Handbook's Dress Code policy, Sales and Office count as Front
        Office; Screen Printing, Embroidery, and Art count as Production.
        Disabling self-serve does not remove the "employee" role or revoke
        anyone's login, it's a soft switch for whether new self-serve
        behavior is expected to be on.
      </p>
    `;
  },

  _wireSettings() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const $ = (sel) => body.querySelector(sel);
    const err = $('#sErr');

    $('#sSave').onclick = async () => {
      const payload = {
        default_stipend_front_office: Number($('#sFrontOffice').value),
        default_stipend_production: Number($('#sProduction').value),
        self_serve_enabled: $('#sSelfServe').value === 'true'
      };
      try {
        const out = await this._ctx.api.request(ENDPOINTS.ccSettings, { method: 'PATCH', body: payload });
        this._settings = out.settings;
        err.hidden = true;
      } catch (e) {
        err.hidden = false;
        err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };

    const err2 = $('#sErr2');
    $('#sSaveClock').onclick = async () => {
      const payload = {
        clock_enabled: $('#sClockOn').value === 'true',
        week_start_day: Number($('#sWeekStart').value),
        overtime_after_hours: Number($('#sOt').value),
        clock_round_minutes: Number($('#sRound').value),
        clock_kiosk_token: $('#sKioskToken').value
      };
      try {
        const out = await this._ctx.api.request(ENDPOINTS.ccSettings, { method: 'PATCH', body: payload });
        this._settings = out.settings;
        err2.hidden = true;
      } catch (e) {
        err2.hidden = false;
        err2.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Time Clock ----------------
   *
   * Rush build, Aug 2026, replacing the shop's broken clock in/out system.
   *
   * Nobody PUNCHES here. Punching happens on /clock, a public page outside
   * the shell, because most of production has no Alliteration login. This
   * view is the back side: read the week, spot a missed punch, fix it,
   * export it for payroll.
   *
   * Same adaptive split as Roster. An admin gets the whole team and every
   * write. A self-serve employee gets their own hours, read only — worth
   * having, since "what did I actually work" was the question the broken
   * system left nobody able to answer.
   */

  async _loadTimecards() {
    const q = [];
    if (this._tcWeek) q.push('week=' + encodeURIComponent(this._tcWeek));
    if (this._tcDept) q.push('dept=' + encodeURIComponent(this._tcDept));
    if (this._tcEmployee) q.push('employee_id=' + encodeURIComponent(this._tcEmployee));
    if (this._tcInactive) q.push('include_inactive=1');
    const url = ENDPOINTS.ccTimecards + (q.length ? '?' + q.join('&') : '');
    this._tc = await this._ctx.api.get(url);
    // Pin the resolved week so the Prev/Next buttons have something concrete
    // to step from, instead of re-resolving "today" on every click.
    if (this._tc && this._tc.week_key) this._tcWeek = this._tc.week_key;
  },

  _tcShiftWeek(n) {
    const base = this._tcWeek || (this._tc && this._tc.week_key);
    if (!base) return;
    const [y, m, d] = base.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (7 * n));
    const p = (x) => String(x).padStart(2, '0');
    this._tcWeek = `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
    this.showView('timeclock');
  },

  _tcWeekLabel() {
    const dates = (this._tc && this._tc.dates) || [];
    if (!dates.length) return '';
    return fmtDate(dates[0]) + ' to ' + fmtDate(dates[6]);
  },

  _tcDayHead(dateStr) {
    const DL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { label: DL[dow], num: m + '/' + d };
  },

  _tcHrs(n) {
    const v = Number(n) || 0;
    return v ? v.toFixed(2) : '';
  },

  _renderTcToolbar() {
    const emps = this._employees || [];
    return `
      <div class="cc-toolbar">
        <div class="tc-weeknav">
          <button class="cc-btn ghost sm" id="tcPrev">&lsaquo; Prev</button>
          <span class="tc-weeklabel" id="tcLabel">${esc(this._tcWeekLabel())}</span>
          <button class="cc-btn ghost sm" id="tcNext">Next &rsaquo;</button>
          <button class="cc-btn ghost sm" id="tcToday">This week</button>
        </div>
        <span class="tc-spacer"></span>
        <select class="cc-filt" id="tcDept">
          <option value="">All departments</option>
          ${DEPARTMENTS.map((d) => `<option value="${esc(d)}" ${this._tcDept === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
        <select class="cc-filt" id="tcEmp">
          <option value="">Everyone</option>
          ${emps.map((e) => `<option value="${esc(e.id)}" ${this._tcEmployee === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
        </select>
      </div>
    `;
  },

  _renderTimeclockAdmin() {
    const tc = this._tc || {};
    const rows = tc.rows || [];
    const dates = tc.dates || [];
    const totals = tc.totals || { hours: 0, overtime: 0, flags: 0 };

    const nowIn = (tc.now_in || []).length
      ? `<div class="tc-now">
           <span class="lbl">On the clock now</span>
           ${tc.now_in.map((n) => `<span class="pill">${esc(n.name)} <span class="t">since ${esc(n.since_local)}</span></span>`).join('')}
         </div>`
      : '';

    // Every flag on one banner rather than buried in a row someone has to
    // think to expand. A missed clock-out is the whole reason this screen
    // gets looked at before payroll runs.
    const allFlags = [];
    rows.forEach((r) => {
      (r.summary.flags || []).forEach((f) => allFlags.push({ name: r.employee.name, ...f }));
    });
    const flagBanner = allFlags.length
      ? `<div class="tc-alert">
           <strong>${allFlags.length} shift${allFlags.length === 1 ? '' : 's'} need${allFlags.length === 1 ? 's' : ''} a look before payroll</strong>
           <ul>${allFlags.map((f) => `<li>${esc(f.name)}, ${fmtDate(f.date)}: ${esc(f.message)}</li>`).join('')}</ul>
         </div>`
      : '';

    const kiosk = `
      <div class="tc-kiosk">
        Kiosk page for the shop floor: <code>${esc(location.origin)}/clock</code>
        &nbsp;Employees pick a name and enter their passcode. No login.
        Set passcodes per person in Roster.
      </div>`;

    if (!rows.length) {
      return this._renderTcToolbar() + kiosk +
        `<div class="cc-empty">Nobody matches those filters.</div>`;
    }

    const cards = `
      <div class="cc-grid">
        <div class="cc-card"><h3>Hours this week</h3><div class="big">${(totals.hours || 0).toFixed(2)}</div>
          <div class="note">${rows.length} ${rows.length === 1 ? 'person' : 'people'}</div></div>
        <div class="cc-card"><h3>Overtime</h3><div class="big">${(totals.overtime || 0).toFixed(2)}</div>
          <div class="note">past ${tc.overtime_after || 40} hours</div></div>
        <div class="cc-card"><h3>On the clock</h3><div class="big">${(tc.now_in || []).length}</div>
          <div class="note">right now</div></div>
        ${totals.cost != null ? `<div class="cc-card"><h3>Estimated labor</h3><div class="big">${fmtMoney(totals.cost)}</div>
          <div class="note">base rate only, no OT multiplier</div></div>` : ''}
      </div>`;

    return this._renderTcToolbar() + nowIn + flagBanner + cards + kiosk + `
      <div class="cc-list">
        <table class="tc-grid">
          <thead>
            <tr>
              <th class="who">Employee</th>
              ${dates.map((d) => {
                const h = this._tcDayHead(d);
                return `<th>${h.label}<span class="dnum">${h.num}</span></th>`;
              }).join('')}
              <th>Total</th>
              <th>OT</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr class="emprow" data-id="${esc(r.employee.id)}">
                <td class="who">${esc(r.employee.name)}
                  <span class="dept">${esc(r.employee.department || '')}</span></td>
                ${dates.map((d) => {
                  const v = r.summary.days[d] || 0;
                  return `<td class="${v ? '' : 'zero'}">${v ? v.toFixed(2) : '·'}</td>`;
                }).join('')}
                <td class="total">${(r.summary.total_hours || 0).toFixed(2)}${(r.summary.flags || []).length ? '<span class="tc-flagdot"></span>' : ''}</td>
                <td class="${r.summary.overtime_hours ? 'ot' : 'zero'}">${r.summary.overtime_hours ? r.summary.overtime_hours.toFixed(2) : '·'}</td>
              </tr>
              <tr class="tc-detail" data-detail="${esc(r.employee.id)}" hidden>
                <td colspan="${dates.length + 3}">${this._renderShiftList(r)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="who">Total</td>
              ${dates.map((d) => {
                const v = rows.reduce((s, r) => s + (r.summary.days[d] || 0), 0);
                return `<td>${v ? v.toFixed(2) : '·'}</td>`;
              }).join('')}
              <td>${(totals.hours || 0).toFixed(2)}</td>
              <td>${(totals.overtime || 0).toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  },

  _renderShiftList(row) {
    const shifts = row.shifts || [];
    if (!shifts.length) {
      return `<div class="tc-shifts"><div class="tc-shift"><span class="note">No shifts recorded this week.</span>
        <span class="grow"></span>
        <button class="cc-btn ghost sm" data-addfor="${esc(row.employee.id)}">Add a shift</button></div></div>`;
    }
    return `
      <div class="tc-shifts">
        ${shifts.map((s) => `
          <div class="tc-shift">
            <span class="d">${fmtDate(s.date)}</span>
            <span class="times">${esc(s.in_time)} to ${s.out_time ? esc(s.out_time) : '<span class="tc-miss">no clock-out</span>'}</span>
            ${s.source === 'manual' ? '<span class="chip">edited</span>' : ''}
            ${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}
            <span class="grow"></span>
            <span class="h">${s.hours != null ? s.hours.toFixed(2) : '—'}</span>
            ${this._isAdmin ? `<button class="cc-btn ghost sm" data-edit="${esc(s.id)}" data-emp="${esc(row.employee.id)}" data-week="${esc(s.week_key)}">Fix</button>` : ''}
          </div>
        `).join('')}
        ${this._isAdmin ? `<div class="tc-shift"><span class="grow"></span>
          <button class="cc-btn ghost sm" data-addfor="${esc(row.employee.id)}">Add a shift</button></div>` : ''}
      </div>
    `;
  },

  _wireTimeclockAdmin() {
    const body = this._root.querySelector('#ccBody');
    const $ = (sel) => body.querySelector(sel);

    const prev = $('#tcPrev'); if (prev) prev.onclick = () => this._tcShiftWeek(-1);
    const next = $('#tcNext'); if (next) next.onclick = () => this._tcShiftWeek(1);
    const today = $('#tcToday'); if (today) today.onclick = () => { this._tcWeek = ''; this.showView('timeclock'); };

    const dept = $('#tcDept');
    if (dept) dept.onchange = () => { this._tcDept = dept.value; this.showView('timeclock'); };
    const emp = $('#tcEmp');
    if (emp) emp.onchange = () => { this._tcEmployee = emp.value; this.showView('timeclock'); };

    body.querySelectorAll('tr.emprow').forEach((tr) => {
      tr.onclick = () => {
        const det = body.querySelector(`tr[data-detail="${tr.dataset.id}"]`);
        if (det) det.hidden = !det.hidden;
      };
    });

    body.querySelectorAll('[data-addfor]').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        this._openShiftForm(null, btn.dataset.addfor);
      };
    });

    body.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const row = (this._tc.rows || []).find((r) => r.employee.id === btn.dataset.emp);
        const shift = row && row.shifts.find((s) => s.id === btn.dataset.edit);
        if (shift) this._openShiftForm({ ...shift, employee_id: btn.dataset.emp });
      };
    });
  },

  /**
   * Add or fix one shift. Times are entered as the wall clock the person
   * actually worked, not a timestamp — the server converts, so a correction
   * typed on a daylight saving changeover day still lands on the right hour.
   */
  _openShiftForm(shift, presetEmployeeId) {
    const body = this._root.querySelector('#ccBody');
    const isEdit = !!shift;
    const emps = this._employees || [];
    const empId = shift ? shift.employee_id : (presetEmployeeId || '');

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${isEdit ? 'Fix a shift' : 'Add a shift'}</h3>
        <div class="cc-form-grid">
          <div><label>Employee</label>
            <select id="tsEmp" ${isEdit ? 'disabled' : ''}>
              <option value="">Pick someone</option>
              ${emps.map((e) => `<option value="${esc(e.id)}" ${empId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
            </select>
          </div>
          <div><label>Date</label><input id="tsDate" type="date" value="${esc(shift ? shift.date : '')}"></div>
          <div><label>Clocked in</label><input id="tsIn" type="time" value="${esc(shift ? shift.in_time : '')}"></div>
          <div><label>Clocked out</label><input id="tsOut" type="time" value="${esc(shift && shift.out_time ? shift.out_time : '')}"></div>
          <div class="full"><label>Note (why this was entered by hand)</label>
            <input id="tsNote" value="${esc(shift ? shift.note : '')}" placeholder="forgot to punch out, tablet was down, etc"></div>
        </div>
        <div class="cc-err" id="tsErr" hidden></div>
        <div class="cc-form-actions">
          ${isEdit ? '<button class="cc-btn ghost" id="tsDelete">Delete</button>' : ''}
          <button class="cc-btn ghost" id="tsCancel">Cancel</button>
          <button class="cc-btn" id="tsSave">Save</button>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:10px">
          Leaving the clock-out time blank records an open shift, the same as
          somebody standing at the tablet right now. An out time earlier than
          the in time is read as crossing midnight.
        </p>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#tsErr');
    const fail = (m) => { err.hidden = false; err.textContent = m; };

    $('#tsCancel').onclick = () => wrap.remove();

    if (isEdit) {
      $('#tsDelete').onclick = async () => {
        if (!confirm('Delete this shift? This cannot be undone.')) return;
        try {
          await this._ctx.api.request(
            ENDPOINTS.ccTimecards + '?employee_id=' + encodeURIComponent(shift.employee_id) +
            '&week=' + encodeURIComponent(shift.week_key) + '&id=' + encodeURIComponent(shift.id),
            { method: 'DELETE' }
          );
          wrap.remove();
          this.showView('timeclock');
        } catch (e) {
          fail((e.body && e.body.error) || e.message || 'Could not delete.');
        }
      };
    }

    $('#tsSave').onclick = async () => {
      const payload = {
        employee_id: isEdit ? shift.employee_id : $('#tsEmp').value,
        date: $('#tsDate').value,
        in_time: $('#tsIn').value,
        out_time: $('#tsOut').value,
        note: $('#tsNote').value
      };
      if (!payload.employee_id) return fail('Pick an employee.');
      if (!payload.date || !payload.in_time) return fail('Date and clock-in time are both required.');

      try {
        if (isEdit) {
          await this._ctx.api.request(
            ENDPOINTS.ccTimecards + '?employee_id=' + encodeURIComponent(shift.employee_id) +
            '&week=' + encodeURIComponent(shift.week_key) + '&id=' + encodeURIComponent(shift.id),
            { method: 'PATCH', body: payload }
          );
        } else {
          await this._ctx.api.request(ENDPOINTS.ccTimecards, { method: 'POST', body: payload });
        }
        wrap.remove();
        this.showView('timeclock');
      } catch (e) {
        fail((e.body && e.body.details && e.body.details.join(', ')) || (e.body && e.body.error) || e.message || 'Could not save.');
      }
    };
  },

  /**
   * Payroll handoff. Built client side from the week already on screen, the
   * same way TravelTrack and ShopStock export, so what lands in the
   * spreadsheet is exactly the numbers being looked at and there is no
   * second round trip that could disagree with them.
   */
  _exportTimecards() {
    const tc = this._tc || {};
    const rows = tc.rows || [];
    const cell = (v) => {
      const str = String(v == null ? '' : v);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [['Employee', 'Department', 'Date', 'Clock in', 'Clock out', 'Hours', 'Source', 'Note'].map(cell).join(',')];
    rows.forEach((r) => {
      r.shifts.forEach((sh) => {
        lines.push([
          r.employee.name, r.employee.department, sh.date, sh.in_time,
          sh.out_time || 'MISSING CLOCK-OUT',
          sh.hours == null ? '' : sh.hours, sh.source, sh.note
        ].map(cell).join(','));
      });
      lines.push([r.employee.name, '', '', '', 'WEEK TOTAL', r.summary.total_hours, '', ''].map(cell).join(','));
    });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'timecards-' + (tc.week_key || 'week') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  },

  /* ---- Time Clock: self-serve ---- */

  _renderTimeclockSelf() {
    const tc = this._tc || {};
    const row = (tc.rows || [])[0];

    if (!row) {
      return `
        <div class="cc-locked">
          <h2>No timecard yet</h2>
          <p>${esc(tc.error_hint || "Nothing recorded for you this week.")}</p>
        </div>
      `;
    }

    const dates = tc.dates || [];
    const todayStr = new Date().toISOString().slice(0, 10);

    return `
      ${this._renderTcSelfNav()}
      <div class="cc-grid">
        <div class="cc-card"><h3>Hours this week</h3><div class="big">${(row.summary.total_hours || 0).toFixed(2)}</div>
          <div class="note">${esc(this._tcWeekLabel())}</div></div>
        ${row.summary.overtime_hours ? `<div class="cc-card"><h3>Overtime</h3><div class="big">${row.summary.overtime_hours.toFixed(2)}</div>
          <div class="note">past ${tc.overtime_after || 40} hours</div></div>` : ''}
      </div>
      <div class="tc-mine">
        ${dates.map((d) => {
          const h = this._tcDayHead(d);
          const v = row.summary.days[d] || 0;
          return `<div class="tc-day ${d === todayStr ? 'today' : ''}">
            <div class="dl">${h.label}</div><div class="dn">${h.num}</div>
            <div class="dh ${v ? '' : 'none'}">${v ? v.toFixed(2) : '·'}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="cc-section">
        <h2>Your shifts</h2>
        <div class="cc-list">${this._renderShiftList(row)}</div>
      </div>
      <p style="font-size:12.5px;color:var(--muted)">
        Something wrong here? Tell a manager. Timecards can only be corrected
        by an admin, on purpose.
      </p>
    `;
  },

  _renderTcSelfNav() {
    return `
      <div class="cc-toolbar">
        <div class="tc-weeknav">
          <button class="cc-btn ghost sm" id="tcPrev">&lsaquo; Prev</button>
          <span class="tc-weeklabel">${esc(this._tcWeekLabel())}</span>
          <button class="cc-btn ghost sm" id="tcNext">Next &rsaquo;</button>
          <button class="cc-btn ghost sm" id="tcToday">This week</button>
        </div>
      </div>
    `;
  },

  _wireTimeclockSelf() {
    const body = this._root.querySelector('#ccBody');
    const prev = body.querySelector('#tcPrev'); if (prev) prev.onclick = () => this._tcShiftWeek(-1);
    const next = body.querySelector('#tcNext'); if (next) next.onclick = () => this._tcShiftWeek(1);
    const today = body.querySelector('#tcToday');
    if (today) today.onclick = () => { this._tcWeek = ''; this.showView('timeclock'); };
  },

  unmount() {
    this._root = null;
    this._ctx = null;
  }
};
