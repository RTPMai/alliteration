// PUT IN: test/route-access.test.cjs
/**
 * A link to an app you cannot open says so.
 *
 * A printed PO scanned by someone without PromoPro used to land them in
 * ShopStock with no explanation, which reads as a broken QR code.
 *
 * Logic half imports js/route-access.js and calls it. Wiring half checks
 * shell.js uses it and no longer lumps "no access" in with "unknown app".
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const { noAccessMessage } = await import(path.join(ROOT, 'js/route-access.js'));

  await t.test('names the app they tried to open', () => {
    const m = noAccessMessage('PromoPro', { id: 'shopstock', name: 'ShopStock', defaultView: 'dashboard' });
    t.equal(m.title, 'No access to PromoPro');
    t.assert(m.body.includes('does not have access to PromoPro'), 'says which app');
    t.assert(m.body.includes('Settings'), 'says where it gets fixed');
  });

  await t.test('offers a way to the app they can open', () => {
    const m = noAccessMessage('PromoPro', { id: 'shopstock', name: 'ShopStock', defaultView: 'dashboard' });
    t.assert(m.body.includes('href="#/shopstock/dashboard"'), 'links to their app');
    t.assert(m.body.includes('Go to ShopStock'), 'labelled');
  });

  await t.test('no apps at all still gives a sentence, no dead link', () => {
    const m = noAccessMessage('PromoPro', null);
    t.assert(!m.body.includes('<a '), 'no link');
    t.assert(m.body.includes('PromoPro'), 'still names it');
  });

  await t.test('escapes what it prints', () => {
    const m = noAccessMessage('<b>x</b>', { id: 'a"b', name: '<i>y</i>' });
    t.assert(!m.body.includes('<b>') && !m.body.includes('<i>'), 'no raw tags');
    t.assert(!m.body.includes('a"b'), 'no raw quote in href');
  });

  await t.test('shell.js shows the message instead of silently falling back', () => {
    const s = read('js/shell.js');
    t.assert(s.includes("from './route-access.js'"), 'imports it');
    t.assert(s.includes('getApp(appId) && !canAccess(state.perms, appId)'), 'no-access branch exists');
    t.assert(!s.includes('!getApp(appId) || !canAccess(state.perms, appId)'), 'old lumped fallback is gone');
  });

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run route-access tests');
  console.log('       ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
