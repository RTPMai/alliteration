// PUT IN: apps/today.js
/**
 * Today: the landing screen. What needs you, from every app, in one list.
 *
 * Sep 24 2026. Replaces the All apps grid as the first thing anyone sees
 * (Ryan's call, Sep 23). All apps is still one click away in the rail.
 *
 * Built to the staff-screen rule: simple, or people will not use it. A row
 * of cards with one number and one button each, then one list sorted into
 * Late, Today, This week, and everything else. No tables.
 *
 * WHERE THE DATA COMES FROM. Each app's own existing endpoint, asked as the
 * signed-in person, so every app's access rules still apply and nothing
 * here can show a record the app itself would refuse. The turning of each
 * answer into rows lives in lib/today/build.js where it is tested with real
 * calls. A source that fails to load says so by name; it never shows a zero
 * it did not actually count.
 */

import { ENDPOINTS } from '../js/api.js';
import { getApp, canAccess, allowedViews } from '../js/registry.js';
import { todayInZone, SHOP_TIME_ZONE } from '../lib/notifications/schema.js';
import {
  BUCKETS, notificationItems, poItems, inquiryItems, timeoffItems,
  taskItems, socialItems, groupItems, dedupeItems, greetingFor, firstName,
} from '../lib/today/build.js';

// Coming back to Today reloads it, but not more often than this. Hopping
// between two apps through Today should not fire six requests every time.
const RELOAD_AFTER_MS = 30000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function shopHour() {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TIME_ZONE, hour: 'numeric', hour12: false })
      .format(new Date());
    return Number(h) % 24;
  } catch (e) {
    return new Date().getHours();
  }
}

function longDate() {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: SHOP_TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric',
    }).format(new Date());
  } catch (e) {
    return '';
  }
}

function dueText(due, today) {
  if (!due) return '';
  const a = new Date(today + 'T00:00:00Z');
  const b = new Date(String(due).slice(0, 10) + 'T00:00:00Z');
  const days = Math.round((b - a) / 86400000);
  if (isNaN(days)) return '';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return '1 day late';
  if (days < 0) return Math.abs(days) + ' days late';
  if (days < 7) return 'Due ' + b.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return 'Due ' + b.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function accentOf(appId) {
  const a = getApp(appId);
  return a && a.accent ? a.accent : 'var(--muted)';
}

export default {
  id: 'today',

  styles: `
    .td-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
    .td-date { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .td-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
    .td-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-card);
               padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; border-top: 3px solid var(--dot, var(--line)); }
    .td-card .td-n { font-size: 30px; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; }
    .td-card .td-n.zero { color: var(--faint); }
    .td-card .td-n.bad { color: var(--danger); }
    .td-card .td-l { font-size: 13px; font-weight: 600; color: var(--ink); }
    .td-card .td-s { font-size: 12px; color: var(--muted); min-height: 16px; }
    .td-card .btn { margin-top: 4px; align-self: flex-start; padding: 6px 12px; font-size: 12.5px; }

    .td-sec { margin-bottom: 18px; }
    .td-sec-hd { display: flex; align-items: baseline; gap: 8px; margin: 0 2px 8px; }
    .td-sec-hd h3 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .td-sec-hd .td-c { font-size: 12px; font-weight: 700; color: var(--muted); }
    .td-sec.late .td-sec-hd h3, .td-sec.late .td-sec-hd .td-c { color: var(--danger); }

    .td-list { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-card); overflow: hidden; }
    .td-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); }
    .td-row:last-child { border-bottom: none; }
    .td-row .td-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dot, var(--muted)); flex: none; }
    .td-row .td-main { flex: 1; min-width: 0; }
    .td-row .td-t { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
    .td-row .td-d { font-size: 12.5px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
    .td-row .td-app { font-weight: 600; }
    .td-row .td-due { font-size: 12px; font-weight: 700; color: var(--muted); white-space: nowrap; }
    .td-row .td-due.late { color: var(--danger); }
    .td-row .td-acts { display: flex; gap: 6px; flex: none; }
    .td-row .btn { padding: 6px 12px; font-size: 12.5px; }

    .td-clear { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 36px 20px; text-align: center; }
    .td-clear strong { display: block; font-size: 16px; margin-bottom: 4px; }
    .td-clear span { color: var(--muted); font-size: 13px; }
    .td-warn { font-size: 12.5px; color: var(--warn); background: var(--warn-tint); border-radius: var(--radius-sm); padding: 8px 12px; margin-bottom: 14px; }
    .td-foot { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
    .td-foot button { background: none; border: none; padding: 0; color: var(--accent-deep); font: inherit; font-weight: 600; cursor: pointer; }

    @media (max-width: 640px) {
      .td-row { flex-wrap: wrap; }
      .td-row .td-main { flex-basis: calc(100% - 24px); }
      .td-row .td-due { margin-left: 21px; }
      .td-row .td-acts { margin-left: auto; }
    }
  `,

  template: `
    <div class="view">
      <div class="td-head">
        <div>
          <div class="page-title" id="tdHello">Today<span class="dot">.</span></div>
          <div class="td-date" id="tdDate"></div>
        </div>
      </div>
      <div id="tdWarn"></div>
      <div class="td-cards" id="tdCards"></div>
      <div id="tdList"><div class="shell-spinner"></div></div>
      <div class="td-foot">Looking for an app? <button type="button" id="tdAll">See all apps</button> or use the menu on the left.</div>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const api = ctx.api;
    const perms = ctx.perms || {};
    const user = ctx.user || {};
    const me = String(user.username || '').toLowerCase();
    const isAdmin = perms.superuser === true;

    const can = (appId, view) => canAccess(perms, appId) &&
      (!view || allowedViews(perms, appId).includes(view));

    let items = [];
    let cards = [];
    let failed = [];
    let loadedAt = 0;
    let loading = null;

    $('#tdAll').addEventListener('click', () => ctx.goApp('hub', null));

    function paintHead() {
      const name = firstName(user.name, user.username);
      $('#tdHello').innerHTML = esc(greetingFor(shopHour()) + (name ? ', ' + name : '')) + '<span class="dot">.</span>';
      $('#tdDate').textContent = longDate();
    }

    function paintCards() {
      $('#tdCards').innerHTML = cards.map((c, i) => {
        const cls = c.count === 0 ? ' zero' : (c.bad ? ' bad' : '');
        return '<div class="td-card" style="--dot:' + accentOf(c.app) + '">' +
          '<div class="td-n' + cls + '">' + esc(c.count) + '</div>' +
          '<div class="td-l">' + esc(c.label) + '</div>' +
          '<div class="td-s">' + esc(c.count === 0 ? c.none : (c.sub || '')) + '</div>' +
          '<button class="btn" type="button" data-card="' + i + '">' + esc(c.button) + '</button>' +
          '</div>';
      }).join('');
    }

    function rowHtml(it, today) {
      const appName = (getApp(it.app) || {}).name || '';
      const due = dueText(it.due, today);
      // Red only when the DATE has passed. A PO can be late for another reason
      // (a silent vendor) with a due date still ahead, and a red future date
      // reads as a mistake.
      const late = !!it.due && String(it.due).slice(0, 10) < today;
      return '<div class="td-row" style="--dot:' + accentOf(it.app) + '">' +
        '<span class="td-dot"></span>' +
        '<div class="td-main">' +
          '<div class="td-t">' + esc(it.title) + '</div>' +
          '<div class="td-d"><span class="td-app">' + esc(appName) + '</span>' +
            (it.detail ? ' · ' + esc(it.detail) : '') + '</div>' +
        '</div>' +
        (due ? '<span class="td-due' + (late ? ' late' : '') + '">' + esc(due) + '</span>' : '') +
        '<div class="td-acts">' +
          (it.notificationId
            ? '<button class="btn" type="button" data-done="' + esc(it.notificationId) + '">Done</button>'
            : '') +
          '<button class="btn btn-accent" type="button" data-open="' + esc(it.id) + '">Open</button>' +
        '</div>' +
      '</div>';
    }

    function paintList() {
      const today = todayInZone();
      $('#tdWarn').innerHTML = failed.length
        ? '<div class="td-warn">Could not load ' + esc(failed.join(', ')) +
          ' just now, so ' + (failed.length === 1 ? 'it is' : 'they are') +
          ' missing below. Everything else is current.</div>'
        : '';

      if (!items.length) {
        $('#tdList').innerHTML = '<div class="td-clear"><strong>Nothing needs you right now.</strong>' +
          '<span>New tasks, late orders and anything waiting on your answer will show up here.</span></div>';
        return;
      }

      const groups = groupItems(items);
      $('#tdList').innerHTML = BUCKETS.filter((b) => groups[b.key].length).map((b) =>
        '<div class="td-sec ' + b.key + '">' +
          '<div class="td-sec-hd"><h3>' + esc(b.label) + '</h3><span class="td-c">' + groups[b.key].length + '</span></div>' +
          '<div class="td-list">' + groups[b.key].map((it) => rowHtml(it, today)).join('') + '</div>' +
        '</div>'
      ).join('');
    }

    async function load() {
      const today = todayInZone();
      const nextItems = [];
      const nextCards = [];
      const nextFailed = [];
      const jobs = [];

      // Each source runs on its own; one that fails is named in the warning
      // strip and the rest still draw.
      const source = (name, fn) => jobs.push(fn().catch((e) => {
        console.warn('[today] ' + name + ' failed', e);
        nextFailed.push(name);
      }));

      // ---- Notifications: every signed-in person has these. ----
      if (can('notifications')) {
        source('your tasks', async () => {
          const d = await api.get(ENDPOINTS.notifications, { assignedTo: me, status: 'open' });
          const list = notificationItems(d && d.notifications, me, today);
          nextItems.push(...list);
          nextCards.push({
            order: 1, app: 'notifications', count: list.length, label: 'Tasks for you',
            sub: list.filter((x) => x.bucket === 'late').length
              ? list.filter((x) => x.bucket === 'late').length + ' late' : 'Assigned to you',
            bad: list.some((x) => x.bucket === 'late'),
            none: 'Nothing assigned', button: 'Open tasks',
            route: { app: 'notifications', view: 'inbox' },
          });
        });
      }

      // ---- PromoPro: my orders going red or amber; the shop's red count for admins. ----
      if (can('promopro')) {
        source('PromoPro', async () => {
          const [p, v, s] = await Promise.all([
            api.get(ENDPOINTS.ppPos), api.get(ENDPOINTS.ppVendors), api.get(ENDPOINTS.ppSettings),
          ]);
          const r = poItems(p && p.pos, v && v.vendors, s && s.settings, today);
          nextItems.push(...r.mine);
          // The "your orders" card is for people PromoPro knows as an account
          // manager (settings.me is their roster link). Everyone else would
          // only ever see a reassuring zero about orders that are never theirs.
          const isAm = !!(s && s.settings && s.settings.me);
          if (isAm || r.mine.length) {
            nextCards.push({
              order: 2, app: 'promopro', count: r.mine.length, label: 'Your orders need a look',
              sub: 'Red or amber in PromoPro', bad: r.mine.some((x) => x.level === 'red'),
              none: 'Your orders are on track', button: 'Open PromoPro',
              route: { app: 'promopro', view: 'orders' },
            });
          }
          if (isAdmin) {
            nextCards.push({
              order: 3, app: 'promopro', count: r.shopRed, label: 'Shop orders in the red',
              sub: 'Everyone’s, not just yours', bad: r.shopRed > 0,
              none: 'No red orders', button: 'Open pipeline',
              route: { app: 'promopro', view: 'pipeline' },
            });
          }
        });
      }

      // ---- BackBone: my inquiries past their clock. ----
      if (can('backbone', 'inquiries') && user.name) {
        source('BackBone inquiries', async () => {
          const d = await api.get(ENDPOINTS.bbLeadsData);
          const list = inquiryItems(d && d.leads, user.name, Date.now());
          nextItems.push(...list);
          if (list.length) {
            nextCards.push({
              order: 4, app: 'backbone', count: list.length, label: 'Inquiries to follow up',
              sub: 'Yours, past their clock or due a call', bad: list.some((x) => x.bucket === 'late'),
              none: '', button: 'Open inquiries',
              route: { app: 'backbone', view: 'inquiries' },
            });
          }
        });
      }

      // ---- CrewCore: time off waiting on me as an approver. ----
      if (can('crewcore', 'timeoff')) {
        source('time off', async () => {
          const d = await api.get(ENDPOINTS.ccTimeoff);
          const list = timeoffItems(d, today);
          nextItems.push(...list);
          if (d && d.me && d.me.is_approver === true) {
            nextCards.push({
              order: 5, app: 'crewcore', count: list.length, label: 'Time off to answer',
              sub: 'Waiting on you', bad: list.some((x) => x.bucket === 'late'),
              none: 'No requests waiting', button: 'Open time off',
              route: { app: 'crewcore', view: 'timeoff' },
            });
          }
        });
      }

      // ---- MarketMachine: my campaign steps. ----
      if (can('marketmachine', 'tasks')) {
        source('campaign steps', async () => {
          const d = await api.get(ENDPOINTS.mkCampaigns, { mine: 'tasks' });
          const list = taskItems(d && d.tasks, today);
          nextItems.push(...list);
          if (list.length) {
            nextCards.push({
              order: 6, app: 'marketmachine', count: list.length, label: 'Campaign steps',
              sub: list.filter((x) => x.bucket === 'late').length
                ? list.filter((x) => x.bucket === 'late').length + ' late' : 'Yours to do',
              bad: list.some((x) => x.bucket === 'late'),
              none: '', button: 'Open my tasks',
              route: { app: 'marketmachine', view: 'tasks' },
            });
          }
        });
      }

      // ---- ConControl: social decisions and slipped posts, Admin flag only. ----
      if (isAdmin && can('concontrol', 'social')) {
        source('ConControl', async () => {
          const d = await api.get(ENDPOINTS.conSocial);
          const list = socialItems(d && d.blockers, today);
          nextItems.push(...list);
          const decisions = list.filter((x) => x.id.startsWith('cc-dec:')).length;
          if (list.length) {
            nextCards.push({
              order: 7, app: 'concontrol', count: list.length, label: 'Flyover Con social',
              sub: decisions ? decisions + ' decision' + (decisions === 1 ? '' : 's') + ' for you' : 'Posts to deal with',
              bad: list.some((x) => x.bucket === 'late'),
              none: '', button: 'Open social plan',
              route: { app: 'concontrol', view: 'social' },
            });
          }
        });
      }

      await Promise.all(jobs);
      items = dedupeItems(nextItems);
      cards = nextCards.sort((a, b) => a.order - b.order);
      failed = nextFailed;
      loadedAt = Date.now();
      paintHead();
      paintCards();
      paintList();
    }

    this._reload = (force) => {
      if (loading) return loading;
      if (!force && Date.now() - loadedAt < RELOAD_AFTER_MS) return Promise.resolve();
      loading = load().finally(() => { loading = null; });
      return loading;
    };

    root.addEventListener('click', async (e) => {
      const cardBtn = e.target.closest('[data-card]');
      if (cardBtn) {
        const c = cards[Number(cardBtn.dataset.card)];
        if (c) ctx.goApp(c.route.app, c.route.view);
        return;
      }
      const open = e.target.closest('[data-open]');
      if (open) {
        const it = items.find((x) => x.id === open.dataset.open);
        if (it) ctx.goApp(it.route.app, it.route.view, it.route.param || undefined);
        return;
      }
      const done = e.target.closest('[data-done]');
      if (done) {
        const id = done.dataset.done;
        done.disabled = true;
        done.textContent = 'Saving';
        try {
          await api.patch(ENDPOINTS.notifications, { status: 'done' }, { query: { id } });
          items = items.filter((x) => x.notificationId !== id);
          const c = cards.find((x) => x.app === 'notifications');
          if (c) {
            c.count = Math.max(0, c.count - 1);
            const late = items.filter((x) => x.source === 'notifications' && x.bucket === 'late').length;
            c.bad = late > 0;
            c.sub = late ? late + ' late' : 'Assigned to you';
          }
          paintCards();
          paintList();
        } catch (err) {
          done.disabled = false;
          done.textContent = 'Done';
          alert('Could not mark that done: ' + (err && err.message ? err.message : 'unknown error'));
        }
      }
    });

    paintHead();
    await this._reload(true);
  },

  // The shell calls this every time Today comes back on screen, so a task
  // finished in another app is gone from here when you return.
  showView() {
    if (typeof this._reload === 'function') this._reload(false);
  }
};
