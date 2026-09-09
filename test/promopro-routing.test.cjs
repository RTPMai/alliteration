// PUT IN: test/promopro-routing.test.cjs
/**
 * The Pipeline tab going dead while a purchase order is open.
 *
 * THE BUG. Clicking a PO on the pipeline called the app's own showView()
 * directly. That swapped the visible page behind the router's back: the screen
 * showed the order, while the URL still said #/promopro/pipeline. Pressing
 * Pipeline then did nothing whatsoever, because router.go() compares the hash
 * it is being asked for against the current one and returns early when they
 * are the same. Nothing was broken in the pipeline screen. The router had
 * simply already been told, incorrectly, that we were on it.
 *
 * This is a whole class of bug rather than one incident: ANY app that moves
 * between its own views without going through the router leaves the URL lying,
 * and the symptom is always a tab that silently stops working. So the first
 * half of this file tests the real router with a stubbed location, pinning the
 * early return that makes the trap possible, and the second half checks that
 * PromoPro navigates through ctx.go rather than around it.
 *
 * The router is imported for real. It reads location, history and window at
 * call time, which is exactly what makes stubbing them enough.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'apps/promopro.js'), 'utf8');

// A stand-in for the browser, small enough to reason about.
//
// `assigned` counts EVERY write to location.hash; `fired` counts only the
// ones that actually change it. Keeping them apart is the point: a real
// browser ignores a write of the identical hash, so if the fake ignored it
// too, the router's own early return would be untestable and could be deleted
// without any test noticing. `assigned` sees past the browser to the router.
function fakeBrowser(startHash) {
  const state = { hash: startHash, fired: 0, assigned: 0, handlers: [] };
  globalThis.location = {
    pathname: '/', search: '',
    get hash() { return state.hash; },
    set hash(v) {
      state.assigned += 1;
      if (v === state.hash) return;      // real browsers do not re-fire either
      state.hash = v;
      state.fired += 1;
      state.handlers.forEach((h) => h());
    },
  };
  globalThis.history = { replaceState() {} };
  globalThis.window = {
    addEventListener: (name, fn) => { if (name === 'hashchange') state.handlers.push(fn); },
    removeEventListener: () => {},
  };
  return state;
}

(async () => {
  /* ---- the trap itself, in the real router ---------------------------- */

  const b = fakeBrowser('#/promopro/pipeline');
  const router = await import('../js/router.js');
  router.start();

  await t.test('asking for the hash we are already on does nothing at all', () => {
    const fired = b.fired;
    const assigned = b.assigned;
    router.go('promopro', 'pipeline');
    t.equal(b.fired, fired);
    // The router returns BEFORE touching location, rather than leaning on the
    // browser to ignore the write. That is what the app is really up against.
    t.equal(b.assigned, assigned);
    // None of this is a bug in the router. It is correct, and it is why an app
    // must never let the URL disagree with what is on screen: the router has
    // no way to know the screen is showing something else.
  });

  await t.test('asking for a different view does fire a navigation', () => {
    const before = b.fired;
    router.go('promopro', 'orders');
    t.equal(b.fired, before + 1);
    t.equal(globalThis.location.hash, '#/promopro/orders');
  });

  await t.test('and Pipeline then works again, because the URL was honest', () => {
    const before = b.fired;
    router.go('promopro', 'pipeline');
    t.equal(b.fired, before + 1);
    t.equal(globalThis.location.hash, '#/promopro/pipeline');
  });

  await t.test('goView routes within whatever app we are in', () => {
    router.goView('vendors');
    t.equal(globalThis.location.hash, '#/promopro/vendors');
  });

  /* ---- so PromoPro must route, not swap pages ------------------------- */

  // COMMENTS STRIPPED FIRST, and the windows are bounded by real syntax
  // rather than a character count. Both matter: this file's own explanation
  // of the bug contains the words "this.showView(", and a fixed-size window
  // would break the moment somebody adds a line above the thing it looks for.
  // That is exactly how a test about vendor replies broke when a product line
  // was added to a card, so it is not a hypothetical.
  const code = app
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');

  /** The statement a branch runs, from its `if (…)` to the `return`. */
  const branchAfter = (needle) => {
    const i = code.indexOf(needle);
    if (i < 0) return '';
    const end = code.indexOf('return;', i);
    return code.slice(i, end < 0 ? i + 400 : end);
  };

  t.test('opening an order from a list routes through the shell', () => {
    const handler = branchAfter('t.dataset && t.dataset.po');
    t.assert(handler.length > 0, 'the order-click handler should still exist');
    t.assert(/ctx\.go\(\s*'orders'\s*\)/.test(handler), 'it should call ctx.go');
    t.assert(!/this\.showView\(/.test(handler), 'and must not call showView directly');
  });

  t.test('New purchase order from the pipeline routes too', () => {
    const branch = branchAfter("t.id === 'ppNewFromPipe'");
    t.assert(branch.length > 0, 'the new-from-pipeline branch should still exist');
    t.assert(/ctx\.go\(\s*'orders'\s*\)/.test(branch), 'it should call ctx.go');
  });

  t.test('nothing in the app navigates by calling its own showView', () => {
    // showView is the SHELL telling the app where it is, never the app
    // deciding for itself. The definition stays; calls to it do not.
    const calls = code.match(/this\.showView\(/g) || [];
    t.equal(calls.length, 0);
  });

  t.test('showView is still defined, so the shell can still drive it', () => {
    t.assert(/^\s*showView\(view, param\)/m.test(app));
  });

  process.exit(t.report());
})();
