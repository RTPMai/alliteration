// PUT IN: test/return-to.test.cjs
/**
 * Deep links survive sign-in.
 *
 * A printed PO's QR code opens #/promopro/orders/<id>. Signed out, the shell
 * used to send the phone to login.html with the hash dropped, and login
 * always went home afterwards, so the scan never reached the PO.
 *
 * Logic half: imports js/return-to.js and calls it.
 * Wiring half: text checks that shell.js and login.html actually use it.
 * Text-reading is legitimate there; the question is "is it wired", and the
 * behaviour itself is covered by the real calls above it.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const load = () => import(path.join(ROOT, 'js/return-to.js'));

(async () => {
  await t.test('a scanned PO link round-trips through sign-in', async () => {
  const { loginUrlFor, afterLoginUrl } = await load();
  const hash = '#/promopro/orders/po_26-66608';
  const login = loginUrlFor(hash);
  t.equal(login, 'login.html?next=' + encodeURIComponent(hash));
  const search = login.slice(login.indexOf('?'));
  t.equal(afterLoginUrl(search), '/' + hash);
});

  await t.test('an encoded PO id survives the round trip', async () => {
  const { loginUrlFor, afterLoginUrl } = await load();
  const hash = '#/promopro/orders/' + encodeURIComponent('PO 26/1');
  const login = loginUrlFor(hash);
  t.equal(afterLoginUrl(login.slice(login.indexOf('?'))), '/' + hash);
});

  await t.test('no hash, or just home, means a plain login and home after', async () => {
  const { loginUrlFor, afterLoginUrl } = await load();
  t.equal(loginUrlFor(''), 'login.html');
  t.equal(loginUrlFor('#/'), 'login.html');
  t.equal(afterLoginUrl(''), '/');
  t.equal(afterLoginUrl('?next='), '/');
});

  await t.test('never an open redirect', async () => {
  const { afterLoginUrl, safeReturnHash } = await load();
  const bad = [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '#javascript:alert(1)',
    '#//evil.example',
    '#/a//evil.example',
    '#/x"><script>',
    '#/' + 'a'.repeat(400),
  ];
  for (const b of bad) {
    t.equal(safeReturnHash(b), '', 'rejects ' + b.slice(0, 40));
    t.equal(afterLoginUrl('?next=' + encodeURIComponent(b)), '/', 'home for ' + b.slice(0, 40));
  }
});

  await t.test('shell.js sends signed-out visitors to login WITH the hash', () => {
  const s = read('js/shell.js');
  t.assert(/import\s*\{\s*loginUrlFor\s*\}\s*from\s*'\.\/return-to\.js'/.test(s), 'imports loginUrlFor');
  t.assert(s.includes('location.replace(loginUrlFor(location.hash))'), 'uses it at the session gate');
});

  await t.test('login.html returns to the destination, not always home', () => {
  const s = read('login.html');
  t.assert(s.includes("from '/js/return-to.js'"), 'imports the helper');
  t.assert(s.includes('afterLoginUrl(location.search)'), 'reads ?next=');
  t.assert(!s.includes("location.replace('/')"), 'no hardcoded home redirect left');
});

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run return-to tests');
  console.log('       ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
