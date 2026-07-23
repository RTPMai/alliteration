/**
 * alliteration. — GivingGauge dial adapter.
 *
 * Same story as js/giving-engine.js. vendor/gauge.cjs is a verbatim copy of
 * GivingGauge/src/gauge.js, which ends in module.exports plus a
 * window.GivingGaugeDial global. The shell is native ES modules, so it loads the
 * file as a classic script and re-exports the global rather than editing it.
 *
 * The dial is pure rendering: it turns a scoring result into gauge SVG. No
 * scoring lives here, so it is safe to treat as a black box the same way the
 * engine is.
 */

const SRC = new URL('../vendor/gauge.cjs', import.meta.url).href;

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
      'Could not fetch dial from ' + src + ' (' + e.message + '). ' +
      'Check that vendor/gauge.cjs deployed.'
    );
  }

  // Guard against a server that returns an HTML error page with a 200.
  if (/^\s*</.test(code)) {
    throw new Error('dial at ' + src + ' returned HTML, not JavaScript. ' +
                    'The file is probably missing and a fallback page was served.');
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
    throw new Error('dial failed to evaluate: ' + e.message);
  }

  const api = (shim.exports && Object.keys(shim.exports).length)
    ? shim.exports
    : window.GivingGaugeDial;

  if (!api) {
    throw new Error('dial evaluated but exported nothing. vendor/gauge.cjs may be truncated.');
  }

  // Publish the global too: the vendored file's own internals may look for it,
  // and so may anything else expecting the standalone app's shape.
  window.GivingGaugeDial = api;
  return api;
}

/** Resolves to the dial renderer ({ renderGauge, PALETTE, scoreToAngle }). */
export function loadDial() {
  if (window.GivingGaugeDial) return Promise.resolve(window.GivingGaugeDial);
  if (!loading) loading = loadVendorGlobal(SRC);
  return loading;
}

export default { loadDial };
