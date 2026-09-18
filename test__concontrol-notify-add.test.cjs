// PUT IN: test/concontrol-notify-add.test.cjs
/**
 * ConControl notify list: adding people by hand (Sep 2026).
 *
 * Ryan's ask: the notify list only filled from the website form or a pasted
 * sheet, so a person met at a booth or on the phone had no way on. The route
 * is CALLED here with real signed sessions over a fake Upstash, not read for
 * the shape of its checks.
 *
 * The rules worth breaking a build over:
 *   - an email is required and must look like one; name and city are not
 *   - somebody already on the list is refused by name, whatever case the
 *     email was typed in, and a hand-added person dedupes against an imported
 *     one the same way
 *   - a hand-added person is marked as added by hand, with who did it
 *   - removing someone is admin only
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const kv = new Map();
const P = 'alliteration:';

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
        return { result: null };
      }),
    };
  }
  const setM = u.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-concontrol-notify';

function seedUsers() {
  kv.set(P + 'users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan', superuser: true },
    jo: { username: 'jo', name: 'Jo', access: { apps: ['concontrol'], can_edit: true } },
  }));
}

async function cookieFor(session) {
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

const RYAN = { username: 'ryan', name: 'Ryan' };
const JO = { username: 'jo', name: 'Jo' };

async function call(handler, as, { method = 'POST', query = {}, body = null } = {}) {
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie: await cookieFor(as) } }, res);
  return res;
}

(async () => {
  const resp = await import(path.join(ROOT, 'lib/concontrol/responses.js'));
  const { default: route } = await import(path.join(ROOT, 'api/concontrol/responses.js'));

  /* ---------------- the pure rule ---------------- */

  t.test('an email alone is enough', () => {
    const out = resp.manualSignup({ email: '  Pat@Shop.Test ' }, []);
    t.equal(out.error, undefined, 'no error');
    t.equal(out.answers.email, 'pat@shop.test', 'trimmed and lowercased');
    t.equal(out.answers.name, '', 'name optional');
  });

  t.test('no email, or a bad one, is refused in words', () => {
    t.assert(/email/i.test(resp.manualSignup({ name: 'Pat' }, []).error || ''), 'missing email');
    t.assert(/does not look like/.test(resp.manualSignup({ email: 'pat@shop' }, []).error || ''), 'malformed email');
  });

  t.test('somebody already on the list is caught, by name, in any case', () => {
    const existing = [{ id: 'NS-00001', answers: { name: 'Pat Lee', email: 'pat@shop.test' } }];
    const out = resp.manualSignup({ email: 'PAT@shop.test' }, existing);
    t.equal(out.duplicate, 'NS-00001', 'points at the existing record');
    t.assert(out.error.indexOf('Pat Lee') !== -1, 'and names who is already there');
  });

  t.test('only the three fields are kept', () => {
    const out = resp.manualSignup({ email: 'a@b.test', name: 'A', city_state: 'Ames, IA', source: 'x', secret: 1 }, []);
    t.equal(Object.keys(out.answers).sort().join(','), 'city_state,email,name', 'nothing else rides along');
  });

  /* ---------------- the route ---------------- */

  kv.clear();
  seedUsers();

  const added = await call(route, JO, { body: { what: 'add-signup', name: 'Pat Lee', email: 'Pat@Shop.test', city_state: 'Ames, IA' } });
  t.test('an editor can add someone', () => {
    t.equal(added.statusCode, 201, '201 created');
    t.equal(added.body.signup.answers.email, 'pat@shop.test', 'stored lowercased');
    t.equal(added.body.signup.source, 'manual', 'marked as added by hand');
    t.equal(added.body.signup.history[0].by, 'jo', 'with who did it');
  });

  const again = await call(route, RYAN, { body: { what: 'add-signup', email: 'pat@SHOP.test' } });
  t.test('adding them twice is a 409, not a second row', () => {
    t.equal(again.statusCode, 409, '409');
    t.assert(again.body.error.indexOf('Pat Lee') !== -1, 'names who is already there');
  });

  const bad = await call(route, RYAN, { body: { what: 'add-signup', name: 'No Email' } });
  t.test('no email is a 400', () => { t.equal(bad.statusCode, 400, '400'); });

  const imported = await call(route, RYAN, { body: { what: 'import-signups', csv: 'name,email,city_state\nPat Again,PAT@shop.test,Ames\nNew One,new@shop.test,' } });
  t.test('a later import dedupes against the hand-added person', () => {
    t.equal(imported.body.created, 1, 'only the new one');
    t.equal(imported.body.duplicate, 1, 'the hand-added one is recognised');
  });

  const list = await call(route, RYAN, { method: 'GET' });
  t.test('the list has two people, not three', () => {
    t.equal(list.body.signups.length, 2, 'two');
  });

  const id = added.body.signup.id;
  const joDrop = await call(route, JO, { method: 'DELETE', query: { id, kind: 'signup' } });
  t.test('removing someone is admin only', () => { t.equal(joDrop.statusCode, 403, 'an editor cannot'); });

  const ryanDrop = await call(route, RYAN, { method: 'DELETE', query: { id, kind: 'signup' } });
  const after = await call(route, RYAN, { method: 'GET' });
  t.test('an admin can', () => {
    t.equal(ryanDrop.statusCode, 200, '200');
    t.equal(after.body.signups.length, 1, 'one left');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL concontrol-notify-add could not run: ' + (e && e.stack || e));
  process.exit(1);
});
