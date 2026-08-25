// test/blob-client-vendor.test.cjs
//
// The vendored browser upload bundle, checked the way vendor/scoring-engine
// is: it is a third-party artifact nobody reads, so the test has to be what
// stands between a bad regeneration and a broken Attach button.
//
// These are real checks, not source greps for a function name. The bundle is
// actually EVALUATED in a context with browser globals and nothing else, so a
// version that reaches for `process` or `require` at load time fails here
// rather than in front of somebody trying to attach artwork.

const t = require('./harness.cjs');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'vendor', 'blob-client.js');
const src = fs.readFileSync(FILE, 'utf8');

t.test('the vendored bundle exists and is not empty', () => {
  t.assert(src.length > 10000, 'a truncated paste would land here');
});

t.test('it says where it came from and how to rebuild it', () => {
  // A 100 KB minified file with no provenance is unmaintainable: nobody can
  // tell what version it is or how to make a new one.
  t.assert(/@vercel\/blob 2\.6\.1/.test(src), 'the exact version should be recorded');
  t.assert(/esbuild/.test(src), 'the command to regenerate it should be recorded');
  t.assert(/DO NOT EDIT BY HAND/i.test(src), 'it should warn against hand edits');
});

t.test('it has no imports of its own', () => {
  // A browser with no build step cannot resolve a bare specifier. If a
  // regeneration forgets --bundle, this is what catches it.
  const body = src.replace(/^\/\/.*$/gm, '');
  t.assert(!/\bfrom\s*["'][^"'.]/.test(body),
    'a bare import would fail to resolve in the browser');
  t.assert(!/\brequire\(/.test(body), 'require() does not exist in a browser');
});

t.test('it does not reach for Node globals at load time', () => {
  // The real test: evaluate it with browser globals ONLY. No process, no
  // Buffer, no require, no __dirname.
  const sandbox = {
    fetch: () => {}, Headers, Request, Response, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob: globalThis.atob, btoa: globalThis.btoa,
    AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, crypto: globalThis.crypto, Blob, File, FormData,
    ReadableStream, WritableStream, TransformStream, DOMException,
    XMLHttpRequest: function () {},
    navigator: { userAgent: 'Mozilla/5.0 test' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Evaluated as a script rather than a module, since vm.SourceTextModule
  // needs a flag the runner does not pass. The export statement is stripped;
  // what matters is that the body runs without a Node global.
  const asScript = src.replace(/export\s*\{[^}]*\};?/g, '');

  let threw = null;
  try {
    new vm.Script(asScript, { filename: 'blob-client.js' }).runInContext(sandbox);
  } catch (e) {
    threw = e;
  }
  t.equal(threw, null, threw ? 'the bundle threw on load: ' + threw.message : '');
});

t.test('it exports upload, and only upload', () => {
  const m = /export\s*\{([^}]*)\}/.exec(src);
  t.assert(m, 'there should be an export statement');
  const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);
  t.equal(names.join(','), 'upload',
    'a wider surface means more third-party code reachable than we asked for');
});

t.test('the app loads it lazily, not on every page view', () => {
  // 100 KB should cost nothing to the many people who never attach a file.
  const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'promopro.js'), 'utf8');
  t.assert(/await import\(['"]\.\.\/vendor\/blob-client\.js['"]\)/.test(app),
    'the bundle should be imported on first use, not at module load');
  t.assert(!/^import .*blob-client/m.test(app),
    'a top-level import would load it for everybody');
});

process.exit(t.report());
