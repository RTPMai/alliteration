/**
 * alliteration. — GivingGauge scoring engine adapter
 *
 * VERBATIM PORT. vendor/scoring-engine.cjs is a byte-for-byte copy of
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

const SRC = new URL('../vendor/scoring-engine.cjs', import.meta.url).href;

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
  // --- 1. fetch and evaluate -------------------------------------------------
  try {
    const res = await fetch(src, { cache: 'no-cache' });
    if (res.ok) {
      const code = await res.text();
      // The file checks for `module`, so give it one; it also sets the window
      // global, which is what we actually read back.
      const shim = { exports: {} };
      // NOTE: `window` is deliberately NOT passed as a parameter. The vendored
      // file ends with `window.GivingGauge = ...`, and a parameter named
      // `window` would shadow the real one, so that assignment would land on a
      // throwaway object and the global would never appear. Leaving it out lets
      // the file see the genuine window through the normal scope chain.
      new Function('module', 'exports', code)(shim, shim.exports);
      if (window.GivingGauge) return window.GivingGauge;
      // Fall back to module.exports for the same object, and publish it so the
      // vendored file's own global lookups still resolve.
      if (shim.exports && Object.keys(shim.exports).length) {
        window.GivingGauge = shim.exports;
        return shim.exports;
      }
    }
  } catch (e) {
    console.warn('[engine] fetch-eval failed, falling back to script tag:', e.message);
  }

  // --- 2. classic script tag -------------------------------------------------
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.dataset.vendor = 'engine';
    s.onload = () => {
      if (!window.GivingGauge) {
        return reject(new Error('engine loaded but window.GivingGauge is undefined'));
      }
      resolve(window.GivingGauge);
    };
    s.onerror = () => reject(new Error('engine failed to load: ' + src));
    document.head.appendChild(s);
  });
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
