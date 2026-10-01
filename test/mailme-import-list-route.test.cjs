// PUT IN: test/mailme-import-list-route.test.cjs
/**
 * MailMe: upload to a list, through the real import route (Oct 1 2026).
 *
 * The Holiday Store upload: a list already holding the 7 prospects from the
 * first try, and a file of those 7 plus clients. The preview must say what
 * the list will hold before and after, and the commit must leave the list
 * holding everyone, written by the server in the same request.
 *
 * Signed session over a fake Upstash, so this is what the browser gets back.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

const kv = new Map();
const P = 'alliteration:';
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
process.env.SESSION_SECRET = 'test-secret-for-mailme-import-list';

const CLIENTS = 5;
const OLD = 3;

function seed(MM) {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    ryan: { username: 'ryan', name: 'Ryan', role: 'admin', superuser: true },
  }));
  const synced = Array.from({ length: CLIENTS }, (_, i) => ({
    customer_id: String(100 + i), company_name: 'Client ' + i,
    primary_contact: { name: 'C ' + i, email: `c${i}@client.com` },
  }));
  synced.forEach((c, i) => { c.total_revenue = 1000 * (i + 1); c.invoice_count = i + 1; });
  const enrichment = { '100': { industry: 'Healthcare' }, '101': { industry: 'Church' }, '102': { industry: 'healthcare' } };
  kv.set('backbone_data', JSON.stringify({ synced, enrichment }));
  const prospects = {};
  for (let i = 0; i < OLD; i++) {
    prospects['P' + i] = { prospect_id: 'P' + i, email: `old${i}@p.com`, company_name: 'Old ' + i, tags: [] };
  }
  kv.set(MM.prospects(), JSON.stringify(prospects));
  kv.set(MM.lists(), JSON.stringify([{
    id: 'LS-00001', name: 'Holiday Store Prospects', kind: 'static',
    members: Object.keys(prospects).map((id) => 'prospect:' + id),
  }]));
}

const CSV = ['Email,Company']
  .concat(Array.from({ length: CLIENTS }, (_, i) => `c${i}@client.com,Client ${i}`))
  .concat(Array.from({ length: OLD }, (_, i) => `old${i}@p.com,Old ${i}`))
  .concat(['brand.new@fresh.com,Fresh Co', 'noreply@junk.com,Junk'])
  .join('\n');

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

(async () => {
  const { keys: MM } = await import(path.join(ROOT, 'lib/mailme/schema.js'));
  const route = (await import(path.join(ROOT, 'api/mailme/import.js'))).default;
  const cookie = await makeCookie({ username: 'ryan' });
  const post = async (body) => {
    const res = fakeRes();
    await route({ method: 'POST', query: {}, body: JSON.stringify(body), headers: { cookie } }, res);
    return res;
  };
  const savedList = () => JSON.parse(kv.get(MM.lists())).find((l) => l.name === 'Holiday Store Prospects');

  await t.test('the preview says what the list holds now and after, and adds nothing', async () => {
    seed(MM);
    const r = await post({ csv: CSV, listName: 'holiday store prospects' });
    t.equal(r.statusCode, 200);
    const p = r.body.listPlan;
    t.assert(p && p.exists, 'the existing list was not found by name');
    t.equal(p.before, OLD);
    t.equal(p.addingExisting, CLIENTS, 'clients to add');
    t.equal(p.alreadyOn, OLD, 'the 3 already on the list');
    t.equal(p.addingNew, 1);
    t.equal(p.after, OLD + CLIENTS + 1);
    t.equal(savedList().members.length, OLD, 'a preview must not touch the list');
  });

  await t.test('the commit imports the new person and puts everyone on the list in one go', async () => {
    seed(MM);
    const r = await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    t.equal(r.statusCode, 201);
    t.equal(r.body.imported, 1);
    t.equal(r.body.list.memberCount, OLD + CLIENTS + 1);
    t.equal(r.body.list.added, CLIENTS + 1);
    t.equal(r.body.list.alreadyOn, OLD);
    t.equal(r.body.listError, null);
    const members = savedList().members;
    t.equal(members.length, OLD + CLIENTS + 1, 'stored list size');
    t.assert(members.includes('client:100'), 'a client is missing from the stored list');
    t.equal(JSON.parse(kv.get(MM.lists())).length, 1, 'a second list with the same name was made');
  });

  await t.test('running the same file again changes nothing and says so', async () => {
    seed(MM);
    await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    const again = await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    t.equal(again.statusCode, 400);
    t.assert(/already on "Holiday Store Prospects"/.test(again.body.error), again.body.error);
  });

  await t.test('a new list name creates the list with everyone on it', async () => {
    seed(MM);
    const r = await post({ csv: CSV, listName: 'Spring Schools', commit: true });
    t.equal(r.statusCode, 201);
    t.equal(r.body.list.created, true);
    t.equal(r.body.list.memberCount, OLD + CLIENTS + 1);
  });

  await t.test('the invalid row never lands on the list', async () => {
    seed(MM);
    await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    t.assert(!kv.get(MM.prospects()).includes('noreply@junk.com'), 'noreply@ was imported');
    const ids = new Set(savedList().members);
    t.equal(ids.size, OLD + CLIENTS + 1, 'only the valid rows are on the list');
  });

  /* ---- filtering and sorting inside a list, through the real list route ---- */
  const listsRoute = (await import(path.join(ROOT, 'api/mailme/lists.js'))).default;
  const getList = async (query) => {
    const res = fakeRes();
    await listsRoute({ method: 'GET', query, headers: { cookie } }, res);
    return res;
  };

  await t.test('a list filtered by industry shows only those, but still reports the whole list', async () => {
    seed(MM);
    await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    const r = await getList({ id: 'LS-00001', industry: 'healthcare' });
    t.equal(r.statusCode, 200);
    t.equal(r.body.members.map((m) => m.id).sort().join(','), 'client:100,client:102');
    t.equal(r.body.memberCount, OLD + CLIENTS + 1, 'the count must stay the whole list');
    t.equal(r.body.memberIds.length, OLD + CLIENTS + 1, 'already-on-list checks need every id');
    t.equal(r.body.filtered, true);
  });

  await t.test('a list sorted by top clients puts the biggest spender first', async () => {
    seed(MM);
    await post({ csv: CSV, listName: 'Holiday Store Prospects', commit: true });
    const r = await getList({ id: 'LS-00001', sort: 'lifetimeRevenue', dir: 'desc' });
    t.equal(r.body.members[0].id, 'client:' + (100 + CLIENTS - 1));
    t.assert(r.body.members[0].tier, 'clients carry their Scorecard tier');
    t.equal(r.body.filtered, false);
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
