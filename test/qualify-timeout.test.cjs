// PUT IN: test/qualify-timeout.test.cjs
/**
 * Lead qualification: what happens when the research runs long.
 *
 * Sep 2026. The button was failing with "An error occurred with your
 * deployment (504)". That is the hosting platform's own page, not this app
 * talking: the function was killed at its 60 second ceiling with the research
 * still in flight, so the handler never got to say anything.
 *
 * Two things are checked here. That the ceiling is high enough for work that
 * involves several rounds of web search, and that when a run really is
 * hopeless the answer is a message a person can act on rather than a gateway
 * page. The second one matters more: a timeout with a next step attached is a
 * nuisance, a timeout with no explanation is a report that the button is
 * broken.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

process.env.SESSION_SECRET = 'test-secret-for-qualify-timeout';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const mod = await import(path.join(ROOT, 'api/qualify.js'));
  const route = mod.default;
  const { config, CALL_TIMEOUT_MS } = mod;

  const RYAN = { username: 'ryan', name: 'Ryan', role: 'admin' };

  async function post(body, fetchImpl) {
    global.fetch = fetchImpl;
    const req = {
      method: 'POST',
      query: {},
      body,
      headers: { cookie: await makeCookie(RYAN) },
    };
    const res = fakeRes();
    await route(req, res);
    return res;
  }

  /* ---- the ceilings ----------------------------------------------------- */

  t.test('the function is allowed longer than one round of research takes', () => {
    // 60 was the old value and it was not a near miss: the screen itself tells
    // people to expect 15 to 30 seconds, and three rounds of web search plus
    // writing 4,000 tokens of JSON goes past a minute often enough that this
    // failed rather than occasionally failed.
    t.assert(config.maxDuration >= 300,
      'maxDuration is ' + config.maxDuration + ', which is what produced the 504');
  });

  t.test('we stop before the platform does', () => {
    // The whole point of our own ceiling is that it fires first. If it is ever
    // raised past maxDuration it does nothing at all, and the failure goes back
    // to being a gateway page.
    t.assert(CALL_TIMEOUT_MS / 1000 < config.maxDuration,
      'our timeout (' + (CALL_TIMEOUT_MS / 1000) + 's) must be under maxDuration (' +
      config.maxDuration + 's) or it never fires');
  });

  /* ---- what a timeout looks like from the screen ------------------------ */

  await check('a run that gets stopped answers 504 with an explanation', async () => {
    const res = await post({ company_name: 'Fake Person Co' }, async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    t.equal(res.statusCode, 504, 'expected 504, got ' + res.statusCode);
    t.equal(res.body.timeout, true, 'the screen needs to tell a timeout from a crash');
    t.assert(/paste/i.test(res.body.detail),
      'a timeout is the one failure with a next step, so the message should name it');
  });

  await check('a real failure is still reported as one', async () => {
    // A timeout and a broken key are different problems. Reporting everything
    // as "took too long" would send somebody looking at the wrong thing.
    const res = await post({ company_name: 'Fake Person Co' }, async () => {
      throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    });
    t.equal(res.statusCode, 500, 'a network failure is not a timeout, got ' + res.statusCode);
    t.assert(!res.body.timeout, 'a network failure must not claim to be a timeout');
  });

  await check('an error from Anthropic still comes back as one', async () => {
    const res = await post({ company_name: 'Fake Person Co' }, async () => ({
      ok: false, status: 401, text: async () => 'invalid x-api-key',
    }));
    t.equal(res.statusCode, 502, 'expected the upstream error path, got ' + res.statusCode);
  });

  await check('a good run is unaffected', async () => {
    const payload = { company_overview: { company_name: 'Hy-Vee', website: 'hy-vee.com' } };
    const res = await post({ company_name: 'Hy-Vee' }, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    }));
    t.equal(res.statusCode, 200, 'a normal answer should still be a normal answer');
    t.equal(res.body.company_overview.company_name, 'Hy-Vee', 'the parsed JSON should come through');
    t.assert(!!res.body.qualified_at, 'the stamp should still be added');
  });

  await check('the abort signal is actually handed to the request', async () => {
    // Without this the timer fires and nothing listens, so the call runs on
    // until the platform kills it and we are back where we started.
    let sawSignal = false;
    await post({ company_name: 'Hy-Vee' }, async (url, opts) => {
      sawSignal = !!(opts && opts.signal);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{}' }] }) };
    });
    t.assert(sawSignal, 'fetch was called without an abort signal, so the timeout cannot stop it');
  });

  await check('the company name is still required', async () => {
    const res = await post({}, async () => { throw new Error('should not be called'); });
    t.equal(res.statusCode, 400, 'a request with no company should be refused before any billing happens');
  });
})();
