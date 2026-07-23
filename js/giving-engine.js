/**
 * alliteration. — GivingGauge scoring engine adapter
 *
 * VERBATIM PORT. vendor/scoring-engine.js is a byte-for-byte copy of
 * GivingGauge/src/scoring-engine.js. Do not edit it, do not "improve" it, do
 * not reformat it. If a rule changes it changes in the source repo and gets
 * re-copied. test/engine-parity.test.js asserts the copy still matches.
 *
 * WHY A WRAPPER RATHER THAN A CONVERSION
 * The source file ends with:
 *     if (typeof module !== 'undefined' && module.exports) module.exports = GivingGauge;
 *     if (typeof window !== 'undefined') window.GivingGauge = GivingGauge;
 * That is CommonJS + a browser global. The shell is native ES modules with no
 * build step, so it cannot `import` that file directly. Rewriting the tail as
 * `export default` would edit the very file the parity test protects, and it
 * would break the app's own test/engine.test.js, which uses require().
 *
 * So: load the file as a classic script (it sets window.GivingGauge), then
 * re-export that global through this ES module. The engine stays untouched and
 * both the shell and the original test suite keep working.
 */

// NOTE the .js extension. The vendored file exists TWICE, byte-identical:
//   vendor/x.cjs  — what Node requires (package.json sets "type": "module",
//                   so a .js there would be treated as ESM and require() breaks)
//   vendor/x.js   — what the BROWSER fetches. A .cjs has no registered MIME
//                   type, so hosts serve it inconsistently: as a download, as
//                   HTML, or rewritten by cleanUrls. A .js is unambiguous.
// The parity test hashes both, so the copies cannot drift.
const SRC = new URL('../vendor/scoring-engine.js', import.meta.url).href;

let loading = null;

/**
 * Load the vendored file and hand back its global.
 *
 * Two-step, because a .cjs file is easy to serve with a Content-Type the
 * browser refuses to execute as a script:
 *   1. fetch() the text and run it. This works regardless of Content-Type.
 *   2. If that fails, fall back to a <script> tag.
 *
 * The file itself is never modified. It ends in module.exports plus a window
 * global, so a shim provides `module` and the global lands on window either way.
 */
async function loadVendorGlobal(src) {
  // Fetch the text and evaluate it. Deliberately NOT a <script> tag: a .cjs is
  // easily served with a Content-Type the browser refuses to execute, and
  // cleanUrls can rewrite the path, both of which fail silently.
  let code;
  try {
    const res = await fetch(src, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    code = await res.text();
  } catch (e) {
    throw new Error(
      'Could not fetch engine from ' + src + ' (' + e.message + '). ' +
      'Check that vendor/scoring-engine.js deployed.'
    );
  }

  // The server can return a 200 with the WRONG BODY: an HTML error page, a JSON
  // error object, or a redirect landing page. Evaluating any of those produces
  // a syntax error that says nothing useful, so check the shape first and
  // report what actually arrived.
  const head = code.slice(0, 200).trim();
  if (head.startsWith('<')) {
    throw new Error(
      'engine at ' + src + ' returned HTML instead of JavaScript. The file is ' +
      'probably not deployed, and a fallback page was served. First bytes: ' +
      JSON.stringify(head.slice(0, 80))
    );
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    throw new Error(
      'engine at ' + src + ' returned JSON instead of JavaScript. First bytes: ' +
      JSON.stringify(head.slice(0, 80))
    );
  }
  // A real copy of this file starts with a comment or "use strict".
  if (!/^(\/\*|\/\/|'use strict'|"use strict")/.test(head)) {
    throw new Error(
      'engine at ' + src + ' does not look like the expected file. First bytes: ' +
      JSON.stringify(head.slice(0, 80))
    );
  }

  // The vendored file ends with:
  //     if (typeof module !== 'undefined' && module.exports) module.exports = X;
  //     if (typeof window !== 'undefined') window.X = X;
  // Reading module.exports is what makes this reliable: the window assignment
  // depends on scope-chain details that differ between eval contexts, and
  // chasing that is what broke this twice. The CommonJS export is unambiguous.
  const shim = { exports: {} };
  try {
    new Function('module', 'exports', code + '\n;return module.exports;')(shim, shim.exports);
  } catch (e) {
    throw new Error('engine failed to evaluate: ' + e.message);
  }

  const api = (shim.exports && Object.keys(shim.exports).length)
    ? shim.exports
    : window.GivingGauge;

  if (!api) {
    throw new Error('engine evaluated but exported nothing. vendor/scoring-engine.js may be truncated.');
  }

  // Publish the global too: the vendored file's own internals may look for it,
  // and so may anything else expecting the standalone app's shape.
  window.GivingGauge = api;
  return api;
}

/** Resolves to the engine object. Safe to call repeatedly. */
export function loadEngine() {
  if (window.GivingGauge) return Promise.resolve(window.GivingGauge);
  if (!loading) loading = loadVendorGlobal(SRC);
  return loading;
}

/**
 * Score a request. Thin pass-through: no logic here, on purpose. Anything that
 * looks like scoring rules belongs in the source repo, not this file.
 */
export async function evaluate(request, account, opts) {
  const engine = await loadEngine();
  return engine.evaluate(request, account, opts);
}

export async function computeDaysOut(request, today) {
  const engine = await loadEngine();
  return engine.computeDaysOut(request, today);
}

export async function toGrade(total) {
  const engine = await loadEngine();
  return engine.toGrade(total);
}

export async function gaugeColor(grade) {
  const engine = await loadEngine();
  return engine.gaugeColor(grade);
}

/** Constants (LEAD_TIME_FLOOR_DAYS, DIMENSION_MAX, TOTAL_MAX). */
export async function constants() {
  const engine = await loadEngine();
  return {
    LEAD_TIME_FLOOR_DAYS: engine.LEAD_TIME_FLOOR_DAYS,
    DIMENSION_MAX: engine.DIMENSION_MAX,
    TOTAL_MAX: engine.TOTAL_MAX
  };
}

export default { loadEngine, evaluate, computeDaysOut, toGrade, gaugeColor, constants };
