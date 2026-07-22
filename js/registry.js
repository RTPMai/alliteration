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
    w1: 'Back', w2: 'Bone', letter: 'B',
    role: 'Who we sell to',
    blurb: 'Accounts, leads, roster, scorecard.',
    accent: '#1B5DAB',           // display only (rail dot / app mark); tokens.css owns theming
    views: [
      ['inbox', 'Inbox'],
      ['leads', 'Leads'],
      ['roster', 'Roster'],
      ['scorecard', 'Scorecard'],
      ['dashboard', 'Dashboard'],
      ['settings', 'Settings']
    ],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'shopstock',
    name: 'ShopStock',
    w1: 'Shop', w2: 'Stock', letter: 'S',
    role: 'What we make it with',
    blurb: 'Inventory, orders, labels.',
    accent: '#E36325',
    views: [
      ['dashboard', 'Dashboard'],
      ['inventory', 'Full Inventory'],
      ['orders', 'Order Queue'],
      ['labels', 'Labels'],
      ['admin', 'Admin']
    ],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'errorengine',
    name: 'ErrorEngine',
    w1: 'Error', w2: 'Engine', letter: 'E',
    role: 'What went wrong',
    blurb: 'Error log, records, vendor accountability.',
    accent: '#745DA8',
    views: [
      ['dashboard', 'Dashboard'],
      ['log', 'Log an Error'],
      ['records', 'Records'],
      ['vendors', 'Vendors'],
      ['settings', 'Settings']
    ],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'givinggauge',
    name: 'GivingGauge',
    w1: 'Giving', w2: 'Gauge', letter: 'G',
    role: 'What we give away',
    blurb: 'Donation and sponsorship scoring.',
    accent: '#D5A029',           // gold, not green — see tokens.css note
    views: [
      ['requests', 'Requests'],
      ['model', 'Model'],
      ['budget', 'Budget']
    ],
    defaultView: 'requests',
    stub: false
  },
  {
    id: 'traveltrack',
    name: 'TravelTrack',
    w1: 'Travel', w2: 'Track', letter: 'T',
    role: 'What it costs to get there',
    blurb: 'Travel and expense tracking.',
    accent: '#0E7C86',
    views: [
      ['dashboard', 'Dashboard']
    ],
    defaultView: 'dashboard',
    // Runs on Base44. There is no api/ folder to point at, so the data model
    // gets rebuilt rather than reconnected. Ships as a placeholder until then.
    stub: true
  }
];

/* ------------------------------------------------------------------ *
 * VIEW HELPERS
 *
 * views is [[key, label], ...] so the rail can render sub-nav labels without
 * every app re-declaring them. viewKeys()/viewLabel() keep callers from
 * caring about the tuple shape.
 * ------------------------------------------------------------------ */

export function viewKeys(app) {
  if (!app || !Array.isArray(app.views)) return [];
  return app.views.map((v) => (Array.isArray(v) ? v[0] : v));
}

export function viewLabel(app, key) {
  if (!app || !Array.isArray(app.views)) return key;
  const hit = app.views.find((v) => (Array.isArray(v) ? v[0] : v) === key);
  if (!hit) return key;
  return Array.isArray(hit) ? hit[1] : hit;
}

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
  const keys = viewKeys(app);
  if (perms && perms.superuser === true) return keys.slice();

  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  const scoped = tabs
    .filter((t) => t.startsWith(appId + ':'))
    .map((t) => t.slice(appId.length + 1));

  // No per-view grants recorded means "all views of an app you can open".
  return scoped.length === 0 ? keys.slice() : keys.filter((v) => scoped.includes(v));
}
