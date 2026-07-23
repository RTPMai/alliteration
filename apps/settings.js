/**
 * Settings — accounts and access.
 *
 * This lives in the SHELL, not in any one app. Accounts are shell-level now:
 * one login covers all five apps, so managing them from inside BackBone (where
 * they used to live) would imply BackBone owns them. It does not.
 *
 * BackBone's own user-management screen is deleted as part of its port. This
 * replaces it.
 *
 * Everything here is admin-only. api/users.js enforces that independently, so
 * hiding the app from the rail is a courtesy rather than the control.
 */

import { ENDPOINTS } from '../js/api.js';
import { APPS } from '../js/registry.js';

export default {
  id: 'settings',

  styles: `
  .set-wrap{max-width:900px}
  .set-hd{margin-bottom:22px}
  .set-hd h1{font-size:24px;font-weight:800;letter-spacing:-.02em}
  .set-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}

  .set-card{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    margin-bottom:16px;overflow:hidden;box-shadow:var(--shadow-card);
  }
  .set-card-hd{
    padding:14px 20px;border-bottom:1px solid var(--line);
    display:flex;align-items:center;justify-content:space-between;gap:12px;
  }
  .set-card-hd h2{font-size:14.5px;font-weight:700}
  .set-card-bd{padding:16px 20px 20px}

  .u-table{width:100%;border-collapse:collapse;font-size:13px}
  .u-table th{
    text-align:left;color:var(--muted);font-weight:600;padding:9px 12px;
    border-bottom:1px solid var(--line);font-size:11.5px;
    text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;
  }
  .u-table td{padding:11px 12px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  .u-table tr:last-child td{border-bottom:none}
  .u-name{font-weight:700}
  .u-sub{font-size:11.5px;color:var(--muted);margin-top:1px}
  .u-actions{text-align:right;white-space:nowrap}

  .set-btn{
    border:1px solid var(--line);background:var(--card);color:var(--ink);
    font-family:inherit;font-size:12px;font-weight:600;padding:5px 10px;
    border-radius:var(--radius-sm);cursor:pointer;margin-left:6px;
  }
  .set-btn:hover{border-color:var(--muted)}
  .set-btn.danger{color:var(--danger);border-color:var(--danger-line)}
  .set-btn.danger:hover{background:var(--danger-tint)}
  .set-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .set-btn.primary:hover{background:var(--accent-deep)}
  .set-btn:disabled{opacity:.5;cursor:default}

  .set-field{margin-bottom:12px}
  .set-field label{
    display:block;font-size:11px;font-weight:700;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);margin-bottom:5px;
  }
  .set-field input,.set-field select{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:9px 11px;font-family:inherit;font-size:13.5px;color:var(--ink);
    background:var(--card);
  }
  .set-field input:focus,.set-field select:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }
  .set-field .hint{font-size:11.5px;color:var(--faint);margin-top:4px}

  .set-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}

  .set-msg{
    font-size:12.5px;border-radius:var(--radius-sm);padding:9px 11px;margin-bottom:14px;
  }
  .set-msg.err{background:var(--danger-tint);color:var(--danger)}
  .set-msg.ok{background:var(--success-tint);color:var(--success-dk)}

  .role-pill{
    display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;background:var(--accent-tint);color:var(--accent-deep);
  }
  .app-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
  .app-chip{
    font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:var(--radius-pill);
    background:var(--line-soft);color:var(--muted);
  }

  .set-empty{padding:32px 20px;text-align:center;color:var(--muted);font-size:13px}
  .set-note{
    font-size:12.5px;color:var(--muted);border-left:3px solid var(--accent);
    padding-left:12px;margin-top:14px;line-height:1.55;
  }

  @media (max-width:720px){
    .set-grid{grid-template-columns:1fr}
    .u-table th:nth-child(3),.u-table td:nth-child(3){display:none}
  }
  `,

  template: `
    <div class="set-wrap">
      <div class="set-hd">
        <h1>Settings.</h1>
        <div class="sub">Accounts and access for every app in the shell.</div>
      </div>

      <div id="setMsg"></div>

      <div class="set-card">
        <div class="set-card-hd">
          <h2>People</h2>
          <button class="set-btn primary" id="addUserBtn">Add someone</button>
        </div>
        <div id="addUserForm" style="display:none">
          <div class="set-card-bd" style="border-bottom:1px solid var(--line)">
            <div class="set-grid">
              <div class="set-field">
                <label for="nu-username">Username</label>
                <input id="nu-username" autocomplete="off">
                <div class="hint">3-32 characters: letters, numbers, dot, dash, underscore</div>
              </div>
              <div class="set-field">
                <label for="nu-name">Full name</label>
                <input id="nu-name" autocomplete="off">
              </div>
              <div class="set-field">
                <label for="nu-password">Password</label>
                <input id="nu-password" type="password" autocomplete="new-password">
                <div class="hint">At least 8 characters</div>
              </div>
              <div class="set-field">
                <label for="nu-role">Role</label>
                <select id="nu-role"></select>
              </div>
            </div>
            <button class="set-btn primary" id="saveUserBtn">Create account</button>
            <button class="set-btn" id="cancelUserBtn">Cancel</button>
          </div>
        </div>
        <div id="userList"><div class="set-empty">Loading...</div></div>
      </div>

      <div class="set-card">
        <div class="set-card-hd"><h2>Roles</h2></div>
        <div class="set-card-bd" id="roleList"></div>
      </div>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    let users = [];
    let roles = {};

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);

    function say(text, kind) {
      $('#setMsg').innerHTML = text
        ? '<div class="set-msg ' + kind + '">' + esc(text) + '</div>'
        : '';
    }

    async function load() {
      try {
        const data = await ctx.api.get(ENDPOINTS.users);
        users = data.users || [];
        roles = data.roles || {};
        renderUsers();
        renderRoles();
        fillRoleSelect();
      } catch (e) {
        $('#userList').innerHTML =
          '<div class="set-empty">Could not load accounts: ' + esc(e.message) + '</div>';
      }
    }

    function appNames(ids) {
      return (ids || []).map((id) => {
        const a = APPS.find((x) => x.id === id);
        return a ? a.name : id;
      });
    }

    function renderUsers() {
      if (!users.length) {
        $('#userList').innerHTML = '<div class="set-empty">No accounts yet.</div>';
        return;
      }

      const me = ctx.user ? String(ctx.user.username || '').toLowerCase() : '';

      $('#userList').innerHTML =
        '<table class="u-table"><thead><tr>' +
          '<th>Person</th><th>Role</th><th>Last signed in</th><th></th>' +
        '</tr></thead><tbody>' +
        users.map((u) => {
          const role = roles[u.role] || {};
          const isMe = String(u.username).toLowerCase() === me;
          return '<tr>' +
            '<td><div class="u-name">' + esc(u.name || u.username) +
              (isMe ? ' <span class="u-sub" style="display:inline">(you)</span>' : '') +
            '</div><div class="u-sub">' + esc(u.username) + '</div></td>' +
            '<td><span class="role-pill">' + esc(role.label || u.role) + '</span>' +
              '<div class="app-chips">' +
                appNames(role.apps).map((n) => '<span class="app-chip">' + esc(n) + '</span>').join('') +
              '</div></td>' +
            '<td class="u-sub">' + (u.last_login ? esc(new Date(u.last_login).toLocaleDateString()) : 'Never') + '</td>' +
            '<td class="u-actions">' +
              '<button class="set-btn" data-reset="' + esc(u.username) + '">Reset password</button>' +
              // Deleting yourself would leave a valid cookie for an account
              // that no longer exists; the endpoint refuses it too.
              (isMe ? '' : '<button class="set-btn danger" data-del="' + esc(u.username) + '">Remove</button>') +
            '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    }

    function renderRoles() {
      const names = Object.keys(roles);
      if (!names.length) { $('#roleList').innerHTML = ''; return; }

      $('#roleList').innerHTML =
        '<table class="u-table"><thead><tr>' +
          '<th>Role</th><th>Apps</th><th>Can edit</th>' +
        '</tr></thead><tbody>' +
        names.map((k) => {
          const r = roles[k];
          return '<tr>' +
            '<td><div class="u-name">' + esc(r.label || k) + '</div>' +
              '<div class="u-sub">' + esc(k) + (r.protected ? ' · protected' : '') + '</div></td>' +
            '<td><div class="app-chips">' +
              appNames(r.apps).map((n) => '<span class="app-chip">' + esc(n) + '</span>').join('') +
            '</div></td>' +
            '<td>' + (r.can_edit === false ? 'Read only' : 'Yes') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>' +
        '<div class="set-note">Roles decide which apps someone can open. The admin role ' +
        'always keeps every app, so an administrator cannot lock themselves out of the ' +
        'only screen that could undo it.</div>';
    }

    function fillRoleSelect() {
      $('#nu-role').innerHTML = Object.keys(roles).map((k) =>
        '<option value="' + esc(k) + '">' + esc(roles[k].label || k) + '</option>'
      ).join('');
    }

    /* ---- add ---- */

    $('#addUserBtn').addEventListener('click', () => {
      const f = $('#addUserForm');
      const open = f.style.display !== 'none';
      f.style.display = open ? 'none' : 'block';
      if (!open) $('#nu-username').focus();
    });

    $('#cancelUserBtn').addEventListener('click', () => {
      $('#addUserForm').style.display = 'none';
      say('');
    });

    $('#saveUserBtn').addEventListener('click', async () => {
      const btn = $('#saveUserBtn');
      btn.disabled = true;
      say('');
      try {
        await ctx.api.post(ENDPOINTS.users, {
          username: $('#nu-username').value.trim(),
          name: $('#nu-name').value.trim(),
          password: $('#nu-password').value,
          role: $('#nu-role').value
        });
        ['#nu-username', '#nu-name', '#nu-password'].forEach((s) => { $(s).value = ''; });
        $('#addUserForm').style.display = 'none';
        say('Account created.', 'ok');
        await load();
      } catch (e) {
        say(e.message || 'Could not create that account', 'err');
      } finally {
        btn.disabled = false;
      }
    });

    /* ---- reset + remove ---- */

    root.addEventListener('click', async (e) => {
      const reset = e.target.closest('[data-reset]');
      if (reset) {
        const username = reset.dataset.reset;
        const pw = prompt('New password for ' + username + ' (at least 8 characters):');
        if (!pw) return;
        try {
          await ctx.api.request(ENDPOINTS.users + '?username=' + encodeURIComponent(username), {
            method: 'PATCH',
            body: { password: pw }
          });
          say('Password updated for ' + username + '.', 'ok');
        } catch (err) {
          say(err.message || 'Could not update that password', 'err');
        }
        return;
      }

      const del = e.target.closest('[data-del]');
      if (del) {
        const username = del.dataset.del;
        if (!confirm('Remove ' + username + '? They will be signed out and cannot sign back in.')) return;
        try {
          await ctx.api.del(ENDPOINTS.users + '?username=' + encodeURIComponent(username));
          say(username + ' removed.', 'ok');
          await load();
        } catch (err) {
          say(err.message || 'Could not remove that account', 'err');
        }
      }
    });

    await load();
  },

  showView() {
    // Single view.
  }
};
