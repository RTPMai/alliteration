/**
 * alliteration. — shell
 *
 * Owns the chrome, the session, and which app is on screen. Everything
 * app-specific lives in apps/. Everything network lives in api.js.
 *
 * Boot order:
 *   1. resolve session (one login for all apps)
 *   2. build the switcher from the registry, filtered by perms
 *   3. start the router, mount the routed app, theme the body
 */

import { APPS, getApp, canAccess, allowedViews, firstAllowed } from './registry.js';
import * as api from './api.js';
import * as router from './router.js';
import { mountApp, showView, isMounted } from './app-host.js';

const el = {
  switcher: null,
  main: null,
  user: null,
  mockBanner: null
};

const state = {
  user: null,
  perms: null,
  activeApp: null,
  hosts: new Map()      // appId -> host element
};

/* ------------------------------------------------------------------ *
 * BOOT
 * ------------------------------------------------------------------ */

export async function boot() {
  el.switcher   = document.getElementById('appSwitcher');
  el.main       = document.getElementById('shellMain');
  el.user       = document.getElementById('shellUser');
  el.mockBanner = document.getElementById('mockBanner');

  if (api.MOCK && el.mockBanner) el.mockBanner.hidden = false;

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
    return renderMessage('Not signed in', 'Sign in to continue.');
  }

  state.user  = session.user;
  state.perms = session.user.perms || {};

  renderUser();
  renderSwitcher();

  const start = router.start();
  router.onRoute(handleRoute);
  await handleRoute(start);
}

/* ------------------------------------------------------------------ *
 * ROUTING
 * ------------------------------------------------------------------ */

async function handleRoute(route) {
  let { app: appId, view } = route;

  // No route, unknown app, or an app this user cannot open: fall back to the
  // first one they can, and normalise the URL without stacking history.
  if (!appId || !getApp(appId) || !canAccess(state.perms, appId)) {
    const fallback = firstAllowed(state.perms);
    if (!fallback) {
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
      return renderMessage('No views available', 'This account cannot open any view in ' + meta.name + '.');
    }
    return router.go(appId, target, { replace: true });
  }

  document.body.dataset.app = appId;
  markSwitcher(appId);

  if (meta.stub) return renderStub(meta);

  try {
    await activate(meta, view);
  } catch (e) {
    console.error('[shell] failed to mount ' + appId, e);
    renderMessage(
      'Could not load ' + meta.name,
      'The app failed to start. Check the console for details.'
    );
  }
}

async function activate(meta, view) {
  clearShellMessage();

  // Hide every host, then reveal (or create) this app's.
  state.hosts.forEach((h) => h.classList.remove('active'));

  let host = state.hosts.get(meta.id);
  if (!host) {
    host = document.createElement('div');
    host.className = 'app-host';
    host.id = 'host-' + meta.id;
    el.main.appendChild(host);
    state.hosts.set(meta.id, host);
  }
  host.classList.add('active');

  if (!isMounted(meta.id)) {
    host.innerHTML = '<div class="shell-spinner"></div>';
    await mountApp(meta, host, {
      user: state.user,
      perms: state.perms,
      go: (v) => router.goView(v)
    });
    const spinner = host.querySelector(':scope > .shell-spinner');
    if (spinner) spinner.remove();
  }

  state.activeApp = meta.id;
  showView(meta.id, view);
}

/* ------------------------------------------------------------------ *
 * CHROME
 * ------------------------------------------------------------------ */

function renderSwitcher() {
  if (!el.switcher) return;
  el.switcher.innerHTML = '';

  APPS.filter((a) => canAccess(state.perms, a.id)).forEach((a) => {
    const btn = document.createElement('button');
    btn.className = 'app-btn';
    btn.dataset.appId = a.id;
    btn.dataset.stub = String(!!a.stub);
    btn.style.setProperty('--dot', a.accent);
    btn.title = a.blurb;
    btn.innerHTML = '<span class="dot-swatch"></span>' + a.name;
    btn.addEventListener('click', () => router.go(a.id, a.defaultView));
    el.switcher.appendChild(btn);
  });
}

function markSwitcher(appId) {
  if (!el.switcher) return;
  el.switcher.querySelectorAll('.app-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.appId === appId);
  });
}

function renderUser() {
  if (!el.user || !state.user) return;
  const name = state.user.name || state.user.email || 'Signed in';
  el.user.innerHTML = '';

  const who = document.createElement('strong');
  who.textContent = name;
  el.user.appendChild(who);

  const out = document.createElement('button');
  out.className = 'shell-logout';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    try { await api.auth.logout(); } catch (e) { /* sign out locally regardless */ }
    location.reload();
  });
  el.user.appendChild(out);
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
  state.hosts.forEach((h) => h.classList.remove('active'));
  shellMessageNode().innerHTML =
    '<div class="shell-msg"><h2>' + escapeHtml(title) + '</h2><p>' + body + '</p></div>';
}

function renderStub(meta) {
  state.hosts.forEach((h) => h.classList.remove('active'));
  shellMessageNode().innerHTML =
    '<div class="shell-msg">' +
      '<h2>' + escapeHtml(meta.name) + '</h2>' +
      '<p>Confirmed for rebuild. This app runs on Base44, so there is no ' +
      '<code>api/</code> folder to point at. The data model gets rebuilt here ' +
      'rather than reconnected.</p>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
