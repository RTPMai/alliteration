// PUT IN: apps/marketmachine/list.js
/**
 * The Campaigns list: filters, the four counts across the top, and one row per
 * campaign showing where it stands and what is next.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { CAMPAIGN_TYPES, typeMeta } from '../../lib/marketmachine/catalog.js';
import { esc, fmtDate, statusClass } from './format.js';

export default function makeList(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

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

    function renderList() {
      const pane = $('#mkListPane');
      if (!pane) return;
      if (state.limited) { pane.innerHTML = ui.limitedScreen(); return; }

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
            <select id="mkFAm">${ui.amOptions(f.am, 'Everyone')}</select></div>
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
                          <div class="who">${esc(meta.label || c.type)}${c.parentId ? `, connected to ${esc(ui.nameOf(c.parentId))}` : ''}${c.childCount ? `, ${c.childCount} connected` : ''}</div></td>
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

  return { filtered, renderList };
}
