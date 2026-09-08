// test/promopro-art-types.test.cjs
/**
 * PUT IN: test/promopro-art-types.test.cjs
 *
 * PromoPro: what a purchase order will take as a file.
 *
 * Everything below CALLS the real exported functions. The bug this file
 * guards against was never a missing type, it was three lists that agreed on
 * paper and not in practice: the picker offered `image/*` while the server
 * had never heard of a photo off an iPhone, so a file could be chosen and
 * then refused. So the check that matters most here is the one comparing the
 * picker's list to the server's, not the ones asserting a single type is
 * present.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const AT = await import('../lib/promopro/art-types.js');
  const { isAllowedArtType, artContentType, ART_ACCEPT, ART_KINDS, ART_ALLOWED_TYPES } = AT;

  /* ---- the documents Ryan asked for ------------------------------------ */

  t.test('a CSV is accepted however the machine names it', () => {
    // Mac Chrome says text/csv. Windows with Excel installed says it is a
    // spreadsheet. A machine with neither says plain text. Same file.
    t.assert(isAllowedArtType('text/csv'), 'text/csv must be accepted');
    t.assert(isAllowedArtType('application/vnd.ms-excel'), 'a Windows CSV must be accepted');
    t.assert(isAllowedArtType('text/plain'), 'a plain-text CSV must be accepted');
  });

  t.test('Excel is accepted, old format and new', () => {
    t.assert(isAllowedArtType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
    t.assert(isAllowedArtType('application/vnd.ms-excel'), 'xls');
    t.assert(isAllowedArtType('application/vnd.ms-excel.sheet.macroEnabled.12'), 'xlsm');
  });

  t.test('Word is accepted, old format and new', () => {
    t.assert(isAllowedArtType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
    t.assert(isAllowedArtType('application/msword'), 'doc');
  });

  t.test('a charset on the end does not make a file unrecognisable', () => {
    // Browsers append this to text types. An exact string match misses it,
    // which would refuse every CSV on some machines and not others.
    t.assert(isAllowedArtType('text/csv;charset=utf-8'), 'a charset must be ignored');
    t.assert(isAllowedArtType('text/csv; charset=UTF-8'), 'a space and different case too');
  });

  /* ---- nothing that worked before stopped working ---------------------- */

  t.test('the design formats that already worked still do', () => {
    for (const ct of [
      'application/pdf', 'application/illustrator', 'application/postscript',
      'image/vnd.adobe.photoshop', 'image/png', 'image/jpeg', 'image/svg+xml',
      'image/tiff', 'image/gif', 'image/webp', 'application/zip',
    ]) {
      t.assert(isAllowedArtType(ct), ct + ' must still be accepted');
    }
  });

  t.test('an unnameable file still gets through, which is how .dst and .indd work', () => {
    t.assert(isAllowedArtType('application/octet-stream'),
      'dropping the catch-all would break every production format a browser cannot name');
  });

  /* ---- the check this file exists for ---------------------------------- */

  t.test('the picker never offers a file the server will refuse', () => {
    for (const kind of ART_KINDS) {
      t.assert(ART_ACCEPT.includes('.' + kind.ext),
        '.' + kind.ext + ' must be offered by the picker');
      for (const ct of kind.types) {
        t.assert(ART_ALLOWED_TYPES.includes(ct),
          '.' + kind.ext + ' can arrive as ' + ct + ', so the server must accept it');
      }
    }
  });

  t.test('image/* on the picker does not over-promise', () => {
    t.assert(ART_ACCEPT.includes('image/*'), 'a phone needs image/* to offer the camera roll');
    // The old gap, closed: choosable and then refused.
    t.assert(isAllowedArtType('image/heic'), 'an iPhone photo must be accepted');
    t.assert(isAllowedArtType('image/bmp'), 'a bitmap must be accepted');
  });

  t.test('something we do not take is actually refused', () => {
    t.assert(!isAllowedArtType('video/mp4'), 'video is not artwork');
    t.assert(!isAllowedArtType('application/x-msdownload'), 'an executable must never be accepted');
    t.assert(!isAllowedArtType('application/x-sh'), 'nor a script');
    t.assert(!isAllowedArtType(''), 'an empty type is not a pass');
    t.assert(!isAllowedArtType(null), 'a missing type is not a pass');
    t.assert(!isAllowedArtType(undefined), 'undefined is not a pass');
    t.assert(!isAllowedArtType(42), 'a non-string is not a pass');
  });

  /* ---- a file already sitting in storage ------------------------------- */

  t.test('a file in storage is named from the same list', () => {
    t.equal(artContentType('sizes.csv'), 'text/csv', 'a CSV in storage is a CSV');
    t.equal(artContentType('run.XLSX'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'extension matching is case-insensitive');
    t.equal(artContentType('spec.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a Word file');
    t.equal(artContentType('front.pdf'), 'application/pdf', 'a PDF is a PDF');
    t.equal(artContentType('logo.ai'), 'application/illustrator', 'an Illustrator file');
  });

  t.test('the two formats the old naming had never heard of', () => {
    // guessType() had no .indd or .cdr even though the picker had been
    // offering both for months. Merging the lists fixed it by construction.
    t.equal(artContentType('layout.indd'), 'application/x-indesign', 'InDesign is now named');
    t.equal(artContentType('mark.cdr'), 'application/x-coreldraw', 'CorelDRAW is now named');
  });

  t.test('an honest unknown beats a wrong guess', () => {
    t.equal(artContentType('digitised.dst'), 'application/octet-stream',
      'an embroidery file has no registered type and must not be given one');
    t.equal(artContentType('noextension'), 'application/octet-stream', 'no extension is not a crash');
    t.equal(artContentType(''), 'application/octet-stream', 'no filename is not a crash');
    t.equal(artContentType(null), 'application/octet-stream', 'null is not a crash');
  });

  /* ---- the wiring, which has to be real -------------------------------- */

  // Import the route BEFORE asserting on it. This harness does not await an
  // async test body, so an async assertion prints "ok" and then throws into
  // the void. Same reason route-imports.test.cjs collects first and asserts
  // after.
  let routeMod = null;
  let routeErr = null;
  try {
    routeMod = await import('../api/promopro/art-upload.js');
  } catch (e) {
    routeErr = e;
  }

  t.test('the upload route loads and takes the shared list', () => {
    // Importing proves it runs. A grep would only prove the letters are
    // there, which is how a route 500ed for days with a green suite.
    if (routeErr && /Cannot find package '@vercel\/blob'/.test(String(routeErr.message))) {
      // npm install not run in this checkout. Environment, not code.
      // route-imports.test.cjs skips on the same condition.
      t.assert(true, 'skipped, node_modules not installed');
      return;
    }
    t.assert(!routeErr, 'the route must import without throwing: ' + (routeErr && routeErr.message));
    t.assert(typeof routeMod.default === 'function', 'the route must export a handler');
  });

  t.test('the shared list is substantial, not a stub', () => {
    t.assert(ART_ALLOWED_TYPES.length > 20,
      'expected a real list, got ' + ART_ALLOWED_TYPES.length + ' entries');
  });

  t.test('no file keeps a second copy of the list', () => {
    const rec = read('lib/promopro/art-reconcile.js');
    t.assert(!/const map = \{/.test(rec),
      'the reconciler must not carry its own extension map again');

    const route = read('api/promopro/art-upload.js');
    t.assert(/ART_ALLOWED_TYPES/.test(route), 'the upload route must read the shared list');
    t.assert(!/"image\/jpeg", "image\/jpg"/.test(route),
      'the upload route must not have grown its own list back');

    const app = read('apps/promopro.js');
    t.assert(!/accept="\.ai,/.test(app),
      'the picker must not carry a hardcoded accept string again');
    t.assert(/ART_ACCEPT/.test(app), 'the picker must read the shared accept string');
  });

  const rec = await import('../lib/promopro/art-reconcile.js');
  t.test('the reconciler still loads after losing its own naming', () => {
    t.assert(typeof rec.reconcileArt === 'function', 'reconcileArt must still export');
    t.assert(typeof rec.artPrefix === 'function', 'artPrefix must still export');
  });

  process.exit(t.report());
})();
