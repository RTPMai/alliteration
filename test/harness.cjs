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
 *
 * ASYNC TESTS MUST BE AWAITED:
 *
 *     await t.test('name', async () => { ... });
 *
 * A try/catch is synchronous. An async function handed to the old test()
 * returned a promise the harness dropped on the floor, so its assertions
 * could fail and the line still printed "ok". Thirty-one tests across six
 * files were in that state on Sep 2, 2026, and at least one of them had been
 * asserting something untrue for weeks.
 *
 * Two things close that hole. An async body is now recorded when its promise
 * settles rather than when it is created, and report() FAILS if any async
 * test is still in the air, so forgetting the await turns the suite red
 * instead of quietly green. A test that cannot fail is worse than no test:
 * it is a claim nobody is checking.
 */

'use strict';

let passed = 0;
let failed = 0;

const pending = new Set();

function pass(name) {
  passed += 1;
  console.log('  ok   ' + name);
}

function fail(name, err) {
  failed += 1;
  const msg = err && err.message ? err.message : String(err);
  console.log('  FAIL ' + name);
  console.log('       ' + msg);
}

function test(name, fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    fail(name, err);
    return Promise.resolve();
  }

  // A thenable means the assertions have not run yet. Record the result when
  // it settles, and hand the promise back so the call site can await it.
  if (out && typeof out.then === 'function') {
    const done = out.then(() => pass(name), (err) => fail(name, err));
    pending.add(done);
    done.then(() => pending.delete(done));
    return done;
  }

  pass(name);
  return Promise.resolve();
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
  // An async test still running when the summary prints is a test whose
  // result nobody will ever see, because process.exit() follows this line.
  // Counting it as a failure is the whole point: a missing await has to cost
  // something, or it goes unnoticed the way it did for months.
  if (pending.size) {
    failed += pending.size;
    console.log('  FAIL ' + pending.size + ' async test(s) were never awaited');
    console.log('       write: await t.test(name, async () => ...)');
  }
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  return failed === 0 ? 0 : 1;
}

module.exports = { test, assert, equal, report };
