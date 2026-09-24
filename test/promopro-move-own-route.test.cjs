// PUT IN: test/promopro-move-own-route.test.cjs
/**
 * PromoPro move-along, through the real purchase-order route.
 *
 * Signed sessions over a fake Upstash, so what is tested is what an account
 * manager's browser would actually get back: their own order ticks, somebody
 * else's does not, and nothing but progress gets through.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* ---- fake Upstash: get, set, pipeline ---------------------------------- */

const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';
const PP = 'promopro_data';

const ok = (result) => ({ ok: true, status: 200, json: async () => result });

global.fetch = async (url, opts) => {
  const raw = String(url);
  if (/\/pipeline$/.test(raw)) {
    const cmds = JSON.parse(opts.body);
    return ok(cmds.map(([op, key, val]) => {
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      return { result: null };
    }));
  }
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return ok({ result: 'OK' });
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return ok({ result: kv.has(key) ? kv.get(key) : null });
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-promopro-move-own';

const PO = {
  id: 'po_1', poNumber: '26-66601', year: '26', vendorId: 'v1',
  accountManager: 'EMP-1', owner: 'jacob', createdAt: '2026-09-01T00:00:00.000Z',
  lines: [{ description: 'Mugs', qty: 10, unitCost: 0 }],
  submittedAt: '2026-09-01', confirmedAt: null, artApprovedAt: null, paymentSentAt: null,
  shippedAt: null, receivedAt: null, closedAt: null, cancelledAt: null,
  carrier: '', trackingNumber: '', notes: 'original', history: [],
};

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan Toney',   role: 'admin', superuser: true },
    jacob:  { username: 'jacob',  name: 'Jacob Whitman', role: 'am' },
    alexis: { username: 'alexis', name: 'Alexis Davis',  role: 'am' },
    hannah: { username: 'hannah', name: 'Hannah Posey',  role: 'am' },
    viv:    { username: 'viv',    name: 'Viv Viewer',    role: 'viewer' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({ id: 'EMP-1', name: 'Alexis Davis', username: 'alexis', email: 'alexis@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({ id: 'EMP-2', name: 'Hannah Posey', username: 'hannah', email: 'hannah@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({ id: 'EMP-3', name: 'Jacob Whitman', username: 'jacob', email: 'jacob@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-4', JSON.stringify({ id: 'EMP-4', name: 'Viv Viewer', username: 'viv', email: 'viv@pmapparel.com', department: 'Sales', status: 'active' }));
  // Jacob is the only named buyer. Alexis and Hannah are AMs who are not.
  kv.set(PP + ':settings', JSON.stringify({ editUsers: ['jacob'], accountManagerIds: ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4'] }));
  kv.set(PP + ':vendors', JSON.stringify([{ id: 'v1', name: 'Vendor One', email: 'v@x.test' }]));
  kv.set(PP + ':index', JSON.stringify(['po_1']));
  kv.set(PP + ':po:po_1', JSON.stringify({ ...PO, accountManager: 'EMP-1' }));
}

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

const who = (username) => ({ username });

async function patch(route, as, body) {
  const cookie = await makeCookie(who(as));
  const res = fakeRes();
  await route({ method: 'PATCH', query: {}, body: JSON.stringify(body), headers: { cookie } }, res);
  return res;
}

const stored = () => JSON.parse(kv.get(PP + ':po:po_1'));

async function check(name, fn) {
  let err = null;
  try { seed(); await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const route = (await import(path.join(ROOT, 'api/promopro/pos.js'))).default;

  await check('the AM on the order can tick a step', async () => {
    const res = await patch(route, 'alexis', { id: 'po_1', confirmedAt: '2026-09-24' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(stored().confirmedAt, '2026-09-24');
    const last = stored().history.slice(-1)[0];
    t.equal(last && last.by, 'alexis', 'the history should say who moved it');
  });

  await check('the AM on the order can set carrier and tracking', async () => {
    const res = await patch(route, 'alexis', { id: 'po_1', carrier: 'UPS', trackingNumber: '1Z999', shippedAt: '2026-09-24' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(stored().trackingNumber, '1Z999');
  });

  await check('the AM on the order can log a follow-up', async () => {
    const res = await patch(route, 'alexis', { id: 'po_1', followUp: { method: 'called', note: 'said Friday' } });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.assert(stored().lastFollowUpAt, 'follow-up not recorded');
  });

  await check('a different AM cannot touch it', async () => {
    const res = await patch(route, 'hannah', { id: 'po_1', confirmedAt: '2026-09-24' });
    t.equal(res.statusCode, 403);
    t.equal(stored().confirmedAt, null, 'the refused tick must not have saved');
  });

  await check('the AM on the order cannot change what was ordered', async () => {
    const res = await patch(route, 'alexis', { id: 'po_1', confirmedAt: '2026-09-24', notes: 'rewritten' });
    t.equal(res.statusCode, 403);
    t.assert(/notes/.test(res.body.error), 'refusal should name the field: ' + res.body.error);
    t.equal(stored().notes, 'original');
    t.equal(stored().confirmedAt, null, 'half a refused patch must not save');
  });

  await check('the AM on the order cannot cancel it', async () => {
    const res = await patch(route, 'alexis', { id: 'po_1', cancelledAt: '2026-09-24' });
    t.equal(res.statusCode, 403);
    t.equal(stored().cancelledAt, null);
  });

  await check('a read-only account cannot move even an order it is on', async () => {
    kv.set(PP + ':po:po_1', JSON.stringify({ ...PO, accountManager: 'EMP-4' }));
    const res = await patch(route, 'viv', { id: 'po_1', confirmedAt: '2026-09-24' });
    t.equal(res.statusCode, 403);
  });

  await check('an AM still cannot raise a new purchase order', async () => {
    const cookie = await makeCookie(who('alexis'));
    const res = fakeRes();
    await route({ method: 'POST', query: {}, body: JSON.stringify({ vendorId: 'v1', accountManager: 'EMP-1', lines: [{ description: 'x', qty: 1 }] }), headers: { cookie } }, res);
    t.equal(res.statusCode, 403);
  });

  await check('a buyer can still edit anything', async () => {
    const res = await patch(route, 'jacob', { id: 'po_1', notes: 'buyer edit' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(stored().notes, 'buyer edit');
  });
})();
