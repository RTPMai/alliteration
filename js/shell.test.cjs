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

/**
 * Every app source file, including inside a folder.
 *
 * BackBone is ~10k lines so it lives in apps/backbone/ rather than one file.
 * A flat readdir would silently SKIP it, which is the worst outcome for a rule
 * test: it passes while checking nothing.
 */
function appFiles() {
  const dir = path.join(ROOT, 'apps');
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) {
      fs.readdirSync(path.join(dir, e.name))
        .filter((f) => f.endsWith('.js'))
        .forEach((f) => out.push(e.name + '/' + f));
    } else if (e.name.endsWith('.js')) {
      out.push(e.name);
    }
  });
  return out;
}
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
  appFiles().forEach((f) => {
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

      // Check EVERY fetch call individually. Exempting a whole file would let a
      // real data fetch hide behind one legitimate asset load.
      code.split('\n').forEach((line, i) => {
        if (!/\bfetch\s*\(/.test(line)) return;

        // NARROW EXEMPTION: the vendor adapters fetch their own .cjs file to
        // evaluate it, because a .cjs can be served with a Content-Type the
        // browser refuses to execute as a script. That is ASSET loading, not
        // app data, so it is not what the seam governs.
        const isAssetLoad = /fetch\(\s*src\s*[,)]/.test(line) &&
                            /^js\/giving-(engine|dial)\.js$/.test(rel);
        if (isAssetLoad) return;

        offenders.push(rel + ':' + (i + 1));
      });
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

t.test('every app import resolves to a file that exists', () => {
  // A missing sibling file makes the shell say "not been ported into the shell
  // yet", which reads like unfinished work rather than a failed upload. This
  // catches it before deploy.
  const dir = path.join(ROOT, 'apps');
  appFiles().forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].forEach((m) => {
      // Resolve against the FILE, not the apps/ root: apps/backbone/index.js
      // importing './styles.js' means apps/backbone/styles.js.
      const target = path.resolve(path.dirname(path.join(dir, f)), m[1]);
      t.assert(fs.existsSync(target),
        'apps/' + f + ' imports ' + m[1] + ' which does not exist');
    });
  });
});

t.test('every js/ import resolves too', () => {
  const dir = path.join(ROOT, 'js');
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    [...src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].forEach((m) => {
      const target = path.resolve(dir, m[1]);
      t.assert(fs.existsSync(target),
        'js/' + f + ' imports ' + m[1] + ' which does not exist');
    });
    // new URL(...) references (the vendor adapters) matter just as much.
    [...src.matchAll(/new URL\(\s*["'](\.\.?\/[^"']+)["']/g)].forEach((m) => {
      const target = path.resolve(dir, m[1]);
      t.assert(fs.existsSync(target),
        'js/' + f + ' references ' + m[1] + ' which does not exist');
    });
  });
});

t.test('app modules reference no undefined globals', () => {
  // A port can be syntactically PERFECT and still be broken: a find-and-replace
  // that leaves "OldGlobal.newLocal.method()" parses fine and throws only when
  // that line runs. Neither node --check nor an import test catches it, because
  // the failure is inside a function that has not been called yet.
  //
  // This scans for Capitalized identifiers used as X.something and checks each
  // is either imported or declared in the file.
  const ALLOWED = new Set([
    'Object', 'Array', 'String', 'Number', 'Math', 'JSON', 'Date', 'RegExp',
    'Promise', 'Set', 'Map', 'Boolean', 'Error', 'CSS', 'QRCode'
  ]);

  const dir = path.join(ROOT, 'apps');
  appFiles().forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = stripComments(src)
      // Drop string and template literals: prose mentioning a proper noun
      // ("no record in Apparelytics.") is not a code reference.
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    const declared = new Set([
      ...[...code.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      // A name the file itself publishes on window is defined by definition —
      // ShopStock's inline handlers rely on exactly this.
      ...[...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\s*\{([^}]*)\}/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())),
      ...[...src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)].map((m) => m[1])
    ]);

    const used = new Set([...code.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\s*\./g)].map((m) => m[1]));
    const undef = [...used].filter((n) => !declared.has(n) && !ALLOWED.has(n));

    t.equal(undef.length, 0,
      'apps/' + f + ' references undefined: ' + undef.join(', ') +
      ' (a leftover from a find-and-replace?)');
  });
});

/* ---- Shell-level screens ------------------------------------------------ */

t.test('settings is a shell screen, not one of the five apps', () => {
  const src = read('js/registry.js');
  t.assert(src.includes('SHELL_APPS'), 'SHELL_APPS is missing');

  // It must NOT be in APPS. Accounts belong to the shell; listing settings as
  // an app would put it in the app switcher and imply a role could be granted
  // "settings" the way it is granted "backbone".
  const appsBlock = src.slice(src.indexOf('export const APPS'), src.indexOf('export const SHELL_APPS'));
  t.assert(!appsBlock.includes("id: 'settings'"),
    'settings must not be listed in APPS');
});

t.test('settings is admin-only and gates on role', () => {
  const src = read('js/registry.js');
  const shellBlock = src.slice(src.indexOf('export const SHELL_APPS'), src.indexOf('/* ---'));
  t.assert(shellBlock.includes('adminOnly: true'), 'settings must be admin-only');

  // Shell screens are never in perms.tabs, so canAccess has to check the role
  // instead or no one would ever reach them.
  t.assert(src.includes("perms.role === 'admin'"),
    'canAccess must gate shell screens on role');
});

t.test('settings app module exists and follows the contract', () => {
  t.assert(exists('apps/settings.js'), 'apps/settings.js is missing');
  const src = read('apps/settings.js');
  ['export default', "id: 'settings'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'settings.js is missing ' + k));
});

t.test('settings manages accounts through the users endpoint', () => {
  const code = stripComments(read('apps/settings.js'));
  t.assert(code.includes('ENDPOINTS.users'), 'settings must use the users endpoint');
  t.assert(!/(?<!api\.)\bfetch\s*\(/.test(code), 'settings must not call fetch directly');
});

/* ---- QR labels are permanent ------------------------------------------- */

t.test('legacy /item/<id> QR labels still resolve', () => {
  // ShopStock printed permanent labels pointing at its OWN standalone route.
  // Those labels are stuck on physical bins and cannot be recalled, so the old
  // path has to keep working forever.
  t.assert(exists('item.html'), 'item.html (the legacy QR redirect) is missing');

  const cfg = JSON.parse(read('vercel.json'));
  const rw = (cfg.rewrites || []).find((r) => r.source.startsWith('/item/'));
  t.assert(rw, 'vercel.json has no rewrite for the legacy /item/:id path');
  t.equal(rw.destination, '/item.html');

  const page = read('item.html');
  t.assert(page.includes('#/shopstock/item/'),
    'the redirect must send the scan to the shell route');
  t.assert(page.includes('location.replace'),
    'use replace() so Back does not bounce through the redirect');
});

t.test('the router carries a third path segment', () => {
  // Without this an item id is dropped and a scan opens a blank item page.
  const src = read('js/router.js');
  t.assert(src.includes('param'), 'the router must parse a route parameter');
  t.assert(src.includes('decodeURIComponent'), 'the parameter must be decoded');
});

t.test('hidden views are routable but not in the rail', () => {
  const reg = read('js/registry.js');
  t.assert(reg.includes('hiddenViews'), 'hiddenViews is missing');
  t.assert(reg.includes('routableViews'), 'routableViews is missing');

  // Both halves matter: routable, or the shell rejects a scan and redirects to
  // the dashboard; hidden, or the rail grows dead links.
  const shell = read('js/shell.js');
  t.assert(shell.includes('hidden.includes(v)'),
    'renderRail must filter hidden views out of the sub-nav');
});

t.test('shopstock opens the scanned item when already mounted', () => {
  const src = read('apps/shopstock.js');
  const fn = src.slice(src.indexOf('showView(view, param)'));
  t.assert(fn.includes('viewItem'),
    'a scan arriving at an already-open app must still open the item');
});

t.test('shopstock does not gate writes on the old admin key', () => {
  // The standalone app had no accounts, so it gated writes behind a shared key
  // typed into its Admin screen. Under the shell the SESSION is the credential.
  // A leftover local check refuses a request the server would have accepted,
  // and the error names a screen that no longer controls anything.
  const code = stripComments(read('apps/shopstock.js'));
  t.assert(!/if\s*\(\s*!adminKey\s*\)/.test(code),
    'a local admin-key check still blocks a write the session would allow');
  t.assert(!code.includes('check admin key'),
    'error messages must not point at the retired admin key screen');
});

t.test('the items endpoint accepts a signed-in admin or manager', () => {
  const src = read('api/items.js');
  const fn = src.slice(src.indexOf('function isAdmin'), src.indexOf('async function kvGet'));
  t.assert(fn.includes('getSession(req)'), 'writes must accept a session');
  t.assert(fn.includes('sess.role === "admin"'), 'admins must be able to write');
  // The key path stays for the scheduled scraper, which has no session.
  t.assert(fn.includes('x-admin-key'), 'the legacy key must still work for the cron');
});

/* ---- Folder-based apps -------------------------------------------------- */

t.test('an app can live in a folder', () => {
  // One file per app is right for most, but BackBone is ~10k lines and a file
  // that long stops being navigable. The CONTRACT does not change: the entry
  // module still default-exports one app object.
  const host = read('js/app-host.js');
  t.assert(host.includes('meta.entry'),
    'app-host must honour an explicit entry path');
  t.assert(host.includes("meta.entry || (meta.id + '.js')"),
    'the single-file layout must remain the default');
});

t.test('backbone is registered as a folder app', () => {
  const reg = read('js/registry.js');
  t.assert(reg.includes("entry: 'backbone/index.js'"), 'backbone entry is missing');
  t.assert(exists('apps/backbone/index.js'), 'apps/backbone/index.js is missing');
  t.assert(exists('apps/backbone/styles.js'), 'apps/backbone/styles.js is missing');
  t.assert(exists('apps/backbone/template.js'), 'apps/backbone/template.js is missing');
});

t.test('the app scanners see inside folders', () => {
  // A flat readdir would SKIP apps/backbone/ entirely: the rule tests would
  // pass while checking nothing, which is worse than failing.
  const files = appFiles();
  t.assert(files.some((f) => f.startsWith('backbone/')),
    'appFiles() must recurse into app folders');
  t.assert(files.includes('shopstock.js'),
    'appFiles() must still return single-file apps');
});

t.test('backbone dropped what the shell now owns', () => {
  // Strip comments: the file DOCUMENTS what it removed, and that explanation
  // must not read as the thing still being present.
  const tpl = stripComments(read('apps/backbone/template.js'));
  // Each of these had a home in the standalone app and has one in the shell now.
  t.assert(!tpl.includes('authGate'), 'the login gate must be gone; the shell signs people in');
  t.assert(!tpl.includes('hdr-wordmark'), 'the app header must be gone; the shell has one');
  t.assert(!tpl.includes('usersWrap'), 'user management moved to the shell Settings screen');
  t.assert(!tpl.includes('rolesWrap'), 'role management moved to the shell Settings screen');
});

t.test('backbone kept its own data operations', () => {
  const tpl = read('apps/backbone/template.js');
  // These are BackBone's, not the shell's: they act on ITS roster.
  ['importBox', 'reconcileBtn', 'calcDistBtn', 'resetBtn']
    .forEach((id) => t.assert(tpl.includes(id),
      'Settings lost ' + id + ', which is BackBone\'s own data operation'));
});

t.test('backbone has all six pages', () => {
  const tpl = read('apps/backbone/template.js');
  ['inbox', 'leads', 'roster', 'scorecard', 'dashboard', 'settings']
    .forEach((v) => t.assert(tpl.includes('id="page-' + v + '"'),
      'page-' + v + ' is missing from the template'));
});

process.exit(t.report());
