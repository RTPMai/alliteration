/**
 * Dark mode.
 *
 * Two halves, and they are different kinds of test on purpose.
 *
 * The logic half IMPORTS js/theme.js and calls it, with a fake storage object
 * and a fake document, so "does 'system' resolve to dark when the OS says
 * dark" is answered by running the code rather than by grepping for the word
 * 'system'. Same reason as test/route-imports.test.cjs.
 *
 * The palette half PARSES css/tokens.css and does contrast arithmetic on the
 * values it finds. That one is text-reading, legitimately: the thing under
 * test IS the data in the file, and a colour cannot be called as a function.
 * What it protects against is the failure mode that makes dark themes bad,
 * which is never a crash. It is a value that was fine on white being carried
 * over onto near-black, where it turns into grey-on-grey. Nobody notices
 * until they are squinting at the one screen nobody demoed.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------ *
 * CONTRAST MATHS (WCAG 2.1 relative luminance)
 * ------------------------------------------------------------------ */

function luminance(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ---- reading the token file ---------------------------------------- */

const tokens = read('css/tokens.css');

function blockVars(startMarker) {
  const i = tokens.indexOf(startMarker);
  if (i === -1) return {};
  const open = tokens.indexOf('{', i);
  const close = tokens.indexOf('}', open);
  const out = {};
  const body = tokens.slice(open, close);
  // Two forms: a literal, and a reference to another token. The hub and the
  // notifications screen deliberately use the reference form so they cannot
  // drift from the shared value they are meant to match, which means a parser
  // that only reads hex silently falls through to the LIGHT value and reports
  // a contrast failure that does not exist.
  const re = /(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6}|var\(\s*(--[a-z0-9-]+)\s*\))/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[3] ? { ref: m[3] } : m[2].toUpperCase();
  return out;
}

/** Follow var() chains until a literal falls out. */
function resolve(vars, key, scope) {
  let v = vars[key];
  for (let hops = 0; v && v.ref && hops < 6; hops += 1) {
    v = vars[v.ref] || (scope && scope[v.ref]);
  }
  return typeof v === 'string' ? v : null;
}

const DARK_RAW = blockVars('html[data-theme="dark"] {');
const DARK = {};
Object.keys(DARK_RAW).forEach((k) => {
  const v = resolve(DARK_RAW, k);
  if (v) DARK[k] = v;
});
const DARK_CARD = DARK['--card'];

function flatten(raw, scope) {
  const out = {};
  Object.keys(raw).forEach((k) => {
    const v = resolve(raw, k, scope);
    if (v) out[k] = v;
  });
  return out;
}
function darkApp(id) {
  return flatten(blockVars('html[data-theme="dark"] body[data-app="' + id + '"] {'), DARK);
}
function lightApp(id) {
  return flatten(blockVars('\nbody[data-app="' + id + '"] {'), blockVars(':root {'));
}

/* ==================================================================== *
 * PALETTE
 * ==================================================================== */

t.test('the dark theme defines its own surfaces rather than inheriting white', () => {
  ['--bg', '--card', '--ink', '--muted', '--line'].forEach((k) => {
    t.assert(DARK[k], 'dark theme does not define ' + k);
  });
  t.assert(luminance(DARK['--bg']) < 0.1, '--bg is not dark');
  t.assert(luminance(DARK['--ink']) > 0.6, '--ink is not light');
});

t.test('a card sits ABOVE the page, so it is lighter, not darker', () => {
  // The light theme separates a card from the page with a shadow. On a dark
  // page a shadow is invisible, so elevation has to be carried by lightness.
  // Getting this backwards is what makes a dark theme look like a hole.
  t.assert(luminance(DARK['--card']) > luminance(DARK['--bg']),
    '--card (' + DARK['--card'] + ') must be lighter than --bg (' + DARK['--bg'] + ')');
});

t.test('body text clears 4.5:1 on the dark card', () => {
  const r = contrast(DARK['--ink'], DARK_CARD);
  t.assert(r >= 4.5, '--ink on --card is only ' + r.toFixed(2) + ':1');
});

t.test('secondary text clears 4.5:1, which is where dark themes usually fail', () => {
  const r = contrast(DARK['--muted'], DARK_CARD);
  t.assert(r >= 4.5, '--muted on --card is only ' + r.toFixed(2) + ':1');
});

t.test('every status colour is readable on the dark card', () => {
  ['--success', '--warn', '--danger', '--amber'].forEach((k) => {
    const r = contrast(DARK[k], DARK_CARD);
    t.assert(r >= 4.5, k + ' on --card is only ' + r.toFixed(2) + ':1');
  });
});

t.test('tints are backgrounds, so in dark they must be dark', () => {
  // Carrying the pale light-mode tints over is the single most common dark
  // mode bug: a "subtle" success pill becomes a glowing white slab.
  Object.keys(DARK).filter((k) => k.endsWith('-tint')).forEach((k) => {
    t.assert(luminance(DARK[k]) < 0.15,
      k + ' (' + DARK[k] + ') is too light to be a background here');
  });
});

t.test('emphasis text is readable on its own tint', () => {
  [['--success-dk', '--success-tint'],
   ['--warn-dk', '--warn-tint'],
   ['--danger-dk', '--danger-tint']].forEach(([fg, bg]) => {
    const r = contrast(DARK[fg], DARK[bg]);
    t.assert(r >= 4.5, fg + ' on ' + bg + ' is only ' + r.toFixed(2) + ':1');
  });
});

t.test('the -dk tokens get LIGHTER in dark mode, not darker', () => {
  // They mean "the emphatic version". Emphasis moves away from the
  // background, which is down on white and up on near-black.
  const light = flatten(blockVars(':root {'), {});
  ['--success', '--warn', '--danger'].forEach((base) => {
    const dkIsDarker = luminance(light[base + '-dk']) < luminance(light[base]);
    const dkIsLighter = luminance(DARK[base + '-dk']) > luminance(DARK[base]);
    t.assert(dkIsDarker && dkIsLighter,
      base + '-dk should invert direction between themes');
  });
});

t.test('chart colours stay tellable apart as a swatch on the dark card', () => {
  for (let i = 1; i <= 9; i += 1) {
    const k = '--chart-' + i;
    const r = contrast(DARK[k], DARK_CARD);
    t.assert(r >= 3, k + ' on --card is only ' + r.toFixed(2) + ':1');
  }
});

t.test('the dark chart palette keeps the light one\'s hue order', () => {
  // A series that was blue must still be blue after a theme switch. If the
  // order drifted, the same data would change colour and every screenshot in
  // circulation would disagree with the screen.
  const light = flatten(blockVars(':root {'), {});
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === mn) return -1;
    let h;
    if (mx === r) h = ((g - b) / (mx - mn)) % 6;
    else if (mx === g) h = (b - r) / (mx - mn) + 2;
    else h = (r - g) / (mx - mn) + 4;
    return ((h * 60) + 360) % 360;
  };
  for (let i = 1; i <= 9; i += 1) {
    const k = '--chart-' + i;
    const a = hue(light[k]);
    const b = hue(DARK[k]);
    if (a === -1 || b === -1) continue;       // the grey one has no hue
    const gap = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    t.assert(gap <= 40, k + ' changed hue by ' + gap.toFixed(0) + ' degrees between themes');
  }
});

/* ---- per-app accents ------------------------------------------------ */

const REGISTERED = [...tokens.matchAll(/\nbody\[data-app="([a-z]+)"\]/g)]
  .map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i);

t.test('every app has a dark accent block or an accent that already works', () => {
  t.assert(REGISTERED.length >= 12, 'expected the full app list, found ' + REGISTERED.length);
  REGISTERED.forEach((id) => {
    const d = darkApp(id);
    const l = lightApp(id);
    const accent = d['--accent'] || l['--accent'];
    t.assert(accent, id + ' resolves to no accent in dark mode');
  });
});

t.test('no app accent disappears into the dark background', () => {
  // This is the check that TeleTally's near-black navy and MarketMachine's
  // dark maroon fail without a dark-mode value of their own. A rail dot you
  // cannot see is an app you cannot find.
  REGISTERED.forEach((id) => {
    const d = darkApp(id);
    const l = lightApp(id);
    const accent = d['--accent'] || l['--accent'];
    const r = contrast(accent, DARK_CARD);
    t.assert(r >= 3, id + ' accent ' + accent + ' is only ' + r.toFixed(2) + ':1 on the dark card');
  });
});

t.test('button labels stay readable on every app accent', () => {
  // --on-accent is white. An accent that has been lightened for the dark
  // background pushes white text the other way, so both ends need checking
  // rather than only the one being fixed.
  const onAccent = DARK['--on-accent'] || '#FFFFFF';
  REGISTERED.forEach((id) => {
    const d = darkApp(id);
    const l = lightApp(id);
    const accent = d['--accent'] || l['--accent'];
    if (!accent) return;
    const r = contrast(onAccent, accent);
    t.assert(r >= 2.3, id + ': label on accent ' + accent + ' is only ' + r.toFixed(2) + ':1');
  });
});

t.test('accent hover goes lighter in dark mode', () => {
  REGISTERED.forEach((id) => {
    const d = darkApp(id);
    if (!d['--accent'] || !d['--accent-deep']) return;
    t.assert(luminance(d['--accent-deep']) > luminance(d['--accent']),
      id + ': --accent-deep must be lighter than --accent in dark mode');
  });
});

t.test('an app added later cannot silently skip its dark tint', () => {
  // Every dark app block that overrides the accent must also say what the
  // tinted panel behind it looks like, or that panel stays pale.
  REGISTERED.forEach((id) => {
    const d = darkApp(id);
    if (!d['--accent']) return;
    t.assert(d['--accent-tint'],
      id + ' has a dark accent but no dark --accent-tint');
  });
});

/* ==================================================================== *
 * THE SWITCH ITSELF
 * ==================================================================== */

t.test('shell.css still declares no hex colours', () => {
  const found = read('css/shell.css').match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  t.equal(found.length, 0, 'shell.css must use tokens, found: ' + found.join(', '));
});

t.test('the theme is set before any stylesheet loads', () => {
  // If the attribute is set by a module instead, every load paints white and
  // then flips. The ordering IS the feature.
  const html = read('index.html');
  const script = html.indexOf('data-theme');
  const css = html.indexOf('css/tokens.css');
  t.assert(script > -1 && css > -1 && script < css,
    'the theme script must come before tokens.css in index.html');
});

t.test('the sign-in page touches no browser storage', () => {
  // Reinforces test/auth-live.test.cjs from this side. Sign-in follows the
  // system only, and gave up honouring an explicit override to keep that
  // guarantee, because it is the one page that handles a password.
  const login = read('login.html');
  t.assert(!/localStorage|sessionStorage/.test(login),
    'login.html must not reference browser storage');
  t.assert(/prefers-color-scheme/.test(login),
    'login.html should still follow the system theme');
});

t.test('the inline script and js/theme.js agree on the storage key', () => {
  // The inline copy exists because a module cannot block the first paint.
  // Two copies of one fact drift, so this is the thing holding them together.
  const html = read('index.html');
  const mod = read('js/theme.js');
  const keyInModule = /STORAGE_KEY\s*=\s*'([^']+)'/.exec(mod);
  t.assert(keyInModule, 'js/theme.js does not export a STORAGE_KEY');
  t.assert(html.includes("'" + keyInModule[1] + "'"),
    'index.html reads a different storage key than js/theme.js writes');
});

t.test('the header control is in the markup with both icons', () => {
  const html = read('index.html');
  t.assert(/id="themeBtn"/.test(html), 'no theme button in the header');
  t.assert(/icon-sun/.test(html) && /icon-moon/.test(html),
    'the button should carry both icons so switching does not re-render it');
});

t.test('the wordmark takes its colour from a token, not a baked-in hex', () => {
  // Solid near-black letterforms on a near-black header are not low
  // contrast, they are absent. The round logomark is deliberately left
  // alone: it is a disc with white glyphs and reads on its own terms.
  const html = read('index.html');
  const wm = /<span class="wordmark-svg">[\s\S]*?<\/span>/.exec(html);
  t.assert(wm, 'wordmark span not found');
  t.assert(!/fill="#231F20"/.test(wm[0]),
    'the wordmark still bakes in the brand near-black');
  t.assert(/currentColor/.test(wm[0]), 'the wordmark should use currentColor');
  t.assert(/\.wordmark-svg\s*\{[^}]*var\(--wordmark-ink\)/.test(read('css/shell.css')),
    'shell.css should point the wordmark at --wordmark-ink');
});

/* ==================================================================== *
 * LOGIC — real calls into js/theme.js
 * ==================================================================== */

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map
  };
}

function fakeDoc() {
  const attrs = {};
  return {
    documentElement: {
      style: {},
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k]
    },
    _attrs: attrs
  };
}

import(path.join(ROOT, 'js/theme.js')).then((theme) => {
  t.test('an unset preference is system, not a guess at light', () => {
    t.equal(theme.getPreference(fakeStorage({})), 'system', 'default preference');
  });

  t.test('a corrupted stored value falls back to system instead of throwing', () => {
    const s = fakeStorage({ 'alliteration.theme': 'chartreuse' });
    t.equal(theme.getPreference(s), 'system', 'unknown value should not be trusted');
  });

  t.test('storage that throws does not take the shell down', () => {
    const hostile = { getItem() { throw new Error('storage disabled'); } };
    t.equal(theme.getPreference(hostile), 'system', 'a nicety must fail soft');
  });

  t.test('system follows the operating system, both ways', () => {
    t.equal(theme.resolveTheme('system', true), 'dark', 'system + OS dark');
    t.equal(theme.resolveTheme('system', false), 'light', 'system + OS light');
  });

  t.test('an explicit choice overrides the operating system', () => {
    // Someone who picked light in a dark room means it.
    t.equal(theme.resolveTheme('light', true), 'light', 'explicit light beats OS dark');
    t.equal(theme.resolveTheme('dark', false), 'dark', 'explicit dark beats OS light');
  });

  t.test('the button cycles system -> light -> dark -> system', () => {
    t.equal(theme.nextPreference('system'), 'light', 'first step');
    t.equal(theme.nextPreference('light'), 'dark', 'second step');
    t.equal(theme.nextPreference('dark'), 'system', 'wraps back round');
  });

  t.test('choosing system is stored, not stored as absence', () => {
    // Removing the key would make "I chose system" and "I never chose"
    // indistinguishable, which matters the day the default changes.
    const s = fakeStorage({ 'alliteration.theme': 'dark' });
    theme.setPreference('system', s);
    t.equal(s.getItem('alliteration.theme'), 'system', 'system should persist');
  });

  t.test('a junk preference is never written to storage', () => {
    const s = fakeStorage({});
    theme.setPreference('neon', s);
    t.equal(s.getItem('alliteration.theme'), 'system', 'unknown input is coerced');
  });

  t.test('applying a theme sets the attribute AND color-scheme', () => {
    // Without color-scheme the page goes dark but scrollbars, selects and
    // autofilled inputs stay light, and no stylesheet of ours can reach those.
    const d = fakeDoc();
    theme.applyTheme('dark', d);
    t.equal(d._attrs['data-theme'], 'dark', 'attribute');
    t.equal(d.documentElement.style.colorScheme, 'dark', 'color-scheme');
  });

  t.test('applying an unknown theme lands on light rather than nothing', () => {
    const d = fakeDoc();
    theme.applyTheme('mauve', d);
    t.equal(d._attrs['data-theme'], 'light', 'unknown theme should fall back');
  });

  t.test('the button label reports the choice and names what the system picked', () => {
    // A button reading "Dark" while the screen is already dark is the
    // standard confusion; it should say what was CHOSEN.
    t.equal(theme.preferenceLabel('dark', 'dark'), 'Dark', 'explicit label');
    t.equal(theme.preferenceLabel('system', 'dark'), 'System (dark)', 'system names the result');
    t.equal(theme.preferenceLabel('system', 'light'), 'System (light)', 'and the other way');
  });

  process.exit(t.report());
}).catch((err) => {
  console.log('  FAIL could not import js/theme.js');
  console.log('       ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
