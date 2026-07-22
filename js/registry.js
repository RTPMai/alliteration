/**
 * alliteration. — app registry
 *
 * ADDING AN APP:
 *   1. Drop a file in apps/<id>.js that default-exports an app object.
 *   2. Add an entry to APPS below.
 *   3. Add a body[data-app="<id>"] accent block to css/tokens.css.
 *
 * The `id` is the contract. It is used as:
 *   - the <body data-app> value (themes the app)
 *   - the URL hash prefix (#/<id>/<view>)
 *   - the apps/<id>.js module path
 *   - the perms.tabs entry that grants access to the app
 * Keep it lowercase, no spaces.
 *
 * Modules are loaded lazily on first switch, so a 10k-line monolith like
 * BackBone costs nothing until someone opens it.
 */

export const APPS = [
  {
    id: 'backbone',
    name: 'BackBone',
    blurb: 'Accounts, leads, roster, scorecard.',
    accent: '#1B5DAB',           // display only (the swatch dot); tokens.css owns theming
    views: ['dashboard', 'inbox', 'leads', 'roster', 'scorecard', 'settings'],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'shopstock',
    name: 'ShopStock',
    blurb: 'Inventory, orders, labels.',
    accent: '#E36325',
    views: ['dashboard', 'inventory', 'orders', 'labels', 'admin'],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'errorengine',
    name: 'ErrorEngine',
    blurb: 'Error log, records, vendor accountability.',
    accent: '#745DA8',
    views: ['dashboard', 'log', 'records', 'vendors', 'settings'],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'givinggauge',
    name: 'GivingGauge',
    blurb: 'Donation and sponsorship scoring.',
    accent: '#D5A029',           // gold, not green — see tokens.css note
    views: ['requests', 'model', 'budget'],
    defaultView: 'requests',
    stub: false
  },
  {
    id: 'traveltrack',
    name: 'TravelTrack',
    blurb: 'Travel and expense tracking.',
    accent: '#0E7C86',
    views: ['dashboard'],
    defaultView: 'dashboard',
    // Runs on Base44. There is no api/ folder to point at, so the data model
    // gets rebuilt rather than reconnected. Ships as a placeholder until then.
    stub: true
  }
];

/* ------------------------------------------------------------------ *
 * LOOKUPS
 * ------------------------------------------------------------------ */

const BY_ID = new Map(APPS.map((a) => [a.id, a]));

export function getApp(id) {
  return BY_ID.get(id) || null;
}

export function appIds() {
  return APPS.map((a) => a.id);
}

export function isApp(id) {
  return BY_ID.has(id);
}

/** First app the user is allowed to see, or null if none. */
export function firstAllowed(perms) {
  for (const app of APPS) {
    if (canAccess(perms, app.id)) return app;
  }
  return null;
}

/**
 * Access check.
 *
 * perms.tabs historically held BackBone's INTERNAL tab names
 * ("dashboard", "roster", "leads"...). Under one login it must also carry app
 * IDs, or every user sees every app.
 *
 * Transitional rule: if perms.tabs contains no app IDs at all, the list is a
 * legacy BackBone-only value, so BackBone is granted and nothing else. Once
 * roles are re-saved with app IDs the check becomes exact. This keeps existing
 * stored roles working instead of locking everyone out on deploy.
 */
export function canAccess(perms, appId) {
  if (!perms) return false;
  if (perms.superuser === true) return true;

  const tabs = Array.isArray(perms.tabs) ? perms.tabs : [];
  const granted = tabs.filter((t) => BY_ID.has(t));

  if (granted.length === 0) return appId === 'backbone';   // legacy shape
  return granted.includes(appId);
}

/**
 * Views within an app the user may see. App-level access is assumed to have
 * been checked already. Names are namespaced "<appId>:<view>" so BackBone's
 * "settings" and ErrorEngine's "settings" stay distinct.
 */
export function allowedViews(perms, appId) {
  const app = getApp(appId);
  if (!app) return [];
  if (perms && perms.superuser === true) return app.views.slice();

  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  const scoped = tabs
    .filter((t) => t.startsWith(appId + ':'))
    .map((t) => t.slice(appId.length + 1));

  // No per-view grants recorded means "all views of an app you can open".
  return scoped.length === 0 ? app.views.slice() : app.views.filter((v) => scoped.includes(v));
}
