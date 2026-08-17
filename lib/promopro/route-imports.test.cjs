/**
 * Every route under api/ must actually LOAD.
 *
 * WHY THIS FILE EXISTS
 * Aug 2026: a refactor of lib/promopro/printavo-lookup.js deleted the
 * searchInvoices function while removing some dead query constants around it.
 * api/promopro/printavo.js still imported that name, so the module threw on
 * load and every Printavo search returned a 500. The whole suite stayed green
 * through all of it, because every test that touched that route read its
 * SOURCE TEXT rather than importing it. Grepping for a function name proves
 * the letters are present, not that the module works.
 *
 * This test imports each route for real. A missing export, a renamed file, a
 * typo in an import path, a syntax error: all of them fail here in a second
 * instead of in production.
 *
 * It is deliberately generic rather than PromoPro-specific. Nothing in this
 * shell stopped this from happening to any other app either.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/** Declared dependencies. A missing one of these means "npm install has not
 *  been run here", which is an environment fact, not a broken route. */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DECLARED = new Set(Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {})));

function routeFiles(dir, acc) {
  acc = acc || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/** "Cannot find package 'x'" for a package we legitimately declare. */
function isMissingDeclaredDep(message) {
  const m = /Cannot find package '([^']+)'/.exec(String(message || ''));
  if (!m) return false;
  const name = m[1];
  return DECLARED.has(name) || [...DECLARED].some((d) => name === d || name.startsWith(d + '/'));
}

(async () => {
  const files = routeFiles(path.join(ROOT, 'api')).sort();

  // Import EVERYTHING first, collecting outcomes. The assertions below are
  // synchronous, because this harness does not await an async test body: an
  // async assertion prints "ok" and then throws into the void, which would
  // leave the suite green on exactly the failure this file exists to catch.
  // Learned the hard way while writing it.
  const results = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
      const mod = await import('file://' + file);
      results.push({ rel, ok: true, hasHandler: typeof mod.default === 'function' });
    } catch (e) {
      results.push({
        rel,
        ok: false,
        skipped: isMissingDeclaredDep(e.message),
        error: e.message,
      });
    }
  }

  t.test('there are routes to check', () => {
    t.assert(results.length > 5, 'expected several api routes, found ' + results.length);
  });

  results.forEach((r) => {
    t.test(r.rel + ' loads and exports a handler', () => {
      if (r.skipped) return;   // npm install not run here; environment, not code
      t.assert(r.ok, r.rel + ' failed to load: ' + r.error);
      t.assert(r.hasHandler, r.rel + ' has no default export function, so Vercel has no handler to call');
    });
  });

  const skipped = results.filter((r) => r.skipped).length;
  if (skipped) {
    console.log('  note: ' + skipped + ' route(s) skipped, node_modules not installed in this checkout');
  }

  process.exit(t.report());
})();
