// PUT IN: test/mailme-delete-sent.test.cjs
/**
 * Admins can delete sends that already went out (Sep 24 2026).
 *
 * Test sends piled up on the Sends list with no way to clear them, because a
 * sent campaign could never be deleted by anyone. Now an Admin (the account's
 * superuser flag, strictly true) can. Everyone else keeps the old rule:
 * drafts only.
 *
 * Real route calls against a mocked store. What is locked:
 *   - who: Admin yes; MailMe editor no; a non-boolean "superuser" no
 *   - what: the send and its report go; unsubscribes and the contact's
 *     "last emailed" record stay
 *   - when: never while it is still going out
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const CAMPAIGNS = 'mailme_data:campaigns';
const EVENTS = (id) => 'mailme_data:events:' + id;

const kv = new Map();
global.fetch = async (url, opts) => {
  const u = String(url);
  const get = u.match(/\/get\/(.+)$/);
  if (get) {
    const key = decodeURIComponent(get[1]);
    return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
  }
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse((opts && opts.body) || '[]');
    const out = cmds.map(([op, key, val]) => {
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'DEL') { kv.delete(key); return { result: 1 }; }
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-mailme-delete';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   superuser: true, access: { apps: [] } },
    abby:   { username: 'abby',   name: 'Abby',   access: { apps: ['mailme'], can_edit: true } },
    sneaky: { username: 'sneaky', name: 'Sneaky', superuser: 'true', access: { apps: ['mailme'], can_edit: true } },
    viewer: { username: 'viewer', name: 'Viewer', access: { apps: ['mailme'], can_edit: false } },
  }));
  kv.set(CAMPAIGNS, JSON.stringify([
    { id: 'MM-00001', status: 'sent', subject: 'Buncha Butts', sentAt: '2026-08-14T00:00:00Z' },
    { id: 'MM-00002', status: 'draft', subject: 'Draft' },
    { id: 'MM-00003', status: 'sending', subject: 'Going out now' },
    { id: 'MM-00004', status: 'scheduled', subject: 'Later' },
  ]));
  kv.set(EVENTS('MM-00001'), JSON.stringify([{ type: 'click', contactId: 'client:1', linkUrl: 'https://x.com' }]));
  // Stand-ins for what must survive: a contact's unsubscribe and send log.
  kv.set('mailme_data:suppression', JSON.stringify({ 'dana@x.com': { reason: 'unsubscribed' } }));
  kv.set('mailme_data:sendlog', JSON.stringify({ 'client:1': '2026-08-14T00:00:00Z' }));
}

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

async function del(route, who, id) {
  const req = { method: 'DELETE', query: { id }, body: null, headers: { cookie: await makeCookie({ username: who }) } };
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await route(req, res);
  return res;
}

const ids = () => JSON.parse(kv.get(CAMPAIGNS)).map((c) => c.id);

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const access = await import(path.join(ROOT, 'lib/mailme/access.js'));
  const route = (await import(path.join(ROOT, 'api/mailme/campaigns.js'))).default;

  await check('the rule, called directly', () => {
    const admin = { superuser: true };
    const editor = { tabs: ['mailme'] };
    t.equal(access.deleteDecision({ status: 'sent' }, admin, true).ok, true, 'admin, sent');
    t.equal(access.deleteDecision({ status: 'sent' }, editor, true).status, 403, 'editor, sent');
    t.equal(access.deleteDecision({ status: 'sent' }, { superuser: 'true' }, true).status, 403, 'a string is not true');
    t.equal(access.deleteDecision({ status: 'sent' }, { superuser: 1 }, true).status, 403, 'neither is 1');
    t.equal(access.deleteDecision({ status: 'draft' }, editor, true).ok, true, 'editor, draft');
    t.equal(access.deleteDecision({ status: 'draft' }, editor, false).status, 403, 'viewer, draft');
    t.equal(access.deleteDecision({ status: 'sending' }, admin, true).status, 409, 'nobody mid-send');
    t.equal(access.deleteDecision(null, admin, true).status, 404);
  });

  await check('an Admin deletes a sent campaign, and its report goes with it', async () => {
    seed();
    const res = await del(route, 'ryan', 'MM-00001');
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.assert(!ids().includes('MM-00001'), 'campaign still listed');
    t.assert(!kv.has(EVENTS('MM-00001')), 'its events (the report) should be gone');
  });

  await check('unsubscribes and send history survive the delete', async () => {
    seed();
    await del(route, 'ryan', 'MM-00001');
    t.assert(kv.has('mailme_data:suppression') && kv.has('mailme_data:sendlog'), 'contact records must stay');
    t.equal(ids().length, 3, 'only the one campaign removed');
  });

  await check('an Admin can delete a scheduled one too', async () => {
    seed();
    t.equal((await del(route, 'ryan', 'MM-00004')).statusCode, 200);
  });

  await check('a MailMe editor still cannot delete a sent campaign', async () => {
    seed();
    const res = await del(route, 'abby', 'MM-00001');
    t.equal(res.statusCode, 403);
    t.assert(/Admin/.test(res.body.error), 'says who can');
    t.assert(ids().includes('MM-00001') && kv.has(EVENTS('MM-00001')), 'nothing removed');
  });

  await check('a truthy but non-boolean superuser is not an Admin', async () => {
    seed();
    t.equal((await del(route, 'sneaky', 'MM-00001')).statusCode, 403);
    t.assert(ids().includes('MM-00001'), 'nothing removed');
  });

  await check('nobody deletes a send that is still going out', async () => {
    seed();
    t.equal((await del(route, 'ryan', 'MM-00003')).statusCode, 409);
    t.assert(ids().includes('MM-00003'), 'nothing removed');
  });

  await check('drafts work as before: editors yes, view-only no', async () => {
    seed();
    t.equal((await del(route, 'viewer', 'MM-00002')).statusCode, 403);
    t.assert(ids().includes('MM-00002'), 'viewer removed nothing');
    t.equal((await del(route, 'abby', 'MM-00002')).statusCode, 200);
    t.assert(!ids().includes('MM-00002'), 'editor deleted the draft');
  });

  await check('an unknown id is a 404', async () => {
    seed();
    t.equal((await del(route, 'ryan', 'MM-09999')).statusCode, 404);
  });

  await check('the Sends list offers Delete only where the server would allow it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/mailme.js'), 'utf8');
    t.assert(/const isAdminUI = \(\) => !!\(ctx\.perms && ctx\.perms\.superuser === true\);/.test(src), 'strict admin check');
    t.assert(/c\.status !== 'sending' &&\s*\(c\.status === 'draft' \? canEditUI\(\) : isAdminUI\(\)\)/.test(src), 'mirrors deleteDecision');
    t.assert(/data-delete=/.test(src), 'list has a delete button');
    t.assert(!/wire\('#mmDeleteCampaign', deleteCampaign\)/.test(src), 'the click event must not be passed as an id');
  });

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run mailme delete tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
