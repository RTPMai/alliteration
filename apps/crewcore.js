/**
 * CrewCore — employee management for the whole team.
 *
 * REAL BUILD, Aug 2026, replacing the earlier stub. No standalone to port
 * from: the closest prior art was the P&M internal Wix site
 * (ryan7339.wixsite.com/pminternal), specifically Company Structure (org
 * chart) and Contact List (roster seed). Neither is a system with data to
 * migrate, just reference pages.
 *
 * SELF-SERVE, decided Aug 3 2026: an "employee" role (data_scope "own") can
 * see their own roster entry (minus pay/stipend/notes), request PTO and see
 * their own balance, and read their own review history. Everyone else with
 * the app granted (data_scope "all", or any superuser account) gets the full
 * admin views. The split is enforced server-side in api/crewcore/*.js — this
 * file adapts what it RENDERS based on ctx.perms, but never trusts the client
 * to be the actual gate.
 *
 * Four views: Dashboard (admin: anniversaries + pending PTO queue; self-serve
 * callers land on Roster instead, see showView), Roster (admin: full list +
 * add/edit; self-serve: your own profile card), PTO (both: request + your
 * balance; admin also gets the approve/deny queue), Reviews (admin: full
 * history + add; self-serve: read-only own history).
 */

import { ENDPOINTS } from '../js/api.js';

const DEPARTMENTS = ['Screen Printing', 'Embroidery', 'Sales', 'Art', 'Office'];
const PTO_TYPES = ['vacation', 'sick', 'personal', 'unpaid'];

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
  .chip.pending{background:var(--accent-tint);color:var(--accent-deep)}
  .chip.approved{background:var(--success-tint);color:var(--success)}
  .chip.denied,.chip.terminated{background:var(--danger-tint);color:var(--danger)}
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

    this._ptoRequests = [];
    this._ptoBalance = null;
    this._reviews = [];
  },

  async _loadPto() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccPto);
    this._ptoRequests = payload.requests || [];
    this._ptoBalance = payload.balance || null;
  },

  async _loadReviews() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccReviews);
    this._reviews = payload.reviews || [];
  },

  async _loadSettings() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccSettings);
    this._settings = payload.settings || { default_pto_days: 10, self_serve_enabled: true };
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
      sub.textContent = 'Anniversaries and what needs your attention.';
      await this._loadPto();
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

    if (view === 'pto') {
      title.textContent = 'PTO.';
      sub.textContent = isAdmin ? 'Requests and balances across the team.' : 'Your time off.';
      await this._loadPto();
      actions.innerHTML = `<button class="cc-btn" id="ccRequestBtn">Request time off</button>`;
      const reqBtn = $('#ccRequestBtn');
      if (reqBtn) reqBtn.onclick = () => this._openPtoForm();
      body.innerHTML = this._renderPto();
      this._wirePto();
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

    if (view === 'settings') {
      // Not reachable by a self-serve caller — allowedViews() in
      // js/registry.js scopes the "employee" role to dashboard/roster/pto/
      // reviews only, so this view never appears in their rail. Still guard
      // here rather than trust the rail alone, same as every other app.
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

    const pending = this._ptoRequests.filter((r) => r.status === 'pending');

    return `
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Team</h3>
          <div class="big">${this._employees.filter((e) => e.status === 'active').length}</div>
          <div class="note">active employees</div>
        </div>
        <div class="cc-card">
          <h3>Pending PTO</h3>
          <div class="big">${pending.length}</div>
          <div class="note">${pending.length ? 'needs a decision' : 'all caught up'}</div>
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

      <div class="cc-section">
        <h2>Pending PTO requests</h2>
        <div class="cc-list">
          ${pending.length ? pending.map((r) => {
            const emp = this._employees.find((e) => e.id === r.employee_id);
            return `
            <div class="cc-row">
              <div>
                <div class="who">${esc(emp ? emp.name : r.employee_id)}</div>
                <div class="meta">${esc(r.type)} · ${fmtDate(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ' – ' + fmtDate(r.end_date) : ''} · ${r.days}d</div>
              </div>
              <span class="chip pending">pending</span>
            </div>`;
          }).join('') : `<div class="cc-empty">No pending requests.</div>`}
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
          <thead><tr><th>Name</th><th>Department</th><th>Title</th><th>Start</th><th>Status</th><th>Rate</th></tr></thead>
          <tbody>
            ${rows.map((e) => `
              <tr class="clickable" data-id="${esc(e.id)}">
                <td>${esc(e.name)}</td>
                <td>${esc(e.department || '')}</td>
                <td>${esc(e.title || '')}</td>
                <td>${fmtDate(e.start_date)}</td>
                <td><span class="chip ${esc(e.status)}">${esc(e.status)}</span></td>
                <td>${e.hourly_rate != null ? fmtMoney(e.hourly_rate) + '/hr' : '—'}</td>
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
          <div><label>Apparel stipend</label><input id="fStipend" type="number" step="0.01" value="${emp ? emp.apparel_stipend : 0}"></div>
          <div><label>PTO days / year</label><input id="fPtoDays" type="number" step="0.5" value="${emp ? emp.pto_days_per_year : 0}"></div>
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
        apparel_stipend: $('#fStipend').value === '' ? 0 : Number($('#fStipend').value),
        pto_days_per_year: $('#fPtoDays').value === '' ? 0 : Number($('#fPtoDays').value),
        notes: $('#fNotes').value
      };
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

  /* ---------------- PTO ---------------- */

  _renderPto() {
    const isAdmin = this._isAdmin;

    if (isAdmin) {
      const pending = this._ptoRequests.filter((r) => r.status === 'pending');
      const rest = this._ptoRequests.filter((r) => r.status !== 'pending');
      const nameFor = (id) => {
        const e = this._employees.find((x) => x.id === id);
        return e ? e.name : id;
      };
      const rowHtml = (r, showActions) => `
        <div class="cc-row" data-id="${esc(r.id)}">
          <div>
            <div class="who">${esc(nameFor(r.employee_id))}</div>
            <div class="meta">${esc(r.type)} · ${fmtDate(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ' – ' + fmtDate(r.end_date) : ''} · ${r.days}d${r.note ? ' · ' + esc(r.note) : ''}</div>
          </div>
          ${showActions
            ? `<div><button class="cc-btn sm" data-act="approved">Approve</button> <button class="cc-btn sm ghost" data-act="denied">Deny</button></div>`
            : `<span class="chip ${esc(r.status)}">${esc(r.status)}</span>`
          }
        </div>
      `;
      return `
        <div class="cc-section">
          <h2>Pending</h2>
          <div class="cc-list" id="ccPtoPending">
            ${pending.length ? pending.map((r) => rowHtml(r, true)).join('') : `<div class="cc-empty">Nothing pending.</div>`}
          </div>
        </div>
        <div class="cc-section">
          <h2>History</h2>
          <div class="cc-list">
            ${rest.length ? rest.map((r) => rowHtml(r, false)).join('') : `<div class="cc-empty">No history yet.</div>`}
          </div>
        </div>
      `;
    }

    const bal = this._ptoBalance;
    return `
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Allotted (${bal ? bal.year : ''})</h3>
          <div class="big">${bal ? bal.allotted : '—'}</div>
          <div class="note">days</div>
        </div>
        <div class="cc-card">
          <h3>Used</h3>
          <div class="big">${bal ? bal.used : '—'}</div>
          <div class="note">days</div>
        </div>
        <div class="cc-card">
          <h3>Remaining</h3>
          <div class="big">${bal ? bal.remaining : '—'}</div>
          <div class="note">days</div>
        </div>
      </div>
      <div class="cc-section">
        <h2>Your requests</h2>
        <div class="cc-list">
          ${this._ptoRequests.length ? this._ptoRequests.map((r) => `
            <div class="cc-row" data-id="${esc(r.id)}">
              <div>
                <div class="who">${esc(r.type)}</div>
                <div class="meta">${fmtDate(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ' – ' + fmtDate(r.end_date) : ''} · ${r.days}d${r.note ? ' · ' + esc(r.note) : ''}</div>
              </div>
              <div>
                <span class="chip ${esc(r.status)}">${esc(r.status)}</span>
                ${r.status === 'pending' ? ` <button class="cc-btn sm ghost" data-act="cancel">Cancel</button>` : ''}
              </div>
            </div>
          `).join('') : `<div class="cc-empty">No requests yet.</div>`}
        </div>
      </div>
    `;
  },

  _wirePto() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const isAdmin = this._isAdmin;

    if (isAdmin) {
      const pendingList = body.querySelector('#ccPtoPending');
      if (pendingList) {
        pendingList.querySelectorAll('button[data-act]').forEach((btn) => {
          btn.onclick = async () => {
            const row = btn.closest('.cc-row');
            const id = row.dataset.id;
            try {
              await this._ctx.api.request(ENDPOINTS.ccPto + '?id=' + encodeURIComponent(id), {
                method: 'PATCH', body: { status: btn.dataset.act }
              });
              this.showView('pto');
            } catch (e) {
              alert(e.message || 'Could not update the request.');
            }
          };
        });
      }
      return;
    }

    body.querySelectorAll('button[data-act="cancel"]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest('.cc-row');
        const id = row.dataset.id;
        try {
          await this._ctx.api.request(ENDPOINTS.ccPto + '?id=' + encodeURIComponent(id), {
            method: 'PATCH', body: { status: 'cancelled' }
          });
          this.showView('pto');
        } catch (e) {
          alert(e.message || 'Could not cancel the request.');
        }
      };
    });
  },

  _openPtoForm() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const isAdmin = this._isAdmin;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>Request time off</h3>
        <div class="cc-form-grid">
          ${isAdmin ? `<div class="full"><label>Employee</label>
            <select id="fEmp">${this._employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>
          </div>` : ''}
          <div><label>Start date</label><input id="fStart" type="date"></div>
          <div><label>End date</label><input id="fEnd" type="date"></div>
          <div><label>Type</label>
            <select id="fType">${PTO_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
          </div>
          <div><label>Days</label><input id="fDays" type="number" step="0.5" value="1"></div>
          <div class="full"><label>Note (optional)</label><input id="fNote"></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSubmit">Submit</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();
    $('#fSubmit').onclick = async () => {
      const payload = {
        start_date: $('#fStart').value,
        end_date: $('#fEnd').value || $('#fStart').value,
        type: $('#fType').value,
        days: Number($('#fDays').value)
      };
      if ($('#fNote')) payload.note = $('#fNote').value;
      if (isAdmin) payload.employee_id = $('#fEmp').value;

      try {
        await this._ctx.api.request(ENDPOINTS.ccPto, { method: 'POST', body: payload });
        wrap.remove();
        this.showView('pto');
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not submit.';
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

  /* ---------------- Settings (admin only) ---------------- */

  _renderSettings() {
    const s = this._settings || {};
    return `
      <div class="cc-form" style="max-width:480px">
        <h3>Defaults</h3>
        <div class="cc-form-grid">
          <div>
            <label>Default PTO days / year</label>
            <input id="sDefaultPto" type="number" step="0.5" value="${s.default_pto_days != null ? s.default_pto_days : 10}">
          </div>
          <div>
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
        Disabling self-serve does not remove the "employee" role or revoke
        anyone's login. It's a soft switch an admin can flip off if
        self-service turns out to need a rethink, without touching account
        setup. Employees already assigned the role keep their CrewCore access
        either way; this only governs whether new self-serve behavior is
        expected to be on.
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
        default_pto_days: Number($('#sDefaultPto').value),
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
