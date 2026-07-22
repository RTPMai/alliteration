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

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-engine="giving"]`);
    if (existing) {
      if (window.GivingGauge) return resolve(window.GivingGauge);
      existing.addEventListener('load', () => resolve(window.GivingGauge));
      existing.addEventListener('error', () => reject(new Error('engine failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.engine = 'giving';
    s.onload = () => {
      if (!window.GivingGauge) return reject(new Error('engine loaded but window.GivingGauge is undefined'));
      resolve(window.GivingGauge);
    };
    s.onerror = () => reject(new Error('engine failed to load: ' + src));
    document.head.appendChild(s);
  });
}

/** Resolves to the engine object. Safe to call repeatedly. */
export function loadEngine() {
  if (window.GivingGauge) return Promise.resolve(window.GivingGauge);
  if (!loading) loading = loadClassicScript(SRC);
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
