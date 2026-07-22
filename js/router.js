/**
 * alliteration. — router
 *
 * URL shape:  #/<appId>/<view>
 * Examples:   #/backbone/dashboard   #/errorengine/records   #/givinggauge/requests
 *
 * Hash routing, not pathname, on purpose: the shell deploys as static files to
 * Vercel from the folder root, and hash routes need no rewrite rules. It also
 * means a deep link survives a hard refresh with no server involvement.
 *
 * The router owns the URL. It does not know what an app is; it reports
 * {app, view} and lets shell.js decide what to mount.
 */

const listeners = new Set();
let current = { app: null, view: null };
let started = false;

function parse(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return { app: null, view: null };
  const [app, view] = raw.split('/').filter(Boolean);
  return { app: app || null, view: view || null };
}

function emit() {
  listeners.forEach((fn) => {
    try { fn({ ...current }); }
    catch (e) { console.error('[router] listener threw:', e); }
  });
}

function handleHashChange() {
  const next = parse(location.hash);
  if (next.app === current.app && next.view === current.view) return;
  current = next;
  emit();
}

/** Subscribe to route changes. Returns an unsubscribe fn. */
export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentRoute() {
  return { ...current };
}

/**
 * Navigate. `replace` avoids stacking history entries when the shell is
 * normalising a URL (e.g. filling in a default view) rather than responding
 * to a real user action.
 */
export function go(app, view, { replace = false } = {}) {
  // The hub lives at bare '#/' rather than '#/hub', so the landing URL stays
  // clean and a shared link to the front page looks like the site root.
  const hash = (app === 'hub' || !app)
    ? '#/'
    : '#/' + [app, view].filter(Boolean).join('/');
  if (location.hash === hash) return;

  if (replace) {
    history.replaceState(null, '', location.pathname + location.search + hash);
    current = parse(hash);
    emit();
  } else {
    location.hash = hash;   // fires hashchange
  }
}

/** Change the view within the current app. */
export function goView(view, opts) {
  if (!current.app) return;
  go(current.app, view, opts);
}

export function start() {
  if (started) return currentRoute();
  started = true;
  window.addEventListener('hashchange', handleHashChange);
  current = parse(location.hash);
  return currentRoute();
}

export function stop() {
  window.removeEventListener('hashchange', handleHashChange);
  started = false;
}
