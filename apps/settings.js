// PUT IN: apps/settings.js (REPLACES the current one)
// (this banner line is for verification only, delete it after checking the path)

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
// SITE_APPS is included in the role toggles so StickySituations can be granted
// without handing somebody the Admin flag. It is one entry, and it is off for
// every role until ticked here.
import { APPS, SITE_APPS } from '../js/registry.js';

// The full toggle list. Site apps sit at the end, after the real apps, because
// they are a different kind of thing: the build-the-platform list rather than
// something used to run the business.
const GRANTABLE_APPS = APPS.concat(SITE_APPS);
// Resolves the donation-decision switch the same way the server does, so the
// box shows ticked for a role that has always been able to decide even though
// nothing was ever written to storage for it.
import { givingDecideVerdict } from '../lib/giving-access.js';
import { GRANT_FLAGS, resolveAccess, accessSummary } from '../lib/user-grants.js';

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
  /* Per-account access, Sep 2026 */
  .u-access{max-width:260px}
  .u-sub.on-account{color:var(--accent)}
  .u-access-panel{
    border:1px solid var(--line);border-radius:var(--radius);
    background:var(--bg);padding:14px;margin:2px 0 8px;
  }
  .u-access-hd{font-size:13px;font-weight:700;margin-bottom:2px}
  .u-access-hd .u-sub{font-weight:400;display:block}
  .u-access-panel .role-flags{margin-top:12px;display:flex;flex-wrap:wrap;gap:10px 18px}
  .acc-copy{font-size:12px;color:var(--muted);margin:10px 0}
  .acc-copy select{margin:0 8px;font-family:inherit;font-size:12px}
  .acc-apps{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .acc-app{border:1px solid transparent;border-radius:var(--radius);padding:4px}
  .acc-app.on{border-color:var(--line);background:var(--card)}
  .acc-views{display:flex;flex-direction:column;gap:3px;padding:8px 4px 2px;font-size:11.5px}
  .acc-views label{display:flex;align-items:center;gap:6px}
  .acc-views .hint{margin-top:4px}
  .u-access-panel .role-flags label{display:flex;align-items:center;gap:7px}
  .u-access-panel .src{font-size:11px;color:var(--muted)}
  .u-access-msg{font-size:12px;color:var(--muted);margin-top:10px;min-height:16px}
  .u-access-msg.err{color:var(--danger)}
  .u-access-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
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
  /* Inline role switcher in the Accounts table. Styled like the pill so the
     table reads the same whether the cell is editable (others) or not (you). */
  .role-select{
    padding:2px 24px 2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;font-family:inherit;
    background:var(--accent-tint);color:var(--accent-deep);
    border:1px solid transparent;cursor:pointer;appearance:auto;
  }
  .role-select:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }
  .role-select:disabled{opacity:.6;cursor:default}
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
                <div class="hint">A new account starts with no apps. Press Set
                access on their row once it exists.</div>
              </div>
            </div>
            <button class="set-btn primary" id="saveUserBtn">Create account</button>
            <button class="set-btn" id="cancelUserBtn">Cancel</button>
          </div>
        </div>
        <div id="userList"><div class="set-empty">Loading...</div></div>
      </div>

    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    let users = [];

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
        renderUsers();
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
        const a = GRANTABLE_APPS.find((x) => x.id === id);
        const name = a ? a.name : id;
        const color = a ? a.accent : 'var(--muted)';
        return '<span class="app-chip" style="--c:' + esc(color) + '">' +
                 '<span class="sq"></span>' + esc(name) +
               '</span>';
      }).join('');
    }

    /**
     * What the Access column says. "Role default" when this account is
     * exactly its role, otherwise the differences by name.
     */
    const appName = (id) => {
      const a = GRANTABLE_APPS.find((x) => x.id === id);
      return a ? a.name : id;
    };

    /**
     * What the Access column says: the apps this person can open, with a note
     * when one of them is narrowed to particular screens.
     */
    function accessCell(u) {
      const bits = accessSummary(u.access, appName);
      if (!bits.length) {
        return '<div class="u-sub">No apps yet</div>';
      }
      return '<div class="u-sub on-account">' + esc(bits.join(', ')) + '</div>';
    }

    /**
     * The access editor for one person, opened under their row.
     *
     * Seeded from the RESOLVED values, so opening it shows what they have
     * today whether that came from the role or from here. Touching a box
     * writes that one key onto the account; everything untouched keeps
     * inheriting. Reset to role clears the lot.
     *
     * Note what is deliberately absent: nothing here can make somebody a
     * CrewCore admin. That is the Admin flag or the protected admin role, and
     * permsFor() applies CrewCore's self-serve ceiling after these grants,
     * so ticking CrewCore on an account gets the same six self-serve views a
     * role would, never Roster or CrewCore Settings.
     */
    function openAccess(username) {
      const u = users.find((x) => x.username === username);
      if (!u) return;
      const access = resolveAccess(u.access);
      // Edited as a copy. Nothing reaches the server until Save, so closing
      // the panel changes nothing.
      const draft = {
        apps: access.apps.slice(),
        views: JSON.parse(JSON.stringify(access.views || {})),
        data_scope: access.data_scope,
      };
      GRANT_FLAGS.forEach((f) => { draft[f.key] = access[f.key]; });

      const wrap = document.createElement('div');
      wrap.className = 'u-access-panel';

      // An app is off, on for everything, or on for particular screens. The
      // third case is why per-view narrowing had to move onto the account:
      // "StitchSense, Stitch Guess only" used to be a property of a role, and
      // with roles gone it is a thing you tick for a person.
      const appBlock = (a) => {
        const on = draft.apps.indexOf(a.id) !== -1;
        // Registry views are [id, label] pairs, not objects.
        const views = (a.views || []).map((v) =>
          Array.isArray(v) ? { id: v[0], name: v[1] || v[0] } : v);
        const picked = draft.views[a.id] || [];
        return '<div class="acc-app' + (on ? ' on' : '') + '" data-acc-block="' + esc(a.id) + '">' +
          '<button type="button" class="app-toggle' + (on ? ' on' : '') +
            '" data-acc-app="' + esc(a.id) + '" style="--c:' + esc(a.accent) + '">' +
            '<span class="sq"></span>' + esc(a.name) + '</button>' +
          (on && views.length > 1
            ? '<div class="acc-views">' + views.map((v) =>
                '<label><input type="checkbox" data-acc-view="' + esc(a.id) + '" value="' + esc(v.id) + '"' +
                  (!picked.length || picked.indexOf(v.id) !== -1 ? ' checked' : '') + '> ' +
                  esc(v.name) + '</label>').join('') +
              '<div class="hint">All ticked means every screen. Untick to narrow.</div></div>'
            : '') +
        '</div>';
      };

      const others = users.filter((x) => x.username !== username);

      wrap.innerHTML =
        '<div class="u-access-hd">Access for ' + esc(u.name || u.username) +
          '<span class="u-sub">This is their whole access. There is no role behind it.</span></div>' +
        (others.length
          ? '<div class="acc-copy">Start from somebody else: ' +
              '<select data-acc="copy"><option value="">pick a person</option>' +
              others.map((o) => '<option value="' + esc(o.username) + '">' +
                esc(o.name || o.username) + '</option>').join('') +
              '</select><span class="hint">Copies their access here for you to adjust. ' +
              'Values only, no link, so changing one person never changes another.</span></div>'
          : '') +
        '<div class="acc-apps">' + GRANTABLE_APPS.map(appBlock).join('') + '</div>' +
        '<div class="role-flags">' +
          GRANT_FLAGS.map((f) =>
            '<label><input type="checkbox" data-acc-flag="' + esc(f.key) + '"' +
              (draft[f.key] ? ' checked' : '') + '> ' + esc(f.label) + '</label>').join('') +
          '<label><input type="checkbox" data-acc-flag="own_only"' +
            (draft.data_scope === 'own' ? ' checked' : '') + '> Own accounts only</label>' +
        '</div>' +
        '<div class="u-access-msg" id="accMsg"></div>' +
        '<div class="u-access-actions">' +
          '<button class="set-btn" data-acc="cancel">Cancel</button>' +
          '<button class="set-btn" data-acc="clear">Remove all access</button>' +
          '<button class="set-btn primary" data-acc="save">Save access</button>' +
        '</div>';

      const row = $('[data-access="' + username + '"]').closest('tr');
      const holder = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.appendChild(wrap);
      holder.appendChild(cell);
      row.parentNode.insertBefore(holder, row.nextSibling);

      const q = (sel) => wrap.querySelector(sel);
      const say = (msg, kind) => {
        const el = q('#accMsg');
        el.textContent = msg || '';
        el.className = 'u-access-msg' + (kind ? ' ' + kind : '');
      };

      const repaintApps = () => {
        wrap.querySelector('.acc-apps').innerHTML = GRANTABLE_APPS.map(appBlock).join('');
        bindApps();
      };

      function bindApps() {
        wrap.querySelectorAll('[data-acc-app]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-acc-app');
            const at = draft.apps.indexOf(id);
            if (at === -1) {
              draft.apps.push(id);
            } else {
              draft.apps.splice(at, 1);
              // A narrowing on an app somebody cannot open is dead weight,
              // and it would come back to life if the app were re-ticked.
              delete draft.views[id];
            }
            say('');
            repaintApps();
          });
        });
        wrap.querySelectorAll('[data-acc-view]').forEach((box) => {
          box.addEventListener('change', () => {
            const id = box.getAttribute('data-acc-view');
            const app = GRANTABLE_APPS.find((x) => x.id === id);
            const all = (app && app.views ? app.views : [])
              .map((v) => (Array.isArray(v) ? v[0] : v.id));
            const ticked = Array.prototype.slice
              .call(wrap.querySelectorAll('[data-acc-view="' + id + '"]'))
              .filter((el) => el.checked).map((el) => el.value);
            if (!ticked.length) {
              // Every screen unticked would grant an app that shows nothing,
              // which reads as broken rather than restricted. Refused here so
              // nobody has to discover it from a blank rail.
              box.checked = true;
              say('Leave at least one screen ticked, or turn the app off.', 'err');
              return;
            }
            // All of them is the same as no narrowing at all, and storing it
            // would silently freeze the list on the day it was saved: a view
            // added later would not appear for this person.
            if (ticked.length === all.length) delete draft.views[id];
            else draft.views[id] = ticked;
            say('');
          });
        });
      }
      bindApps();

      wrap.querySelectorAll('[data-acc-flag]').forEach((box) => {
        box.addEventListener('change', () => {
          const key = box.getAttribute('data-acc-flag');
          if (key === 'own_only') draft.data_scope = box.checked ? 'own' : 'all';
          else draft[key] = box.checked;
          say('');
        });
      });

      const copy = q('[data-acc="copy"]');
      if (copy) {
        copy.addEventListener('change', () => {
          const from = users.find((x) => x.username === copy.value);
          if (!from) return;
          const src = resolveAccess(from.access);
          draft.apps = src.apps.slice();
          draft.views = JSON.parse(JSON.stringify(src.views || {}));
          draft.data_scope = src.data_scope;
          GRANT_FLAGS.forEach((f) => { draft[f.key] = src[f.key]; });
          repaintApps();
          wrap.querySelectorAll('[data-acc-flag]').forEach((box) => {
            const key = box.getAttribute('data-acc-flag');
            box.checked = key === 'own_only' ? draft.data_scope === 'own' : !!draft[key];
          });
          copy.value = '';
          say('Copied ' + (from.name || from.username) + '. Nothing is saved until you press Save access.');
        });
      }

      const close = () => { holder.remove(); };
      q('[data-acc="cancel"]').addEventListener('click', close);
      q('[data-acc="clear"]').addEventListener('click', async () => {
        if (!confirm('Remove every app from ' + (u.name || u.username) + '?')) return;
        await saveAccess(username, { apps: [], views: {}, data_scope: draft.data_scope }, close, say);
      });
      q('[data-acc="save"]').addEventListener('click', async () => {
        await saveAccess(username, draft, close, say);
      });
    }

    async function saveAccess(username, access, close, say) {
      say('Saving...');
      try {
        const out = await ctx.api.request(
          ENDPOINTS.users + '?username=' + encodeURIComponent(username),
          { method: 'PATCH', body: { access: access } });
        const at = users.findIndex((x) => x.username === username);
        if (at !== -1 && out.user) users[at] = out.user;
        close();
        renderUsers();
      } catch (err) {
        say(err.message || 'Could not save access', 'err');
      }
    }

    function renderUsers() {
      if (!users.length) {
        $('#userList').innerHTML = '<div class="set-empty">No accounts yet.</div>';
        return;
      }

      const me = ctx.user ? String(ctx.user.username || '').toLowerCase() : '';

      $('#userList').innerHTML =
        '<table class="u-table"><thead><tr>' +
          // "Admin", not "Superuser" — Ryan's call, Aug 2026. The stored field
          // is still `superuser` everywhere in code. With roles gone this is
          // the only administrator there is, which is why the last one cannot
          // be unticked.
          '<th>Person</th><th>Access</th><th>Admin</th><th>Last signed in</th><th></th>' +
        '</tr></thead><tbody>' +
        users.map((u) => {
          const isMe = String(u.username).toLowerCase() === me;
          return '<tr>' +
            '<td><div class="u-name">' + esc(u.name || u.username) +
              (isMe ? ' <span class="u-sub" style="display:inline">(you)</span>' : '') +
            '</div><div class="u-sub">' + esc(u.username) + '</div></td>' +
            // ACCESS, Sep 2026. Roles are gone; this IS their access, not an
            // override of anything. Shown in the table rather than only inside
            // an editor, because an access model nobody can read at a glance
            // is one nobody audits.
            '<td class="u-access">' + accessCell(u) +
              '<button class="set-btn" data-access="' + esc(u.username) + '">Set access</button></td>' +
            // Separate from role on purpose: an account can be "admin" and
            // still not see stub apps like CrewCore's pay/review data unless
            // this is checked. Unlike role, editing your own is allowed —
            // it only changes what stub placeholders you can see, nothing
            // about sign-in access, so there is no lockout risk.
            '<td>' +
              '<label class="su-toggle" title="Admin: sees every app in the rail, including Site Work and anything not yet built">' +
                '<input type="checkbox" data-superuser-user="' + esc(u.username) + '"' +
                  (u.superuser ? ' checked' : '') + '>' +
              '</label>' +
            '</td>' +
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
          password: $('#nu-password').value
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
      const acc = e.target.closest('[data-access]');
      if (acc) {
        const username = acc.dataset.access;
        // Toggle: a second press on an open editor closes it rather than
        // stacking a second copy under the same row.
        const open = acc.closest('tr').nextSibling;
        if (open && open.querySelector && open.querySelector('.u-access-panel')) {
          open.remove();
        } else {
          document.querySelectorAll('.u-access-panel').forEach((el) => {
            const holder = el.closest('tr');
            if (holder) holder.remove();
          });
          openAccess(username);
        }
        return;
      }

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

    /* ---- switch a user's role ---- */

    // Saved per-change, unlike the role editor below: one user's role is a
    // single independent value, so there is no half-made state to batch.
    root.addEventListener('change', async (e) => {
      const su = e.target.closest('[data-superuser-user]');
      if (su) {
        const username = su.dataset.superuserUser;
        const next = su.checked;
        su.disabled = true;
        try {
          await ctx.api.request(ENDPOINTS.users + '?username=' + encodeURIComponent(username), {
            method: 'PATCH',
            body: { superuser: next }
          });
          say(username + (next ? ' can now see not-yet-built apps.' : ' no longer sees not-yet-built apps.'), 'ok');
          await load();
        } catch (err) {
          say(err.message || 'Could not change that setting', 'err');
          await load();
        }
      }
    });

    await load();
  },

  showView() {
    // Single view.
  }
};
