// PUT IN: apps/marketmachine/timeline.js
/**
 * Launch dates and review dates by month, quarter or year.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { CAMPAIGN_TYPES, typeMeta } from '../../lib/marketmachine/catalog.js';
import { esc, fmtDate, statusClass, MONTHS_LONG } from './format.js';

export default function makeTimeline(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function periodMonths() {
      const [y, m] = state.tl.anchor.split('-').map(Number);
      const count = state.tl.span === 'year' ? 12 : state.tl.span === 'quarter' ? 3 : 1;
      const startMonth = state.tl.span === 'year' ? 0 : state.tl.span === 'quarter' ? Math.floor((m - 1) / 3) * 3 : m - 1;
      return Array.from({ length: count }, (_, i) => {
        const mm = startMonth + i;
        return { y: y + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 };
      });
    }

    function shiftPeriod(dir) {
      const [y, m] = state.tl.anchor.split('-').map(Number);
      const step = state.tl.span === 'year' ? 12 : state.tl.span === 'quarter' ? 3 : 1;
      const total = (y * 12 + (m - 1)) + dir * step;
      state.tl.anchor = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
    }

    function renderTimeline() {
      const body = $('#mkTimelineBody');
      if (!body) return;
      if (state.limited) { body.innerHTML = `<div class="mk-notice">${esc(state.limitedMessage)}</div>`; return; }
      const tl = state.tl;
      const months = periodMonths();
      const first = months[0], last = months[months.length - 1];
      const title = tl.span === 'year' ? String(first.y)
        : tl.span === 'quarter' ? `${MONTHS_LONG[first.m]} to ${MONTHS_LONG[last.m]} ${last.y}`
          : `${MONTHS_LONG[first.m]} ${first.y}`;

      const events = [];
      state.campaigns.forEach((c) => {
        if (c.status === 'cancelled') return;
        if (tl.type && c.type !== tl.type) return;
        if (tl.am && String(c.accountManagerId || '') !== tl.am) return;
        const meta = typeMeta(c.type) || {};
        const d = c.dates || {};
        if (d.control) events.push({ date: d.control, what: meta.controlLabel || 'Launch date', c });
        if (d.prelaunchReview) events.push({ date: d.prelaunchReview, what: 'Prelaunch review', c });
        if (d.postLaunchReview) events.push({ date: d.postLaunchReview, what: 'Post-launch review', c });
      });

      const typeOptions = CAMPAIGN_TYPES.map((t) =>
        `<option value="${esc(t.key)}"${tl.type === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('');

      body.innerHTML = `
        <div class="mk-filters">
          <div><label>View</label><div class="mk-seg" role="group" aria-label="View">
            ${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, l]) =>
              `<button data-span="${k}" aria-pressed="${tl.span === k}">${l}</button>`).join('')}
          </div></div>
          <div><label>Period</label><div class="mk-seg" role="group" aria-label="Period">
            <button data-shift="-1" aria-label="Earlier">Earlier</button>
            <button data-shift="0">This ${tl.span}</button>
            <button data-shift="1" aria-label="Later">Later</button>
          </div></div>
          <div><label for="mkTlType">Campaign type</label>
            <select id="mkTlType"><option value="">All types</option>${typeOptions}</select></div>
          <div><label for="mkTlAm">Account Manager</label>
            <select id="mkTlAm">${ui.amOptions(tl.am, 'Everyone')}</select></div>
        </div>
        <h2 style="font-size:18px;font-weight:800;margin:4px 0 14px">${esc(title)}</h2>
        ${months.map(({ y, m }) => {
          const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
          const inMonth = events.filter((e) => e.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
          return `<div class="mk-tl-month mk-card"><div class="mk-card-hd"><h3>${esc(MONTHS_LONG[m])} ${y}</h3>
              <span class="meta">${inMonth.length ? inMonth.length + ' date' + (inMonth.length === 1 ? '' : 's') : 'Nothing scheduled'}</span></div>
            ${inMonth.map((e) => {
              const meta = typeMeta(e.c.type) || {};
              return `<div class="mk-tl-row" data-open="${esc(e.c.id)}" tabindex="0">
                <span class="d">${esc(fmtDate(e.date))}</span>
                <span class="w">${esc(e.what)}</span>
                <span><b>${esc(e.c.name)}</b> <span class="who">${esc(meta.label || '')}${e.c.accountManagerName ? ', ' + esc(e.c.accountManagerName) : ''}</span></span>
                <span class="pill ${statusClass((e.c.progress || {}).label)}">${esc((e.c.progress || {}).label || '')}</span>
              </div>`;
            }).join('')}
          </div>`;
        }).join('')}`;
    }

    /* ---------------- settings ---------------- */

  return { periodMonths, shiftPeriod, renderTimeline };
}
