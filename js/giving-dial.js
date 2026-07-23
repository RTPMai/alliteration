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

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-engine="giving-dial"]');
    if (existing) {
      if (window.GivingGaugeDial) return resolve(window.GivingGaugeDial);
      existing.addEventListener('load', () => resolve(window.GivingGaugeDial));
      existing.addEventListener('error', () => reject(new Error('dial failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.engine = 'giving-dial';
    s.onload = () => {
      if (!window.GivingGaugeDial) return reject(new Error('dial loaded but window.GivingGaugeDial is undefined'));
      resolve(window.GivingGaugeDial);
    };
    s.onerror = () => reject(new Error('dial failed to load: ' + src));
    document.head.appendChild(s);
  });
}

/** Resolves to the dial renderer ({ renderGauge, PALETTE, scoreToAngle }). */
export function loadDial() {
  if (window.GivingGaugeDial) return Promise.resolve(window.GivingGaugeDial);
  if (!loading) loading = loadClassicScript(SRC);
  return loading;
}

export default { loadDial };
