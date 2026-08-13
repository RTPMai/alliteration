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
    // BackBone is ~10k lines, so it lives in a FOLDER rather than one file.
    // `entry` selects that layout; the app contract is unchanged.
    entry: 'backbone/index.js',
    views: [
      ['dashboard', 'Dashboard'],
      ['inbox', 'Inbox'],
      ['leads', 'Leads'],
      ['roster', 'Roster'],
      ['scorecard', 'Scorecard'],
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
    // These are the app's THREE real nav buttons, matching its page-* ids.
    // "Order Queue" and "Labels" were in the earlier plan but do not exist:
    // ordering lives on the dashboard, and labels print from Full Inventory.
    // page-queue and page-item exist in the markup but are reached in-app
    // (from a row click), not from the rail.
    views: [
      ['inventory', 'Dashboard'],
      ['full', 'Full Inventory'],
      ['admin', 'Admin']
    ],
    // Reachable by URL but NOT shown in the rail. "item" is where a scanned QR
    // label lands (#/shopstock/item/<id>) and "queue" is opened from a row
    // click. Listing them above would put two dead links in the nav; leaving
    // them out entirely would make the shell reject the route and bounce a scan
    // back to the dashboard.
    hiddenViews: ['item', 'queue'],
    defaultView: 'inventory',
    stub: false
  },
  {
    id: 'errorengine',
    name: 'ErrorEngine',
    w1: 'Error', w2: 'Engine', letter: 'E',
    role: 'What went wrong',
    blurb: 'Error log, records, vendor accountability.',
    accent: '#745DA8',
    // These match the ported app's four sections. "Vendors" from the earlier
    // plan is not a view: vendor accountability renders on the Dashboard (the
    // Errors by Vendor panel and the replaced stat). "Settings" became "Manage
    // Lists": its user-management half moved to the shell's Settings screen
    // (accounts are shell-level now), and what remains is the taxonomy + fusion
    // price list editor. The record DETAIL screen is internal to Records
    // (opened by row click), so it is not routable and not listed here.
    views: [
      ['dashboard', 'Dashboard'],
      ['log', 'Log an Error'],
      ['records', 'Records'],
      ['lists', 'Manage Lists']
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
    // Model and Budget were planned tabs in the standalone app that were never
    // built, so they are still absent: listing a view that does not exist puts
    // dead sub-nav in the rail.
    views: [
      ['requests', 'Requests'],
      ['giving', 'Giving']
    ],
    defaultView: 'requests',
    stub: false
  },
  {
    id: 'traveltrack',
    name: 'TravelTrack',
    w1: 'Travel', w2: 'Track', letter: 'T',
    role: 'What it costs to get there',
    blurb: 'Trips, expenses, mileage, miles.',
    accent: '#52A246',           // display only (rail dot / app mark); tokens.css owns theming — exact value from the vector logo file (was #51A446, off by a hair)
    // Rebuilt from scratch (Base44 had no api/ to point at). Trip Form and
    // Expense Form aren't separate rail entries: both live inline on their
    // list view, matching how the rest of the shell handles create panels.
    // Org Settings and Account Settings from the Base44 page list are one
    // "Settings" view here; the Org section only renders for data_scope
    // "all" + can_edit, everyone gets their own Account section.
    views: [
      ['dashboard', 'Dashboard'],
      ['trips', 'Trips'],
      ['expenses', 'Expenses'],
      ['miles', 'Redeem Miles'],
      ['reports', 'Reports'],
      ['settings', 'Settings']
    ],
    defaultView: 'dashboard',
    stub: false
  },
  {
    id: 'crewcore',
    name: 'CrewCore',
    w1: 'Crew', w2: 'Core', letter: 'C',
    role: 'Who does the work',
    blurb: 'Employees, stipends, reviews, handbook.',
    accent: '#E1251B',           // display only (rail dot / app mark); tokens.css owns theming — exact value from the vector logo file (was #D61623, a different red)
    // Real build, Aug 2026. Roster and Reviews render an admin view (roles
    // with data_scope "all", or any superuser account) and a self-serve "my
    // profile" view otherwise, from the SAME route — see apps/crewcore.js.
    // Stipend is where self-serve actually does something: see your own
    // apparel allotment and spend history. Handbook is read-only and open to
    // both views — see api/crewcore/handbook.js. Dashboard is admin-only
    // (anniversaries, headline numbers) and folds into Roster for a
    // self-serve caller.
    //
    // PTO REMOVED, Aug 2026 (Ryan's call): time off tracking stays in
    // QuickBooks, not duplicated here. The old 'pto' view, and everything
    // behind it, is gone — not hidden, gone. See DEPLOY-NOTES.md.
    views: [
      ['dashboard', 'Dashboard'],
      ['roster', 'Roster'],
      ['stipend', 'Stipend'],
      ['reviews', 'Reviews'],
      ['handbook', 'Handbook'],
      ['settings', 'Settings']
    ],
    defaultView: 'dashboard',
    // Still the most sensitive app in the shell: hourly rates and review
    // notes. No role is granted 'crewcore' by registry default — the only
    // grant path is an explicit role assignment in lib/users.js (the
    // "employee" role for self-serve, or admin/manager for the full view) or
    // the per-account superuser flag. See js/registry.js canAccess() and
    // test/scope.test.cjs, which asserts the registry itself stays
    // deny-by-default even though the app is real now.
    stub: false
  },
  {
    id: 'mailme',
    name: 'MailMe',
    w1: 'Mail', w2: 'Me', letter: 'M',
    role: 'What we tell them',
    blurb: 'Email marketing, opens, clicks, unsubscribes.',
    accent: '#8CA9CC',           // display only (rail dot / app mark); tokens.css owns theming — exact value from the vector logo file (was #85A0C6, close but off)
    views: [
      ['dashboard', 'Dashboard'],
      ['contacts', 'Contacts'],
      ['lists', 'Lists'],
      ['import', 'Import'],
      ['campaigns', 'Campaigns'],
      ['settings', 'Settings']
    ],
    defaultView: 'dashboard',
    // BUILT, but deliberately still ungranted. stub:false means the real app
    // mounts; access stays superuser-only because no role's apps[] lists
    // 'mailme'. That is intentional and should stay that way until sending is
    // switched on: the app exposes the whole customer email list, and the
    // suppression ledger is the record that keeps sends CAN-SPAM compliant.
    //
    // SENDING IS NOT WIRED. Campaigns save as drafts and api/mailme/campaigns.js
    // rejects any status but "draft". Three things must land first: a provider
    // account (Postmark/Resend/SendGrid), a sending domain with SPF/DKIM/DMARC,
    // and the tokenized unsubscribe page plus its webhook receiver.
    stub: false
  },
  {
    id: 'teletally',
    name: 'TeleTally',
    w1: 'Tele', w2: 'Tally', letter: 'T',
    role: 'Who is on the phone',
    blurb: 'Call activity, answering performance, team usage.',
    accent: '#000B8C',           // display only (rail dot / app mark); tokens.css owns theming — exact value from the vector logo file (was #282A72, too indigo/purple — the logo is a darker true navy)
    views: [
      ['dashboard', 'Dashboard']
    ],
    defaultView: 'dashboard',
    stub: true,
    stubNote: 'Planned. Connects to the shop phones to track call activity: ' +
      'total calls, duration, and volume, who is answering vs. missing ' +
      'calls, talk time and response time, and performance comparison ' +
      'across the team.'
  },
  {
    id: 'websitewidget',
    name: 'WebsiteWidget',
    w1: 'Website', w2: 'Widget', letter: 'W',
    role: 'What the websites are doing',
    blurb: 'Visitors, traffic sources, site performance across every site.',
    accent: '#00BBB4',           // display only (rail dot / app mark); tokens.css owns theming — exact value from the vector logo file (was #02A9A5, close but off)
    // Real build, Aug 2026, extended the same month for multiple sites
    // (PMApparel.com, IowaOnDemand.com, Flyover Con). Pulls from GA4 via
    // api/websitewidget/stats.js — see lib/websitewidget/ga4.js. GA4_CLIENT_EMAIL
    // and GA4_PRIVATE_KEY (one shared service account) still need to be set
    // in Vercel; until then the dashboard shows a plain setup notice
    // instead of any invented numbers. Which sites exist is NOT an env var
    // — see lib/websitewidget/sites-store.js — so adding IowaOnDemand.com
    // or a future site is a Settings-tab action, not a redeploy.
    views: [
      ['dashboard', 'Dashboard'],
      ['settings', 'Manage Sites']
    ],
    defaultView: 'dashboard',
    stub: false
  }
];

/**
 * Shell-level screens. Not one of the five apps: these belong to the shell
 * itself, so they live in the rail's "Shared" section rather than the app list.
 *
 * Settings used to be a tab inside BackBone. Accounts are shell-level now (one
 * login covers every app), so managing them from inside one app would imply
 * that app owns them.
 */
export const SHELL_APPS = [
  {
    id: 'settings',
    name: 'Settings',
    role: 'Accounts and access',
    accent: '#6B7684',
    views: [['accounts', 'Accounts']],
    defaultView: 'accounts',
    adminOnly: true,
    shellLevel: true,
    stub: false
  },
  {
    id: 'notifications',
    name: 'Notifications',
    role: 'Assigned tasks, needs, hand offs',
    accent: '#3E4C59',
    views: [['inbox', 'Assigned to me'], ['sent', 'I assigned']],
    defaultView: 'inbox',
    // Not adminOnly: every signed-in employee uses this to assign and track
    // work across apps. See js/registry.js canAccess(): shell screens with
    // adminOnly:false are open to any authenticated user.
    //
    // This was briefly a header-dropdown-only panel (Aug 6) and got reverted
    // back to a routed screen the same day — Ryan preferred the full page.
    // The header bell (js/shell.js) still shows the open-count badge and
    // still navigates here on click; it just doesn't render the list itself
    // anymore.
    adminOnly: false,
    shellLevel: true,
    stub: false
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

/** Views reachable by URL, including ones the rail does not list. */
export function routableViews(app) {
  if (!app) return [];
  return viewKeys(app).concat(app.hiddenViews || []);
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

const BY_ID = new Map(APPS.concat(SHELL_APPS).map((a) => [a.id, a]));

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

  // Shell-level screens gate on ROLE, not on perms.tabs. They are not apps, so
  // they are never listed in a role's app grants.
  const shell = SHELL_APPS.find((a) => a.id === appId);
  if (shell) {
    if (!shell.adminOnly) return true;
    return perms.role === 'admin' || perms.superuser === true;
  }

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
  // Hidden views are included: they are legitimate destinations (a QR scan, a
  // row click), just not rail entries. renderRail() filters them back out.
  const keys = routableViews(app);
  if (perms && perms.superuser === true) return keys.slice();

  const tabs = (perms && Array.isArray(perms.tabs)) ? perms.tabs : [];
  const scoped = tabs
    .filter((t) => t.startsWith(appId + ':'))
    .map((t) => t.slice(appId.length + 1));

  // No per-view grants recorded means "all views of an app you can open".
  return scoped.length === 0 ? keys.slice() : keys.filter((v) => scoped.includes(v));
}
