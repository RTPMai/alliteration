/**
 * Hub — the "All apps" landing view.
 *
 * Not one of the apps. It is the shell's own front page: what needs attention
 * across everything, and where the apps feed each other.
 *
 * v2: REAL numbers. The original shipped hardcoded prototype values ("312
 * customers", "4 trips to Cedar Rapids") wearing Live pills — including on the
 * TravelTrack stub, which has never held a trip. Everything here now comes
 * through the seam on mount, and anything that can't be fetched says so
 * instead of inventing.
 *
 * Endpoint names are looked up defensively: BackBone's are verified; the other
 * apps' entries in ENDPOINTS are found from a candidate list, so a card whose
 * endpoint isn't wired renders an honest "not wired" line rather than crashing
 * or lying. When js/api.js gains a name that matches, the card lights up with
 * no further changes here.
 */

import { APPS, getApp, canAccess } from '../js/registry.js';
import { ENDPOINTS, appsOnSampleData } from '../js/api.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* First ENDPOINTS key that actually exists, or null. Never guess a URL. */
function findEndpoint(candidates) {
  for (const k of candidates) {
    if (ENDPOINTS && ENDPOINTS[k]) return ENDPOINTS[k];
  }
  return null;
}

function fmtMoneyShort(n) {
  n = Number(n) || 0;
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + Math.round(n);
}

function relTime(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return hrs + ' hr ago';
  return Math.round(hrs / 24) + ' days ago';
}

/* Tolerant list reader: endpoints variously return an array or an object
   wrapping one. Counting is the only thing the hub needs, so read generously. */
function listOf(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return null;
}

/* Where the apps feed each other. Kept as data so it stays honest as apps
   land: a flow whose source app is still a stub is worth seeing greyed. */
const FLOWS = [
  ['errorengine', 'BackBone', 'Remake cost per customer, folded into the tier score'],
  ['errorengine', 'ShopStock', 'Vendor defect rate, for deciding who to keep buying blanks from'],
  ['traveltrack', 'BackBone', 'Cost to service an account, from trip expenses tagged to a client'],
  ['shopstock', 'ErrorEngine', 'Live supply pricing, so remake cost is stamped accurately'],
  ['backbone', 'MailMe', 'The roster itself: MailMe keeps no contact list, it reads this one']
];

function flowRow([fromId, to, what]) {
  const from = getApp(fromId);
  return `
    <tr class="flowrow">
      <td><span class="dotc" style="--dot:${from ? from.accent : 'var(--muted)'}"></span><span class="from">${esc(from ? from.name : fromId)}</span></td>
      <td>${esc(to)}</td>
      <td>${esc(what)}</td>
    </tr>`;
}

/* One skeleton card per app; mount() fills the metric/line/pill nodes in. */
function appCard(app, sample) {
  const planned = app.stub;
  const pill = planned
    ? '<span class="pill p-mute">Not built</span>'
    : (sample
      ? '<span class="pill p-mute" data-hub-pill="' + app.id + '">Sample data</span>'
      : '<span class="pill p-ok" data-hub-pill="' + app.id + '">Live</span>');

  return `
    <button class="app${planned ? ' planned' : ''}"
            ${planned ? 'disabled' : `data-goto="${app.id}"`}>
      <div class="app-hd">
        <img class="app-mark" src="/assets/logos/${app.id}-mark.svg" alt="" width="34" height="34">
        <div>
          <img class="app-wordmark" src="/assets/logos/${app.id}-wordmark.svg" alt="${esc(app.name)}">
          <div class="app-role">${esc(app.role || app.blurb)}</div>
        </div>
      </div>
      <div class="app-body">
        <div class="app-metrics" data-hub-metrics="${app.id}">${planned ? '' : '<div class="app-metric"><div class="v">&mdash;</div><div class="l">Loading</div></div>'}</div>
        <div class="app-line" data-hub-line="${app.id}">${planned ? esc(app.blurb || '') : ''}</div>
      </div>
      <div class="app-ft">
        ${pill}
        <span class="go">${planned ? 'Proposed' : 'Open'}</span>
      </div>
    </button>`;
}

export default {
  id: 'hub',

  template: `
    <div class="view">
      <div class="page-head">
        <div>
          <div class="page-title">All apps<span class="dot">.</span></div>
          <div class="page-sub" id="hubSub">What needs attention, across everything.</div>
        </div>
      </div>

      <div class="stats" id="hubStats"></div>

      <div class="apps" id="hubApps"></div>

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
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const api = ctx.api;

    let sampleApps = [];
    try { sampleApps = appsOnSampleData() || []; } catch (e) { /* seam predates helper */ }

    // Only apps this person can open; matches the rail.
    const visible = APPS.filter((a) => canAccess(ctx.perms, a.id));
    $('#hubApps').innerHTML = visible.map((a) => appCard(a, sampleApps.includes(a.id))).join('');

    root.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = getApp(btn.dataset.goto);
        if (target) ctx.goApp(target.id, target.defaultView);
      });
    });

    const setCard = (id, metrics, line) => {
      const m = $('[data-hub-metrics="' + id + '"]');
      const l = $('[data-hub-line="' + id + '"]');
      if (m) m.innerHTML = metrics.map(([v, lab]) =>
        '<div class="app-metric"><div class="v">' + esc(v) + '</div><div class="l">' + esc(lab) + '</div></div>').join('');
      if (l) l.textContent = line || '';
    };
    const notWired = (id) => setCard(id, [], "The hub isn't wired to this app's data yet.");

    // Headline stats accumulate from whatever the fetches below produce; a stat
    // whose app couldn't answer simply doesn't appear.
    const stats = [];
    const renderStats = () => {
      $('#hubStats').innerHTML = stats.map(([label, value, delta]) => `
        <div class="stat">
          <div class="label">${esc(label)}</div>
          <div class="value">${esc(value)}</div>
          <div class="delta">${esc(delta || '')}</div>
        </div>`).join('');
    };

    const has = (id) => visible.some((a) => a.id === id);
    const jobs = [];

    // ---- BackBone: roster size, last sync, quotes this week, outstanding ----
    if (has('backbone')) {
      jobs.push((async () => {
        try {
          const d = await api.get(ENDPOINTS.bbData);
          const roster = (d && Array.isArray(d.synced)) ? d.synced.length : 0;
          const when = relTime(d && d.lastSynced);
          let quotesWk = null, outTotal = null;
          try {
            const ops = await api.get(ENDPOINTS.bbData, { ops: 1 });
            if (ops && ops.available) {
              quotesWk = ops.quotesThisWeek;
              outTotal = ops.outstandingTotal;
            }
          } catch (e) { /* ops slice optional */ }
          setCard('backbone',
            [[String(roster), 'Customers']].concat(quotesWk != null ? [[String(quotesWk), 'Quotes this wk']] : []),
            when ? 'Last sync from Printavo ' + when : 'No sync recorded yet');
          if (quotesWk != null) stats.push(['New quotes', String(quotesWk), 'last 7 days']);
          if (outTotal != null) stats.push(['Outstanding', fmtMoneyShort(outTotal), 'open invoices']);
          renderStats();
        } catch (e) { setCard('backbone', [], 'Could not load roster.'); }
      })());
    }

    // ---- ShopStock: item counts. Endpoint discovered, never guessed. ----
    if (has('shopstock')) {
      jobs.push((async () => {
        const ep = findEndpoint(['ssItems', 'ssInventory', 'ssData', 'shopstockItems', 'items']);
        if (!ep) return notWired('shopstock');
        try {
          const d = await api.get(ep);
          const items = listOf(d, ['items', 'inventory', 'rows', 'data']);
          if (!items) return notWired('shopstock');
          // Field names vary; count a "needs ordering" state only when a field
          // confidently carries it. Absent that, the total alone is still true.
          const needs = items.filter((it) =>
            it && (it.needsOrdered === true || it.needs_order === true ||
                   /need/i.test(String(it.status || '')))).length;
          setCard('shopstock',
            [[String(items.length), 'Items']].concat(needs ? [[String(needs), 'Need ordering']] : []),
            needs ? needs + ' flagged for reorder' : 'Nothing needs ordering');
          if (needs) { stats.push(['Items to reorder', String(needs), '']); renderStats(); }
        } catch (e) { setCard('shopstock', [], 'Could not load inventory.'); }
      })());
    }

    // ---- ErrorEngine: open error count (sample data until it goes live). ----
    if (has('errorengine')) {
      jobs.push((async () => {
        const ep = findEndpoint(['eeErrors', 'eeData', 'errors', 'errorLog', 'eeRecords']);
        if (!ep) return notWired('errorengine');
        try {
          const d = await api.get(ep);
          const errs = listOf(d, ['errors', 'records', 'rows', 'data']);
          if (!errs) return notWired('errorengine');
          setCard('errorengine', [[String(errs.length), 'Errors logged']], '');
        } catch (e) { setCard('errorengine', [], 'Could not load errors.'); }
      })());
    }

    // ---- GivingGauge: request count. ----
    if (has('givinggauge')) {
      jobs.push((async () => {
        const ep = findEndpoint(['ggRequests', 'ggData', 'givingRequests', 'requests']);
        if (!ep) return notWired('givinggauge');
        try {
          const d = await api.get(ep);
          const reqs = listOf(d, ['requests', 'rows', 'items', 'data']);
          if (!reqs) return notWired('givinggauge');
          setCard('givinggauge', [[String(reqs.length), 'Requests']], '');
          stats.push(['Donation asks', String(reqs.length), '']);
          renderStats();
        } catch (e) { setCard('givinggauge', [], 'Could not load requests.'); }
      })());
    }

    // ---- TravelTrack: trip count, pending expenses awaiting approval. ----
    if (has('traveltrack')) {
      jobs.push((async () => {
        try {
          const d = await api.get(ENDPOINTS.ttTrips);
          const trips = listOf(d, ['trips']) || [];
          let pending = 0;
          try {
            const ex = await api.get(ENDPOINTS.ttExpenses);
            const expenses = listOf(ex, ['expenses']) || [];
            pending = expenses.filter((e) => e && e.status === 'pending').length;
          } catch (e) { /* expenses optional for the card */ }
          setCard('traveltrack',
            [[String(trips.length), 'Trips']].concat(pending ? [[String(pending), 'Pending expenses']] : []),
            pending ? pending + ' expense' + (pending === 1 ? '' : 's') + ' awaiting approval' : 'Nothing awaiting approval');
          if (pending) { stats.push(['Pending reimbursements', String(pending), '']); renderStats(); }
        } catch (e) { setCard('traveltrack', [], 'Could not load trips.'); }
      })());
    }

    // ---- MailMe: mailable contacts, split by audience. ----
    if (has('mailme')) {
      jobs.push((async () => {
        try {
          const d = await api.get(ENDPOINTS.mmContacts);
          const c = (d && d.counts) || {};
          const suppressed = (c.unsubscribed || 0) + (c.bounced || 0) + (c.complained || 0);
          setCard('mailme',
            [[String(c.mailable || 0), 'Mailable']].concat(
              c.prospect ? [[String(c.prospect), 'Prospects']] : []),
            suppressed ? suppressed + ' suppressed, never mailed'
                       : 'Nobody has opted out yet');
        } catch (e) { setCard('mailme', [], 'Could not load contacts.'); }
      })());
    }

    // ---- CrewCore: active headcount, upcoming anniversaries. ----
    // Self-serve ("employee" role) accounts get a narrower employees response
    // (their own record only, see api/crewcore/employees.js) with no
    // "employees" array — has('crewcore') is still true for them since the
    // app itself is visible, so this branch degrades to notWired() rather
    // than showing someone else's headcount from a payload shape it can't
    // read. Admin/superuser accounts get the real array and the real card.
    if (has('crewcore')) {
      jobs.push((async () => {
        try {
          const d = await api.get(ENDPOINTS.ccEmployees);
          const employees = listOf(d, ['employees']);
          if (!employees) return notWired('crewcore');
          const active = employees.filter((e) => e && e.status === 'active').length;
          const soon = employees.filter((e) => {
            if (!e || !e.start_date) return false;
            const start = new Date(e.start_date + 'T00:00:00');
            if (Number.isNaN(start.getTime())) return false;
            const now = new Date();
            const next = new Date(now.getFullYear(), start.getMonth(), start.getDate());
            if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
              next.setFullYear(next.getFullYear() + 1);
            }
            return Math.round((next - now) / 86400000) <= 60;
          }).length;
          setCard('crewcore',
            [[String(active), 'Active']].concat(soon ? [[String(soon), 'Anniversaries soon']] : []),
            soon ? soon + ' in the next 60 days' : 'Nothing coming up');
        } catch (e) { setCard('crewcore', [], 'Could not load the roster.'); }
      })());
    }

    await Promise.allSettled(jobs);
    if (!stats.length) {
      // Nothing headline-worthy loaded; keep the strip empty rather than fake.
      $('#hubStats').innerHTML = '';
    }
  },

  showView() {
    // Single view.
  }
};
