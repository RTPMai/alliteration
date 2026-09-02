// PUT IN: test/harness.test.cjs
/**
 * The harness itself.
 *
 * Found Sep 2, 2026. t.test() ran the function inside a try/catch, which is
 * synchronous, so an async test body handed back a promise the harness threw
 * away. The line printed "ok" whatever its assertions did. Thirty-one tests
 * across six files were in that state, and three of them were asserting
 * something untrue at the time: a stale field ladder, and two calls to a
 * function that does not exist in the repo.
 *
 * A test that cannot fail is worse than no test. It is a claim nobody is
 * checking, and it reads on screen exactly like a claim somebody is.
 *
 * This file loads a SEPARATE copy of the harness so its pass and fail counts
 * stay out of the reporting harness below.
 */

'use strict';

const path = require('path');
const t = require('./harness.cjs');

/** A fresh harness with its counters to itself, and its output captured. */
function sandbox() {
  delete require.cache[require.resolve('./harness.cjs')];
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  const h = require('./harness.cjs');
  console.log = realLog;
  return {
    h,
    lines,
    run(fn) {
      const realLog2 = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try { return fn(); } finally { console.log = realLog2; }
    },
    async runAsync(fn) {
      const realLog2 = console.log;
      console.log = (...args) => lines.push(args.join(' '));
      try { return await fn(); } finally { console.log = realLog2; }
    },
  };
}

(async () => {
  await t.test('an async test that fails is reported as a failure', async () => {
    const s = sandbox();
    await s.runAsync(() => s.h.test('pretend', async () => {
      s.h.assert(false, 'this assertion must count');
    }));
    const code = s.run(() => s.h.report());
    t.equal(code, 1, 'a failing async body has to turn the suite red');
    t.assert(s.lines.some((l) => /FAIL pretend/.test(l)), 'and it has to be named on screen');
    t.assert(s.lines.some((l) => /this assertion must count/.test(l)), 'with its message');
  });

  await t.test('an async test that passes is reported once, not twice', async () => {
    const s = sandbox();
    await s.runAsync(() => s.h.test('pretend', async () => { s.h.assert(true); }));
    const code = s.run(() => s.h.report());
    t.equal(code, 0);
    t.equal(s.lines.filter((l) => /ok   pretend/.test(l)).length, 1);
  });

  await t.test('a rejected promise counts, not just a thrown assertion', async () => {
    const s = sandbox();
    await s.runAsync(() => s.h.test('pretend', () => Promise.reject(new Error('boom'))));
    t.equal(s.run(() => s.h.report()), 1);
    t.assert(s.lines.some((l) => /boom/.test(l)));
  });

  await t.test('forgetting the await turns the suite red rather than green', async () => {
    // This is the failure mode that hid for months: the test is still in the
    // air when report() prints and process.exit() follows. If a missing await
    // costs nothing, nobody notices the next one either.
    const s = sandbox();
    // Drained inside the capture, or the sandbox test's own "ok" line lands
    // in this suite's output a tick later and reads like a real result.
    const code = await s.runAsync(async () => {
      s.h.test('pretend', async () => { s.h.assert(true); });
      const c = s.h.report();
      await new Promise((r) => setTimeout(r, 0));
      return c;
    });
    t.equal(code, 1, 'an unawaited async test must not report green');
    t.assert(s.lines.some((l) => /never awaited/.test(l)), 'and it must say what is wrong');
  });

  await t.test('a synchronous test still behaves exactly as before', async () => {
    const s = sandbox();
    s.run(() => {
      s.h.test('good', () => s.h.assert(true));
      s.h.test('bad', () => s.h.assert(false, 'nope'));
    });
    t.equal(s.run(() => s.h.report()), 1);
    t.assert(s.lines.some((l) => /ok   good/.test(l)));
    t.assert(s.lines.some((l) => /FAIL bad/.test(l)));
  });

  t.test('every async test in the suite is awaited', () => {
    // The harness catches this at run time, but only for a file that gets as
    // far as report(). This reads the files, so a new one is caught the first
    // time the suite runs rather than the first time it matters.
    const fs = require('fs');
    const dir = path.join(__dirname);
    const offenders = [];
    fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')).forEach((f) => {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/(^|[^.\w])t\.test\(.*async \(/.test(line) && !/await t\.test\(/.test(line)) {
          offenders.push(f + ':' + (i + 1));
        }
      });
    });
    t.equal(offenders.length, 0, 'unawaited async tests: ' + offenders.join(', '));
  });

  process.exit(t.report());
})();
