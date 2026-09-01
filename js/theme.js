/**
 * alliteration. — theme
 *
 * One place that decides whether the platform is drawing light or dark.
 *
 * THREE PREFERENCES, TWO OUTCOMES.
 *   'system' (the default) follows the operating system and keeps following it,
 *   so a phone that flips to dark at sunset flips the app with it.
 *   'light' and 'dark' are explicit overrides that ignore the system.
 * Whatever the preference, what lands on the page is only ever the resolved
 * answer: <html data-theme="light"> or <html data-theme="dark">. CSS never has
 * to think about "system", which is why tokens.css needs one dark block
 * instead of one dark block plus a duplicate inside a media query.
 *
 * WHY <html> AND NOT <body>. The anti-flash script in index.html runs inside
 * <head>, before <body> exists. Putting the attribute on the element that is
 * already there is what lets the first paint be the right colour.
 *
 * WHY localStorage AND NOT THE USER RECORD. The theme has to be known before
 * the first pixel. A value on the server is one fetch away, and one fetch is
 * long enough to paint a white screen and then swap it. Storing it locally is
 * what removes the flash. The cost is that the preference is per browser, and
 * the 'system' default is what absorbs that: a new device already matching the
 * OS is right often enough that most people never touch the control.
 */

export const STORAGE_KEY = 'alliteration.theme';

/** The three things a person can choose, in the order the toggle cycles. */
export const PREFERENCES = ['system', 'light', 'dark'];

/** The two things that can actually end up on the page. */
export const THEMES = ['light', 'dark'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set();
let mediaQuery = null;

/* ------------------------------------------------------------------ *
 * READING AND WRITING THE PREFERENCE
 * ------------------------------------------------------------------ */

/**
 * The stored preference, or 'system' when nothing is stored or the stored
 * value is not one we recognise.
 *
 * Storage can throw outright, not just come back empty: Safari in private
 * browsing used to, and a browser with site data blocked still does. A theme
 * is a nicety, so every path here falls back to 'system' rather than letting
 * a storage failure take the shell down with it.
 */
export function getPreference(store) {
  const s = store || safeStorage();
  if (!s) return 'system';
  let raw = null;
  try { raw = s.getItem(STORAGE_KEY); } catch (e) { return 'system'; }
  return PREFERENCES.includes(raw) ? raw : 'system';
}

/**
 * Store a preference. 'system' is stored explicitly rather than by removing
 * the key, so that choosing it is a decision that survives, and so a future
 * default other than 'system' would not silently reinterpret everyone who
 * had chosen it.
 */
export function setPreference(pref, store) {
  const next = PREFERENCES.includes(pref) ? pref : 'system';
  const s = store || safeStorage();
  if (s) { try { s.setItem(STORAGE_KEY, next); } catch (e) { /* nicety, not critical */ } }
  return next;
}

/** system -> light -> dark -> system. What the header button steps through. */
export function nextPreference(pref) {
  const i = PREFERENCES.indexOf(pref);
  return PREFERENCES[(i + 1) % PREFERENCES.length];
}

/* ------------------------------------------------------------------ *
 * RESOLVING
 * ------------------------------------------------------------------ */

/**
 * Turn a preference into a theme.
 *
 * `systemIsDark` is passed in rather than read here so this stays a pure
 * function the tests can call without a browser. Production passes the real
 * media query result.
 */
export function resolveTheme(pref, systemIsDark) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return systemIsDark ? 'dark' : 'light';
}

/** What the operating system is asking for right now. */
export function systemPrefersDark(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.matchMedia !== 'function') return false;
  try { return w.matchMedia(DARK_QUERY).matches; } catch (e) { return false; }
}

/* ------------------------------------------------------------------ *
 * APPLYING
 * ------------------------------------------------------------------ */

/**
 * Put the resolved theme on <html> and tell the browser about it.
 *
 * `color-scheme` is the half people forget. Without it the page goes dark but
 * scrollbars, date pickers, select dropdowns and autofilled inputs stay light,
 * and those are drawn by the browser where no stylesheet of ours can reach.
 */
export function applyTheme(theme, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const resolved = THEMES.includes(theme) ? theme : 'light';
  if (d && d.documentElement) {
    d.documentElement.setAttribute('data-theme', resolved);
    d.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

/** The current preference resolved and painted. Returns the resolved theme. */
export function refresh() {
  return applyTheme(resolveTheme(getPreference(), systemPrefersDark()));
}

/* ------------------------------------------------------------------ *
 * WIRING
 * ------------------------------------------------------------------ */

/**
 * Paint the current theme and keep following the system while the preference
 * is 'system'. Safe to call more than once.
 */
export function initTheme() {
  const theme = refresh();

  if (!mediaQuery && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      mediaQuery = window.matchMedia(DARK_QUERY);
      const onSystemChange = () => {
        // Only an unopinionated preference should move. Someone who explicitly
        // chose light does not want the sunset flipping them.
        if (getPreference() !== 'system') return;
        announce(refresh());
      };
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onSystemChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(onSystemChange);   // older Safari
      }
    } catch (e) { /* no live following, the initial paint still worked */ }
  }

  return theme;
}

/** Choose a preference, store it, paint it, and tell anyone listening. */
export function choose(pref) {
  setPreference(pref);
  const theme = refresh();
  announce(theme);
  return theme;
}

/** Step to the next preference. What the header button calls. */
export function cycle() {
  const pref = nextPreference(getPreference());
  choose(pref);
  return pref;
}

/** Notified whenever the painted theme changes. Used to relabel the button. */
export function onChange(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(theme) {
  listeners.forEach((fn) => {
    try { fn(theme, getPreference()); } catch (e) { /* one bad listener is not everyone's problem */ }
  });
}

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (e) {
    return null;   // storage disabled entirely
  }
}

/* ------------------------------------------------------------------ *
 * LABELS
 * ------------------------------------------------------------------ */

/**
 * What the header button should say. The button reports the CHOICE, not the
 * current colour, because a button reading "Dark" when the screen is already
 * dark is the standard confusion. On 'system' it says so and names what the
 * system picked, so nobody wonders why it went dark on its own.
 */
export function preferenceLabel(pref, resolved) {
  if (pref === 'light') return 'Light';
  if (pref === 'dark') return 'Dark';
  return 'System (' + (resolved === 'dark' ? 'dark' : 'light') + ')';
}
