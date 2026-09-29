// PUT IN: test/promopro-move-any.test.cjs
/**
 * PromoPro: "can move any order along", Sep 29 2026.
 *
 * Production staff (Margo) watch every order come through but are never the
 * account manager on one, so the move-own rule gave them nothing, and making
 * them a buyer would hand them prices, sending and cancelling. Now Settings
 * can name people who may move ANY order along: same fields as an AM on
 * their own order, on every order.
 *
 * The rule is called for real, then the real routes are driven with signed
 * sessions over a fake Upstash.
 *
 * Originally: PromoPro move-along, through the real purchase-order route.
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
    jacob:  { username: 'jacob',  name: 'Jacob Whitman', role: 'am', access: { apps: ['promopro'] } },
    alexis: { username: 'alexis', name: 'Alexis Davis',  role: 'am' },
    hannah: { username: 'hannah', name: 'Hannah Posey',  role: 'am' },
    viv:    { username: 'viv',    name: 'Viv Viewer',    role: 'viewer' },
    margo:  { username: 'margo',  name: 'Margo Niemeyer', role: 'production', access: { apps: ['promopro'] } },
    pat:    { username: 'pat',    name: 'Pat Production', role: 'production', access: { apps: ['promopro'] } },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({ id: 'EMP-1', name: 'Alexis Davis', username: 'alexis', email: 'alexis@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({ id: 'EMP-2', name: 'Hannah Posey', username: 'hannah', email: 'hannah@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({ id: 'EMP-3', name: 'Jacob Whitman', username: 'jacob', email: 'jacob@pmapparel.com', department: 'Sales', status: 'active' }));
  kv.set(CC + ':employee:EMP-4', JSON.stringify({ id: 'EMP-4', name: 'Viv Viewer', username: 'viv', email: 'viv@pmapparel.com', department: 'Sales', status: 'active' }));
  // Jacob is the only named buyer. Alexis and Hannah are AMs who are not.
  kv.set(PP + ':settings', JSON.stringify({ editUsers: ['jacob'], moveUsers: ['MARGO', 'viv'], accountManagerIds: ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4'] }));
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
  const m = await import(path.join(ROOT, 'lib/promopro/move-own.js'));
  const schema = await import(path.join(ROOT, 'lib/promopro/schema.js'));
  const route = (await import(path.join(ROOT, 'api/promopro/pos.js'))).default;
  const settingsRoute = (await import(path.join(ROOT, 'api/promopro/settings.js'))).default;

  const EDITOR = { name: 'production', label: 'Production', can_edit: true };
  const VIEWER = { name: 'viewer', label: 'Viewer', can_edit: false };
  const S = { moveUsers: ['margo'] };

  /* ---- the rule ------------------------------------------------------- */

  t.test('named in Settings: can move an order that is not theirs', () => {
    const v = m.moveVerdict({ canEdit: false, role: EDITOR, po: { accountManager: 'EMP-1' }, meId: 'EMP-5', username: 'margo', settings: S });
    t.equal(v.allowed, true);
    t.equal(v.full, false, 'moving along must never mean full edit');
  });

  t.test('the list ignores case and spaces', () => {
    t.equal(m.namedMover({ moveUsers: [' Margo '] }, 'MARGO'), true);
  });

  t.test('not named, not the AM: still no', () => {
    const v = m.moveVerdict({ canEdit: false, role: EDITOR, po: { accountManager: 'EMP-1' }, meId: 'EMP-6', username: 'pat', settings: S });
    t.equal(v.allowed, false);
  });

  t.test('named but read-only in the shell: still read-only', () => {
    const v = m.moveVerdict({ canEdit: false, role: VIEWER, po: {}, meId: '', username: 'margo', settings: S });
    t.equal(v.allowed, false);
  });

  t.test('no settings, empty list, blank username: nobody extra', () => {
    t.equal(m.namedMover(undefined, 'margo'), false);
    t.equal(m.namedMover({ moveUsers: [] }, 'margo'), false);
    t.equal(m.namedMover({ moveUsers: ['', 'margo'] }, ''), false);
  });

  t.test('the list is stored and validated like the buyer list', () => {
    t.equal(schema.withSettingDefaults({}).moveUsers.length, 0, 'default must be empty');
    const ok = schema.validateSettings({ moveUsers: [' Margo ', 'margo', '', 'Pat'] });
    t.equal(JSON.stringify((ok.patch || ok.record || {}).moveUsers), JSON.stringify(['margo', 'pat']));
    const bad = schema.validateSettings({ moveUsers: 'margo' });
    t.assert((bad.errors || []).length > 0, 'a non-list must be refused');
  });

  /* ---- through the real route ------------------------------------------ */

  await check('Margo can tick a step on somebody else\'s order', async () => {
    const res = await patch(route, 'margo', { id: 'po_1', receivedAt: '2026-09-29' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(stored().receivedAt, '2026-09-29');
  });

  await check('Margo can set carrier and tracking', async () => {
    const res = await patch(route, 'margo', { id: 'po_1', carrier: 'UPS', trackingNumber: '1Z999' });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.equal(stored().trackingNumber, '1Z999');
  });

  await check('Margo cannot change what the vendor was told', async () => {
    const res = await patch(route, 'margo', { id: 'po_1', notes: 'changed', shippedAt: '2026-09-29' });
    t.equal(res.statusCode, 403);
    t.equal(stored().notes, 'original');
    t.equal(stored().shippedAt, null, 'a refused PATCH must save nothing');
  });

  await check('Margo cannot cancel', async () => {
    const res = await patch(route, 'margo', { id: 'po_1', cancelledAt: '2026-09-29' });
    t.equal(res.statusCode, 403);
    t.equal(stored().cancelledAt, null);
  });

  await check('Margo cannot raise a PO', async () => {
    const cookie = await makeCookie(who('margo'));
    const res = fakeRes();
    await route({ method: 'POST', query: {}, body: JSON.stringify({ vendorId: 'v1', lines: [] }), headers: { cookie } }, res);
    t.equal(res.statusCode, 403);
  });

  await check('somebody not on the list still cannot', async () => {
    const res = await patch(route, 'pat', { id: 'po_1', receivedAt: '2026-09-29' });
    t.equal(res.statusCode, 403);
    t.equal(stored().receivedAt, null);
  });

  await check('a viewer on the list stays a viewer', async () => {
    const res = await patch(route, 'viv', { id: 'po_1', receivedAt: '2026-09-29' });
    t.equal(res.statusCode, 403);
  });

  /* ---- the screen is told the same answer ------------------------------ */

  async function settingsAs(u) {
    const cookie = await makeCookie(who(u));
    const res = fakeRes();
    await settingsRoute({ method: 'GET', query: {}, headers: { cookie } }, res);
    return res.body && res.body.settings;
  }

  await check('Settings tells Margo she can move any order, and Pat that he cannot', async () => {
    t.equal((await settingsAs('margo')).youCanMoveAny, true);
    t.equal((await settingsAs('pat')).youCanMoveAny, false);
    t.equal((await settingsAs('viv')).youCanMoveAny, false, 'read-only beats the list');
  });

  await check('the admin readout shows who can move any order', async () => {
    const s = await settingsAs('ryan');
    const row = (u) => (s.buyers || []).find((r) => r.username === u);
    t.assert(row('margo') && row('margo').canOpen, 'margo row missing'); t.assert(row('pat') && row('pat').canOpen, 'pat row missing');
    t.assert(row('jacob') && row('jacob').canOpen, 'jacob row missing');
    t.equal(row('margo').canMoveAny, true);
    t.equal(row('margo').canRaise, false, 'moving along must not read as buying');
    t.equal(row('pat').canMoveAny, false);
    t.equal(row('jacob').canMoveAny, true, 'a buyer can move anything');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL promopro-move-any could not run: ' + (e && e.stack || e));
  process.exit(1);
});
