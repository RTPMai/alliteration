// PUT IN: test/sitework-done-notice.test.cjs
/**
 * Checking off a sticky tells the person who made it (Ryan, Sep 28 2026:
 * "when I check off a sticky, please notify the person who made the sticky.
 * Not me for mine though").
 *
 * Driven through the real PATCH route against a mocked store, then read back
 * through the real notifications route, because the parts that matter (who
 * hears, and that nobody else can read it) only show up end to end.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const SW = 'sitework_data:';
const NT = 'notifications_data:';

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
      if (op === 'INCR') {
        const n = Number(kv.get(key) || 0) + 1;
        kv.set(key, String(n));
        return { result: n };
      }
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-sitework-done-notice';

function note(id, createdBy, extra) {
  return Object.assign({ id, title: 'Note ' + id, status: 'open', color: 'yellow',
    size: 'unknown', order: 0, createdBy }, extra || {});
}

function seed() {
  kv.clear();
  kv.set(P + 'roles', JSON.stringify({
    builder: { name: 'builder', label: 'Builder', apps: ['stickies'], can_edit: true },
    office:  { name: 'office',  label: 'Office',  apps: ['backbone'], can_edit: true },
  }));
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   role: 'admin', superuser: true },
    jacob:  { username: 'jacob',  name: 'Jacob',  role: 'builder' },
    dana:   { username: 'dana',   name: 'Dana',   role: 'builder' },
    amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
  }));
  const notes = [
    note('S-0001', 'jacob', { title: 'Rail breaks on mobile' }),
    note('S-0002', 'ryan'),
    note('S-0003', ''),                      // older note, maker unknown
    note('S-0004', 'amanda'),                // maker lost board access
    note('S-0005', 'jacob', { status: 'done' }),
    note('S-0006', 'dana'),
  ];
  kv.set(SW + 'index', JSON.stringify(notes.map((n) => n.id)));
  notes.forEach((n) => kv.set(SW + 'note:' + n.id, JSON.stringify(n)));
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
async function call(handler, { as, method, query = {}, body = null }) {
  const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
  const res = fakeRes();
  await handler(req, res);
  return res;
}
const RYAN  = { username: 'ryan',  name: 'Ryan',  role: 'admin' };
const JACOB = { username: 'jacob', name: 'Jacob', role: 'builder' };
const DANA  = { username: 'dana',  name: 'Dana',  role: 'builder' };

function notices() {
  return [...kv.keys()].filter((k) => k.startsWith(NT + 'note:')).map((k) => JSON.parse(kv.get(k)));
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const dn = await import(path.join(ROOT, 'lib/sitework/done-notice.js'));
  let route = null, inbox = null;
  try {
    route = (await import(path.join(ROOT, 'api/sitework.js'))).default;
    inbox = (await import(path.join(ROOT, 'api/notifications.js'))).default;
  } catch (e) {
    if (!/Cannot find package/.test(String(e && e.message))) throw e;
    console.log('  note: sticky check-off ROUTE tests skipped, node_modules not installed');
  }
  const done = (as, id) => call(route, { as, method: 'PATCH', query: { id }, body: { status: 'done' } });

  /* ---- the rule, called directly ------------------------------------- */
  const open = { status: 'open', createdBy: 'Jacob' };
  const closed = { status: 'done', createdBy: 'Jacob' };
  t.test('someone else checking off your note notifies you', () =>
    t.equal(dn.doneRecipient(open, closed, 'ryan'), 'jacob'));
  t.test('checking off your own note notifies nobody, case aside', () =>
    t.equal(dn.doneRecipient(open, closed, 'JACOB'), null));
  t.test('a note already done does not notify again', () =>
    t.equal(dn.doneRecipient(closed, closed, 'ryan'), null));
  t.test('reopening is not a check-off', () =>
    t.equal(dn.doneRecipient(closed, open, 'ryan'), null));
  t.test('a note with no maker notifies nobody', () =>
    t.equal(dn.doneRecipient({ status: 'open' }, { status: 'done' }, 'ryan'), null));

  if (!route) { process.exit(t.report()); }

  /* ---- through the route --------------------------------------------- */
  seed();
  await check('Ryan checking off Jacob\'s sticky notifies Jacob, privately, linked to the note', async () => {
    const r = await done(RYAN, 'S-0001');
    t.equal(r.statusCode, 200);
    const list = notices();
    t.equal(list.length, 1, 'exactly one notification');
    const n = list[0];
    t.equal(n.assignedTo, 'jacob');
    t.equal(n.visibility, 'private', 'the build list stays off the team inbox');
    t.equal(n.link && n.link.type, 'sticky');
    t.equal(n.link && n.link.id, 'S-0001');
    t.assert(/Rail breaks on mobile/.test(n.title), 'title names the sticky');
    t.assert(/Ryan/.test(n.detail), 'detail says who checked it off');
  });

  await check('Jacob sees it in his inbox; Dana and Ryan do not', async () => {
    const seen = async (as) => {
      const r = await call(inbox, { as, method: 'GET' });
      const arr = (r.body && (r.body.notifications || r.body.items)) || [];
      return arr.some((n) => n.link && n.link.id === 'S-0001');
    };
    t.assert(await seen(JACOB), 'Jacob should see it');
    t.assert(!(await seen(DANA)), 'Dana should not');
    t.assert(!(await seen(RYAN)), 'Ryan should not, admin or not');
  });

  seed();
  await check('Ryan checking off his own sticky notifies nobody', async () => {
    t.equal((await done(RYAN, 'S-0002')).statusCode, 200);
    t.equal(notices().length, 0);
  });

  seed();
  await check('Jacob checking off Ryan\'s sticky notifies Ryan', async () => {
    t.equal((await done(JACOB, 'S-0002')).statusCode, 200);
    const list = notices();
    t.equal(list.length, 1);
    t.equal(list[0].assignedTo, 'ryan');
  });

  seed();
  await check('no maker on record, maker without board access, or already done: nothing raised', async () => {
    await done(RYAN, 'S-0003');
    await done(RYAN, 'S-0004');
    await done(RYAN, 'S-0005');
    t.equal(notices().length, 0);
  });

  seed();
  await check('editing a note without checking it off notifies nobody', async () => {
    await call(route, { as: RYAN, method: 'PATCH', query: { id: 'S-0006' }, body: { title: 'Renamed' } });
    t.equal(notices().length, 0);
  });

  seed();
  await check('a notification that cannot be saved does not fail the check-off', async () => {
    const real = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).endsWith('/pipeline') && String(opts && opts.body).includes(NT)) throw new Error('kv down');
      return real(url, opts);
    };
    try {
      const r = await done(RYAN, 'S-0006');
      t.equal(r.statusCode, 200);
      t.equal(r.body.note.status, 'done');
    } finally { global.fetch = real; }
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL sitework-done-notice could not run: ' + ((e && e.stack) || e));
  process.exit(1);
});
