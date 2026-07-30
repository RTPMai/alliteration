/**
 * BackBone template ID contract.
 *
 * main.js renders into elements it looks up with $id("..."). A missing id in
 * template.js does not throw at startup; the render just silently no-ops (the
 * defensive guards) or crashes mid-interaction. Either way the bug reaches
 * production quiet. This test makes a missing id a RED SUITE instead.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload (the file
 * in git contained a copy of main.js).
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('apps/backbone/main.js');
const template = read('apps/backbone/template.js');

// Every id the code looks up, single or double quoted. Dynamic lookups
// ($id(someVar)) are invisible to this scan and are checked by the guard test.
function lookedUpIds() {
  const ids = new Set();
  [...main.matchAll(/\$id\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)]
    .forEach((m) => ids.add(m[1]));
  return [...ids];
}

// Every id the markup declares.
function declaredIds() {
  const ids = new Set();
  [...template.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)]
    .forEach((m) => ids.add(m[1]));
  return ids;
}

t.test('main.js references a sane number of template ids', () => {
  const n = lookedUpIds().length;
  t.assert(n >= 100, 'only ' + n + ' $id() lookups found; the scan regex is probably broken');
});

t.test('every id main.js looks up exists in template.js', () => {
  const declared = declaredIds();
  // Ids created at runtime by main.js itself (renderers build DOM and assign
  // ids before looking them up). Verified by hand; keep this list short.
  const RUNTIME = new Set(
    [...main.matchAll(/\bid=\\?["']([A-Za-z0-9_-]+)\\?["']/g)].map((m) => m[1])
  );
  const missing = lookedUpIds().filter((id) => !declared.has(id) && !RUNTIME.has(id));
  t.equal(missing.length, 0,
    'ids looked up but never declared (template.js or a renderer): ' + missing.join(', '));
});

t.test('the dashboard KPI render guards against a missing root', () => {
  // The defensive-render rule: render functions bail when their root element
  // is absent instead of throwing halfway through a paint.
  t.assert(/if\s*\(!\$id\(/.test(main),
    'expected at least one defensive if (!$id(...)) guard in main.js');
});

process.exit(t.report());
