// PUT IN: apps/notifications.js (new)
// (this banner line is for verification only, delete it after checking the path)

/**
 * Notifications — shell-level to-do / hand-off list.
 *
 * Lives in the SHELL, same reasoning as Settings: this is not one app's
 * data, it spans all of them, so it does not belong inside BackBone or any
 * other single app. Every signed-in employee can open this (unlike
 * Settings, which is admin-only) — see js/registry.js SHELL_APPS.
 *
 * Two views, both driven off one fetch:
 *   inbox -> notifications ASSIGNED TO the signed-in user
 *   sent  -> notifications CREATED BY the signed-in user
 *
 * The header bell (js/shell.js) shows the open count for "inbox" from
 * anywhere in the shell; this screen is where you actually work the list.
 */

import { ENDPOINTS } from '../js/api.js';
import { APPS } from '../js/registry.js';
import { TYPES, GENERAL_APP } from '../lib/notifications/schema.js';

const APP_OPTIONS = APPS.map((a) => ({ id: a.id, name: a.name, accent: a.accent }))
  .concat([{ id: GENERAL_APP, name: 'General', accent: 'var(--muted)' }]);

function appMeta(id) {
  return APP_OPTIONS.find((a) => a.id === id) || { id, name: id, accent: 'var(--muted)' };
}

function typeLabel(v) {
  const hit = TYPES.find((t) => t.value === v);
  return hit ? hit.label : v;
}

function fmtDue(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days < 0) return 'Overdue ' + d.toLocaleDateString();
  return 'Due ' + d.toLocaleDateString();
}

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

export default {
  id: 'notifications',

  styles: `
  .nt-wrap{max-width:900px}
  .nt-hd{margin-bottom:22px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .nt-hd h1{font-size:24px;font-weight:800;letter-spacing:-.02em}
  .nt-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}

  .nt-btn{
    border:1px solid var(--line);background:var(--card);color:var(--ink);
    font-family:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;
    border-radius:var(--radius-sm);cursor:pointer;
  }
  .nt-btn:hover{border-color:var(--muted)}
  .nt-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .nt-btn.primary:hover{background:var(--accent-deep)}
  .nt-btn.danger{color:var(--danger);border-color:var(--danger-line)}
  .nt-btn.danger:hover{background:var(--danger-tint)}
  .nt-btn:disabled{opacity:.5;cursor:default}
  .nt-btn.small{padding:4px 9px;font-size:11.5px}

  .nt-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--line)}
  .nt-tab{
    border:none;background:none;font-family:inherit;font-size:13px;font-weight:700;
    color:var(--muted);padding:9px 4px;margin-right:18px;cursor:pointer;
    border-bottom:2px solid transparent;
  }
  .nt-tab.active{color:var(--accent-deep);border-color:var(--accent)}
  .nt-tab .ct{color:var(--faint);font-weight:600;margin-left:4px}

  .nt-msg{font-size:12.5px;border-radius:var(--radius-sm);padding:9px 11px;margin-bottom:14px}
  .nt-msg.err{background:var(--danger-tint);color:var(--danger)}
  .nt-msg.ok{background:var(--success-tint);color:var(--success-dk)}

  .nt-form{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow-card);
  }
  .nt-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .nt-field{margin-bottom:12px}
  .nt-field label{
    display:block;font-size:11px;font-weight:700;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);margin-bottom:5px;
  }
  .nt-field input,.nt-field select,.nt-field textarea{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:9px 11px;font-family:inherit;font-size:13.5px;color:var(--ink);
    background:var(--card);
  }
  .nt-field textarea{resize:vertical;min-height:60px}
  .nt-field input:focus,.nt-field select:focus,.nt-field textarea:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }

  .nt-card{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:14px 16px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start;
  }
  .nt-card.done{opacity:.55}
  .nt-check{margin-top:2px;width:17px;height:17px;cursor:pointer;flex:none}
  .nt-body{flex:1;min-width:0}
  .nt-title{font-size:14px;font-weight:700;color:var(--ink)}
  .nt-title.done{text-decoration:line-through}
  .nt-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;align-items:center}
  .nt-pill{
    display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;
    padding:2px 9px;border-radius:var(--radius-pill);white-space:nowrap;
  }
  .nt-pill .sq{width:6px;height:6px;border-radius:2px;flex:none}
  .nt-pill.app{
    background:color-mix(in srgb, var(--c) 12%, transparent);color:var(--c);
    border:1px solid color-mix(in srgb, var(--c) 26%, transparent);
  }
  .nt-pill.app .sq{background:var(--c)}
  .nt-pill.type-task{background:var(--bg);color:var(--muted);border:1px solid var(--line)}
  .nt-pill.type-need{background:var(--warn-tint);color:var(--warn-dk);border:1px solid var(--warn-tint)}
  .nt-pill.type-handoff{background:var(--accent-tint);color:var(--tier-a);border:1px solid transparent}
  .nt-meta{font-size:11.5px;color:var(--faint);margin-top:6px}
  .nt-notes{font-size:12.5px;color:var(--muted);margin-top:6px;line-height:1.5}
  .nt-actions{display:flex;gap:6px;flex:none}

  .nt-empty{padding:32px 20px;text-align:center;color:var(--muted);font-size:13px}
  .nt-showdone{font-size:12px;color:var(--muted);margin:10px 0 4px;display:flex;align-items:center;gap:6px;cursor:pointer}

  @media (max-width:640px){ .nt-grid{grid-template-columns:1fr} }
  `,

  template: `
    <div class="nt-wrap">
      <div class="nt-hd">
        <div>
          <h1>Notifications.</h1>
          <div class="sub">Tasks, needs, and hand offs across every app.</div>
        </div>
        <button class="nt-btn primary" id="ntNewBtn">New notification</button>
      </div>

      <div id="ntMsg"></div>

      <div class="nt-tabs">
        <button class="nt-tab" data-tab="inbox">Assigned to me<span class="ct" id="ntInboxCt"></span></button>
        <button class="nt-tab" data-tab="sent">I assigned<span class="ct" id="ntSentCt"></span></button>
      </div>

      <div id="ntForm" style="display:none"></div>
      <div id="ntList"><div class="nt-empty">Loading…</div></div>
      <label class="nt-showdone" id="ntShowDoneWrap" style="display:none">
        <input type="checkbox" id="ntShowDone"> Show completed
      </label>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    let all = [];
    let people = [];
    let tab = 'inbox';
    let showDone = false;

    const me = String(ctx.user && ctx.user.username || '').toLowerCase();

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);

    function say(text, kind) {
      $('#ntMsg').innerHTML = text
        ? '<div class="nt-msg ' + kind + '">' + esc(text) + '</div>'
        : '';
    }

    async function load() {
      try {
        const [notesRes, peopleRes] = await Promise.all([
          ctx.api.get(ENDPOINTS.notifications),
          people.length ? Promise.resolve({ people }) : ctx.api.get(ENDPOINTS.notifications, { people: '1' })
        ]);
        all = notesRes.notifications || [];
        people = peopleRes.people || people;
        renderTabs();
        renderList();
      } catch (e) {
        $('#ntList').innerHTML = '<div class="nt-empty">Could not load notifications: ' + esc(e.message) + '</div>';
      }
    }

    function renderTabs() {
      const inboxOpen = all.filter((n) => n.assignedTo === me && n.status === 'open').length;
      const sentOpen = all.filter((n) => n.createdBy === me && n.status === 'open').length;
      $('#ntInboxCt').textContent = inboxOpen ? ' (' + inboxOpen + ')' : '';
      $('#ntSentCt').textContent = sentOpen ? ' (' + sentOpen + ')' : '';
      root.querySelectorAll('.nt-tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
    }

    function typePillClass(t) {
      return 'nt-pill type-' + (t === 'handoff' ? 'handoff' : t === 'need' ? 'need' : 'task');
    }

    function cardHtml(n) {
      const app = appMeta(n.appId);
      const done = n.status === 'done';
      const who = tab === 'inbox'
        ? 'From ' + esc(n.createdByName || n.createdBy)
        : 'To ' + esc(n.assignedToName || n.assignedTo);
      const due = n.dueDate ? ' · ' + esc(fmtDue(n.dueDate)) : '';
      return '' +
        '<div class="nt-card' + (done ? ' done' : '') + '" data-id="' + esc(n.id) + '">' +
          '<input type="checkbox" class="nt-check" data-toggle="' + esc(n.id) + '"' +
            (done ? ' checked' : '') + ' title="' + (done ? 'Mark open' : 'Mark done') + '">' +
          '<div class="nt-body">' +
            '<div class="nt-title' + (done ? ' done' : '') + '">' + esc(n.title) + '</div>' +
            '<div class="nt-tags">' +
              '<span class="nt-pill app" style="--c:' + esc(app.accent) + '"><span class="sq"></span>' + esc(app.name) + '</span>' +
              '<span class="' + typePillClass(n.type) + '">' + esc(typeLabel(n.type)) + '</span>' +
            '</div>' +
            (n.notes ? '<div class="nt-notes">' + esc(n.notes) + '</div>' : '') +
            '<div class="nt-meta">' + who + due + ' · ' + esc(relTime(n.createdAt)) + '</div>' +
          '</div>' +
          '<div class="nt-actions"><button class="nt-btn small danger" data-del="' + esc(n.id) + '">Delete</button></div>' +
        '</div>';
    }

    function renderList() {
      const mine = tab === 'inbox'
        ? all.filter((n) => n.assignedTo === me)
        : all.filter((n) => n.createdBy === me);

      const visible = mine.filter((n) => showDone || n.status !== 'done');
      $('#ntShowDoneWrap').style.display = mine.some((n) => n.status === 'done') ? 'flex' : 'none';

      if (!visible.length) {
        $('#ntList').innerHTML = '<div class="nt-empty">' +
          (tab === 'inbox' ? 'Nothing assigned to you right now.' : 'You have not assigned anything yet.') +
        '</div>';
        return;
      }

      $('#ntList').innerHTML = visible
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'done' ? 1 : -1))
        .map(cardHtml).join('');
    }

    function fillFormSelects() {
      const appSel = $('#nf-app');
      if (appSel) {
        appSel.innerHTML = APP_OPTIONS.map((a) =>
          '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
      }
      const whoSel = $('#nf-who');
      if (whoSel) {
        whoSel.innerHTML = people.map((p) =>
          '<option value="' + esc(p.username) + '"' + (p.username === me ? ' selected' : '') + '>' +
            esc(p.name) + (p.username === me ? ' (you)' : '') +
          '</option>').join('');
      }
    }

    function openForm() {
      $('#ntForm').innerHTML =
        '<div class="nt-form">' +
          '<div class="nt-grid">' +
            '<div class="nt-field" style="grid-column:1/-1"><label for="nf-title">Title</label>' +
              '<input id="nf-title" maxlength="200" placeholder="What needs to happen"></div>' +
            '<div class="nt-field"><label for="nf-type">Type</label><select id="nf-type">' +
              TYPES.map((t) => '<option value="' + t.value + '">' + t.label + '</option>').join('') +
            '</select></div>' +
            '<div class="nt-field"><label for="nf-app">App</label><select id="nf-app"></select></div>' +
            '<div class="nt-field"><label for="nf-who">Assign to</label><select id="nf-who"></select></div>' +
            '<div class="nt-field"><label for="nf-due">Due date (optional)</label><input id="nf-due" type="date"></div>' +
            '<div class="nt-field" style="grid-column:1/-1"><label for="nf-notes">Notes (optional)</label>' +
              '<textarea id="nf-notes" maxlength="2000"></textarea></div>' +
          '</div>' +
          '<button class="nt-btn primary" id="nf-save">Create</button>' +
          '<button class="nt-btn" id="nf-cancel">Cancel</button>' +
        '</div>';

      fillFormSelects();
      $('#ntForm').style.display = 'block';
      $('#nf-title').focus();

      $('#nf-cancel').addEventListener('click', () => { $('#ntForm').style.display = 'none'; $('#ntForm').innerHTML = ''; });

      $('#nf-save').addEventListener('click', async () => {
        const btn = $('#nf-save');
        btn.disabled = true;
        say('');
        try {
          await ctx.api.post(ENDPOINTS.notifications, {
            title: $('#nf-title').value.trim(),
            type: $('#nf-type').value,
            appId: $('#nf-app').value,
            assignedTo: $('#nf-who').value,
            dueDate: $('#nf-due').value || null,
            notes: $('#nf-notes').value.trim()
          });
          $('#ntForm').style.display = 'none';
          $('#ntForm').innerHTML = '';
          say('Notification created.', 'ok');
          await load();
        } catch (e) {
          say(e.message || 'Could not create that notification', 'err');
        } finally {
          btn.disabled = false;
        }
      });
    }

    $('#ntNewBtn').addEventListener('click', () => {
      const open = $('#ntForm').style.display !== 'none';
      if (open) { $('#ntForm').style.display = 'none'; $('#ntForm').innerHTML = ''; }
      else openForm();
    });

    root.querySelectorAll('.nt-tab').forEach((b) => {
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        ctx.go(tab);
        renderTabs();
        renderList();
      });
    });

    $('#ntShowDone').addEventListener('change', (e) => {
      showDone = e.target.checked;
      renderList();
    });

    root.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-toggle]');
      if (!box) return;
      const id = box.dataset.toggle;
      const next = box.checked ? 'done' : 'open';
      box.disabled = true;
      try {
        await ctx.api.patch(ENDPOINTS.notifications, { status: next }, { query: { id } });
        await load();
      } catch (err) {
        say(err.message || 'Could not update that notification', 'err');
        box.disabled = false;
        box.checked = !box.checked;
      }
    });

    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const id = del.dataset.del;
      if (!confirm('Delete this notification?')) return;
      try {
        await ctx.api.del(ENDPOINTS.notifications, { query: { id } });
        await load();
      } catch (err) {
        say(err.message || 'Could not delete that notification', 'err');
      }
    });

    // Exposed so showView() (called by the shell on every route change,
    // including the very first one) can switch tabs without re-mounting.
    this._setTab = (v) => { tab = v; renderTabs(); renderList(); };

    await load();
    this._setTab(ctx.defaultView === 'sent' ? 'sent' : 'inbox');
  },

  showView(view) {
    if (this._setTab) this._setTab(view === 'sent' ? 'sent' : 'inbox');
  }
};
