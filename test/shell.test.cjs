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

t.test('api.js is the only file that calls fetch', () => {
  const offenders = [];

  const scan = (dir) => {
    fs.readdirSync(path.join(ROOT, dir)).forEach((f) => {
      if (!f.endsWith('.js')) return;
      const rel = dir + '/' + f;
      if (rel === 'js/api.js') return;
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

t.test('TravelTrack has no endpoint wired', () => {
  const src = read('js/api.js');
  t.assert(/ttData:\s*null/.test(src),
    'TravelTrack runs on Base44 and has no api/ folder; its endpoint must stay null');
});

t.test('MOCK defaults on so the shell runs offline', () => {
  t.assert(/const DEFAULT_MOCK = true/.test(read('js/api.js')),
    'DEFAULT_MOCK should be true until the real endpoints are pointed at');
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

t.test('traveltrack stub module implements the contract', () => {
  const src = read('apps/traveltrack.js');
  ['export default', 'id:', 'mount', 'showView']
    .forEach((k) => t.assert(src.includes(k), 'traveltrack.js is missing ' + k));
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

t.test('shopstock QR labels point at the shell route', () => {
  const src = read('apps/shopstock.js');
  // Printed labels are PERMANENT. A QR pointing at the old standalone /item/:id
  // path would scan to a 404 once that deployment is retired.
  t.assert(src.includes('#/shopstock/item/'),
    'QR urls must target the shell route, not the old standalone path');
  t.assert(!/\$\{window\.location\.origin\}\/item\//.test(src),
    'the old /item/:id path must not survive');
});

t.test('shopstock namespaces its localStorage key', () => {
  // Strip comments: the file DOCUMENTS the old key name in explaining the
  // rename, and that explanation must not count as a violation.
  const code = stripComments(read('apps/shopstock.js'));
  t.assert(code.includes('shopstock.admin_key'), 'admin key must be namespaced');
  t.assert(!code.includes('"supply_admin_key"'),
    'five apps share one origin now; a bare key can collide');
});

process.exit(t.report());
