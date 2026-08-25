/**
 * Notifications — shell-level to-do / hand-off list.
 *
 * Lives in the SHELL, same reasoning as Settings: this is not one app's
 * data, it spans all of them. Every signed-in employee can open this
 * (unlike Settings, which is admin-only) — see js/registry.js SHELL_APPS.
 *
 * Reverted back to a routed screen (Aug 6) after a same-day detour through
 * a header-dropdown panel — Ryan preferred the full page. The header bell
 * (js/shell.js) still shows the open-count badge and navigates here.
 *
 * Three views, all driven off one fetch:
 *   inbox -> notifications ASSIGNED TO the signed-in user
 *   sent  -> notifications CREATED BY the signed-in user
 *   team  -> notifications assigned to the signed-in user's DIRECT REPORTS
 *            (Ryan's ask, Aug 25 2026). Membership comes from CrewCore's
 *            reports_to field, resolved server-side by api/notifications.js
 *            ?team=1, so the org chart has one home instead of two. The tab
 *            hides itself when the answer is an empty team, which means a
 *            manager gets it by having reports recorded, not by being
 *            granted anything. It exposes nothing new either: a team-
 *            visibility notification is already readable by everyone signed
 *            in, and private items stay creator-only here as everywhere.
 *
 * A filter bar sits under the tabs (same ask): search, app, type, due date,
 * status, and a person picker that appears only when more than one person's
 * work is on screen. The rules themselves live in lib/notifications/filters.js
 * as pure functions so the tests can call them rather than grep for them.
 * Active filters highlight, the count line says "showing 3 of 40", and an
 * empty list caused by a filter says so instead of looking like an empty
 * inbox.
 *
 * The create form's App and Type pickers are the same multi-select
 * toggle-pill pattern as Settings' role editor (.app-toggle there, .nt-toggle
 * here) — both fields take more than one selection, per Ryan's ask. There is
 * no notes field on creation.
 *
 * Every notification also carries a `history` log (who created it, every
 * reassignment, who marked it done, edits with before/after values, plain
 * comments) — the Printavo Tasks pattern Ryan described: a question gets
 * asked by reassigning with a message, the answer comes back the same way,
 * and both hops stay visible here rather than only the current assignee
 * showing. Reassigning is done from this screen with an optional message;
 * api/notifications.js turns that into a history entry.
 *
 * Whoever created a notification can edit it later if they got something
 * wrong — title, type(s), app(s), due date — using the same toggle-pill
 * pickers as creation, via the "Edit" button on each card. Every edit is
 * itself a history entry with the old and new values, not a silent
 * overwrite. The assignee and admins can edit too, same "isParty" rule the
 * server already used for reassigning and marking done.
 *
 * The Delete button only shows if the signed-in user's role allows it
 * (ctx.perms.can_delete_notifications, set in Settings > Roles) or they are
 * an admin/superuser — api/notifications.js enforces this server-side
 * regardless of what the button shows, this is just to not offer an action
 * that will get rejected.
 */

import { ENDPOINTS } from '../js/api.js';
import { APPS } from '../js/registry.js';
import { TYPES, GENERAL_APP, LINK_TYPE_LABELS, PICKABLE_LINK_TYPES } from '../lib/notifications/schema.js';
import {
  DUE_FILTERS, STATUS_FILTERS, EMPTY_FILTERS,
  applyFilters, activeFilterCount, teamPool, todayLocalISO,
} from '../lib/notifications/filters.js';

// Where a link opens, per type: { app, view }. "client" has no top-level
// BackBone view of its own — the roster lives inside the dashboard page as
// a sub-tab — so it routes to dashboard and BackBone's showView() switches
// to that sub-tab itself. See openDeepLink() in apps/backbone/main.js (and
// the TravelTrack/GivingGauge equivalents for expense/donation).
const LINK_ROUTE = {
  inquiry: { app: 'backbone', view: 'inbox' },
  lead: { app: 'backbone', view: 'leads' },
  client: { app: 'backbone', view: 'dashboard' },
  expense: { app: 'traveltrack', view: 'expenses' },
  donation: { app: 'givinggauge', view: 'requests' },
};

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

function fmtChangeValue(field, v) {
  if (field === 'link') return fmtLinkValue(v);
  if (v == null || v === '') return '(none)';
  if (field === 'appIds') return (Array.isArray(v) ? v : [v]).map((id) => appMeta(id).name).join(', ');
  if (field === 'types') return (Array.isArray(v) ? v : [v]).map(typeLabel).join(', ');
  if (field === 'dueDate') return fmtDue(v) || v;
  return String(v);
}

const FIELD_LABEL = { title: 'title', types: 'type', appIds: 'app', dueDate: 'due date', link: 'linked record' };

function fmtLinkValue(v) {
  if (!v || !v.id) return '(none)';
  return (LINK_TYPE_LABELS[v.type] || v.type) + ': ' + (v.label || v.id);
}

function historyLine(e) {
  switch (e.action) {
    case 'created':
      return e.byName + ' created this, assigned to ' + (e.toName || e.to);
    case 'reassigned':
      return e.byName + ' reassigned from ' + (e.fromName || e.from) + ' to ' + (e.toName || e.to);
    case 'completed':
      return e.byName + ' marked this done';
    case 'reopened':
      return e.byName + ' reopened this';
    case 'edited':
      if (Array.isArray(e.changes) && e.changes.length) {
        const parts = e.changes.map((c) =>
          (FIELD_LABEL[c.field] || c.field) + ': "' + fmtChangeValue(c.field, c.from) +
          '" \u2192 "' + fmtChangeValue(c.field, c.to) + '"');
        return e.byName + ' edited \u2014 ' + parts.join('; ');
      }
      return e.byName + ' edited ' + (Array.isArray(e.fields) ? e.fields.join(', ') : 'this');
    case 'comment':
      return e.byName + ' commented';
    default:
      return e.byName + ' updated this';
  }
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
  .nt-field textarea{resize:vertical;min-height:50px}
  .nt-field input:focus,.nt-field select:focus,.nt-field textarea:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }

  /* Multi-select toggle-pill grid — same pattern as Settings' role editor
     (.app-toggle), reused here so picking apps/types for a notification
     feels like picking apps for a role. aria-pressed carries on/off state. */
  .nt-toggles{display:flex;gap:6px;flex-wrap:wrap}
  .nt-toggle{
    display:inline-flex;align-items:center;gap:6px;cursor:pointer;
    font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:var(--radius-pill);
    border:1px solid var(--line);background:var(--card);color:var(--muted);
    font-family:inherit;transition:.12s;
  }
  .nt-toggle .sq{width:7px;height:7px;border-radius:2px;background:var(--line);flex:none}
  .nt-toggle[aria-pressed="true"]{
    background:color-mix(in srgb, var(--c) 14%, transparent);
    border-color:color-mix(in srgb, var(--c) 40%, transparent);
    color:var(--c);
  }
  .nt-toggle[aria-pressed="true"] .sq{background:var(--c)}

  .nt-card{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:14px 16px;margin-bottom:10px;
  }
  .nt-card.done{opacity:.6}
  .nt-card-top{display:flex;gap:12px;align-items:flex-start}
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
  .nt-pill.type-handoff{background:var(--accent-tint);color:var(--accent-deep);border:1px solid transparent}
  .nt-pill.link{
    background:none;border:1px solid var(--line);color:var(--accent-deep);
    cursor:pointer;font-family:inherit;padding:2px 9px 2px 7px;
  }
  .nt-pill.link:hover{border-color:var(--accent)}
  .nt-pill.private{background:none;color:var(--faint);border:1px dashed var(--line)}
  .nt-private label{display:flex;align-items:center;gap:7px;cursor:pointer;font-weight:400}
  .nt-private input{width:auto;margin:0}
  .nt-hint{display:block;font-size:11.5px;color:var(--faint);margin-top:3px}
  .nt-meta{font-size:11.5px;color:var(--faint);margin-top:6px}

  /* Link-to-record picker — a type select plus a live search-as-you-type
     result list, same idea as the assignee dropdown but needs its own
     lookup since it spans three different BackBone data sets. */
  .nt-link-picker{border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px;margin-top:4px}
  .nt-link-row{display:flex;gap:6px;flex-wrap:wrap}
  .nt-link-row select{flex:1;min-width:110px}
  .nt-link-row input{flex:2;min-width:160px}
  .nt-link-results{margin-top:6px;max-height:160px;overflow-y:auto}
  .nt-link-opt{
    display:flex;justify-content:space-between;gap:8px;padding:6px 8px;
    border-radius:var(--radius-sm);cursor:pointer;font-size:12.5px;
  }
  .nt-link-opt:hover{background:var(--bg)}
  .nt-link-opt .sub{color:var(--faint);font-size:11px}
  .nt-link-empty{padding:6px 8px;color:var(--faint);font-size:12px}
  .nt-link-chip{
    display:inline-flex;align-items:center;gap:8px;margin-top:8px;
    background:var(--accent-tint);color:var(--accent-deep);border-radius:var(--radius-pill);
    padding:5px 6px 5px 12px;font-size:12px;font-weight:600;
  }
  .nt-link-chip button{
    border:none;background:none;color:inherit;cursor:pointer;font-family:inherit;
    font-size:14px;line-height:1;padding:0 4px;
  }
  .nt-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}

  .nt-sub{border-top:1px solid var(--line-soft);margin-top:11px;padding-top:10px}
  .nt-reassign{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px}
  .nt-reassign select{flex:1;min-width:140px}
  .nt-reassign input{flex:2;min-width:180px}

  .nt-hist{margin-top:8px}
  .nt-hist-row{font-size:11.5px;color:var(--muted);padding:5px 0;border-top:1px solid var(--line-soft)}
  .nt-hist-row:first-child{border-top:none}
  .nt-hist-when{color:var(--faint);margin-left:5px}
  .nt-hist-msg{color:var(--ink);margin-top:2px;font-style:italic}

  .nt-empty{padding:32px 20px;text-align:center;color:var(--muted);font-size:13px}
  .nt-empty .nt-btn{margin-top:12px}

  /* Filter bar. One row that wraps, not a collapsible panel: a filter you
     cannot see is a filter you forget is on, and "where did my list go" is
     the failure this whole feature exists to avoid. */
  .nt-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .nt-filters input,.nt-filters select{
    border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:6px 9px;font-family:inherit;font-size:12.5px;color:var(--ink);
    background:var(--card);
  }
  .nt-filters input:focus,.nt-filters select:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }
  .nt-filters .nt-search{flex:1;min-width:170px}
  .nt-filters select{max-width:170px}
  .nt-filters select.on,.nt-filters input.on{
    border-color:var(--accent);background:var(--accent-tint);color:var(--accent-deep);font-weight:600;
  }
  .nt-count{font-size:11.5px;color:var(--faint);margin:0 0 10px}
  @media (max-width:640px){ .nt-filters select{max-width:none;flex:1;min-width:120px} }

  @media (max-width:640px){ .nt-reassign{flex-direction:column;align-items:stretch} }
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
        <button class="nt-tab" data-tab="team" id="ntTeamTab" style="display:none">My team<span class="ct" id="ntTeamCt"></span></button>
      </div>

      <div class="nt-filters" id="ntFilters"></div>
      <div class="nt-count" id="ntCount"></div>

      <div id="ntForm" style="display:none"></div>
      <div id="ntList"><div class="nt-empty">Loading…</div></div>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    let all = [];
    let people = [];
    let tab = 'inbox';
    // One filter set, shared by all three tabs on purpose: switching tabs to
    // check something and coming back to a list that quietly re-filtered
    // itself is worse than carrying the filter across, and the bar shows
    // what is on either way.
    let filters = { ...EMPTY_FILTERS };
    // { scope: 'reports' | 'all' | 'none', team: [{username, name}] } —
    // resolved server-side from CrewCore's org chart, see api/notifications.js.
    let teamInfo = { scope: 'none', team: [] };
    const today = todayLocalISO();
    let formTypes = new Set();
    let formApps = new Set();
    // Per-card UI state that should NOT reset on every re-render: which
    // card has its reassign form, edit form, or history log expanded.
    const openReassign = new Set();
    const openHistory = new Set();
    const openEdit = new Set();

    const me = String(ctx.user && ctx.user.username || '').toLowerCase();
    // Admins/superusers always retain delete regardless of the role flag
    // (see api/notifications.js callerCanDelete) — mirrored here so the
    // button doesn't appear and then get rejected by the server.
    const canDelete = !!(ctx.perms && (
      ctx.perms.superuser === true || ctx.perms.role === 'admin' ||
      ctx.perms.can_delete_notifications !== false
    ));

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
        const [notesRes, peopleRes, teamRes] = await Promise.all([
          ctx.api.get(ENDPOINTS.notifications),
          people.length ? Promise.resolve({ people }) : ctx.api.get(ENDPOINTS.notifications, { people: '1' }),
          // A team lookup that fails must not take the whole screen with
          // it: the two original tabs work without it.
          teamInfo.scope !== 'none'
            ? Promise.resolve(teamInfo)
            : ctx.api.get(ENDPOINTS.notifications, { team: '1' }).catch(() => ({ scope: 'none', team: [] }))
        ]);
        all = notesRes.notifications || [];
        people = peopleRes.people || people;
        teamInfo = { scope: teamRes.scope || 'none', team: teamRes.team || [] };
        if (tab === 'team' && !canSeeTeam()) tab = 'inbox';
        renderTabs();
        renderFilters();
        renderList();
      } catch (e) {
        $('#ntList').innerHTML = '<div class="nt-empty">Could not load notifications: ' + esc(e.message) + '</div>';
      }
    }

    // The tab appears when there is actually a team behind it. Nobody has to
    // be granted anything: record who reports to whom in CrewCore and the
    // tab shows up for that manager on their next load.
    function canSeeTeam() {
      return teamInfo.scope !== 'none' && teamInfo.team.length > 0;
    }

    // The unfiltered pool for the current tab. Filters are applied on top of
    // this, so "3 of 40" always means three of the forty on THIS tab.
    function poolFor(which) {
      if (which === 'sent') return all.filter((n) => n.createdBy === me);
      if (which === 'team') return teamPool(all, teamInfo.team, me);
      return all.filter((n) => n.assignedTo === me);
    }

    function renderTabs() {
      const openIn = (list) => list.filter((n) => n.status === 'open').length;
      const inboxOpen = openIn(poolFor('inbox'));
      const sentOpen = openIn(poolFor('sent'));
      $('#ntInboxCt').textContent = inboxOpen ? ' (' + inboxOpen + ')' : '';
      $('#ntSentCt').textContent = sentOpen ? ' (' + sentOpen + ')' : '';

      const teamTab = $('#ntTeamTab');
      if (canSeeTeam()) {
        const teamOpen = openIn(poolFor('team'));
        teamTab.style.display = '';
        $('#ntTeamCt').textContent = teamOpen ? ' (' + teamOpen + ')' : '';
      } else {
        teamTab.style.display = 'none';
      }

      root.querySelectorAll('.nt-tab').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
    }

    // ---- Filter bar (Ryan's ask, Aug 25 2026) -------------------------------
    // Rebuilt from `filters` on every render rather than mutated in place, so
    // the controls can never disagree with the list they are filtering.

    function optionsHtml(items, selected, allLabel) {
      return '<option value="">' + esc(allLabel) + '</option>' +
        items.map((it) => '<option value="' + esc(it.value) + '"' +
          (it.value === selected ? ' selected' : '') + '>' + esc(it.label) + '</option>').join('');
    }

    function renderFilters() {
      // Only offer people who actually appear on this tab. An assignee
      // dropdown listing the whole company on a tab holding four people's
      // work is a list of dead ends.
      const pool = poolFor(tab);
      const whoSeen = [];
      pool.forEach((n) => {
        const u = String(n.assignedTo || '').toLowerCase();
        if (u && u !== me && !whoSeen.some((p) => p.value === u)) {
          whoSeen.push({ value: u, label: n.assignedToName || u });
        }
      });
      whoSeen.sort((a, b) => a.label.localeCompare(b.label));

      const on = (v, dflt) => (v !== (dflt === undefined ? '' : dflt) ? ' class="on"' : '');

      $('#ntFilters').innerHTML =
        '<input class="nt-search' + (filters.q ? ' on' : '') + '" id="ntQ" type="search" ' +
          'placeholder="Search title, person, or linked record" value="' + esc(filters.q) + '">' +
        '<select id="ntApp"' + on(filters.appId) + '>' +
          optionsHtml(APP_OPTIONS.map((a) => ({ value: a.id, label: a.name })), filters.appId, 'All apps') +
        '</select>' +
        '<select id="ntType"' + on(filters.type) + '>' +
          optionsHtml(TYPES.map((t) => ({ value: t.value, label: t.label })), filters.type, 'All types') +
        '</select>' +
        '<select id="ntDue"' + on(filters.due, 'any') + '>' +
          DUE_FILTERS.map((d) => '<option value="' + esc(d.value) + '"' +
            (d.value === filters.due ? ' selected' : '') + '>' + esc(d.label) + '</option>').join('') +
        '</select>' +
        '<select id="ntStatus"' + on(filters.status, 'open') + '>' +
          STATUS_FILTERS.map((s) => '<option value="' + esc(s.value) + '"' +
            (s.value === filters.status ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') +
        '</select>' +
        (whoSeen.length > 1
          ? '<select id="ntPerson"' + on(filters.person) + '>' +
              optionsHtml(whoSeen, filters.person, 'Everyone') +
            '</select>'
          : '');
    }

    // Set a filter from one of the dropdowns: rebuild the bar (so the "this
    // one is on" highlight is right) and the list. The search box does NOT
    // come through here — see the input handler, which leaves the bar alone
    // so the caret does not jump on every keystroke.
    function setFilter(key, value) {
      filters[key] = value;
      renderFilters();
      renderList();
    }

    function typePillClass(t) {
      return 'nt-pill type-' + (t === 'handoff' ? 'handoff' : t === 'need' ? 'need' : 'task');
    }

    function toggleHtml(items, selectedSet, dataAttr) {
      return items.map((it) => {
        const on = selectedSet.has(it.id);
        return '<button type="button" class="nt-toggle" style="--c:' + esc(it.accent) + '"' +
          ' data-' + dataAttr + '="' + esc(it.id) + '" aria-pressed="' + on + '">' +
          '<span class="sq"></span>' + esc(it.name) +
        '</button>';
      }).join('');
    }

    function historyHtml(n) {
      const hist = Array.isArray(n.history) ? n.history.slice().reverse() : [];
      if (!hist.length) return '<div class="nt-hist"><div class="nt-hist-row">No history yet.</div></div>';
      return '<div class="nt-hist">' + hist.map((e) =>
        '<div class="nt-hist-row">' + esc(historyLine(e)) +
          '<span class="nt-hist-when">' + esc(relTime(e.at)) + '</span>' +
          (e.message ? '<div class="nt-hist-msg">\u201c' + esc(e.message) + '\u201d</div>' : '') +
        '</div>'
      ).join('') + '</div>';
    }

    function reassignHtml(n) {
      return '<div class="nt-reassign">' +
        '<select data-reassign-who="' + esc(n.id) + '">' +
          people.map((p) => '<option value="' + esc(p.username) + '"' +
            (p.username === n.assignedTo ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select>' +
        '<input type="text" data-reassign-msg="' + esc(n.id) + '" maxlength="500" placeholder="Optional message (e.g. a question for them)">' +
        '<button class="nt-btn small primary" data-reassign-save="' + esc(n.id) + '">Reassign</button>' +
      '</div>';
    }

    // Whoever created a notification (or the current assignee, or an admin
    // — same "isParty" rule the server enforces) can fix a mistake here.
    // The change itself becomes a history entry (api/notifications.js), so
    // fixing something wrong is visible, not silent.
    function editHtml(n) {
      const typeItems = TYPES.map((t) => ({ id: t.value, name: t.label, accent: 'var(--accent)' }));
      const editTypes = new Set(n.types || []);
      const editApps = new Set(n.appIds || []);
      return '<div class="nt-form" data-edit-form="' + esc(n.id) + '">' +
        '<div class="nt-field"><label>Title</label>' +
          '<input type="text" data-edit-title="' + esc(n.id) + '" maxlength="200" value="' + esc(n.title) + '"></div>' +
        '<div class="nt-field"><label>Type (select one or more)</label><div class="nt-toggles" data-edit-type-toggles="' + esc(n.id) + '">' +
          toggleHtml(typeItems, editTypes, 'edit-type') +
        '</div></div>' +
        '<div class="nt-field"><label>App (select one or more)</label><div class="nt-toggles" data-edit-app-toggles="' + esc(n.id) + '">' +
          toggleHtml(APP_OPTIONS, editApps, 'edit-app') +
        '</div></div>' +
        '<div class="nt-field"><label>Due date (optional)</label>' +
          '<input type="date" data-edit-due="' + esc(n.id) + '" value="' + esc(n.dueDate || '') + '"></div>' +
        '<div class="nt-field"><label>Link to a record (optional)</label>' +
          linkPickerHtml(n.id, n.link || null) +
        '</div>' +
        '<div class="nt-field"><label>What changed (optional, goes in History)</label>' +
          '<input type="text" data-edit-msg="' + esc(n.id) + '" maxlength="500" placeholder="e.g. wrong app selected the first time"></div>' +
        '<button class="nt-btn small primary" data-edit-save="' + esc(n.id) + '">Save changes</button>' +
        '<button class="nt-btn small" data-edit-cancel="' + esc(n.id) + '">Cancel</button>' +
      '</div>';
    }

    // Toggle-pill state lives in the DOM (aria-pressed) for edit forms,
    // since — unlike the create form — each card needs its own independent
    // selection and there can be several edit forms rendered at once.
    function editSelected(id, kind) {
      const sel = root.querySelector('[data-edit-' + kind + '-toggles="' + id + '"]');
      if (!sel) return [];
      return [...sel.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset['edit' + kind[0].toUpperCase() + kind.slice(1)]);
    }

    // ---- Link-to-record picker (Ryan's ask, Aug 2026) ----------------------
    // A type select plus a live search-as-you-type list, spanning three
    // different BackBone data sets (inquiries, leads, roster clients) via
    // GET ?linkSearch=. The chosen value lives in data-* attributes on the
    // wrapper (data-link-type/-id/-label), not module state, so the same
    // markup works for the one create form and for however many edit forms
    // are open at once — same reasoning as the edit toggle-pills.
    const linkSearchTimers = {};

    function pickerEl(scope) {
      return root.querySelector('[data-link-picker="' + scope + '"]');
    }

    function linkPickerHtml(scope, link) {
      const type = link ? link.type : '';
      const id = link ? link.id : '';
      const label = link ? link.label : '';
      const typeOptions = PICKABLE_LINK_TYPES.map((t) =>
        '<option value="' + t + '"' + (t === type ? ' selected' : '') + '>' + esc(LINK_TYPE_LABELS[t]) + '</option>'
      ).join('');
      return '' +
        '<div class="nt-link-picker" data-link-picker="' + esc(scope) + '"' +
          ' data-link-type="' + esc(type) + '" data-link-id="' + esc(id) + '" data-link-label="' + esc(label) + '">' +
          '<div class="nt-link-row">' +
            '<select data-link-type-select="' + esc(scope) + '">' +
              '<option value="">No link</option>' + typeOptions +
            '</select>' +
            (type && !id
              ? '<input type="text" data-link-search="' + esc(scope) + '" autocomplete="off" ' +
                'placeholder="Search ' + esc((LINK_TYPE_LABELS[type] || '').toLowerCase()) + 's by company name">'
              : '') +
          '</div>' +
          (id
            ? '<div class="nt-link-chip" data-link-chip="' + esc(scope) + '">' +
                esc(LINK_TYPE_LABELS[type] || type) + ': ' + esc(label || id) +
                '<button type="button" data-link-clear="' + esc(scope) + '" title="Remove link">\u00d7</button>' +
              '</div>'
            : '') +
          '<div class="nt-link-results" data-link-results="' + esc(scope) + '"></div>' +
        '</div>';
    }

    function doLinkSearch(scope, type, q) {
      const resultsEl = root.querySelector('[data-link-results="' + scope + '"]');
      if (!resultsEl) return;
      ctx.api.get(ENDPOINTS.notifications, { linkSearch: type, q: q || '' })
        .then((res) => {
          const items = (res && res.results) || [];
          resultsEl.innerHTML = items.length
            ? items.map((it) =>
                '<div class="nt-link-opt" data-link-pick="' + esc(scope) + '"' +
                  ' data-pick-id="' + esc(it.id) + '" data-pick-label="' + esc(it.label) + '">' +
                  '<span>' + esc(it.label) + '</span>' +
                  (it.sublabel ? '<span class="sub">' + esc(it.sublabel) + '</span>' : '') +
                '</div>'
              ).join('')
            : '<div class="nt-link-empty">No matches.</div>';
        })
        .catch(() => {
          resultsEl.innerHTML = '<div class="nt-link-empty">Could not search right now.</div>';
        });
    }

    // Full re-render of one picker (type change, a result gets picked, or
    // clearing) — cheap since it's one small block, not the whole card list,
    // so it doesn't disturb anything else on screen mid-edit.
    function applyLinkSelection(scope, type, id, label) {
      const el = pickerEl(scope);
      if (!el) return;
      el.outerHTML = linkPickerHtml(scope, type ? { type, id, label } : null);
      if (type && !id) doLinkSearch(scope, type, '');
    }

    function readLinkPicker(scope) {
      const el = pickerEl(scope);
      if (!el) return null;
      const type = el.dataset.linkType, id = el.dataset.linkId, label = el.dataset.linkLabel;
      return type && id ? { type, id, label } : null;
    }

    function cardHtml(n) {
      const app0 = appMeta((n.appIds || [])[0]);
      const done = n.status === 'done';
      // The team tab is the one place both halves matter: a manager needs to
      // know whose plate it is on AND who put it there, since the answer to
      // "why is this stuck" is often the second name.
      const who = tab === 'team'
        ? 'To ' + esc(n.assignedToName || n.assignedTo) +
          ' \u00b7 from ' + esc(n.createdByName || n.createdBy)
        : tab === 'inbox'
          ? 'From ' + esc(n.createdByName || n.createdBy)
          : 'To ' + esc(n.assignedToName || n.assignedTo);
      const due = n.dueDate ? ' \u00b7 ' + esc(fmtDue(n.dueDate)) : '';
      const completed = done && n.doneByName ? ' \u00b7 Completed by ' + esc(n.doneByName) : '';
      const appPills = (n.appIds || []).map((id) => {
        const a = appMeta(id);
        return '<span class="nt-pill app" style="--c:' + esc(a.accent) + '"><span class="sq"></span>' + esc(a.name) + '</span>';
      }).join('');
      const typePills = (n.types || []).map((t) =>
        '<span class="' + typePillClass(t) + '">' + esc(typeLabel(t)) + '</span>').join('') +
        (n.visibility === 'private' ? '<span class="nt-pill private">Just for me</span>' : '');
      const linkPill = (n.link && n.link.id)
        ? '<button type="button" class="nt-pill link" data-link-open data-link-type="' + esc(n.link.type) + '"' +
            ' data-link-id="' + esc(n.link.id) + '" title="Open in BackBone">' +
            '\u2192 ' + esc(LINK_TYPE_LABELS[n.link.type] || n.link.type) + ': ' + esc(n.link.label || n.link.id) +
          '</button>'
        : '';
      const histCount = Array.isArray(n.history) ? n.history.length : 0;
      const showReassign = openReassign.has(n.id);
      const showHistory = openHistory.has(n.id);
      const showEdit = openEdit.has(n.id);

      return '' +
        '<div class="nt-card' + (done ? ' done' : '') + '" data-id="' + esc(n.id) + '">' +
          '<div class="nt-card-top">' +
            '<input type="checkbox" class="nt-check" data-toggle="' + esc(n.id) + '"' +
              (done ? ' checked' : '') + ' title="' + (done ? 'Reopen' : 'Mark done') + '">' +
            '<div class="nt-body">' +
              '<div class="nt-title' + (done ? ' done' : '') + '">' + esc(n.title) + '</div>' +
              '<div class="nt-tags">' + appPills + typePills + linkPill + '</div>' +
              '<div class="nt-meta">' + who + due + completed + ' \u00b7 ' + esc(relTime(n.createdAt)) + '</div>' +
            '</div>' +
            '<div class="nt-actions">' +
              '<button class="nt-btn small" data-edit-toggle="' + esc(n.id) + '">Edit</button>' +
              '<button class="nt-btn small" data-reassign-toggle="' + esc(n.id) + '">Reassign</button>' +
              '<button class="nt-btn small" data-history-toggle="' + esc(n.id) + '">History' +
                (histCount ? ' (' + histCount + ')' : '') + '</button>' +
              (canDelete
                ? '<button class="nt-btn small danger" data-del="' + esc(n.id) + '">Delete</button>'
                : '') +
            '</div>' +
          '</div>' +
          (showEdit ? '<div class="nt-sub">' + editHtml(n) + '</div>' : '') +
          (showReassign ? '<div class="nt-sub">' + reassignHtml(n) + '</div>' : '') +
          (showHistory ? '<div class="nt-sub">' + historyHtml(n) + '</div>' : '') +
        '</div>';
    }

    // Empty is not one state. "You have nothing" and "your filters hid
    // everything" need different words and different exits, or the second
    // one gets read as the first and somebody concludes the list is broken.
    function emptyHtml(poolSize, activeCount) {
      if (poolSize && activeCount) {
        return '<div class="nt-empty">Nothing here matches the filters you have on.' +
          '<div><button class="nt-btn small" id="ntClearEmpty">Clear filters</button></div>' +
        '</div>';
      }
      const msg = tab === 'inbox'
        ? 'Nothing assigned to you right now.'
        : tab === 'sent'
          ? 'You have not assigned anything yet.'
          : 'Nothing on your team\u2019s plates right now.';
      return '<div class="nt-empty">' + msg + '</div>';
    }

    function renderList() {
      const pool = poolFor(tab);
      const visible = applyFilters(pool, filters, { today });
      const active = activeFilterCount(filters);

      // Says why the list is the length it is, and carries the way out of a
      // filter that is hiding more than it meant to.
      $('#ntCount').innerHTML = pool.length
        ? esc('Showing ' + visible.length + ' of ' + pool.length) +
          (active
            ? ' \u00b7 <button class="nt-btn small" id="ntClear">Clear filters (' + active + ')</button>'
            : '')
        : '';

      if (!visible.length) {
        $('#ntList').innerHTML = emptyHtml(pool.length, active);
        return;
      }

      $('#ntList').innerHTML = visible.map(cardHtml).join('');
    }

    function fillWhoSelect() {
      const whoSel = $('#nf-who');
      if (whoSel) {
        whoSel.innerHTML = people.map((p) =>
          '<option value="' + esc(p.username) + '"' + (p.username === me ? ' selected' : '') + '>' +
            esc(p.name) + (p.username === me ? ' (you)' : '') +
          '</option>').join('');
      }
    }

    function openForm() {
      const typeItems = TYPES.map((t) => ({ id: t.value, name: t.label, accent: 'var(--accent)' }));
      $('#ntForm').innerHTML =
        '<div class="nt-form">' +
          '<div class="nt-field"><label>Title</label>' +
            '<input id="nf-title" maxlength="200" placeholder="What needs to happen"></div>' +
          '<div class="nt-field"><label>Type (select one or more)</label><div class="nt-toggles" id="nfTypeToggles">' +
            toggleHtml(typeItems, formTypes, 'type') +
          '</div></div>' +
          '<div class="nt-field"><label>App (select one or more)</label><div class="nt-toggles" id="nfAppToggles">' +
            toggleHtml(APP_OPTIONS, formApps, 'app') +
          '</div></div>' +
          '<div class="nt-field nt-private">' +
            '<label for="nf-private"><input type="checkbox" id="nf-private"> Just for me</label>' +
            '<span class="nt-hint">Nobody else can see it, not even an admin. Stays assigned to you.</span>' +
          '</div>' +
          '<div class="nt-field" id="nf-who-field"><label>Assign to</label><select id="nf-who"></select></div>' +
          '<div class="nt-field"><label>Due date (optional)</label><input id="nf-due" type="date"></div>' +
          '<div class="nt-field"><label>Link to a record (optional)</label>' +
            linkPickerHtml('new', null) +
          '</div>' +
          '<button class="nt-btn primary" id="nf-save">Create</button>' +
          '<button class="nt-btn" id="nf-cancel">Cancel</button>' +
        '</div>';

      fillWhoSelect();
      const priv = $('#nf-private');
      if (priv) {
        priv.addEventListener('change', () => {
          // Assigning a private item is meaningless: the server pins it to
          // you either way, so hide the control rather than let it lie.
          $('#nf-who-field').style.display = priv.checked ? 'none' : '';
        });
      }
      $('#ntForm').style.display = 'block';
      $('#nf-title').focus();
    }

    $('#ntNewBtn').addEventListener('click', () => {
      const isOpen = $('#ntForm').style.display !== 'none';
      if (isOpen) { $('#ntForm').style.display = 'none'; $('#ntForm').innerHTML = ''; }
      else { formTypes = new Set(); formApps = new Set(); openForm(); }
    });

    root.querySelectorAll('.nt-tab').forEach((b) => {
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        // The person filter is the one filter tied to the tab it was set on:
        // "only Margo's" carried onto a tab Margo never appears on shows an
        // empty list for a reason nobody can see. Everything else carries.
        filters.person = '';
        ctx.go(tab);
        renderTabs();
        renderFilters();
        renderList();
      });
    });

    // ---- Delegated events on the root: covers the form, the toggle-pill
    // pickers, and every card, including ones re-rendered after a reload. ----

    root.addEventListener('click', async (e) => {
      // Both clear buttons (the one in the count line and the one inside the
      // "your filters hid everything" empty state) do the same thing.
      if (e.target.id === 'ntClear' || e.target.id === 'ntClearEmpty') {
        filters = { ...EMPTY_FILTERS };
        renderFilters();
        renderList();
        return;
      }

      const linkOpen = e.target.closest('[data-link-open]');
      if (linkOpen) {
        const route = LINK_ROUTE[linkOpen.dataset.linkType];
        if (route && ctx.goApp) ctx.goApp(route.app, route.view, linkOpen.dataset.linkId);
        return;
      }

      const linkPick = e.target.closest('[data-link-pick]');
      if (linkPick) {
        const scope = linkPick.dataset.linkPick;
        const el = pickerEl(scope);
        const type = el ? el.dataset.linkType : '';
        applyLinkSelection(scope, type, linkPick.dataset.pickId, linkPick.dataset.pickLabel);
        return;
      }

      const linkClear = e.target.closest('[data-link-clear]');
      if (linkClear) {
        applyLinkSelection(linkClear.dataset.linkClear, '', '', '');
        return;
      }

      const typeToggle = e.target.closest('[data-type]');
      if (typeToggle && typeToggle.closest('#nfTypeToggles')) {
        const v = typeToggle.dataset.type;
        if (formTypes.has(v)) formTypes.delete(v); else formTypes.add(v);
        typeToggle.setAttribute('aria-pressed', formTypes.has(v));
        return;
      }

      const appToggle = e.target.closest('[data-app]');
      if (appToggle && appToggle.closest('#nfAppToggles')) {
        const v = appToggle.dataset.app;
        if (formApps.has(v)) formApps.delete(v); else formApps.add(v);
        appToggle.setAttribute('aria-pressed', formApps.has(v));
        return;
      }

      if (e.target.id === 'nf-cancel') {
        $('#ntForm').style.display = 'none'; $('#ntForm').innerHTML = '';
        return;
      }

      if (e.target.id === 'nf-save') {
        const btn = e.target;
        btn.disabled = true;
        say('');
        try {
          await ctx.api.post(ENDPOINTS.notifications, {
            title: $('#nf-title').value.trim(),
            types: [...formTypes],
            appIds: [...formApps],
            assignedTo: $('#nf-who').value,
            visibility: $('#nf-private') && $('#nf-private').checked ? 'private' : 'team',
            dueDate: $('#nf-due').value || null,
            link: readLinkPicker('new')
          });
          $('#ntForm').style.display = 'none';
          $('#ntForm').innerHTML = '';
          say('Notification created.', 'ok');
          await load();
        } catch (err) {
          say(err.message || 'Could not create that notification', 'err');
        } finally {
          btn.disabled = false;
        }
        return;
      }

      const editToggle = e.target.closest('[data-edit-toggle]');
      if (editToggle) {
        const id = editToggle.dataset.editToggle;
        if (openEdit.has(id)) openEdit.delete(id); else openEdit.add(id);
        renderList();
        return;
      }

      const editTypeToggle = e.target.closest('[data-edit-type]');
      if (editTypeToggle) {
        const on = editTypeToggle.getAttribute('aria-pressed') === 'true';
        editTypeToggle.setAttribute('aria-pressed', String(!on));
        return;
      }

      const editAppToggle = e.target.closest('[data-edit-app]');
      if (editAppToggle) {
        const on = editAppToggle.getAttribute('aria-pressed') === 'true';
        editAppToggle.setAttribute('aria-pressed', String(!on));
        return;
      }

      const editCancel = e.target.closest('[data-edit-cancel]');
      if (editCancel) {
        openEdit.delete(editCancel.dataset.editCancel);
        renderList();
        return;
      }

      const editSave = e.target.closest('[data-edit-save]');
      if (editSave) {
        const id = editSave.dataset.editSave;
        const title = root.querySelector('[data-edit-title="' + id + '"]').value.trim();
        const types = editSelected(id, 'type');
        const apps = editSelected(id, 'app');
        const due = root.querySelector('[data-edit-due="' + id + '"]').value || null;
        const msg = root.querySelector('[data-edit-msg="' + id + '"]').value.trim();
        if (!title) { say('Title cannot be blank.', 'err'); return; }
        if (!types.length) { say('Select at least one type.', 'err'); return; }
        if (!apps.length) { say('Select at least one app.', 'err'); return; }
        editSave.disabled = true;
        try {
          await ctx.api.patch(ENDPOINTS.notifications,
            { title, types, appIds: apps, dueDate: due, link: readLinkPicker(id), message: msg || undefined },
            { query: { id } });
          openEdit.delete(id);
          say('Notification updated.', 'ok');
          await load();
        } catch (err) {
          say(err.message || 'Could not save that edit', 'err');
          editSave.disabled = false;
        }
        return;
      }

      const reassignToggle = e.target.closest('[data-reassign-toggle]');
      if (reassignToggle) {
        const id = reassignToggle.dataset.reassignToggle;
        if (openReassign.has(id)) openReassign.delete(id); else openReassign.add(id);
        renderList();
        return;
      }

      const historyToggle = e.target.closest('[data-history-toggle]');
      if (historyToggle) {
        const id = historyToggle.dataset.historyToggle;
        if (openHistory.has(id)) openHistory.delete(id); else openHistory.add(id);
        renderList();
        return;
      }

      const reassignSave = e.target.closest('[data-reassign-save]');
      if (reassignSave) {
        const id = reassignSave.dataset.reassignSave;
        const who = root.querySelector('[data-reassign-who="' + id + '"]').value;
        const msg = root.querySelector('[data-reassign-msg="' + id + '"]').value.trim();
        reassignSave.disabled = true;
        try {
          await ctx.api.patch(ENDPOINTS.notifications,
            { assignedTo: who, message: msg || undefined }, { query: { id } });
          openReassign.delete(id);
          say('Reassigned.', 'ok');
          await load();
        } catch (err) {
          say(err.message || 'Could not reassign that notification', 'err');
          reassignSave.disabled = false;
        }
        return;
      }

      const del = e.target.closest('[data-del]');
      if (del) {
        if (!confirm('Delete this notification?')) return;
        try {
          await ctx.api.del(ENDPOINTS.notifications, { query: { id: del.dataset.del } });
          await load();
        } catch (err) {
          say(err.message || 'Could not delete that notification', 'err');
        }
      }
    });

    let searchTimer = null;

    root.addEventListener('input', (e) => {
      // The filter search box deliberately does NOT rebuild the filter bar:
      // replacing the input you are typing into loses the caret on every
      // keystroke. It updates its own highlight and re-renders the list only.
      if (e.target.id === 'ntQ') {
        const v = e.target.value;
        e.target.classList.toggle('on', !!v.trim());
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { filters.q = v.trim(); renderList(); }, 180);
        return;
      }

      const search = e.target.closest('[data-link-search]');
      if (!search) return;
      const scope = search.dataset.linkSearch;
      const el = pickerEl(scope);
      const type = el ? el.dataset.linkType : '';
      if (!type) return;
      clearTimeout(linkSearchTimers[scope]);
      const q = search.value;
      linkSearchTimers[scope] = setTimeout(() => doLinkSearch(scope, type, q), 200);
    });

    root.addEventListener('change', async (e) => {
      const FILTER_IDS = {
        ntApp: 'appId', ntType: 'type', ntDue: 'due',
        ntStatus: 'status', ntPerson: 'person',
      };
      if (FILTER_IDS[e.target.id]) {
        setFilter(FILTER_IDS[e.target.id], e.target.value);
        return;
      }

      const linkTypeSelect = e.target.closest('[data-link-type-select]');
      if (linkTypeSelect) {
        const scope = linkTypeSelect.dataset.linkTypeSelect;
        const type = linkTypeSelect.value;
        applyLinkSelection(scope, type, '', '');
        return;
      }

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

    // Exposed so showView() (called by the shell on every route change,
    // including the very first one) can switch tabs without re-mounting.
    // A URL asking for /notifications/team from somebody with no team lands
    // on the inbox rather than an empty screen with no explanation.
    this._setTab = (v) => {
      tab = (v === 'team' && canSeeTeam()) ? 'team' : (v === 'sent' ? 'sent' : 'inbox');
      renderTabs();
      renderFilters();
      renderList();
    };

    await load();
    this._setTab(ctx.defaultView || 'inbox');
  },

  showView(view) {
    if (this._setTab) this._setTab(view);
  }
};
