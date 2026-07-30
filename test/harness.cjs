/**
 * alliteration. — test harness.
 *
 * Tiny, dependency-free. Rebuilt Jul 29, 2026 after the original was lost to
 * a wrong-file upload (it contained a copy of run.sh; the real harness never
 * reached git). API reconstructed from every call site in test/*.test.cjs:
 *
 *   t.test(name, fn)        run fn now; catch = fail, return = pass
 *   t.assert(cond, msg)     throw msg unless cond is truthy
 *   t.equal(a, b, msg)      throw unless a === b (msg gets both values)
 *   t.report()              print summary, return exit code (0 green, 1 red)
 */

'use strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log('  FAIL ' + name);
    console.log('       ' + msg);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function equal(a, b, msg) {
  if (a !== b) {
    throw new Error((msg || 'not equal') + ' (got ' + JSON.stringify(a) +
      ', wanted ' + JSON.stringify(b) + ')');
  }
}

function report() {
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  return failed === 0 ? 0 : 1;
}

module.exports = { test, assert, equal, report };
