/**
 * Hub — the "All apps" landing view.
 *
 * Not one of the five apps. It is the shell's own front page: what needs
 * attention across everything, and where the apps feed each other.
 *
 * That second table is the actual argument for a shared shell. The login is
 * incidental; the reason these belong together is that each app holds a number
 * the others need to tell the truth about a client. ErrorEngine knows what a
 * customer's remakes cost, which is what turns BackBone's revenue tiering into
 * margin tiering.
 *
 * Numbers here come from ctx.api like anywhere else. Under MOCK they are the
 * placeholder values below; when the seam flips they come from the real
 * endpoints and this file does not change.
 */

import { APPS, getApp } from '../js/registry.js';

/* Per-app hub summary. Replaced by a real /api/summary call when the endpoints
   are wired; shaped the same either way so the markup does not change. */
const SUMMARY = {
  backbone:    { metrics: [['312', 'Customers'], ['7', 'Inquiries']],
                 line: 'Last sync from Printavo 6 minutes ago' },
  shopstock:   { metrics: [['486', 'SKUs'], ['12', 'Low stock']],
                 line: '3 orders queued, 1 awaiting vendor price' },
  errorengine: { metrics: [['5', 'Open'], ['$1,840', 'Exposure']],
                 line: '2 vendor-attributed, awaiting credit' },
  givinggauge: { metrics: [['3', 'Requests'], ['$4,200', 'Remaining']],
                 line: 'One request over the 21-day lead time floor' },
  traveltrack: { metrics: [['4', 'Trips'], ['$2,310', 'Unfiled']],
                 line: 'Des Moines to Cedar Rapids, filed Friday' }
};

const HEADLINE = [
  ['Open inquiries', '7', '+3 this week', 'up'],
  ['Items to reorder', '12', '4 critical', 'down'],
  ['Open errors', '5', '$1,840 exposure', ''],
  ['Unfiled expenses', '9', '2 trips', ''],
  ['Donation asks', '3', 'Awaiting review', '']
];

/* Where the apps feed each other. Kept as data so it stays honest as apps
   land: a flow whose source app is still a stub is worth seeing greyed. */
const FLOWS = [
  ['errorengine', 'BackBone', 'Remake cost per customer, folded into the tier score'],
  ['errorengine', 'ShopStock', 'Vendor defect rate, for deciding who to keep buying blanks from'],
  ['traveltrack', 'BackBone', 'Cost to service an account, from trip expenses tagged to a client'],
  ['shopstock', 'ErrorEngine', 'Live supply pricing, so remake cost is stamped accurately']
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function statCard([label, value, delta, dir]) {
  return `
    <div class="stat">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      <div class="delta ${dir}">${esc(delta)}</div>
    </div>`;
}

function appCard(app) {
  const s = SUMMARY[app.id] || { metrics: [], line: '' };
  const planned = app.stub;

  const metrics = s.metrics.map(([v, l]) => `
    <div class="app-metric">
      <div class="v">${esc(v)}</div>
      <div class="l">${esc(l)}</div>
    </div>`).join('');

  return `
    <button class="app${planned ? ' planned' : ''}"
            ${planned ? 'disabled' : `data-goto="${app.id}"`}
            style="--mark:${app.accent}">
      <div class="app-hd">
        <div class="app-mark">${esc(app.letter || app.name[0])}</div>
        <div>
          <div class="app-name">
            <span class="w1">${esc(app.w1 || app.name)}</span><span class="w2">${esc(app.w2 || '')}</span><span class="dot">.</span>
          </div>
          <div class="app-role">${esc(app.role || app.blurb)}</div>
        </div>
      </div>
      <div class="app-body">
        <div class="app-metrics">${metrics}</div>
        <div class="app-line">${esc(s.line)}</div>
      </div>
      <div class="app-ft">
        <span class="pill ${planned ? 'p-mute' : 'p-ok'}">${planned ? 'Not built' : 'Live'}</span>
        <span class="go">${planned ? 'Proposed' : 'Open'}</span>
      </div>
    </button>`;
}

function flowRow([fromId, to, what]) {
  const from = getApp(fromId);
  return `
    <tr class="flowrow">
      <td><span class="dotc" style="--dot:${from ? from.accent : 'var(--muted)'}"></span><span class="from">${esc(from ? from.name : fromId)}</span></td>
      <td>${esc(to)}</td>
      <td>${esc(what)}</td>
    </tr>`;
}

export default {
  id: 'hub',

  template: `
    <div class="view">
      <div class="page-head">
        <div>
          <div class="page-title">All apps<span class="dot">.</span></div>
          <div class="page-sub">
            The chrome around this content never reloads. Pick an app and only
            this region changes.
          </div>
        </div>
      </div>

      <div class="stats">${HEADLINE.map(statCard).join('')}</div>

      <div class="apps">${APPS.map(appCard).join('')}</div>

      <div class="card" style="margin-top:16px">
        <div class="card-hd">
          <h3>Where the apps feed each other</h3>
          <span class="meta">Cross-app joins</span>
        </div>
        <div class="card-bd">
          <div class="help">
            The reason to share a shell is not the login. Each app holds a number
            the others need to tell the truth about a client.
          </div>
          <table>
            <thead><tr><th>From</th><th>To</th><th>What moves</th></tr></thead>
            <tbody>${FLOWS.map(flowRow).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>
  `,

  async mount(ctx) {
    ctx.root.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = getApp(btn.dataset.goto);
        if (target) ctx.goApp(target.id, target.defaultView);
      });
    });
  },

  showView() {
    // Single view.
  }
};
