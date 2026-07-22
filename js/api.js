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
  ggRequests:      '/api/giving/requests',
  ggBudget:        '/api/giving/budget',

  // ---- TravelTrack ----
  // Base44. No api/ folder exists to point at; the data model must be rebuilt,
  // not reconnected. Left null on purpose so a stray call fails loudly.
  ttData:          null
};

/* ------------------------------------------------------------------ *
 * ERRORS
 * ------------------------------------------------------------------ */

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

  if (MOCK) return mockResponse(path, method, body, query);

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
    const msg = (payload && payload.error) || res.statusText || ('HTTP ' + res.status);
    const err = new ApiError(msg, res.status, payload);
    if (err.isAuth) announceAuthFailure(err);
    throw err;
  }

  return payload;
}

export const get  = (path, query, opts)  => request(path, { ...opts, method: 'GET', query });
export const post = (path, body, opts)   => request(path, { ...opts, method: 'POST', body });
export const put  = (path, body, opts)   => request(path, { ...opts, method: 'PUT', body });
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
  email: 'ryan@pmapparel.com',
  name: 'Ryan',
  role: 'admin',
  perms: {
    superuser: true,
    tabs: ['backbone', 'shopstock', 'errorengine', 'givinggauge', 'traveltrack']
  }
};

const MOCK_DATA = {
  [ENDPOINTS.session]: () => ({ authenticated: true, user: MOCK_USER }),

  [ENDPOINTS.bbData]: () => ({
    synced: [],
    lastSynced: new Date().toISOString(),
    accounts: []
  }),

  [ENDPOINTS.eeErrors]: () => ({ errors: [], total: 0 }),
  [ENDPOINTS.eeTaxonomy]: () => ({ types: [], causes: [], vendors: [] }),

  [ENDPOINTS.ssItems]: () => ({ items: [], total: 0 }),
  [ENDPOINTS.ssSettings]: () => ({ settings: {} }),

  [ENDPOINTS.ggRequests]: () => ({ requests: [] }),
  [ENDPOINTS.ggBudget]: () => ({ annual: 0, committed: 0, remaining: 0 })
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
  request, get, post, put, del, auth, onAuthFailure
};
