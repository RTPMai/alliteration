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

// The one definition of "is this caller a CrewCore administrator", shared
// with the server routes and the screen. lib/crewcore/schema.js has no
// imports of its own, so it is safe to pull into the browser.
import { isCrewCoreAdmin } from '../lib/crewcore/schema.js';

/**
 * Views an app shows to somebody who is NOT an administrator of it, used by
 * allowedViews() as a ceiling rather than as a grant. Only CrewCore needs
 * this: it is the one app where a role having the app ticked must not mean
 * "and every screen in it". See the long note in allowedViews().
 */
const SELF_SERVE_VIEWS = {
  crewcore: ['dashboard', 'timeclock', 'stipend', 'kudos', 'reviews', 'handbook'],
};

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
    id: 'promopro',
    name: 'PromoPro',
    w1: 'Promo', w2: 'Pro', letter: 'P',
    role: 'Where every vendor order stands',
    blurb: 'Purchase orders, vendor timelines, art approvals, tracking.',
    accent: '#E31E2D',           // display only (rail dot / app mark); tokens.css owns theming — from the Aug 14 2026 logo lineup. CrewCore moved off red to raspberry the same day so the two rail dots stay distinguishable.
    // Owns the PO end to end: builds it from a Printavo quote (or from
    // nothing, for a manual web order), emails it to the vendor, then tracks
    // submitted / confirmed / art / payment / ship / receive with a per-vendor
    // clock on each step. Replaces raising POs in QuickBooks — the vendor
    // BILL still gets entered there when it arrives, so the accounting side
    // is unchanged, but the open-order picture now lives here where the whole
    // team can see it instead of in one person's inbox.
    //
    // Read access is deliberately wide (AMs need to answer "where is my
    // order" without asking); writing is can_edit, deleting is admin only.
    views: [
      ['pipeline', 'Pipeline'],
      ['orders', 'Purchase Orders'],
      ['vendors', 'Vendors'],
      ['settings', 'Settings']
    ],
    defaultView: 'pipeline',
    stub: false
  },
  {
    id: 'crewcore',
    name: 'CrewCore',
    w1: 'Crew', w2: 'Core', letter: 'C',
    role: 'Who does the work',
    blurb: 'Employees, stipends, reviews, handbook.',
    accent: '#C83E73',           // display only (rail dot / app mark); tokens.css owns theming — raspberry, from the Aug 14 2026 logo lineup (was #E1251B red; PromoPro took the red so the two rail dots stay distinguishable)
    // Real build, Aug 2026. Reviews renders an admin view (the admin role or
    // an account with the elevated Admin flag) and a self-serve read-only
    // view otherwise, from the SAME route — see apps/crewcore.js. Stipend is
    // where self-serve actually does something: see your own apparel
    // allotment and spend history. Handbook is read-only and open to both
    // views — see api/crewcore/handbook.js.
    //
    // ROSTER IS ADMIN-ONLY as of Aug 2026 (Ryan's call): it lists the whole
    // team, so it is not a screen everyone with a login should open. The
    // self-serve profile card that used to be the employee's version of
    // Roster now lives on the DASHBOARD, which is what an employee lands on
    // — their profile plus their own stipend balance, hours this pay week,
    // next review and handbook status. Dashboard is therefore two different
    // screens behind one key, the same adaptive pattern the other views use.
    //
    // PTO REMOVED, Aug 2026 (Ryan's call): time off tracking stays in
    // QuickBooks, not duplicated here. The old 'pto' view, and everything
    // behind it, is gone — not hidden, gone. See DEPLOY-NOTES.md.
    //
    // TIME CLOCK added Aug 2026 as a rush replacement for the shop's broken
    // clock in/out system. An admin sees the whole team's timecards and can
    // correct them, a self-serve employee sees only their own hours, read
    // only. The PUNCHING itself does not happen here at all — it happens on
    // /clock, a public page outside the shell, because most of production
    // has no login.
    //
    // The view is granted only to people who actually punch: permsFor() in
    // lib/users.js strips "crewcore:timeclock" for any employee whose record
    // has clock_enabled false, so salaried staff never see the tab.
    views: [
      ['dashboard', 'Dashboard'],
      ['roster', 'Roster'],
      ['timeclock', 'Time Clock'],
      ['stipend', 'Stipend'],
      // SanMar sample drops. Sits next to Stipend because a pick draws that
      // person's apparel allotment the moment it is made.
      ['samples', 'Samples'],
      // KUDOS, Sep 2026. The one screen in this app anybody can WRITE to:
      // a manager giving credit and one employee thanking another are the
      // same record. Everybody with CrewCore reads the same feed, which is
      // the point — praise only two people can see is a private message.
      // Note that DOCUMENTATION, its opposite number, is deliberately NOT a
      // view: it is drawn inside Reviews and is admin-only, so keeping it
      // off this list means it can never appear in a rail at all.
      ['kudos', 'Kudos'],
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
    // FOUR views, restructured Aug 2026 (was six). Contacts and Lists were
    // two screens showing the same people, so they merged into Audience, with
    // lists as a filter rail over one table. Import stopped being a permanent
    // tab for a task done a few times a year and became a button there. The
    // old Dashboard was mostly an explanatory essay; its live parts moved to
    // a strip on Campaigns. Reports is what the "Results" modal became, now
    // that sending no longer happens on it.
    views: [
      // "Sends", not "Campaigns". A MailMe record is ONE EMAIL; a campaign is
      // the whole multi-channel effort and lives in MarketMachine. Both apps
      // calling their record a campaign meant the word answered two different
      // questions, the same conflict as Roster meaning customers in BackBone
      // and employees in CrewCore.
      //
      // The VIEW KEY stays 'campaigns'. It is in stored dashboard layouts and
      // in deep links, so renaming it would break those for no gain, and the
      // key is not something anyone reads.
      ['campaigns', 'Sends'],
      ['audience', 'Audience'],
      ['reports', 'Reports'],
      ['settings', 'Settings']
    ],
    // Campaigns, not a dashboard. The thing people open MailMe to do is send
    // something; landing them on a summary screen first was a step in the way.
    defaultView: 'campaigns',
    // BUILT and SENDING, through Resend. Access stays tightly held because the
    // app exposes the whole customer email list, and the suppression ledger is
    // the record that keeps sends CAN-SPAM compliant. Grant it per person
    // rather than opening it to a role wholesale.
    //
    // Safety does not come from who can click Send: it comes from the checks
    // that run immediately before dispatch every time (CAN-SPAM compliance,
    // live domain verification, a from-address, and current suppression for
    // every recipient). A draft can sit for weeks, so nothing about it is
    // trusted as still true at send time.
    stub: false
  },
  {
    id: 'marketmachine',
    name: 'MarketMachine',
    w1: 'Market', w2: 'Machine', letter: 'M',
    role: 'Every campaign, every channel',
    blurb: 'Campaigns across email, mail, ads, events and calls, with what each one cost.',
    accent: '#6E1E2B',           // display only (rail dot / app mark); tokens.css owns theming. PROVISIONAL: see the note in tokens.css, this needs checking against the logo lineup sheet.
    // OWNS THE CAMPAIGN OF RECORD. MailMe grew a Campaigns tab because email
    // was the first channel P&M automated, but a real campaign is rarely only
    // email: a spring school push is a postcard drop, a booth, a paid social
    // run and an email, all aimed at the same people over the same weeks.
    // Keeping the campaign inside the email tool made the other five channels
    // invisible and made "did that work" unanswerable.
    //
    // MailMe keeps EMAIL: composing, suppression, the cold ramp, domain
    // reputation, CAN-SPAM. None of that has an analogue in a postcard drop,
    // which is exactly why it does not belong in a planner.
    //
    // The link is ONE pointer and MailMe holds it (marketingCampaignId on its
    // own records). MarketMachine asks "which of your emails belong to me"
    // rather than keeping its own list, because two copies of one fact drift
    // the first time an email is deleted.
    //
    // Reading is open to any signed-in user: a campaign plan is something AMs
    // need to see without asking. Writing is can_edit, deleting is admin.
    views: [
      ['campaigns', 'Campaigns'],
      ['calendar', 'Calendar'],
      // Data Entry is a screen rather than a form buried inside a campaign.
      // Entering last week's numbers is a recurring chore across several
      // campaigns at once, and making somebody open each campaign to do it is
      // how the numbers stop getting entered.
      ['entry', 'Data Entry'],
      // Definitions is generated from the metric catalog, so it cannot drift
      // from the maths. It exists to end the "these numbers look low" argument
      // before it starts.
      ['definitions', 'Definitions'],
      ['settings', 'Settings']
    ],
    defaultView: 'campaigns',
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
  },
  {
    id: 'stitchsense',
    name: 'StitchSense',
    w1: 'Stitch', w2: 'Sense', letter: 'S',
    role: 'What it costs to sew',
    blurb: 'Stitch count estimating, design library, and the guessing game.',
    accent: '#D61F7A',           // display only (rail dot / app mark); tokens.css owns theming
    // Built Aug 2026. The model behind it (lib/stitchsense/model.js) was
    // fitted on 5,904 archive DST files with grouped cross validation, and
    // replaces the earlier prototype's flat "covered area x 1666" rule.
    //
    // FOUR VIEWS, and the last two are not decoration:
    //   estimate   what an AM opens to quote a job
    //   library    the archive, and the accurate requote-at-a-new-size path
    //   colorway   drop a DST, assign a thread colour per block, export a PNG.
    //              Possible because a DST carries colour CHANGES but no
    //              colours, so the blocks arrive already separated and with
    //              nothing baked in to strip out.
    //   guess      Stitch Guess, the training game for the embroidery team.
    //              It collects design-character labels, which is the feature
    //              that failed validation when it was scraped from filenames.
    //   accuracy   estimate versus actual on real jobs. The archive says the
    //              model is 18.6% off; only this view can say whether that
    //              holds once a customer PNG is the input instead of a DST.
    views: [
      ['estimate', 'Estimate'],
      ['library', 'Library'],
      ['colorway', 'Colorway'],
      ['guess', 'Stitch Guess'],
      ['accuracy', 'Accuracy']
    ],
    defaultView: 'estimate',
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
    views: [['inbox', 'Assigned to me'], ['sent', 'I assigned'], ['team', 'My team']],
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

/**
 * Site Work screens. Not apps, and deliberately NOT shell screens either.
 *
 * Shared (Settings, Notifications) is the team's shell: things everyone uses
 * while running the business. Site Work is the opposite audience — the list of
 * what still needs building in Alliteration itself. Ryan asked for it as its
 * own rail section rather than another Shared entry, because a sticky note
 * reading "fix the ShopStock session bug" is not the same kind of object as a
 * hand-off reading "call this customer back", and stacking them in one list is
 * what made the first attempt unusable.
 *
 * Superuser only. Enforced in api/sitework.js as well; hiding a rail entry is
 * not access control.
 */
export const SITE_APPS = [
  {
    id: 'stickies',
    name: 'Sticky Notes',
    role: 'What still needs building',
    accent: '#C9A227',
    views: [['board', 'Board']],
    defaultView: 'board',
    superuserOnly: true,
    siteLevel: true,
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

const BY_ID = new Map(APPS.concat(SHELL_APPS, SITE_APPS).map((a) => [a.id, a]));

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

  // Site Work screens gate on the per-account superuser flag alone. Not a
  // role grant, not perms.tabs: this section is for whoever builds the
  // platform, and that is not a job title anyone can be given by editing a
  // role. Checked before the blanket superuser pass below so the rule reads
  // in one place.
  const site = SITE_APPS.find((a) => a.id === appId);
  if (site) return perms.superuser === true;

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
  let scoped = tabs
    .filter((t) => t.startsWith(appId + ':'))
    .map((t) => t.slice(appId.length + 1));

  // CREWCORE IS DENY-BY-DEFAULT PER VIEW, Aug 28 2026.
  //
  // "No per-view grants recorded means every view" is a sane default for
  // most apps and was the wrong one here. A role only has to have CrewCore
  // ticked and no tabs list — which is every role except the self-serve
  // "employee" one, including any role created in Settings — for the rail to
  // hand it Roster, Time Clock and Settings. It did exactly that: an office
  // account with CrewCore granted got the whole team's roster in her rail,
  // even though the server correctly answered every request with only her
  // own record.
  //
  // So for CrewCore the fallback is inverted: anyone who is not a CrewCore
  // admin (see isCrewCoreAdmin — the per-account Admin flag or the protected
  // admin role, never a role checkbox) is narrowed to the self-serve views,
  // whatever their role does or does not list. permsFor() does the same on
  // the server, so this is the second of two gates, not the only one.
  const selfServe = SELF_SERVE_VIEWS[appId];
  if (selfServe && !isCrewCoreAdmin({
    superuser: perms && perms.superuser,
    roleName: perms && perms.role,
  })) {
    scoped = scoped.length
      ? scoped.filter((v) => selfServe.includes(v))
      : selfServe.slice();
  }

  // No per-view grants recorded means "all views of an app you can open".
  return scoped.length === 0 ? keys.slice() : keys.filter((v) => scoped.includes(v));
}
