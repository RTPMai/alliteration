/**
 * alliteration. — THE SEAM
 *
 * No app file calls fetch() directly. Ever. Everything goes through api.request()
 * or one of the namespaced helpers below.
 *
 * MOCK = true  -> returns fake data, no network. Develop the shell offline.
 * MOCK = false -> hits the real endpoints, already written in below.
 *
 * Flip it with any of:
 *   - ?mock=0 / ?mock=1 in the URL
 *   - localStorage.setItem('alliteration.mock', '0')
 *   - editing the default below
 */

// Static handbook content, shared with api/crewcore/handbook.js. Safe to
// import into browser code: it's plain data with no Node builtins, same as
// js/registry.js importing DEPARTMENTS-style constants from lib/ elsewhere
// in this codebase.
import { HANDBOOK_SECTIONS as HANDBOOK_SECTIONS_FOR_MOCK } from '../lib/crewcore/handbook-content.js';

/* ------------------------------------------------------------------ *
 * MODE
 * ------------------------------------------------------------------ */

const DEFAULT_MOCK = true;

function resolveMock() {
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '0' || q === 'false') return false;
    if (q === '1' || q === 'true') return true;
    const ls = localStorage.getItem('alliteration.mock');
    if (ls === '0') return false;
    if (ls === '1') return true;
  } catch (e) { /* SSR / blocked storage — fall through */ }
  return DEFAULT_MOCK;
}

export const MOCK = resolveMock();

/**
 * Endpoints that exist on the server RIGHT NOW.
 *
 * The shell ships auth before the app backends are migrated, so the two cannot
 * share one on/off switch: signing in needs the real server, while an app whose
 * api/ folder has not been copied over yet needs mock data. With a single flag
 * you get either a fake login or an app that cannot load.
 *
 * A path listed here always goes to the network. Everything else falls back to
 * mock data when the server has no route for it. Delete an entry from this list
 * as each app's endpoints are deployed.
 */
const LIVE_PREFIXES = [
  '/api/auth', '/api/users', '/api/health',
  // ShopStock: api/items.js, api/settings.js and api/scrape.js are deployed.
  '/api/items', '/api/settings', '/api/scrape',
  // GivingGauge: fed by the Jotform webhook.
  '/api/giving-requests', '/api/giving-intake',
  // BackBone: roster, leads, inbox and the AI endpoints are all deployed.
  '/api/data', '/api/save', '/api/leads-data', '/api/leads-save',
  '/api/intake', '/api/zip-check', '/api/inquiry-brief', '/api/qualify', '/api/brief', '/api/scan-card',
  '/api/printavo-sync', '/api/printavo-schema', '/api/customer-match',
  '/api/reorder-settings',
  // ErrorEngine: api/errors.js, api/taxonomy.js and api/errorengine/customers.js
  // are deployed. ('/api/errors' does not prefix-match '/api/errorengine/…' —
  // the 's' vs 'e' at position 10 keeps them distinct.)
  '/api/errors', '/api/taxonomy', '/api/errorengine/',
  // TravelTrack: api/traveltrack/{trips,expenses,miles,settings}.js are
  // deployed. Rebuilt from scratch (Base44 had no api/ to point at), so this
  // whole folder is new rather than a port.
  '/api/traveltrack/',
  // MailMe: api/mailme/{contacts,campaigns,lists,import,webhook}.js are
  // deployed. Client contacts are resolved live from the BackBone roster
  // rather than stored, so this app has real data the day it ships without an
  // import step; imported prospects are MailMe's own.
  '/api/mailme/',
  // CrewCore: api/crewcore/{employees,stipend,reviews,handbook,settings}.js
  // are deployed. PTO's api/crewcore/pto.js was removed Aug 2026 (PTO stays
  // in QuickBooks) — the /api/crewcore/ prefix below still needs to be live
  // for everything else, that removal isn't a route to un-list here.
  // The most sensitive app in the shell (pay, review notes), so every route
  // enforces scope server-side regardless of what MOCK shows on the client.
  '/api/crewcore/',
  // Notifications: api/notifications.js is deployed. Shell-level, not one of
  // the nine apps, same as auth/users/health above.
  '/api/notifications',
  // Site Work: api/sitework.js is deployed. Superuser-only, gated in the
  // route itself, not merely hidden from the rail.
  '/api/sitework',
  // WebsiteWidget: api/websitewidget/{stats,sites}.js are deployed. Both
  // live under the folder (no flat api/websitewidget.js) because Vercel
  // treats a same-named file and folder as a route conflict once the .js
  // is stripped. api/websitewidget/stats.js always answers 200 — when GA4
  // isn't configured yet it returns configured:false rather than erroring,
  // so this counts as live even before the service account exists.
  '/api/websitewidget/',
  // PromoPro: api/promopro/{pos,vendors,printavo}.js are deployed. Folder
  // form, not a flat api/promopro.js, for the same Vercel file-vs-folder
  // route conflict WebsiteWidget hit. api/promopro/printavo.js answers 200
  // with configured:false when the Printavo env vars are missing, so it
  // counts as live either way.
  '/api/promopro/',
  // StitchSense: api/stitchsense/{designs,estimates,rounds,settings}.js are
  // deployed. Live from the first deploy, so there is no mock block for it:
  // an empty library is a real and expected state (nobody has imported the
  // archive yet), and inventing sample designs would put fake stitch counts
  // in front of somebody quoting a real job.
  '/api/stitchsense/'
];

function isLive(path) {
  return LIVE_PREFIXES.some((p) => String(path).startsWith(p));
}

/**
 * Which apps still have no deployed backend. Drives the banner, so it can name
 * them instead of claiming the whole shell is on sample data when most of it
 * is not.
 */
export function appsOnSampleData() {
  const byApp = {
    shopstock:   [ENDPOINTS.ssItems, ENDPOINTS.ssSettings],
    // Only ggRequests: the budget view was never built, so requiring its
    // endpoint would report the app as fake when its real data is live.
    givinggauge: [ENDPOINTS.ggRequests],
    backbone:    [ENDPOINTS.bbData],
    errorengine: [ENDPOINTS.eeErrors],
    traveltrack: [ENDPOINTS.ttTrips],
    mailme:      [ENDPOINTS.mmContacts, ENDPOINTS.mmLists],
    crewcore:    [ENDPOINTS.ccEmployees],
    websitewidget: [ENDPOINTS.wwStats],
    promopro:    [ENDPOINTS.ppPos],
    stitchsense: [ENDPOINTS.ssenseDesigns]
  };
  return Object.keys(byApp).filter(
    (id) => !byApp[id].every((p) => p && isLive(p))
  );
}

/* ------------------------------------------------------------------ *
 * ENDPOINTS
 *
 * Four collisions exist between BackBone and ErrorEngine. BackBone wins in
 * every case; ErrorEngine's routes move aside.
 *
 * Verified against the repos:
 *   api/auth.js      — real file collision (both apps ship one)
 *   api/intake.js    — real file collision (both apps ship one)
 *   api/users.js     — ErrorEngine only; BackBone's equivalent is lib/users.js,
 *                      so this is a namespace reservation, not a live clash
 *   api/customers.js — ErrorEngine only; same situation
 *
 * The last two are renamed anyway so BackBone can add /api/users later without
 * silently stealing ErrorEngine's route.
 * ------------------------------------------------------------------ */

export const ERRORS_ENDPOINT = '/api/errors';   // was ErrorEngine's /api/intake

export const ENDPOINTS = {
  // ---- Shell / auth (BackBone's, shared by all apps) ----
  auth:            '/api/auth',
  session:         '/api/auth?action=session',
  users:           '/api/users',

  // ---- BackBone ----
  bbData:          '/api/data',
  bbSave:          '/api/save',
  bbIntake:        '/api/intake',
  bbLeadsData:     '/api/leads-data',
  bbLeadsSave:     '/api/leads-save',
  bbQualify:       '/api/qualify',
  bbBrief:         '/api/brief',
  bbScanCard:      '/api/scan-card',
  bbPrintavoSync:  '/api/printavo-sync',
  bbPrintavoSchema:'/api/printavo-schema',
  bbCustomerMatch: '/api/customer-match',
  bbZipCheck:      '/api/zip-check',
  bbInquiryBrief:  '/api/inquiry-brief',

  // ---- ErrorEngine (collisions resolved) ----
  eeErrors:        ERRORS_ENDPOINT,        // renamed from /api/intake
  eeUsers:         '/api/errorengine/users',
  eeCustomers:     '/api/errorengine/customers',
  eeTaxonomy:      '/api/taxonomy',

  // ---- ShopStock ----
  ssItems:         '/api/items',
  ssSettings:      '/api/settings',
  ssScrape:        '/api/scrape',

  // ---- GivingGauge ----
  ggRequests:      '/api/giving-requests',
  ggIntake:        '/api/giving-intake',
  ggBudget:        '/api/giving/budget',

  // ---- TravelTrack ----
  // Rebuilt, not reconnected: the standalone runs on Base44, which has no
  // api/ folder to point at.
  ttTrips:         '/api/traveltrack/trips',
  ttExpenses:      '/api/traveltrack/expenses',
  ttMiles:         '/api/traveltrack/miles',
  ttSettings:      '/api/traveltrack/settings',
  ttReceipt:       '/api/traveltrack/receipt',

  // ---- MailMe ----
  // No mmContacts POST equivalent by design: contacts are the BackBone
  // roster, not a list MailMe owns. See api/mailme/contacts.js.
  mmContacts:      '/api/mailme/contacts',
  mmCampaigns:     '/api/mailme/campaigns',
  mmLists:         '/api/mailme/lists',
  mmImport:        '/api/mailme/import',
  // Not called from the front end: the sending provider POSTs to it directly.
  // Listed so the path has one canonical home rather than being typed into a
  // provider dashboard from memory.
  mmWebhook:       '/api/mailme/webhook',
  mmSettings:      '/api/mailme/settings',
  // Reorder timing thresholds. NOT a MailMe endpoint despite MailMe being the
  // heaviest reader: BackBone owns them (they describe the customer, not the
  // email), so the path sits at the top level rather than under /api/mailme/.
  reorderSettings: '/api/reorder-settings',
  // Read-only Resend domain verification check, surfaced in Settings.
  mmDomains:       '/api/mailme/domains',
  // Public, called from unsubscribe.html rather than the shell.
  mmUnsubscribe:   '/api/mailme/unsubscribe',
  // Public, called from flyover-con-signup.html (and any future event
  // signup page) rather than the shell.
  mmSignup:        '/api/mailme/signup',

  // ---- CrewCore ----
  // Fresh build, no standalone to port: the P&M internal Wix site (Company
  // Structure, Contact List, New Hire Onboarding pages) was the only prior
  // art, not a system with an API of its own.
  ccEmployees:     '/api/crewcore/employees',
  ccStipend:       '/api/crewcore/stipend',
  ccReviews:       '/api/crewcore/reviews',
  ccHandbook:      '/api/crewcore/handbook',
  ccSettings:      '/api/crewcore/settings',
  // Time clock back side. The PUBLIC punch endpoint (/api/crewcore/clock)
  // is deliberately NOT listed here: clock.html lives outside the shell and
  // calls it directly, the same way scan.html calls api/scan-status.js. The
  // seam rule covers app modules, and there is no app module in that path.
  ccTimecards:     '/api/crewcore/timecards',

  // ---- Notifications (shell-level) ----
  notifications:   '/api/notifications',

  // ---- Site Work (superuser-only section, not an app) ----
  sitework:        '/api/sitework',

  // ---- WebsiteWidget ----
  wwStats:         '/api/websitewidget/stats',
  wwSites:         '/api/websitewidget/sites',

  // ---- PromoPro ----
  ppPos:           '/api/promopro/pos',
  ppVendors:       '/api/promopro/vendors',
  ppPrintavo:      '/api/promopro/printavo',
  ppSettings:      '/api/promopro/settings',
  ppArt:           '/api/promopro/art',
  ppSend:          '/api/promopro/send',
  ppPrint:         '/api/promopro/print',

  // ---- StitchSense ----
  // Folder form, not a flat api/stitchsense.js, for the same Vercel
  // file-vs-folder route conflict WebsiteWidget and PromoPro hit.
  ssenseDesigns:   '/api/stitchsense/designs',
  ssenseEstimates: '/api/stitchsense/estimates',
  ssenseRounds:    '/api/stitchsense/rounds',
  ssenseSettings:  '/api/stitchsense/settings'
};

/* ------------------------------------------------------------------ *
 * ERRORS
 * ------------------------------------------------------------------ */

/**
 * Best human-readable message from any error payload shape we might get:
 *   { error: "text" }                     our own routes
 *   { error: { code, message } }          Vercel platform errors
 *   { message: "text" } / { msg: "..." }  assorted middleware
 * Falls back to a compact JSON dump rather than "[object Object]", because a
 * dump you can read beats a shrug you cannot.
 */
function errorText(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;

  const e = payload.error !== undefined ? payload.error : payload;
  if (typeof e === 'string') return e;

  if (e && typeof e === 'object') {
    if (typeof e.message === 'string') {
      return e.code ? e.message + ' (' + e.code + ')' : e.message;
    }
    if (typeof e.code === 'string') return e.code;
    try {
      const dump = JSON.stringify(e);
      if (dump && dump !== '{}') return dump.slice(0, 300);
    } catch (err) { /* fall through */ }
  }

  if (typeof payload.message === 'string') return payload.message;
  return null;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  get isAuth() { return this.status === 401 || this.status === 403; }
}

/* ------------------------------------------------------------------ *
 * CORE
 * ------------------------------------------------------------------ */

const listeners = new Set();

/** Subscribe to auth failures so the shell can bounce to login once, centrally. */
export function onAuthFailure(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announceAuthFailure(err) {
  listeners.forEach((fn) => { try { fn(err); } catch (e) { /* never let a listener break a request */ } });
}

/**
 * The ONLY place fetch() is called in this codebase.
 *
 * @param {string} path   Endpoint. Use ENDPOINTS.*, not a literal.
 * @param {object} opts   { method, body, query, signal, headers }
 */
export async function request(path, opts = {}) {
  if (path == null) {
    throw new ApiError('Endpoint is null. This app has no backend wired up yet.', 0, null);
  }

  const { method = 'GET', body, query, signal, headers = {} } = opts;

  // Auth always talks to the real server, even in mock mode, or you would be
  // "signed in" as a fake user. Everything else uses mock data when MOCK is on.
  if (MOCK && !isLive(path)) return mockResponse(path, method, body, query);

  let url = path;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    });
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }

  const init = {
    method,
    credentials: 'same-origin',        // session cookie is HttpOnly
    headers: Object.assign({ Accept: 'application/json' }, headers),
    signal
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Network request failed: ' + url, 0, null);
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch (e) { payload = text; }
  }

  if (!res.ok) {
    // A 404 on a not-yet-migrated endpoint falls back to mock data instead of
    // breaking the app. This is what lets a ported app run against the shell
    // before its api/ folder has been copied over. Auth is never faked.
    if (res.status === 404 && !isLive(path)) {
      console.warn('[api] ' + path + ' is not deployed yet; using mock data.');
      return mockResponse(path, method, body, query);
    }
    // Error payloads are not always { error: "a string" }. Vercel's own
    // platform errors (a crashed function, a missing module) come back as
    // { error: { code, message } }, and pushing that object straight into
    // Error#message renders as the useless "[object Object]" — which is
    // exactly what it did, hiding a real deploy fault behind a shrug.
    const msg = errorText(payload) || res.statusText || ('HTTP ' + res.status);
    const err = new ApiError(msg, res.status, payload);
    if (err.isAuth) announceAuthFailure(err);
    throw err;
  }

  return payload;
}

export const get  = (path, query, opts)  => request(path, { ...opts, method: 'GET', query });
export const post = (path, body, opts)   => request(path, { ...opts, method: 'POST', body });
export const put  = (path, body, opts)   => request(path, { ...opts, method: 'PUT', body });
// PATCH was missing until MailMe needed it. ErrorEngine's routes accept PATCH
// too, so anything there doing a partial update through post() was sending the
// wrong verb; this is the correct helper for both.
export const patch = (path, body, opts)  => request(path, { ...opts, method: 'PATCH', body });
// NOTE the signature: del takes OPTIONS, not a body. To pass an id, use
// del(path, { query: { id } }). Passing { id } directly does nothing, which
// fails silently as a request with no id at all.
export const del  = (path, opts)         => request(path, { ...opts, method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * SESSION
 * ------------------------------------------------------------------ */

export const auth = {
  session: () => get(ENDPOINTS.session),
  login:   (email, password) => post(ENDPOINTS.auth, { action: 'login', email, password }),
  logout:  () => post(ENDPOINTS.auth, { action: 'logout' })
};

/* ------------------------------------------------------------------ *
 * MOCKS
 * Shaped like the real responses so views built against MOCK keep working
 * when the flag flips.
 * ------------------------------------------------------------------ */

const MOCK_LATENCY = 120;

const MOCK_USER = {
  username: 'ryan',
  name: 'Ryan',
  role: 'admin',
  perms: {
    tabs: ['backbone', 'shopstock', 'errorengine', 'givinggauge', 'traveltrack'],
    data_scope: 'all',
    can_edit: true,
    can_export: true,
    role: 'admin'
  }
};

const MOCK_DATA = {
  [ENDPOINTS.session]: () => ({ authenticated: true, user: MOCK_USER }),

  [ENDPOINTS.bbData]: () => ({
    synced: [],
    lastSynced: new Date().toISOString(),
    accounts: []
  }),

  // Shapes mirror api/errors.js, api/taxonomy.js and api/errorengine/customers.js
  // so views built against MOCK keep working when the flag flips.
  [ENDPOINTS.eeErrors]: () => ({ errors: [] }),
  [ENDPOINTS.eeTaxonomy]: () => {
    const opt = (v) => ({ value: v, label: v.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()), active: true });
    return {
      taxonomy: {
        error_type: ['misprint','wrong garment','wrong size/color','short ship','late','art error','vendor defect','replacement/reprint'].map(opt),
        root_cause: ['art','production','purchasing','vendor','CSR','customer-supplied'].map(opt),
        status: ['open','in review','resolved','written-off'].map(opt)
      },
      usage: { error_type: {}, root_cause: {}, status: {} },
      prices: [
        { id: '4x4', label: '4x4', unit_cost: 8 },
        { id: '5x11', label: '5x11', unit_cost: 10 },
        { id: '11x11', label: '11x11', unit_cost: 12 }
      ],
      protected: { status: ['open', 'resolved'], error_type: [], root_cause: [] },
      can_edit: true
    };
  },
  [ENDPOINTS.eeCustomers]: () => ({ customers: [], lastSynced: null, source: 'mock' }),

  [ENDPOINTS.ssItems]: () => ([{"id":"itm_0142","name":"Plastisol white, gallon","department":"Screen print","category":"Ink","supplier":"Fusion","status":"In Stock","qty":14,"reorderAt":6,"unitCost":38.4,"sku":"PM-0142"},{"id":"itm_0143","name":"Plastisol black, gallon","department":"Screen print","category":"Ink","supplier":"Fusion","status":"Needs Ordered","qty":5,"reorderAt":6,"unitCost":38.4,"sku":"PM-0143"},{"id":"itm_0219","name":"Poly thread, 5500yd black","department":"Embroidery","category":"Thread","supplier":"Madeira","status":"In Stock","qty":22,"reorderAt":10,"unitCost":6.2,"sku":"PM-0219"},{"id":"itm_0221","name":"Poly thread, 5500yd white","department":"Embroidery","category":"Thread","supplier":"Madeira","status":"Needs Ordered","qty":4,"reorderAt":10,"unitCost":6.2,"sku":"PM-0221"},{"id":"itm_0308","name":"Cutaway backing 2.5oz","department":"Embroidery","category":"Backing","supplier":"Madeira","status":"Ordered","qty":0,"reorderAt":8,"unitCost":41.0,"sku":"PM-0308"},{"id":"itm_0410","name":"Emulsion, quart","department":"Screen print","category":"Chemical","supplier":"Fusion","status":"In Stock","qty":9,"reorderAt":4,"unitCost":29.75,"sku":"PM-0410"},{"id":"itm_0512","name":"Poly mailers 12x15","department":"Shipping","category":"Packaging","supplier":"Uline","status":"In Stock","qty":340,"reorderAt":150,"unitCost":0.14,"sku":"PM-0512"},{"id":"itm_0530","name":"Folding boards","department":"Finishing","category":"Supplies","supplier":"Uline","status":"Needs Ordered","qty":2,"reorderAt":5,"unitCost":11.9,"sku":"PM-0530"},{"id":"itm_0611","name":"Squeegee 70/90 durometer","department":"Screen print","category":"Tools","supplier":"Fusion","status":"Issue","qty":3,"reorderAt":2,"unitCost":24.5,"sku":"PM-0611"}]),
  [ENDPOINTS.ssSettings]: () => ({"deptColors":{"Screen print":"#E36325","Embroidery":"#1B5DAB","Finishing":"#745DA8","Shipping":"#3D9A5C","Front office":"#6B7684"},"categories":["Ink","Thread","Backing","Chemical","Packaging","Supplies","Tools"]}),

  [ENDPOINTS.ggRequests]: () => ({ requests: [{"id":"REQ-014","received":"2026-07-19","status":"pending","request":{"orgName":"Ankeny Miracle League","contactName":"Dana Whitmer","email":"dana@ankenymiracleleague.org","phone":"515-555-0142","eventName":"Fall Opening Day","city":"Ankeny","state":"IA","county":"Polk","eventDate":"2026-09-26","selfReportedCustomer":"not sure","taxStatus":"exempt","missionFit":"core","logoRequired":true,"attendance":450,"yearsActive":7,"pieceCount":60,"purchaseIntent":"specific","merchandise":"Short-sleeve tees for players and buddies","description":"Adaptive baseball league for children with disabilities. Opening day brings players, buddy volunteers and families to the Ankeny complex.","carriesPMMark":true},"account":{"found":true,"matchConfidence":"Confirmed","customerId":"C-3310","tier":"Silver","score":3,"owner":"Abby","lifetimeRevenue":27400,"orderCount":11,"medianGapDays":84,"daysSinceLastOrder":61,"ytdRevenue":9200,"priorYtdRevenue":7100,"firstOrder":"2021-04-02"}},{"id":"REQ-013","received":"2026-07-18","status":"pending","request":{"orgName":"Saylorville Trail Run","contactName":"Marcus Bell","email":"marcus@saylorvilletrailrun.com","phone":"515-555-0198","eventName":"Saylorville Half Marathon","city":"Polk City","state":"IA","county":"Polk","eventDate":"2026-10-17","selfReportedCustomer":"yes","taxStatus":"business","missionFit":"civic","logoRequired":false,"attendance":900,"yearsActive":4,"pieceCount":180,"multipleTypes":true,"purchaseIntent":"no","merchandise":"Finisher tees and hooded sweatshirts","description":"Ticketed trail half marathon around the reservoir. Organizer operates as an LLC."},"account":{"found":false}},{"id":"REQ-012","received":"2026-07-16","status":"pending","request":{"orgName":"Johnston Dragons Wrestling Club","contactName":"Trent Kolar","email":"tkolar@johnstonwrestling.org","phone":"515-555-0177","eventName":"Youth Duals Tournament","city":"Johnston","state":"IA","county":"Polk","eventDate":"2026-11-14","selfReportedCustomer":"yes","taxStatus":"exempt","missionFit":"adjacent","logoRequired":true,"attendance":1600,"yearsActive":9,"pieceCount":70,"purchaseIntent":"vague","merchandise":"Singlet warm-up shirts for the host team","description":"Regional youth wrestling duals drawing clubs from across central Iowa. Host club has run the event since 2017."},"account":{"found":true,"matchConfidence":"Confirmed","customerId":"C-1042","tier":"Gold","score":4,"owner":"Abby","lifetimeRevenue":51800,"orderCount":19,"medianGapDays":96,"daysSinceLastOrder":623,"ytdRevenue":0,"priorYtdRevenue":8400,"firstOrder":"2018-09-11"}},{"id":"REQ-011","received":"2026-07-10","status":"approved","decidedBy":"Ryan","override":true,"note":"Volunteer shirts contingent on the paid tournament shirt order.","request":{"orgName":"Polk County Pickleball","contactName":"Ethan Welch","email":"ethan@polkcountypickleball.org","phone":"515-555-0121","eventName":"Fall Open","city":"Ankeny","state":"IA","county":"Polk","eventDate":"2026-09-12","selfReportedCustomer":"no","taxStatus":"exempt","missionFit":"adjacent","logoRequired":true,"attendance":300,"yearsActive":3,"pieceCount":null,"purchaseIntent":"","merchandise":"Volunteer shirts","description":"Community pickleball tournament at the Ankeny courts. Submitted on the previous form, before piece count and purchase intent were asked.","carriesPMMark":true},"account":{"found":false}},{"id":"REQ-010","received":"2026-07-08","status":"declined","decidedBy":"Ryan","note":"Medals impractical at low quantities. Kept the shirt quote conversation open.","request":{"orgName":"Raising Readers in the Heartland","contactName":"Jill Friestad-Tate","email":"jill@raisingreadersheartland.org","phone":"515-555-0163","eventName":"Literacy Fun Run","city":"Ankeny","state":"IA","county":"Polk","eventDate":"2026-10-03","selfReportedCustomer":"no","taxStatus":"exempt","missionFit":"core","logoRequired":false,"attendance":120,"yearsActive":2,"pieceCount":40,"multipleTypes":true,"purchaseIntent":"no","merchandise":"Shirts and finisher medals","description":"Family fun run supporting early childhood literacy programming."},"account":{"found":false}},{"id":"REQ-009","received":"2026-07-14","status":"approved","decidedBy":"Ryan","override":true,"note":"20% off list with online store ordering. Routed to Abby.","request":{"orgName":"Lutheran Services in Iowa","contactName":"Shay Olthoff","email":"solthoff@lsiowa.org","phone":"515-555-0155","eventName":"Foster Care Appreciation Picnic","city":"Des Moines","state":"IA","county":"Polk","eventDate":"2026-07-31","selfReportedCustomer":"not sure","taxStatus":"exempt","orgType":"religious","isReligious":true,"askIsSecular":true,"missionFit":"core","logoRequired":true,"attendance":200,"yearsActive":4,"pieceCount":50,"purchaseIntent":"vague","merchandise":"Shirts for foster families and staff","description":"Annual appreciation picnic for foster families. Ask is secular; the org is faith-affiliated social services."},"account":{"found":false}}] }),
  [ENDPOINTS.ggBudget]: () => ({ annual: 0, committed: 0, remaining: 0 }),

  // Shapes mirror api/traveltrack/*.js so views built against MOCK keep
  // working when the flag flips. Empty by default: unlike the other apps,
  // TravelTrack never shipped sample rows on the standalone, so there is
  // nothing plausible to fake here.
  // Shape mirrors api/websitewidget/stats.js's "not configured" response — the
  // real endpoint answers this same shape until GA4 env vars are set, so
  // MOCK and the live-but-unconfigured state look identical on purpose.
  [ENDPOINTS.wwStats]: () => ({
    configured: false,
    siteId: null,
    generatedAt: new Date().toISOString(),
    days: 30,
    totals: { activeUsers: 0, newUsers: 0, sessions: 0, pageViews: 0 },
    trend: [],
    channels: [],
    topPages: []
  }),

  // Empty by default: unlike the ShopStock/GivingGauge mocks, there is no
  // plausible sample site list to invent here without it looking real.
  [ENDPOINTS.wwSites]: () => ({ sites: [] }),

  // PromoPro. Empty rather than invented: a fake purchase order looks exactly
  // like a real one on screen, and the whole point of this app is that people
  // trust what the pipeline says.
  [ENDPOINTS.ppPos]: () => ({ pos: [] }),
  [ENDPOINTS.ppVendors]: () => ({ vendors: [] }),
  [ENDPOINTS.ppPrintavo]: () => ({ configured: false, results: [], invoice: null }),
  [ENDPOINTS.ppSettings]: () => ({ settings: { chaseAfterDays: 3, alwaysCc: [], accountManagers: [] } }),
  [ENDPOINTS.ppArt]: () => ({ art: [] }),
  [ENDPOINTS.ppSend]: () => ({ error: 'Sending is not available in sample mode.' }),

  [ENDPOINTS.ttTrips]: () => ({ trips: [] }),
  [ENDPOINTS.ttExpenses]: () => ({ expenses: [] }),
  [ENDPOINTS.ttMiles]: () => ({ accounts: [] }),
  [ENDPOINTS.ttSettings]: () => ({
    org: { mileage_rate: 0.67, per_diem_rate: 0, approval_threshold: 500, policy_notes: '', redemption_label: 'Miles / Rewards' },
    account: { home_airport: '', default_payment_method: 'personal_reimburse' },
    can_edit_org: true
  }),
  // Receipt upload/extract needs Blob + the Anthropic API, neither of which
  // exists offline. Mock returns empty fields so the form still opens under
  // MOCK; it just prefills nothing.
  [ENDPOINTS.ttReceipt]: () => ({ ok: true, fields: { date: '', amount: '', description: '', category: '' }, advisory: true }),

  // MailMe. Shapes mirror api/mailme/*.js. The contacts mock carries BOTH
  // sources plus a suppressed contact on purpose: the source split and the
  // suppression rule are the parts worth exercising offline, and a mock where
  // everyone is a subscribed client would never catch a broken filter.
  [ENDPOINTS.mmContacts]: () => {
    const contacts = [
      { id: 'client:1042', source: 'client', customer_id: '1042', company_name: 'Johnston Dragons Wrestling Club', contact_name: 'Trent Kolar', title: 'Club President', email: 'tkolar@johnstonwrestling.org', phone: '', city: 'Johnston', state: 'IA', status: 'subscribed', reason: null, tags: ['booster-club'], updatedAt: null },
      { id: 'client:3310', source: 'client', customer_id: '3310', company_name: 'Ankeny Miracle League', contact_name: 'Dana Whitmer', title: 'Director', email: 'dana@ankenymiracleleague.org', phone: '', city: 'Ankeny', state: 'IA', status: 'subscribed', reason: null, tags: ['nonprofit', 'vip'], updatedAt: null },
      { id: 'client:2015', source: 'client', customer_id: '2015', company_name: 'Saylorville Trail Run', contact_name: 'Marcus Bell', title: '', email: 'marcus@saylorvilletrailrun.com', phone: '', city: 'Polk City', state: 'IA', status: 'unsubscribed', reason: 'Too many emails', tags: [], updatedAt: '2026-07-02T14:10:00.000Z' },
      { id: 'client:4471', source: 'client', customer_id: '4471', company_name: 'Polk County Pickleball', contact_name: 'Ethan Welch', title: '', email: 'ethan@polkcountypickleball.org', phone: '', city: 'Ankeny', state: 'IA', status: 'bounced', reason: 'Mailbox does not exist', tags: ['nonprofit'], updatedAt: '2026-06-28T09:00:00.000Z' },
      { id: 'prospect:PR-00001', source: 'prospect', prospect_id: 'PR-00001', company_name: 'Waukee Warriors Booster Club', contact_name: 'Sara Lentz', title: 'Merchandise Chair', email: 'slentz@waukeeboosters.org', phone: '', city: 'Waukee', state: 'IA', status: 'subscribed', reason: null, tags: ['booster-club', 'cold-2026-q3'], importedAt: '2026-08-01T12:00:00.000Z', importBatch: 'BATCH-20260801120000', updatedAt: '2026-08-01T12:00:00.000Z' },
      { id: 'prospect:PR-00002', source: 'prospect', prospect_id: 'PR-00002', company_name: 'Grimes Chamber of Commerce', contact_name: 'Paul Ridge', title: 'Events Coordinator', email: 'pridge@grimeschamber.org', phone: '', city: 'Grimes', state: 'IA', status: 'subscribed', reason: null, tags: ['chamber', 'cold-2026-q3'], importedAt: '2026-08-01T12:00:00.000Z', importBatch: 'BATCH-20260801120000', updatedAt: '2026-08-01T12:00:00.000Z' }
    ];
    return {
      contacts,
      counts: {
        total: contacts.length, shown: contacts.length, client: 4, prospect: 2,
        mailable: 4, unsubscribed: 1, bounced: 1, complained: 0,
        customersWithoutEmail: 2, totalRosterSize: 6
      },
      tags: ['booster-club', 'chamber', 'cold-2026-q3', 'nonprofit', 'vip']
    };
  },
  [ENDPOINTS.mmCampaigns]: () => ({ campaigns: [] }),
  [ENDPOINTS.mmLists]: () => ({ lists: [] }),
  [ENDPOINTS.mmSettings]: () => ({
    settings: {
      companyName: 'P&M Apparel', fromName: '', replyToMode: 'account-manager', replyToFixed: '',
      postalAddress: { line1: '', line2: '', city: '', state: '', postalCode: '' },
      unsubscribeUrl: '',
      policy: { minDaysBetweenEmails: 14, coldDailyCapStart: 20, coldDailyCapMax: 200,
        coldRampDays: 30, clientDailyCap: 1000, skipOpenQuotes: true, skipInvalidVerification: true },
      reorder: { dueAt: 1, overdueAt: 1.5, lapsedAt: 3, minOrders: 3, minGapDays: 7 },
      coldStartedAt: null
    },
    blockers: [
      { field: 'postalAddress', text: 'A physical postal address is required in every commercial email by CAN-SPAM. Missing: line1, city, state, postalCode.' },
      { field: 'unsubscribeUrl', text: 'Every commercial email needs a working unsubscribe link.' },
      { field: 'fromName', text: 'A from-name is required so recipients can tell who is writing.' }
    ],
    footerPreview: '', coldCapToday: 20, rampDay: 0
  }),
  [ENDPOINTS.mmImport]: () => ({ ok: true, dryRun: true, summary: { parsed: 0, importable: 0, duplicate: 0, existingClients: 0, suppressed: 0, invalid: 0, headers: [], unmappedColumns: [], topDomains: [], tags: [] }, preview: [], rejected: { duplicate: [], existingClients: [], suppressed: [], invalid: [] } }),
  [ENDPOINTS.mmDomains]: () => ({ configured: false, domains: [] }),

  // CrewCore. Shapes mirror api/crewcore/*.js. MOCK_USER (below) is admin, so
  // the admin-view shape is what renders offline by default; the self-serve
  // shape (own record, own stipend/reviews only) only shows up against the
  // real server for an "employee"-role account. A handful of seeded names
  // carried over from the same Wix Contact List used for the real seed, so
  // the mock roster isn't just placeholder rows. Stipend figures follow the
  // Handbook's Dress Code split: $250 Front Office (Sales, Office), $150
  // Production (Screen Printing, Embroidery, Art).
  [ENDPOINTS.ccEmployees]: () => ({
    employees: [
      { id: 'EMP-00001', name: 'Kim Taylor', username: null, department: 'Embroidery', title: 'Embroidery Production Manager', start_date: '2013-03-01', status: 'active', phone: '206-817-1151', email: '', hourly_rate: 26.5, apparel_stipend: 150, notes: '' },
      { id: 'EMP-00002', name: 'Margo Niemeyer', username: null, department: 'Screen Printing', title: 'Screen Printing Production Manager', start_date: '2018-06-01', status: 'active', phone: '605-690-1126', email: '', hourly_rate: 25, apparel_stipend: 150, notes: '' },
      { id: 'EMP-00003', name: 'Jacob Whitman', username: 'jacob', department: 'Sales', title: 'Sales Director', start_date: '2019-01-01', status: 'active', phone: '616-307-7612', email: '', hourly_rate: null, apparel_stipend: 250, notes: '' },
      { id: 'EMP-00004', name: 'Amanda Clark', username: 'amanda', department: 'Office', title: 'Bookkeeper', start_date: '2022-02-01', status: 'active', phone: '402-366-9695', email: '', hourly_rate: 24, apparel_stipend: 250, notes: '' },
      { id: 'EMP-00005', name: 'Alexis Davis', username: 'alexis', department: 'Sales', title: 'Account Manager', start_date: '2021-04-01', status: 'active', phone: '515-868-1519', email: '', hourly_rate: 21, apparel_stipend: 250, notes: '' }
    ]
  }),
  [ENDPOINTS.ccStipend]: () => ({
    spends: [
      { id: 'STP-00001', employee_id: 'EMP-00003', date: '2026-03-14', amount: 85, category: 'apparel', description: 'Branded quarter-zip', logged_by: 'ryan' },
      { id: 'STP-00002', employee_id: 'EMP-00003', date: '2026-06-02', amount: 40, category: 'apparel', description: 'P&M tee, 2-pack', logged_by: 'ryan' }
    ],
    balance: { year: 2026, allotted: 250, used: 125, remaining: 125 }
  }),
  [ENDPOINTS.ccHandbook]: () => ({
    // The full section list is real (not mocked) — imported directly so the
    // offline/mock experience matches production exactly for read-only
    // static content instead of duplicating it here.
    sections: HANDBOOK_SECTIONS_FOR_MOCK,
    updated: '2026-08',
    // Mocked as NOT yet acknowledged so the offline/sample experience shows
    // the acknowledgment interstitial too, not just the real deployment.
    acknowledged: false,
    ack_version: null,
    ack_at: null
  }),
  [ENDPOINTS.ccReviews]: () => ({
    reviews: [
      { id: 'REV-00001', employee_id: 'EMP-00003', review_date: '2026-06-15', reviewer_name: 'Ryan Toney', summary: 'Strong quarter, marketing initiatives gaining traction.', strengths: 'Client relationships, trend research', growth_areas: 'Delegating routine follow-ups', next_review_date: '2026-12-15' }
    ]
  }),
  [ENDPOINTS.ccSettings]: () => ({ settings: { default_stipend_front_office: 250, default_stipend_production: 150, self_serve_enabled: true, clock_enabled: true, week_start_day: 0, overtime_after_hours: 40, clock_round_minutes: 0, clock_kiosk_token: '' } }),
  [ENDPOINTS.ccTimecards]: () => ({
    scope: 'all', timezone: 'America/Chicago', week_start_day: 0,
    week_key: '2026-08-09', dates: ['2026-08-09','2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15'],
    round_minutes: 0, overtime_after: 40,
    rows: [], totals: { hours: 0, overtime: 0, flags: 0, cost: 0 }, now_in: []
  }),

  // Shape mirrors api/notifications.js. Two sample rows assigned to the mock
  // user so the header bell has something to show while developing offline.
  [ENDPOINTS.notifications]: (query) => {
    if (query && query.people === '1') {
      return {
        people: [
          { username: 'ryan', name: 'Ryan' }, { username: 'alexis', name: 'Alexis Davis' },
          { username: 'hannah', name: 'Hannah Posey' }, { username: 'abby', name: 'Abby Penton' },
          { username: 'jacob', name: 'Jacob Whitman' }, { username: 'megan', name: 'Megan Griffith' },
          { username: 'amanda', name: 'Amanda Clark' }, { username: 'margo', name: 'Margo Niemeyer' }
        ]
      };
    }
    return {
      notifications: [
        {
          id: 'N-00002', title: 'Reprint approval on hold', types: ['need'],
          appIds: ['errorengine'], status: 'open',
          assignedTo: 'ryan', assignedToName: 'Ryan',
          createdBy: 'margo', createdByName: 'Margo',
          dueDate: null, createdAt: new Date(Date.now() - 3 * 3600e3).toISOString(), doneAt: null
        },
        {
          id: 'N-00001', title: 'Hand off Ankeny Miracle League quote', types: ['handoff'],
          appIds: ['backbone'], status: 'open',
          assignedTo: 'ryan', assignedToName: 'Ryan',
          createdBy: 'abby', createdByName: 'Abby',
          dueDate: null, createdAt: new Date(Date.now() - 26 * 3600e3).toISOString(), doneAt: null
        }
      ]
    };
  }
};

function mockResponse(path, method, body, query) {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (method === 'POST' && path === ENDPOINTS.auth) {
        if (body && body.action === 'logout') return resolve({ ok: true });
        return resolve({ ok: true, user: MOCK_USER });
      }

      const key = Object.keys(MOCK_DATA).find((k) => path.startsWith(k));
      if (key) return resolve(MOCK_DATA[key](query, body));

      // Unmocked GETs resolve empty rather than throwing, so a half-built view
      // renders instead of blowing up. Writes echo back.
      resolve(method === 'GET' ? {} : { ok: true, echo: body ?? null });
    }, MOCK_LATENCY);
  });
}

export default {
  MOCK, ENDPOINTS, ERRORS_ENDPOINT, ApiError,
  request, get, post, put, patch, del, auth, onAuthFailure
};
