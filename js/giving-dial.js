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
  // --- 1. fetch and evaluate -------------------------------------------------
  try {
    const res = await fetch(src, { cache: 'no-cache' });
    if (res.ok) {
      const code = await res.text();
      // The file checks for `module`, so give it one; it also sets the window
      // global, which is what we actually read back.
      const shim = { exports: {} };
      // NOTE: `window` is deliberately NOT passed as a parameter. The vendored
      // file ends with `window.GivingGaugeDial = ...`, and a parameter named
      // `window` would shadow the real one, so that assignment would land on a
      // throwaway object and the global would never appear. Leaving it out lets
      // the file see the genuine window through the normal scope chain.
      new Function('module', 'exports', code)(shim, shim.exports);
      if (window.GivingGaugeDial) return window.GivingGaugeDial;
      // Fall back to module.exports for the same object, and publish it so the
      // vendored file's own global lookups still resolve.
      if (shim.exports && Object.keys(shim.exports).length) {
        window.GivingGaugeDial = shim.exports;
        return shim.exports;
      }
    }
  } catch (e) {
    console.warn('[dial] fetch-eval failed, falling back to script tag:', e.message);
  }

  // --- 2. classic script tag -------------------------------------------------
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.dataset.vendor = 'dial';
    s.onload = () => {
      if (!window.GivingGaugeDial) {
        return reject(new Error('dial loaded but window.GivingGaugeDial is undefined'));
      }
      resolve(window.GivingGaugeDial);
    };
    s.onerror = () => reject(new Error('dial failed to load: ' + src));
    document.head.appendChild(s);
  });
}

/** Resolves to the dial renderer ({ renderGauge, PALETTE, scoreToAngle }). */
export function loadDial() {
  if (window.GivingGaugeDial) return Promise.resolve(window.GivingGaugeDial);
  if (!loading) loading = loadVendorGlobal(SRC);
  return loading;
}

export default { loadDial };
