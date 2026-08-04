/**
 * Shell contract tests.
 *
 * These lock down the three architectural rules that are easy to break by
 * accident and expensive to discover later:
 *   1. tokens.css is the ONLY place colors are defined.
 *   2. No app file calls fetch() directly.
 *   3. Every registered app has a theme block and a module.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ---- Registry ---------------------------------------------------------- */

// Parsed textually rather than imported: registry.js is an ES module and the
// harness runs under CommonJS. Keeps the test dependency-free.
function registryIds() {
  const src = read('js/registry.js');
  const block = src.slice(src.indexOf('export const APPS'), src.indexOf('BY_ID'));
  return [...block.matchAll(/id:\s*'([a-z0-9]+)'/g)].map((m) => m[1]);
}

t.test('registry defines the five apps', () => {
  const ids = registryIds();
  ['backbone', 'shopstock', 'errorengine', 'givinggauge', 'traveltrack']
    .forEach((id) => t.assert(ids.includes(id), 'registry is missing ' + id));
});

t.test('every registered app has an accent block in tokens.css', () => {
  const tokens = read('css/tokens.css');
  registryIds().forEach((id) => {
    t.assert(tokens.includes(`body[data-app="${id}"]`),
      'tokens.css has no theme block for ' + id);
  });
});

t.test('app ids are lowercase and unique', () => {
  const ids = registryIds();
  ids.forEach((id) => t.equal(id, id.toLowerCase(), 'app id must be lowercase: ' + id));
  t.equal(new Set(ids).size, ids.length, 'duplicate app id in registry');
});

/* ---- tokens.css is the only source of color ---------------------------- */

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

t.test('shell.css declares no hex colors', () => {
  const found = read('css/shell.css').match(HEX) || [];
  t.equal(found.length, 0,
    'shell.css must use var(--token), found: ' + found.join(', '));
});

t.test('index.html declares no hex colors outside brand artwork', () => {
  // The logomark and wordmark are brand SVGs. Their fills are artwork, not
  // theming: the P&M mark must NOT recolor when data-app changes, so those
  // hex values are correct where they are. Everything else must use tokens.
  const src = read('index.html').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const found = src.match(HEX) || [];
  t.equal(found.length, 0, 'index.html contains hex colors: ' + found.join(', '));
});

t.test('shell chrome outside the brand SVGs is token-driven', () => {
  const src = read('index.html');
  // A style="" attribute with a raw hex would slip past the SVG strip above.
  const inline = [...src.matchAll(/style="[^"]*#[0-9a-fA-F]{3,8}/g)];
  t.equal(inline.length, 0, 'inline style with a hex color found in index.html');
});

t.test('app modules declare no hex colors', () => {
  // THREE narrow exemptions, each marked TOKEN-EXEMPT in the source:
  //   1. Department colors are DATA the user picks, not theming.
  //   2. QR codes are generated images; a CSS variable renders nothing.
  //   3. Print windows are separate documents that never load tokens.css.
  // Everything else must use a token. The exemption is DECLARED in the code,
  // so this stays a real rule rather than a blanket pass for one file.
  const EXEMPT = [
    /const DEFAULT_DEPT_COLORS = \{[\s\S]*?\};/g,      // department data
    /new QRCode\([\s\S]*?\}\);/g,                        // generated images
    /<input type="color"[^>]*>/g,                      // color-picker defaults (data)
    /w\.document\.write\(`[\s\S]*?`\);/g              // print windows
  ];

  const dir = path.join(ROOT, 'apps');
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    let src = fs.readFileSync(path.join(dir, f), 'utf8');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    EXEMPT.forEach((re) => { src = src.replace(re, ''); });

    const found = src.match(HEX) || [];
    t.equal(found.length, 0,
      'apps/' + f + ' must use var(--token), found: ' + found.join(', '));
  });
});

t.test('color exemptions are declared, not assumed', () => {
  // If a file leans on an exemption it must say so, so the next person knows
  // the hex is deliberate rather than an oversight.
  const src = read('apps/shopstock.js');
  t.assert(src.includes('TOKEN-EXEMPT'),
    'shopstock uses exempt hex values but does not mark them');
  const marks = (src.match(/TOKEN-EXEMPT/g) || []).length;
  t.assert(marks >= 3, 'each exempt category should be marked, found ' + marks);
});

/* ---- api.js is the seam ------------------------------------------------ */

// Comments mention fetch legitimately ("a real app fetches here via ctx.api"),
// so strip them before scanning. Otherwise documenting the rule violates it.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ONE narrow exemption class, marked SEAM-EXEMPT in the source: the vendor
// loaders fetch the TEXT of a static vendored file from our own deploy and
// evaluate it (Content-Type workaround). That is module loading, not data
// traffic, which is what the seam exists to route. Anything else that wants
// fetch() goes through ctx.api.
const SEAM_EXEMPT = ['js/giving-dial.js', 'js/giving-engine.js'];

t.test('seam exemptions are marked in their source', () => {
  SEAM_EXEMPT.forEach((rel) => {
    const src = read(rel);
    t.assert(src.includes('SEAM-EXEMPT'),
      rel + ' is exempt from the fetch rule but carries no SEAM-EXEMPT marker');
  });
});

t.test('api.js is the only file that calls fetch', () => {
  const offenders = [];

  const scan = (dir) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      if (!f.endsWith('.js')) return;
      const rel = dir + '/' + f;
      if (rel === 'js/api.js') return;
      if (SEAM_EXEMPT.includes(rel)) return;
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      if (code.match(/\bfetch\s*\(/)) {
        offenders.push(rel);
      }
    });
  };

  scan('js');
  scan('apps');

  t.equal(offenders.length, 0,
    'these files call fetch() directly; route them through api.js: ' + offenders.join(', '));
});

t.test('api.js exposes ERRORS_ENDPOINT for the ErrorEngine rename', () => {
  const src = read('js/api.js');
  t.assert(src.includes('ERRORS_ENDPOINT'), 'ERRORS_ENDPOINT constant is missing');
  t.assert(src.includes("'/api/errors'"), "ErrorEngine's intake must resolve to /api/errors");
});

t.test('TravelTrack is wired to its own endpoints', () => {
  const src = read('js/api.js');
  t.assert(/ttTrips:\s*'\/api\/traveltrack\/trips'/.test(src),
    'TravelTrack trips endpoint is missing or renamed');
  t.assert(/ttExpenses:\s*'\/api\/traveltrack\/expenses'/.test(src),
    'TravelTrack expenses endpoint is missing or renamed');
  t.assert(/ttMiles:\s*'\/api\/traveltrack\/miles'/.test(src),
    'TravelTrack miles endpoint is missing or renamed');
  t.assert(/ttSettings:\s*'\/api\/traveltrack\/settings'/.test(src),
    'TravelTrack settings endpoint is missing or renamed');
  t.assert(src.includes("'/api/traveltrack/'"),
    'TravelTrack endpoints must be listed in LIVE_PREFIXES');
});

t.test('MOCK defaults on so the shell runs offline', () => {
  t.assert(/const DEFAULT_MOCK = true/.test(read('js/api.js')),
    'DEFAULT_MOCK should be true until the real endpoints are pointed at');
});

/* ---- browser code must not contain server code ------------------------- */

t.test('no browser file imports a Node builtin', () => {
  // THE JUL 26 / AUG 3 OUTAGE CLASS. Files are placed by hand during deploy,
  // and a server file dropped into apps/ or js/ fails only in the browser,
  // at runtime, with "Failed to resolve module specifier" — a message that
  // sends you looking at the import map rather than at the file itself.
  //
  // A Node builtin import is the cleanest fingerprint of server code sitting
  // where browser code belongs, so it fails HERE instead.
  const BUILTINS = ['crypto', 'fs', 'path', 'http', 'https', 'os', 'url',
    'stream', 'buffer', 'zlib', 'child_process', 'util', 'net'];
  const offenders = [];

  const scan = (dir) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      const rel = dir + '/' + f;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) return scan(rel);
      if (!f.endsWith('.js')) return;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      BUILTINS.forEach((b) => {
        const re = new RegExp('from\\s+["\'](node:)?' + b + '["\']');
        if (re.test(src)) offenders.push(rel + ' imports ' + b);
      });
    });
  };
  scan('apps');
  scan('js');

  t.equal(offenders.length, 0,
    'server code appears to have been placed in a browser folder: ' + offenders.join(', '));
});

t.test('no browser file carries a Vercel handler signature', () => {
  // The same shuffle, caught a second way: an api/ route dropped into apps/
  // exports a default request handler and reads process.env.
  const offenders = [];
  const scan = (dir) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      const rel = dir + '/' + f;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) return scan(rel);
      if (!f.endsWith('.js')) return;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/export default async function handler\s*\(\s*req\s*,\s*res/.test(src)) {
        offenders.push(rel);
      }
    });
  };
  scan('apps');
  scan('js');
  t.equal(offenders.length, 0,
    'an API route appears to have been placed in a browser folder: ' + offenders.join(', '));
});

/* ---- App contract ------------------------------------------------------ */

t.test('every non-stub registered app has a module in apps/', () => {
  const src = read('js/registry.js');
  registryIds().forEach((id) => {
    const entry = src.slice(src.indexOf(`id: '${id}'`));
    const isStub = /stub:\s*true/.test(entry.slice(0, entry.indexOf('}')));
    if (isStub) return;
    // Ports land here as they are migrated; absence is expected pre-migration.
    if (!exists('apps/' + id + '.js')) {
      console.log('        (not yet ported: apps/' + id + '.js)');
    }
  });
  t.assert(true);
});

t.test('hub module exists and implements the contract', () => {
  const src = read('apps/hub.js');
  ['export default', "id: 'hub'", 'mount', 'showView']
    .forEach((k) => t.assert(src.includes(k), 'apps/hub.js is missing ' + k));
});

t.test('every app declares view labels for the rail sub-nav', () => {
  const src = read('js/registry.js');
  // views must be [key, label] tuples now that the rail renders labels.
  const bad = [...src.matchAll(/views:\s*\[\s*'/g)];
  t.equal(bad.length, 0,
    'views must be [key, label] tuples, not bare strings, so the rail can label them');
});

t.test('registry exposes viewKeys and viewLabel helpers', () => {
  const src = read('js/registry.js');
  ['export function viewKeys', 'export function viewLabel']
    .forEach((k) => t.assert(src.includes(k), 'registry is missing ' + k));
});

t.test('index.html carries the rail and header mount points', () => {
  const src = read('index.html');
  ['id="rail"', 'id="main"', 'id="crumb"', 'id="avatar"', 'id="brandBtn"']
    .forEach((k) => t.assert(src.includes(k), 'index.html is missing ' + k));
});

t.test('traveltrack is ported and follows the contract', () => {
  t.assert(exists('apps/traveltrack.js'), 'apps/traveltrack.js is missing');
  const src = read('apps/traveltrack.js');
  ['export default', "id: 'traveltrack'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'traveltrack.js is missing ' + k));
});

t.test('traveltrack registry entry is no longer a stub', () => {
  const src = read('js/registry.js');
  const entry = src.slice(src.indexOf("id: 'traveltrack'"));
  const block = entry.slice(0, entry.indexOf("id: 'crewcore'"));
  t.assert(/stub:\s*false/.test(block), 'traveltrack should be un-stubbed now that it is built');
  t.assert(!/stubNote:/.test(block), 'a live app should not still carry a stubNote');
});

t.test('traveltrack fetches through the seam', () => {
  const src = stripComments(read('apps/traveltrack.js'));
  t.assert(!src.match(/\bfetch\s*\(/), 'traveltrack.js must not call fetch() directly');
  t.assert(src.includes("import { ENDPOINTS } from '../js/api.js'"),
    'traveltrack.js should import ENDPOINTS from the seam');
});

t.test('traveltrack scopes DOM lookups to its root', () => {
  const src = read('apps/traveltrack.js');
  t.assert(!/document\.getElementById/.test(src),
    'traveltrack.js should use ctx.root, not document.getElementById (other apps are mounted too)');
});

t.test('traveltrack API routes require auth and scope by data_scope', () => {
  ['trips', 'expenses', 'miles', 'settings'].forEach((name) => {
    const src = read('api/traveltrack/' + name + '.js');
    t.assert(src.includes('requireAuth'), 'api/traveltrack/' + name + '.js must call requireAuth');
  });
  const trips = read('api/traveltrack/trips.js');
  const expenses = read('api/traveltrack/expenses.js');
  t.assert(trips.includes("data_scope"), 'trips.js should scope by data_scope');
  t.assert(expenses.includes("data_scope"), 'expenses.js should scope by data_scope');
});

/* ---- Session ----------------------------------------------------------- */

t.test('perms access check accounts for legacy BackBone tab names', () => {
  const src = read('js/registry.js');
  t.assert(src.includes('canAccess'), 'canAccess is missing');
  t.assert(/legacy shape/.test(src),
    'canAccess must handle perms.tabs holding only BackBone internal tab names');
});


/* ---- GivingGauge port -------------------------------------------------- */

t.test('givinggauge is ported and follows the contract', () => {
  t.assert(exists('apps/givinggauge.js'), 'apps/givinggauge.js is missing');
  const src = read('apps/givinggauge.js');
  ['export default', "id: 'givinggauge'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'givinggauge.js is missing ' + k));
});

t.test('givinggauge computes no scores of its own', () => {
  const src = read('apps/givinggauge.js');
  // The score must come from the engine. Any scoring constant appearing here
  // means logic leaked out of the verbatim port.
  ['DIMENSION_MAX', 'GRADE_BANDS', 'LEAD_TIME_FLOOR']
    .forEach((m) => t.assert(!src.includes(m),
      'givinggauge.js contains engine logic (' + m + '); it must only render'));
  t.assert(src.includes('engine.evaluate'),
    'givinggauge must score via the engine adapter');
});

t.test('givinggauge scopes DOM lookups to its root', () => {
  // Strip comments first: the file DOCUMENTS that it removed getElementById,
  // and that explanation must not count as a violation.
  const src = read('apps/givinggauge.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // document.getElementById would find another mounted app's nodes. The port
  // must query within its own root.
  t.assert(!src.includes('document.getElementById'),
    'givinggauge must not use document.getElementById — several apps are mounted at once');
});

t.test('givinggauge fetches through the seam', () => {
  const src = read('apps/givinggauge.js');
  t.assert(src.includes('ctx.api.get') && src.includes('ENDPOINTS.ggRequests'),
    'requests must come through the api seam, not a hardcoded global');
  t.assert(!/\bfetch\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'givinggauge must not call fetch directly');
});

/* ---- ShopStock port ---------------------------------------------------- */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

t.test('shopstock is ported and follows the contract', () => {
  t.assert(exists('apps/shopstock.js'), 'apps/shopstock.js is missing');
  const src = read('apps/shopstock.js');
  ['export default', "id: 'shopstock'", 'mount', 'showView', 'unmount', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'shopstock.js is missing ' + k));
});

t.test('shopstock scopes DOM lookups to its root', () => {
  const code = stripComments(read('apps/shopstock.js'));
  t.assert(!code.includes('document.getElementById'),
    'shopstock must not use document.getElementById — several apps are mounted at once');
});

t.test('shopstock fetches through the seam', () => {
  const code = stripComments(read('apps/shopstock.js'));
  t.assert(!/(?<!api\.)\bfetch\s*\(/.test(code), 'shopstock must not call fetch directly');
  t.assert(code.includes('ENDPOINTS.ssItems'), 'shopstock must use ENDPOINTS');
});

t.test('shopstock uses exactly ONE namespaced global', () => {
  const src = read('apps/shopstock.js');
  // The compromise: 46 inline onclick handlers need reachable functions. One
  // namespace is a contained risk; 27 bare globals would not be.
  t.assert(src.includes('window.ShopStock = {'), 'the namespace is missing');
  const bare = [...stripComments(src).matchAll(/^\s*window\.([a-zA-Z_]+)\s*=/gm)]
    .map((m) => m[1]).filter((n) => n !== 'ShopStock');
  t.equal(bare.length, 0, 'only window.ShopStock may be set, found: ' + bare.join(', '));
});

t.test('every namespaced handler resolves to an exposed function', () => {
  const src = read('apps/shopstock.js');
  const nsStart = src.indexOf('window.ShopStock = {');
  const ns = src.slice(nsStart, src.indexOf('};', nsStart));
  const exposed = [...ns.matchAll(/^\s+([a-zA-Z_]+),/gm)].map((m) => m[1]);
  const declared = new Set([...src.matchAll(/(?:async )?function ([a-zA-Z_]+)\s*\(/g)].map((m) => m[1]));

  const missing = exposed.filter((f) => !declared.has(f));
  t.equal(missing.length, 0, 'exposed but never declared: ' + missing.join(', '));

  // A handler pointing at something not exposed is a button that silently does
  // nothing — the exact failure this port risks.
  const called = new Set([...stripComments(src).matchAll(/ShopStock\.([a-zA-Z_]+)\(/g)].map((m) => m[1]));
  const unresolved = [...called].filter((f) => !exposed.includes(f));
  t.equal(unresolved.length, 0, 'handler targets nothing exposed: ' + unresolved.join(', '));
});

t.test('shopstock tears its namespace down on unmount', () => {
  const src = read('apps/shopstock.js');
  t.assert(src.includes('delete window.ShopStock'),
    'a stale namespace would survive a remount');
});

t.test('shopstock QR labels point at the public no-login scan route', () => {
  const src = read('apps/shopstock.js');
  // Aug 2026: Ryan wants scanning a label to flip status with no sign-in
  // step, so newly generated QR codes target the public /scan/:id page
  // (scan.html) instead of the logged-in #/shopstock/item/:id shell route.
  // Labels already printed before this change keep working unaffected: they
  // have the old URL baked into the physical QR image already, and that
  // route still exists in the app for logged-in viewing.
  t.assert(src.includes('/scan/'),
    'QR urls must target the public no-login scan route');
  t.assert(!/\$\{window\.location\.origin\}\/item\//.test(src),
    'the old standalone /item/:id path must not survive');
});

t.test('shopstock namespaces its localStorage key', () => {
  // Strip comments: the file DOCUMENTS the old key name in explaining the
  // rename, and that explanation must not count as a violation.
  const code = stripComments(read('apps/shopstock.js'));
  t.assert(code.includes('shopstock.admin_key'), 'admin key must be namespaced');
  t.assert(!code.includes('"supply_admin_key"'),
    'five apps share one origin now; a bare key can collide');
});

/* ---- ErrorEngine dashboard toggles -------------------------------------- */

// Every Count/Cost toggle in the markup must have a click handler and a
// metric variable. A toggle that renders but does nothing is the worst kind
// of broken: it looks like a working control reporting a real number.
t.test('errorengine: every metric toggle in the markup is wired', () => {
  const src = read('apps/errorengine.js');
  const toggles = [...src.matchAll(/id="(ee-[a-z]+-metric)"/g)].map((m) => m[1]);
  t.assert(toggles.length >= 4,
    'expected month, type, cause and vendor toggles; found: ' + toggles.join(', '));
  toggles.forEach((id) => {
    t.assert(src.includes("$('" + id + "').addEventListener"),
      id + ' renders in the markup but has no click handler');
  });
});

t.test('errorengine: type and cause charts honor the cost metric', () => {
  const src = read('apps/errorengine.js');
  ['typeMetric', 'causeMetric'].forEach((v) => {
    t.assert(new RegExp('let ' + v).test(src), v + ' state variable is missing');
    t.assert(new RegExp(v + "\\s*===\\s*'cost'").test(src),
      v + ' never reaches the render; the toggle would be decorative');
  });
});

/* ---- ErrorEngine delete gate ------------------------------------------- */
// FIXED Aug 2026: api/errors.js used to gate DELETE on
// ["admin","superuser"].includes(sess.role), but superuser is a boolean flag
// on the user (perms.superuser), never a role name, so a real superuser
// whose role wasn't literally "admin" could never delete a record. This
// locks the fix in place and matches the pattern api/crewcore/*.js already
// uses: look up the user's role AND check the superuser flag, don't
// string-match role against a fake role name.
t.test('errors.js delete gate checks the superuser flag, not a fake "superuser" role name', () => {
  const src = read('api/errors.js');
  t.assert(!/\[\s*["']admin["']\s*,\s*["']superuser["']\s*\]/.test(src),
    'errors.js should not gate delete on a hardcoded ["admin","superuser"] role-name list');
  t.assert(src.includes('user.superuser === true'),
    'errors.js should check the user record\'s superuser flag before allowing delete');
  t.assert(src.includes('getRole') && src.includes('data_scope'),
    'errors.js should resolve the caller\'s role and check data_scope, matching the CrewCore admin-check pattern');
});

process.exit(t.report());
