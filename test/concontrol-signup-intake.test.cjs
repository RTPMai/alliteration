/**
 * ConControl notify list: website intake (Sep 2026).
 *
 * Ryan signed up on flyovercon.ink/notify and nothing showed up in ConControl.
 * The site wrote the Sheet and never forwarded. This route is the missing hop.
 *
 *   - a real signup lands as a record, source "website"
 *   - the same email twice is one person, not two, in any case
 *   - a junk email is refused, a missing name is not
 *   - the honeypot gets a 200 and writes nothing
 *   - GET is refused
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const kv = new Map();

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => cmds.map(([verb, key, val]) => {
        if (verb === 'SET') { kv.set(key, val); return { result: 'OK' }; }
        if (verb === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
        if (verb === 'DEL') { const had = kv.has(key); kv.delete(key); return { result: had ? 1 : 0 }; }
        if (verb === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
        if (verb === 'EXPIRE') return { result: 1 };
        return { result: null };
      }),
    };
  }
  const setM = u.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const incrM = u.match(/\/incr\/(.+)$/);
  if (incrM) {
    const k = decodeURIComponent(incrM[1]);
    const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n));
    return { ok: true, status: 200, json: async () => ({ result: n }) };
  }
  if (/\/expire\//.test(u)) return { ok: true, status: 200, json: async () => ({ result: 1 }) };
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-concontrol-signup';

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

async function post(handler, body, method = 'POST') {
  const res = fakeRes();
  await handler({ method, headers: {}, body, query: {} }, res);
  return res;
}

(async () => {
  const { default: route } = await import(path.join(ROOT, 'api/concontrol/signup.js'));
  const store = await import(path.join(ROOT, 'lib/concontrol/store.js'));

  await t.test('GET is refused', async () => {
    const res = await post(route, null, 'GET');
    t.equal(res.statusCode, 405, 'not how you submit a form');
  });

  await t.test('a website signup lands as a record', async () => {
    const res = await post(route, { name: 'Pat Lee', email: 'Pat@Shop.test', city_state: 'Ames, IA' });
    t.equal(res.statusCode, 201, 'created');
    const list = await store.listSignups('FOC27');
    t.equal(list.length, 1, 'one on the list');
    t.equal(list[0].source, 'website', 'marked as from the website');
    t.equal(list[0].answers.email, 'pat@shop.test', 'email lowercased');
  });

  await t.test('the same email again is one person', async () => {
    const res = await post(route, { name: 'Pat', email: 'PAT@shop.test' });
    t.equal(res.statusCode, 200, 'not an error for the person on the page');
    t.equal(res.body.duplicate, true, 'flagged as a duplicate');
    t.equal((await store.listSignups('FOC27')).length, 1, 'still one');
  });

  await t.test('junk email refused, missing name fine', async () => {
    t.equal((await post(route, { name: 'X', email: 'nope' })).statusCode, 400, 'bad email refused');
    t.equal((await post(route, { email: 'solo@shop.test' })).statusCode, 201, 'email alone is enough');
  });

  await t.test('honeypot writes nothing', async () => {
    const before = (await store.listSignups('FOC27')).length;
    const res = await post(route, { email: 'bot@spam.test', _gotcha: 'x' });
    t.equal(res.statusCode, 200, 'bot sees success');
    t.equal((await store.listSignups('FOC27')).length, before, 'nothing added');
  });

  t.done && t.done();
})();
