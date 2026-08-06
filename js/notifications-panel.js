// PUT IN: js/notifications-panel.js (new)
// (this banner line is for verification only, delete it after checking the path)

/**
 * js/notifications-panel.js — the header bell's dropdown panel.
 *
 * Notifications has no routed screen and no rail entry. Everything — the
 * "Assigned to me" / "I assigned" tabs, the create form, marking done,
 * deleting — lives in this panel, opened from the bell button in the
 * header (index.html #bellBtn / #bellPanel). Ryan's call: "the notifications
 * panel at the top header wherever it makes sense."
 *
 * The create form's App and Type pickers reuse the exact toggle-pill
 * multi-select pattern from Settings' role editor (apps/settings.js
 * .app-toggle), per Ryan's ask — both fields take more than one selection.
 * There is no notes field.
 *
 * Owns its own badge-count polling (moved here from js/shell.js) since the
 * badge and the panel share one fetch and one "what's open" concept.
 */

import * as api from './api.js';
import { APPS } from './registry.js';
import { TYPES, GENERAL_APP } from '../lib/notifications/schema.js';

const APP_OPTIONS = APPS.map((a) => ({ id: a.id, name: a.name, accent: a.accent }))
  .concat([{ id: GENERAL_APP, name: 'General', accent: 'var(--muted)' }]);

const POLL_MS = 60000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function typeLabel(v) {
  const hit = TYPES.find((t) => t.value === v);
  return hit ? hit.label : v;
}

function appMeta(id) {
  return APP_OPTIONS.find((a) => a.id === id) || { id, name: id, accent: 'var(--muted)' };
}

function fmtDue(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days < 0) return 'overdue ' + d.toLocaleDateString();
  return 'due ' + d.toLocaleDateString();
}

function relTime(iso) {
  if (!iso) return '';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

export function initBellPanel(els, user) {
  const { btn, badge, panel } = els;
  if (!btn || !panel) return;

  const me = String((user && user.username) || '').toLowerCase();

  let open = false;
  let tab = 'inbox';
  let showDone = false;
  let formOpen = false;
  let formTypes = new Set();
  let formApps = new Set();
  let all = [];
  let people = [];
  let loaded = false;
  let msg = '';
  let msgKind = '';

  btn.hidden = false;

  /* ---- badge (independent of whether the panel is open) ---- */

  async function refreshBadge() {
    try {
      const data = await api.get(api.ENDPOINTS.notifications, { assignedTo: me, status: 'open' });
      const n = Array.isArray(data && data.notifications) ? data.notifications.length : 0;
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (e) { /* a failed poll should not surface as an error banner */ }
  }

  refreshBadge();
  setInterval(refreshBadge, POLL_MS);

  /* ---- data ---- */

  async function loadAll() {
    try {
      const [notesRes, peopleRes] = await Promise.all([
        api.get(api.ENDPOINTS.notifications),
        people.length ? Promise.resolve({ people }) : api.get(api.ENDPOINTS.notifications, { people: '1' })
      ]);
      all = notesRes.notifications || [];
      people = peopleRes.people || people;
      loaded = true;
    } catch (e) {
      msg = 'Could not load notifications: ' + e.message;
      msgKind = 'err';
    }
    render();
  }

  /* ---- render ---- */

  function toggleHtml(items, selectedSet, dataAttr) {
    return items.map((it) => {
      const on = selectedSet.has(it.id);
      return '<button type="button" class="bp-toggle" style="--c:' + esc(it.accent) + '"' +
        ' data-' + dataAttr + '="' + esc(it.id) + '" aria-pressed="' + on + '">' +
        '<span class="sq"></span>' + esc(it.name) +
      '</button>';
    }).join('');
  }

  function formHtml() {
    const typeItems = TYPES.map((t) => ({ id: t.value, name: t.label, accent: 'var(--notif)' }));
    return '' +
      '<div class="bp-form">' +
        '<div class="bp-field"><label>Title</label><input id="bpTitle" maxlength="200" placeholder="What needs to happen"></div>' +
        '<div class="bp-field"><label>Type (select one or more)</label><div class="bp-toggles" id="bpTypeToggles">' +
          toggleHtml(typeItems, formTypes, 'type') +
        '</div></div>' +
        '<div class="bp-field"><label>App (select one or more)</label><div class="bp-toggles" id="bpAppToggles">' +
          toggleHtml(APP_OPTIONS, formApps, 'app') +
        '</div></div>' +
        '<div class="bp-field"><label>Assign to</label><select id="bpWho">' +
          people.map((p) => '<option value="' + esc(p.username) + '"' + (p.username === me ? ' selected' : '') + '>' +
            esc(p.name) + (p.username === me ? ' (you)' : '') + '</option>').join('') +
        '</select></div>' +
        '<div class="bp-field"><label>Due date (optional)</label><input id="bpDue" type="date"></div>' +
        '<div class="bp-actions">' +
          '<button class="bp-btn primary" id="bpSave">Create</button>' +
          '<button class="bp-btn" id="bpCancel">Cancel</button>' +
        '</div>' +
      '</div>';
  }

  function typePillClass(t) {
    return 'bp-pill type-' + (t === 'handoff' ? 'handoff' : t === 'need' ? 'need' : 'task');
  }

  function rowHtml(n) {
    const done = n.status === 'done';
    const who = tab === 'inbox'
      ? 'from ' + esc(n.createdByName || n.createdBy)
      : 'to ' + esc(n.assignedToName || n.assignedTo);
    const due = n.dueDate ? ' · ' + esc(fmtDue(n.dueDate)) : '';
    const appPills = (n.appIds || []).map((id) => {
      const a = appMeta(id);
      return '<span class="bp-pill app" style="--c:' + esc(a.accent) + '"><span class="sq"></span>' + esc(a.name) + '</span>';
    }).join('');
    const typePills = (n.types || []).map((t) =>
      '<span class="' + typePillClass(t) + '">' + esc(typeLabel(t)) + '</span>').join('');
    return '' +
      '<div class="bp-row' + (done ? ' done' : '') + '">' +
        '<input type="checkbox" class="bp-check" data-toggle="' + esc(n.id) + '"' + (done ? ' checked' : '') +
          ' title="' + (done ? 'Mark open' : 'Mark done') + '">' +
        '<div class="bp-body">' +
          '<div class="bp-title' + (done ? ' done' : '') + '">' + esc(n.title) + '</div>' +
          '<div class="bp-tags">' + appPills + typePills + '</div>' +
          '<div class="bp-meta">' + who + due + ' · ' + esc(relTime(n.createdAt)) + '</div>' +
        '</div>' +
        '<button class="bp-del" data-del="' + esc(n.id) + '" title="Delete">✕</button>' +
      '</div>';
  }

  function render() {
    if (!open) return;

    const mine = tab === 'inbox'
      ? all.filter((n) => n.assignedTo === me)
      : all.filter((n) => n.createdBy === me);
    const inboxOpenCt = all.filter((n) => n.assignedTo === me && n.status === 'open').length;
    const sentOpenCt = all.filter((n) => n.createdBy === me && n.status === 'open').length;
    const visible = mine.filter((n) => showDone || n.status !== 'done');
    const hasDone = mine.some((n) => n.status === 'done');

    let listHtml;
    if (!loaded) {
      listHtml = '<div class="bp-empty">Loading…</div>';
    } else if (!visible.length) {
      listHtml = '<div class="bp-empty">' +
        (tab === 'inbox' ? 'Nothing assigned to you right now.' : 'You have not assigned anything yet.') +
      '</div>';
    } else {
      listHtml = visible
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'done' ? 1 : -1))
        .map(rowHtml).join('');
    }

    panel.innerHTML =
      '<div class="bp-hd"><h3>Notifications</h3><button class="bp-new" id="bpNewBtn">' +
        (formOpen ? 'Close' : 'New') + '</button></div>' +
      (msg ? '<div class="bp-msg ' + msgKind + '">' + esc(msg) + '</div>' : '') +
      (formOpen ? formHtml() : '') +
      '<div class="bp-tabs">' +
        '<button class="bp-tab' + (tab === 'inbox' ? ' active' : '') + '" data-tab="inbox">Assigned to me' +
          (inboxOpenCt ? '<span class="ct">(' + inboxOpenCt + ')</span>' : '') + '</button>' +
        '<button class="bp-tab' + (tab === 'sent' ? ' active' : '') + '" data-tab="sent">I assigned' +
          (sentOpenCt ? '<span class="ct">(' + sentOpenCt + ')</span>' : '') + '</button>' +
      '</div>' +
      '<div>' + listHtml + '</div>' +
      (hasDone
        ? '<label class="bp-showdone"><input type="checkbox" id="bpShowDone"' + (showDone ? ' checked' : '') + '> Show completed</label>'
        : '');

    wireEvents();
  }

  function wireEvents() {
    const q = (sel) => panel.querySelector(sel);

    const newBtn = q('#bpNewBtn');
    if (newBtn) newBtn.addEventListener('click', () => {
      formOpen = !formOpen;
      if (formOpen) { formTypes = new Set(); formApps = new Set(); }
      msg = ''; render();
    });

    panel.querySelectorAll('.bp-tab').forEach((b) => {
      b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
    });

    const showDoneBox = q('#bpShowDone');
    if (showDoneBox) showDoneBox.addEventListener('change', (e) => { showDone = e.target.checked; render(); });

    panel.querySelectorAll('[data-type]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.type;
        if (formTypes.has(v)) formTypes.delete(v); else formTypes.add(v);
        b.setAttribute('aria-pressed', formTypes.has(v));
      });
    });

    panel.querySelectorAll('[data-app]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.app;
        if (formApps.has(v)) formApps.delete(v); else formApps.add(v);
        b.setAttribute('aria-pressed', formApps.has(v));
      });
    });

    const cancelBtn = q('#bpCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { formOpen = false; msg = ''; render(); });

    const saveBtn = q('#bpSave');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api.post(api.ENDPOINTS.notifications, {
          title: (q('#bpTitle').value || '').trim(),
          types: [...formTypes],
          appIds: [...formApps],
          assignedTo: q('#bpWho').value,
          dueDate: q('#bpDue').value || null
        });
        formOpen = false;
        msg = 'Notification created.'; msgKind = 'ok';
        await loadAll();
        refreshBadge();
      } catch (e) {
        msg = e.message || 'Could not create that notification'; msgKind = 'err';
        saveBtn.disabled = false;
        render();
      }
    });

    panel.querySelectorAll('[data-toggle]').forEach((box) => {
      box.addEventListener('change', async () => {
        const id = box.dataset.toggle;
        const next = box.checked ? 'done' : 'open';
        box.disabled = true;
        try {
          await api.patch(api.ENDPOINTS.notifications, { status: next }, { query: { id } });
          await loadAll();
          refreshBadge();
        } catch (e) {
          msg = e.message || 'Could not update that notification'; msgKind = 'err';
          await loadAll();
        }
      });
    });

    panel.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this notification?')) return;
        try {
          await api.del(api.ENDPOINTS.notifications, { query: { id: b.dataset.del } });
          await loadAll();
          refreshBadge();
        } catch (e) {
          msg = e.message || 'Could not delete that notification'; msgKind = 'err';
          render();
        }
      });
    });
  }

  /* ---- open / close ---- */

  function openPanel() {
    open = true;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    msg = ''; msgKind = '';
    render();
    loadAll(); // always refresh on open, cheap single GET
  }

  function closePanel() {
    open = false;
    panel.hidden = true;
    formOpen = false;
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closePanel(); else openPanel();
  });

  document.addEventListener('click', (e) => {
    if (!open) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') closePanel();
  });
}
