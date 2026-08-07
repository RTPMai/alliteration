/**
 * Ops sync chain-handoff regression tests.
 *
 * Aug 5, 2026: the nightly ops sync (api/printavo-sync.js, mode=ops) stopped
 * completing. The dashboard's "Data through" stamp stayed stuck on Jul 31
 * for a week while every cron run still logged a clean 200. Three separate
 * bugs were stacked on top of each other, each one hiding behind the last:
 *
 *   1. The chain handoff (continueOps(), which re-invokes this route to
 *      keep paginating past Vercel's 5-minute function limit) raced a
 *      fire-and-forget fetch against a 1.5s timer and treated "still in
 *      flight" as success. A handoff that took longer than 1.5s to connect
 *      reported chained:true with no way to tell it never actually landed.
 *   2. Fixing #1 to really await the child response introduced a scope bug:
 *      continueOps() is defined in the OUTER handler scope, but the code
 *      reached for `acc` and `deadline`, both declared with let/const
 *      inside a nested per-mode block further down the file. Referencing
 *      them threw "acc is not defined" / "deadline is not defined" and
 *      crashed the whole run with a 500 the moment that code path ran live.
 *   3. Fixing #2 exposed a third, unrelated bug: the child request was
 *      addressed using req.headers.host, the per-deployment URL, which at
 *      least once served a cached HTML shell (the dashboard's own front
 *      end) instead of actually invoking the function. It came back status
 *      200, cache-header HIT, so a plain status check reported success for
 *      a request that never really ran.
 *
 * None of this was catchable by asserting on live network behavior (no real
 * Printavo/Vercel calls in this harness), so these tests instead lock the
 * STRUCTURAL properties that would have caught each bug: continueOps() must
 * not reference any identifier that isn't in true outer scope, must confirm
 * a real response before reporting success, and must not trust an HTTP
 * status code alone as proof the response is real.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const sync = fs.readFileSync(path.join(ROOT, 'api/printavo-sync.js'), 'utf8');

// Isolate the continueOps() function body for the scope checks below.
const start = sync.indexOf('async function continueOps()');
t.test('continueOps() exists in api/printavo-sync.js', () => {
  t.assert(start !== -1, 'continueOps() was not found — has it been renamed or removed?');
});

function extractFunctionBody(src, fnStartIndex) {
  const braceStart = src.indexOf('{', fnStartIndex);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(fnStartIndex, i + 1);
    }
  }
  return src.slice(fnStartIndex); // fallback, shouldn't happen on valid JS
}

const continueOpsBody = start !== -1 ? extractFunctionBody(sync, start) : '';

/* ---- bug #2: out-of-scope variable references -------------------------- */

t.test('continueOps() never references acc', () => {
  // `acc` is declared with `let` inside the mode==="ops" block, far below
  // and outside continueOps()'s own closure. Any reference to it here is a
  // guaranteed ReferenceError the first time this code path actually runs,
  // exactly what happened Aug 5 (twice, at two different call sites inside
  // the function, on two separate days).
  t.assert(!/\bacc\./.test(continueOpsBody) && !/\bacc\[/.test(continueOpsBody),
    'continueOps() references acc, which is out of scope — this WILL throw ' +
    '"acc is not defined" the first time a chained request actually fires. ' +
    'Return the result from continueOps() and let the caller (which has acc ' +
    'in scope) merge it in, the way every call site currently does.');
});

t.test('continueOps() never references the per-mode `deadline`', () => {
  // Same shape of bug, different variable: `deadline` is declared inside
  // the ops-mode block (`const deadline = Date.now() + 230000`), not in the
  // handler's outer scope where continueOps() lives.
  t.assert(!/[^a-zA-Z0-9_]deadline\b/.test(continueOpsBody),
    'continueOps() references `deadline`, which is declared inside a nested ' +
    'per-mode block and out of scope here. Use invocationStart (declared at ' +
    'the top of the handler) to compute any time budget instead.');
});

t.test('continueOps() returns a result object, not a bare boolean', () => {
  // The fix for bug #2 changed the return shape from `return true/false` to
  // `return { chained, chainError, lastChainResponse }` specifically so
  // every call site has to explicitly pull values out and merge them into
  // its own in-scope `acc`, rather than the function quietly writing into a
  // variable it can't see.
  t.assert(/return\s*\{\s*chained:/.test(continueOpsBody),
    'continueOps() should return { chained, chainError, lastChainResponse }. ' +
    'A bare boolean return invites the next call site to skip recording ' +
    'chainError/lastChainResponse on acc, silently losing diagnostics again.');
});

/* ---- bug #1: unconfirmed fire-and-forget handoff ------------------------ */

t.test('continueOps() awaits the chained fetch rather than racing a short timer', () => {
  t.assert(/await fetch\(url/.test(continueOpsBody),
    'the chain handoff must await fetch() directly. A Promise.race() against ' +
    'a short timer can return before the child request is confirmed to have ' +
    'landed, which is how a fully dead chain looked identical to a healthy ' +
    'one for several days.');
  t.assert(!/Promise\.race/.test(continueOpsBody),
    'Promise.race is no longer expected in continueOps() — this was the ' +
    'exact pattern (racing a fire-and-forget fetch against a timeout) that ' +
    'let the chain silently drop without ever reporting an error.');
});

/* ---- bug #3: trusting a cached response as a real invocation ------------ */

t.test('continueOps() rejects a non-JSON chain response instead of trusting the status code alone', () => {
  t.assert(/content-type/.test(continueOpsBody) && /application\/json/.test(continueOpsBody),
    'continueOps() no longer checks the chained response is actually JSON. ' +
    'A cached HTML page served in place of a real invocation returns 200 ' +
    'with no error, and was mistaken for a successful chain link on Aug 5.');
});

t.test('the chain URL prefers the stable production host over the per-deployment Host header', () => {
  t.assert(sync.includes('VERCEL_PROJECT_PRODUCTION_URL'),
    'the chain handoff should address VERCEL_PROJECT_PRODUCTION_URL first. ' +
    'Using req.headers.host alone ties every chained request to whichever ' +
    'per-deployment URL happened to receive the parent request, and that ' +
    'URL is not guaranteed to behave the same as the stable production ' +
    'domain for caching purposes.');
});

t.test('the chain fetch sends explicit no-cache request headers', () => {
  t.assert(/no-cache/.test(continueOpsBody),
    'the chain handoff should ask for a fresh response explicitly (no-cache ' +
    'headers), as defense in depth even with the stable-host fix above.');
});

/* ---- every call site must merge the result into its own acc ------------ */

t.test('every continueOps() call site captures chainError and lastChainResponse onto acc', () => {
  const callSites = sync.split('await continueOps()').length - 1;
  t.assert(callSites >= 3, 'expected at least 3 call sites (quotes, invoices, cash phases) — ' +
    'found ' + callSites + '. If a phase was removed intentionally, update this count.');
  const mergesChainError = (sync.match(/acc\.chainError = chainResult\.chainError/g) || []).length;
  t.assert(mergesChainError >= 3,
    'every continueOps() call site should assign chainResult.chainError onto ' +
    'its own acc — found only ' + mergesChainError + ' of ' + callSites + '. A ' +
    'call site that skips this loses the diagnostic the next time the chain ' +
    'silently fails.');
});
