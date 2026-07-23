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
  /* App chips carry each app's OWN color, set inline from the registry via
     --c. That is the whole point: scanning the list should show at a glance
     who can open what, and grey-on-grey chips make you read every word. */
  .app-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
  .app-chip{
    display:inline-flex;align-items:center;gap:5px;
    font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:var(--radius-pill);
    background:color-mix(in srgb, var(--c) 12%, transparent);
    color:var(--c);
    border:1px solid color-mix(in srgb, var(--c) 26%, transparent);
  }
  .app-chip .sq{width:6px;height:6px;border-radius:2px;background:var(--c);flex:none}
  .app-chip.off{
    background:transparent;color:var(--faint);border-color:var(--line);
  }
  .app-chip.off .sq{background:var(--line)}

  /* ---- role editor ---- */
  .role-block{
    border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:14px 16px;margin-bottom:10px;
  }
  .role-block.protected{background:var(--bg)}
  .role-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .role-name{font-size:14px;font-weight:700}
  .role-id{font-size:11.5px;color:var(--muted);margin-top:1px}
  .role-apps{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
  .app-toggle{
    display:inline-flex;align-items:center;gap:6px;cursor:pointer;
    font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:var(--radius-pill);
    border:1px solid var(--line);background:var(--card);color:var(--muted);
    font-family:inherit;transition:.12s;
  }
  .app-toggle .sq{width:7px;height:7px;border-radius:2px;background:var(--line);flex:none}
  .app-toggle[aria-pressed="true"]{
    background:color-mix(in srgb, var(--c) 12%, transparent);
    border-color:color-mix(in srgb, var(--c) 40%, transparent);
    color:var(--c);
  }
  .app-toggle[aria-pressed="true"] .sq{background:var(--c)}
  .app-toggle:disabled{opacity:.55;cursor:default}
  .role-opts{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12.5px}
  .role-opts label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--muted)}
  .role-opts input{cursor:pointer}
  .role-lock{font-size:11.5px;color:var(--faint);margin-top:10px;line-height:1.5}
  .role-holders{font-size:11.5px;color:var(--muted);margin-top:8px}

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
        <div class="set-card-hd">
          <h2>Roles</h2>
          <div>
            <span class="set-msg" id="roleMsg" style="display:none;margin:0 8px 0 0;padding:4px 9px"></span>
            <button class="set-btn" id="addRoleBtn">Add role</button>
            <button class="set-btn primary" id="saveRolesBtn" disabled>Save changes</button>
          </div>
        </div>
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

    /** App chips in each app's own color, so the list is scannable. */
    function appChips(ids) {
      if (!ids || !ids.length) {
        return '<span class="app-chip off"><span class="sq"></span>No apps</span>';
      }
      return ids.map((id) => {
        const a = APPS.find((x) => x.id === id);
        const name = a ? a.name : id;
        const color = a ? a.accent : 'var(--muted)';
        return '<span class="app-chip" style="--c:' + esc(color) + '">' +
                 '<span class="sq"></span>' + esc(name) +
               '</span>';
      }).join('');
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
              '<div class="app-chips">' + appChips(role.apps) + '</div></td>' +
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

    /**
     * Roles are edited in place: toggle apps, tick permissions, then Save.
     *
     * Not saved per-click, unlike the classification dropdowns in GivingGauge.
     * Roles have invariants that only hold for a COMPLETE set — every role must
     * keep at least one app — so a half-made edit is a state the server would
     * rightly reject. Batching means the whole set is valid when it is sent.
     */
    function renderRoles() {
      const names = Object.keys(roles);
      if (!names.length) { $('#roleList').innerHTML = ''; return; }

      const holderCount = (roleKey) => users.filter((u) => u.role === roleKey).length;

      $('#roleList').innerHTML = names.map((key) => {
        const r = roles[key];
        const locked = !!r.protected;
        const held = holderCount(key);

        const toggles = APPS.map((a) => {
          const on = Array.isArray(r.apps) && r.apps.includes(a.id);
          return '<button class="app-toggle" type="button"' +
            ' style="--c:' + esc(a.accent) + '"' +
            ' data-role="' + esc(key) + '" data-app-toggle="' + esc(a.id) + '"' +
            ' aria-pressed="' + on + '"' +
            (locked ? ' disabled' : '') + '>' +
            '<span class="sq"></span>' + esc(a.name) +
          '</button>';
        }).join('');

        return '' +
          '<div class="role-block' + (locked ? ' protected' : '') + '">' +
            '<div class="role-top">' +
              '<div>' +
                '<div class="role-name">' + esc(r.label || key) + '</div>' +
                '<div class="role-id">' + esc(key) +
                  (held ? ' · ' + held + (held === 1 ? ' person' : ' people') : ' · nobody yet') +
                '</div>' +
              '</div>' +
              (locked ? '' :
                '<button class="set-btn danger" data-del-role="' + esc(key) + '">Delete role</button>') +
            '</div>' +

            '<div class="role-apps">' + toggles + '</div>' +

            '<div class="role-opts">' +
              '<label><input type="checkbox" data-role="' + esc(key) + '" data-flag="can_edit"' +
                (r.can_edit !== false ? ' checked' : '') + (locked ? ' disabled' : '') + '> Can edit</label>' +
              '<label><input type="checkbox" data-role="' + esc(key) + '" data-flag="can_export"' +
                (r.can_export !== false ? ' checked' : '') + (locked ? ' disabled' : '') + '> Can export</label>' +
              '<label><input type="checkbox" data-role="' + esc(key) + '" data-flag="own_only"' +
                (r.data_scope === 'own' ? ' checked' : '') + (locked ? ' disabled' : '') + '> Own accounts only</label>' +
            '</div>' +

            (locked
              ? '<div class="role-lock">The admin role always keeps every app and every ' +
                'permission. Without that, an administrator could remove their own access ' +
                'to the only screen that could undo it.</div>'
              : '') +
          '</div>';
      }).join('');
    }

    let dirty = false;
    function markDirty(on) {
      dirty = on;
      const btn = $('#saveRolesBtn');
      if (btn) btn.disabled = !on;
    }

    function sayRole(text, kind) {
      const el = $('#roleMsg');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'set-msg ' + (kind || '');
      el.style.display = text ? 'inline-block' : 'none';
      el.style.margin = '0 8px 0 0';
      el.style.padding = '4px 9px';
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

    /* ---- role editing ---- */

    // App toggles and permission ticks edit the LOCAL copy. Nothing reaches the
    // server until Save, because saveRoles validates the whole set at once.
    root.addEventListener('click', (e) => {
      const tog = e.target.closest('[data-app-toggle]');
      if (!tog || tog.disabled) return;

      const key = tog.dataset.role;
      const appId = tog.dataset.appToggle;
      const role = roles[key];
      if (!role) return;

      role.apps = Array.isArray(role.apps) ? role.apps : [];
      const at = role.apps.indexOf(appId);
      if (at === -1) role.apps.push(appId); else role.apps.splice(at, 1);

      // Warn immediately rather than letting Save fail: a role with no apps
      // means its people sign in to a blank screen.
      if (!role.apps.length) {
        sayRole('"' + (role.label || key) + '" has no apps', 'err');
      } else {
        sayRole('');
      }

      renderRoles();
      markDirty(true);
    });

    root.addEventListener('change', (e) => {
      const box = e.target.closest('[data-flag]');
      if (!box || box.disabled) return;

      const role = roles[box.dataset.role];
      if (!role) return;

      const flag = box.dataset.flag;
      if (flag === 'own_only') role.data_scope = box.checked ? 'own' : 'all';
      else role[flag] = box.checked;

      markDirty(true);
    });

    $('#saveRolesBtn').addEventListener('click', async () => {
      const empty = Object.keys(roles).filter(
        (k) => k !== 'admin' && (!roles[k].apps || !roles[k].apps.length));
      if (empty.length) {
        sayRole('Give ' + empty.join(', ') + ' at least one app first', 'err');
        return;
      }

      const btn = $('#saveRolesBtn');
      btn.disabled = true;
      sayRole('Saving...');
      try {
        const out = await ctx.api.post(ENDPOINTS.users + '?scope=roles', { roles });
        roles = out.roles || roles;
        renderRoles();
        renderUsers();          // the people table shows role apps too
        fillRoleSelect();
        markDirty(false);
        sayRole('Saved', 'ok');
        setTimeout(() => sayRole(''), 2500);
      } catch (err) {
        sayRole(err.message || 'Could not save roles', 'err');
        btn.disabled = false;
      }
    });

    $('#addRoleBtn').addEventListener('click', () => {
      const label = prompt('Name for the new role (e.g. "Production Lead"):');
      if (!label || !label.trim()) return;

      const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!key) { sayRole('That name has no usable letters or numbers', 'err'); return; }
      if (roles[key]) { sayRole('A role called "' + key + '" already exists', 'err'); return; }

      roles[key] = {
        name: key,
        label: label.trim(),
        protected: false,
        // Starts with BackBone only. An empty app list would be invalid, and
        // defaulting to everything would quietly over-grant.
        apps: ['backbone'],
        data_scope: 'all',
        can_edit: true,
        can_export: false
      };
      renderRoles();
      markDirty(true);
      sayRole('Added "' + label.trim() + '". Pick its apps, then Save.', 'ok');
    });

    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-role]');
      if (!del) return;

      const key = del.dataset.delRole;
      const held = users.filter((u) => u.role === key);
      if (held.length) {
        // Deleting a role someone holds would silently drop them to viewer
        // permissions. They would not lose access, they would lose the RIGHT
        // access, which is harder to notice.
        sayRole(held.length + (held.length === 1 ? ' person is' : ' people are') +
                ' still using this role. Move them first.', 'err');
        return;
      }
      if (!confirm('Delete the "' + (roles[key].label || key) + '" role?')) return;

      try {
        const out = await ctx.api.del(ENDPOINTS.users + '?scope=roles&role=' + encodeURIComponent(key));
        roles = out.roles || roles;
        renderRoles();
        fillRoleSelect();
        markDirty(false);
        sayRole('Role deleted', 'ok');
      } catch (err) {
        sayRole(err.message || 'Could not delete that role', 'err');
      }
    });

    await load();
  },

  showView() {
    // Single view.
  }
};
