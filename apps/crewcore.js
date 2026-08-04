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

  .cc-hb-nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
  .cc-hb-navbtn{
    border:1px solid var(--line);background:var(--card);border-radius:var(--radius-pill);
    padding:5px 12px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;
  }
  .cc-hb-navbtn:hover{color:var(--ink)}
  .cc-hb-section{margin-bottom:32px;scroll-margin-top:16px}
  .cc-hb-section h2{font-size:18px;font-weight:800;margin-bottom:12px;letter-spacing:-.01em}
  .cc-hb-section h3{font-size:13.5px;font-weight:700;margin:16px 0 6px}
  .cc-hb-section p{font-size:13.5px;line-height:1.65;color:var(--ink);margin-bottom:10px}
  .cc-hb-section ul{margin:0 0 10px 20px;padding:0}
  .cc-hb-section li{font-size:13.5px;line-height:1.65;margin-bottom:4px}
  .cc-hb-updated{font-size:12px;color:var(--muted);margin-bottom:20px}
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
          <thead><tr><th>Name</th><th>Department</th><th>Title</th><th>Start</th><th>Status</th><th>Rate</th><th>Stipend</th></tr></thead>
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
    return `
      <div class="cc-hb-updated">Last updated ${esc(hb.updated || '')}</div>
      <div class="cc-hb-nav">
        ${hb.sections.map((s) => `<button class="cc-hb-navbtn" data-jump="${esc(s.id)}">${esc(s.title)}</button>`).join('')}
      </div>
      ${hb.sections.map((s) => `
        <div class="cc-hb-section" id="hb-${esc(s.id)}">
          <h2>${esc(s.title)}</h2>
          ${s.blocks.map(blockHtml).join('')}
        </div>
      `).join('')}
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
  },

  unmount() {
    this._root = null;
    this._ctx = null;
  }
};
