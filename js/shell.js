/**
 * alliteration. — shell
 *
 * Owns the chrome (header, rail, crumb), the session, and which app is on
 * screen. Everything app-specific lives in apps/. Everything network lives in
 * api.js.
 *
 * The chrome never re-renders on navigation. Switching views repaints the rail
 * sub-nav and the crumb; the header and the mounted app hosts stay put.
 *
 * Routes:
 *   #/            -> hub ("All apps")
 *   #/<app>/<view>
 */

import { APPS, getApp, canAccess, allowedViews, firstAllowed, viewLabel } from './registry.js';
import * as api from './api.js';
import * as router from './router.js';
import { mountApp, showView, isMounted } from './app-host.js';

const HUB = 'hub';

const el = {};
const state = {
  user: null,
  perms: null,
  app: HUB,
  view: null,
  hosts: new Map()
};

/* ------------------------------------------------------------------ *
 * BOOT
 * ------------------------------------------------------------------ */

export async function boot() {
  el.rail       = document.getElementById('rail');
  el.main       = document.getElementById('main');
  el.crumb      = document.getElementById('crumb');
  el.avatar     = document.getElementById('avatar');
  el.mockBanner = document.getElementById('mockBanner');
  el.brandBtn   = document.getElementById('brandBtn');
  el.railToggle = document.getElementById('railToggle');

  if (api.MOCK && el.mockBanner) el.mockBanner.hidden = false;

  el.brandBtn.addEventListener('click', () => router.go(HUB, null));
  el.railToggle.addEventListener('click', () => document.body.classList.toggle('rail-open'));

  api.onAuthFailure(() => renderMessage(
    'Session expired',
    'Your session ended or was signed out elsewhere. Reload to sign in again.'
  ));

  renderSpinner();

  let session;
  try {
    session = await api.auth.session();
  } catch (e) {
    return renderMessage(
      'Cannot reach the server',
      'The session endpoint did not respond. If you are working offline, run with <code>?mock=1</code>.'
    );
  }

  if (!session || session.authenticated === false || !session.user) {
    // Not signed in: hand off to the sign-in screen rather than showing a dead
    // end. In mock mode there is no real session, so stay put instead of
    // bouncing in a loop.
    if (!api.MOCK) {
      location.replace('login.html');
      return;
    }
    return renderMessage('Not signed in', 'Sign in to continue.');
  }

  state.user  = session.user;
  state.perms = session.user.perms || {};

  renderAvatar();

  const start = router.start();
  router.onRoute(handleRoute);
  await handleRoute(start);
}

/* ------------------------------------------------------------------ *
 * ROUTING
 * ------------------------------------------------------------------ */

async function handleRoute(route) {
  const { app: appId, view } = route;

  // No route at all, or an explicit hub route.
  if (!appId || appId === HUB) {
    state.app = HUB;
    state.view = null;
    document.body.dataset.app = HUB;
    renderRail();
    renderCrumb();
    return activateHub();
  }

  // Unknown app, or one this user cannot open: fall back to the first they can.
  if (!getApp(appId) || !canAccess(state.perms, appId)) {
    const fallback = firstAllowed(state.perms);
    if (!fallback) {
      renderRail();
      return renderMessage(
        'No apps available',
        'This account has no apps assigned. An administrator can grant access in Settings.'
      );
    }
    return router.go(fallback.id, fallback.defaultView, { replace: true });
  }

  const meta = getApp(appId);
  const permitted = allowedViews(state.perms, appId);

  if (!view || !permitted.includes(view)) {
    const target = permitted.includes(meta.defaultView) ? meta.defaultView : permitted[0];
    if (!target) {
      return renderMessage('No views available',
        'This account cannot open any view in ' + meta.name + '.');
    }
    return router.go(appId, target, { replace: true });
  }

  state.app = appId;
  state.view = view;
  document.body.dataset.app = appId;

  renderRail();
  renderCrumb();

  if (meta.stub) return renderStub(meta);

  try {
    await activate(meta, view);
  } catch (e) {
    console.error('[shell] failed to mount ' + appId, e);

    // Distinguish "not built yet" from "built but failed to load". They look
    // identical to a user and have completely different fixes: the first is
    // waiting on work, the second is usually a file that did not deploy.
    const missing = e && (e.name === 'TypeError' || /Failed to fetch|Importing a module|dynamically imported/i.test(e.message || ''));

    renderMessage(
      'Could not load ' + meta.name,
      missing
        ? 'The app file did not load. Check that <code>apps/' + appId + '.js</code> ' +
          'and everything it imports were deployed, then look at the browser console ' +
          'for the exact path that failed.'
        : 'The app failed to start: ' + escape(e && e.message ? e.message : String(e)) +
          '. See the browser console for details.'
    );
  }
}

function hostFor(id) {
  let host = state.hosts.get(id);
  if (!host) {
    host = document.createElement('div');
    host.className = 'app-host';
    host.id = 'host-' + id;
    el.main.appendChild(host);
    state.hosts.set(id, host);
  }
  return host;
}

function hideAllHosts() {
  state.hosts.forEach((h) => h.classList.remove('active'));
}

async function activateHub() {
  clearShellMessage();
  hideAllHosts();

  const host = hostFor(HUB);
  host.classList.add('active');

  if (!isMounted(HUB)) {
    host.innerHTML = '<div class="shell-spinner"></div>';
    await mountApp({ id: HUB, views: [], defaultView: null }, host, {
      user: state.user,
      perms: state.perms,
      go: () => {},
      goApp: (a, v) => router.go(a, v)
    });
    const spinner = host.querySelector(':scope > .shell-spinner');
    if (spinner) spinner.remove();
  }

  window.scrollTo({ top: 0 });
}

async function activate(meta, view) {
  clearShellMessage();
  hideAllHosts();

  const host = hostFor(meta.id);
  host.classList.add('active');

  if (!isMounted(meta.id)) {
    host.innerHTML = '<div class="shell-spinner"></div>';
    await mountApp(meta, host, {
      user: state.user,
      perms: state.perms,
      go: (v) => router.goView(v),
      goApp: (a, v) => router.go(a, v)
    });
    const spinner = host.querySelector(':scope > .shell-spinner');
    if (spinner) spinner.remove();
  }

  showView(meta.id, view);
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ *
 * RAIL
 * ------------------------------------------------------------------ */

function renderRail() {
  if (!el.rail) return;

  const visible = APPS.filter((a) => canAccess(state.perms, a.id));
  let html = '<div class="rail-label">Apps</div>';

  visible.forEach((a) => {
    const on = state.app === a.id;
    html += `
      <button class="rail-item${on ? ' active' : ''}${a.stub ? ' planned' : ''}"
              data-app="${a.id}" style="--dot:${a.accent}">
        <span class="sq"></span>${escape(a.name)}${a.stub ? '<span class="tag">Soon</span>' : ''}
      </button>`;

    // Sub-nav only under the open app, and only views this user may see.
    if (on) {
      const views = allowedViews(state.perms, a.id);
      if (views.length > 1) {
        html += '<div class="subnav">';
        views.forEach((v) => {
          html += `
            <button class="sub-item${state.view === v ? ' active' : ''}"
                    data-app="${a.id}" data-view="${v}">${escape(viewLabel(a, v))}</button>`;
        });
        html += '</div>';
      }
    }
  });

  html += '<div class="rail-hr"></div><div class="rail-label">Shared</div>';
  html += `
    <button class="rail-item${state.app === HUB ? ' active' : ''}" data-app="${HUB}">
      <span class="sq" style="--dot:var(--hub)"></span>All apps
    </button>`;

  el.rail.innerHTML = html;

  el.rail.querySelectorAll('[data-app]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.body.classList.remove('rail-open');
      const id = btn.dataset.app;
      if (id === HUB) return router.go(HUB, null);
      const target = getApp(id);
      router.go(id, btn.dataset.view || (target ? target.defaultView : null));
    });
  });
}

/* ------------------------------------------------------------------ *
 * CRUMB + AVATAR
 * ------------------------------------------------------------------ */

function renderCrumb() {
  if (!el.crumb) return;

  if (state.app === HUB) {
    el.crumb.innerHTML = '<span>All apps</span>';
    return;
  }

  const app = getApp(state.app);
  if (!app) { el.crumb.innerHTML = ''; return; }

  el.crumb.innerHTML =
    '<span>alliteration</span>' +
    '<span class="sep">/</span>' +
    `<span class="now">${escape(app.name)}</span>` +
    (state.view
      ? '<span class="sep">/</span><span>' + escape(viewLabel(app, state.view)) + '</span>'
      : '');
}

function renderAvatar() {
  if (!el.avatar || !state.user) return;
  const name = state.user.name || state.user.username || '?';
  el.avatar.textContent = name.trim()[0].toUpperCase();
  el.avatar.title = name + ' — click to sign out';
  el.avatar.style.cursor = 'pointer';
  el.avatar.setAttribute('role', 'button');
  el.avatar.setAttribute('tabindex', '0');

  const signOut = async () => {
    try { await api.auth.logout(); } catch (e) { /* sign out locally regardless */ }
    location.replace('login.html');
  };

  el.avatar.addEventListener('click', signOut);
  el.avatar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); signOut(); }
  });
}

/* ------------------------------------------------------------------ *
 * SHELL-LEVEL VIEWS
 * ------------------------------------------------------------------ */

function shellMessageNode() {
  let node = document.getElementById('shellMessage');
  if (!node) {
    node = document.createElement('div');
    node.id = 'shellMessage';
    el.main.appendChild(node);
  }
  return node;
}

function clearShellMessage() {
  const node = document.getElementById('shellMessage');
  if (node) node.remove();
}

function renderSpinner() {
  shellMessageNode().innerHTML = '<div class="shell-spinner"></div>';
}

function renderMessage(title, body) {
  hideAllHosts();
  shellMessageNode().innerHTML =
    '<div class="shell-msg"><h2>' + escape(title) + '</h2><p>' + body + '</p></div>';
}

function renderStub(meta) {
  hideAllHosts();
  shellMessageNode().innerHTML =
    '<div class="view"><div class="page-head"><div>' +
      '<div class="page-title">' + escape(meta.name) + '<span class="dot">.</span></div>' +
      '<div class="page-sub">' + escape(meta.role || meta.blurb) + '</div>' +
    '</div></div>' +
    '<div class="card"><div class="card-bd"><div class="empty">' +
      '<strong>Not built yet</strong>' +
      'Confirmed for rebuild. This app runs on Base44, so there is no ' +
      '<code>api/</code> folder to point at. The data model gets rebuilt here ' +
      'rather than reconnected.' +
    '</div></div></div></div>';
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
