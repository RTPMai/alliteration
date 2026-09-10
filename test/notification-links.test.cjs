// PUT IN: test/notification-links.test.cjs
/**
 * Notification record links: the picker follows the app tag, and two new
 * kinds of record can be linked (Ryan's ask, Sep 2026).
 *
 * The picker used to offer every searchable record type no matter what the
 * notification was tagged with, so "which app is this about" and "which record
 * is this about" were two questions with mostly the same answer. Ticking
 * PromoPro is now what puts purchase orders in the list.
 *
 * These are real calls: linkTypesForApps() is called for real, and the search
 * goes through the real api/notifications.js route against a mocked store. The
 * sticky branch especially, because that one is a permission question and the
 * board is not open to the whole team the way the rest of these records are.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const SW = 'sitework_data:';    // lib/sitework/schema.js KEY_PREFIX
const PP = 'promopro_data:';    // lib/promopro/schema.js KEY_PREFIX

/* ---- the store --------------------------------------------------------- */

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
process.env.SESSION_SECRET = 'test-secret-for-notification-links';

function seed() {
  kv.clear();
  kv.set(P + 'roles', JSON.stringify({
    builder: { name: 'builder', label: 'Builder', apps: ['backbone', 'promopro', 'stickies'], can_edit: true },
    office:  { name: 'office',  label: 'Office',  apps: ['backbone', 'promopro'], can_edit: true },
  }));
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   role: 'admin', superuser: true },
    dana:   { username: 'dana',   name: 'Dana',   role: 'builder' },
    amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
  }));

  // Two purchase orders, one with a company on it and one raised by hand.
  kv.set(PP + 'index', JSON.stringify(['po_a', 'po_b']));
  kv.set(PP + 'po:po_a', JSON.stringify({
    id: 'po_a', poNumber: '26-66608-9', createdAt: '2026-09-01T12:00:00.000Z',
    vendorId: 'v1', submittedAt: '2026-09-01T13:00:00.000Z',
    printavo: { companyName: 'Hy-Vee', customerName: 'Jill Stevents' },
  }));
  kv.set(PP + 'po:po_b', JSON.stringify({
    id: 'po_b', poNumber: '26-70001-1', createdAt: '2026-09-05T12:00:00.000Z',
    vendorId: 'v2', printavo: {},
  }));

  // Three stickies, one of them already done.
  kv.set(SW + 'index', JSON.stringify(['SN-00001', 'SN-00002', 'SN-00003']));
  kv.set(SW + 'note:SN-00001', JSON.stringify({
    id: 'SN-00001', title: 'Fix the rail on mobile', status: 'open', color: 'yellow', appId: 'backbone',
  }));
  kv.set(SW + 'note:SN-00002', JSON.stringify({
    id: 'SN-00002', title: 'Capacity view', detail: 'open jobs per AM', status: 'open', color: 'blue',
  }));
  kv.set(SW + 'note:SN-00003', JSON.stringify({
    id: 'SN-00003', title: 'Favicon', status: 'done', color: 'grey',
  }));
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

async function search(route, as, type, q) {
  const req = {
    method: 'GET',
    query: { linkSearch: type, q: q || '' },
    headers: { cookie: await makeCookie(as) },
  };
  const res = fakeRes();
  await route(req, res);
  return res;
}

const RYAN   = { username: 'ryan',   name: 'Ryan',   role: 'admin' };
const DANA   = { username: 'dana',   name: 'Dana',   role: 'builder' };
const AMANDA = { username: 'amanda', name: 'Amanda', role: 'office' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const schema = await import(path.join(ROOT, 'lib/notifications/schema.js'));
  const {
    LINK_TYPES, LINK_TYPE_APP, PICKABLE_LINK_TYPES,
    linkTypesForApps, appForLinkType, validateNew,
  } = schema;
  const registry = await import(path.join(ROOT, 'js/registry.js'));
  const route = (await import(path.join(ROOT, 'api/notifications.js'))).default;

  seed();

  /* ---- the picker follows the app tags --------------------------------- */

  t.test('ticking PromoPro offers purchase orders and nothing else', () => {
    t.equal(JSON.stringify(linkTypesForApps(['promopro'])), JSON.stringify(['po']),
      'PromoPro should offer exactly one kind of record');
  });

  t.test('ticking StickySituations offers stickies', () => {
    t.equal(JSON.stringify(linkTypesForApps(['stickies'])), JSON.stringify(['sticky']),
      'the board should offer its own notes');
  });

  t.test('BackBone still offers both of its pickable records', () => {
    const got = linkTypesForApps(['backbone']);
    t.assert(got.includes('inquiry') && got.includes('client'),
      'BackBone should still offer inquiries and clients');
    t.assert(!got.includes('lead'),
      'lead stopped being pickable when Inbox and Leads merged; it must not come back through this door');
  });

  t.test('two apps ticked offers both apps records', () => {
    const got = linkTypesForApps(['promopro', 'stickies']);
    t.assert(got.includes('po') && got.includes('sticky'), 'expected records from both apps');
    t.equal(got.length, 2, 'and nothing from apps that were not ticked');
  });

  t.test('nothing ticked offers nothing', () => {
    // Offering everything when nothing is chosen puts back the picker this
    // replaced, for exactly the person who has not decided yet.
    t.equal(linkTypesForApps([]).length, 0, 'an empty selection should offer no link types');
    t.equal(linkTypesForApps(null).length, 0, 'a missing selection should not throw or offer everything');
  });

  t.test('General carries no records', () => {
    t.equal(linkTypesForApps(['general']).length, 0,
      '"restock the front office coffee" has nothing to point at');
  });

  t.test('an app with no linkable records offers none', () => {
    t.equal(linkTypesForApps(['mailme', 'websitewidget']).length, 0,
      'only apps in LINK_TYPE_APP should offer anything');
  });

  /* ---- the table itself ------------------------------------------------ */

  t.test('every link type names a real app', () => {
    // A type whose app does not exist is a link that saves and then goes
    // nowhere, which is worse than not offering it at all.
    const ids = registry.APPS.map((a) => a.id)
      .concat(registry.SITE_APPS.map((a) => a.id))
      .concat(registry.SHELL_APPS.map((a) => a.id));
    LINK_TYPES.forEach((type) => {
      t.assert(ids.includes(LINK_TYPE_APP[type]),
        'link type ' + type + ' points at "' + LINK_TYPE_APP[type] + '", which is not an app');
    });
  });

  t.test('appForLinkType answers empty for a type this build does not know', () => {
    t.equal(appForLinkType('nonsense'), '', 'an unknown type must not resolve to some app');
    t.equal(appForLinkType(undefined), '', 'and neither must nothing at all');
  });

  t.test('every pickable type can actually be searched', () => {
    // PICKABLE is what the form offers; the route allowlist is built from the
    // same constant. This checks the third leg: a branch in searchLinkable.
    const src = require('fs').readFileSync(path.join(ROOT, 'api/notifications.js'), 'utf8');
    PICKABLE_LINK_TYPES.forEach((type) => {
      t.assert(src.includes('type === "' + type + '"'),
        'searchLinkable has no branch for pickable type ' + type);
    });
  });

  /* ---- purchase orders ------------------------------------------------- */

  await check('a PO is findable by its number', async () => {
    const res = await search(route, AMANDA, 'po', '66608');
    t.equal(res.statusCode, 200, 'the search should answer, got ' + res.statusCode);
    const hits = res.body.results;
    t.equal(hits.length, 1, 'expected one match on the PO number');
    t.equal(hits[0].id, 'po_a', 'and it should be the order carrying that number');
    t.assert(/Hy-Vee/.test(hits[0].sublabel), 'the company belongs on the line so two numbers can be told apart');
  });

  await check('a PO is findable by the company it is for', async () => {
    // The number is what somebody holding the paper searches by; the company
    // is what somebody who only knows whose order it is searches by.
    const res = await search(route, AMANDA, 'po', 'hy-vee');
    t.equal(res.body.results.length, 1, 'expected the Hy-Vee order');
    t.equal(res.body.results[0].id, 'po_a', 'matched the wrong order');
  });

  await check('an empty search lists orders newest first', async () => {
    const res = await search(route, AMANDA, 'po', '');
    t.equal(res.body.results.length, 2, 'expected both orders');
    t.equal(res.body.results[0].id, 'po_b',
      'newest first: a PO being linked to is almost always a live one');
  });

  await check('a manual order with no company still gets a usable line', async () => {
    const res = await search(route, AMANDA, 'po', '70001');
    t.equal(res.body.results.length, 1, 'expected the manual order');
    t.assert(!!res.body.results[0].label, 'a result with no label cannot be picked from a list');
    t.assert(res.body.results[0].sublabel.includes('Manual order'),
      'an order with no Printavo company should say so rather than showing a blank');
  });

  /* ---- stickies, which are NOT open to everyone ------------------------ */

  await check('somebody without the board gets nothing back', async () => {
    // Amanda can open PromoPro but has no Site Work grant. The titles on that
    // board are the build plan, not a team hand-off list.
    const res = await search(route, AMANDA, 'sticky', '');
    t.equal(res.statusCode, 200, 'a refusal here is an empty list, not an error');
    t.equal(res.body.results.length, 0, 'the board leaked to somebody without the grant');
  });

  await check('a role with the box ticked can search the board', async () => {
    const res = await search(route, DANA, 'sticky', '');
    t.assert(res.body.results.length > 0, 'a granted role should be able to search the board');
  });

  await check('the Admin flag can search the board', async () => {
    const res = await search(route, RYAN, 'sticky', 'rail');
    t.equal(res.body.results.length, 1, 'expected one match on the title');
    t.equal(res.body.results[0].id, 'SN-00001', 'matched the wrong note');
  });

  await check('a note is findable by its detail, not just its title', async () => {
    const res = await search(route, RYAN, 'sticky', 'open jobs');
    t.equal(res.body.results.length, 1, 'the detail line should be searchable too');
    t.equal(res.body.results[0].id, 'SN-00002', 'matched the wrong note');
  });

  await check('a note already ticked off is not offered', async () => {
    // Linking a hand-off to a finished note points somebody at something that
    // has already been dealt with.
    const res = await search(route, RYAN, 'sticky', 'favicon');
    t.equal(res.body.results.length, 0, 'a done note should not be offered as a link target');
  });

  /* ---- the route allowlist --------------------------------------------- */

  await check('an unknown search type is refused', async () => {
    const res = await search(route, RYAN, 'employee', '');
    t.equal(res.statusCode, 400, 'an unknown linkSearch type should be refused, got ' + res.statusCode);
  });

  await check('lead can still be searched for links already on file', async () => {
    const res = await search(route, RYAN, 'lead', '');
    t.equal(res.statusCode, 200, 'lead left the picker but must not start erroring');
  });

  /* ---- storing one ----------------------------------------------------- */

  t.test('a notification can carry a link to a purchase order', () => {
    const { ok, record } = validateNew(
      { title: 'Chase this one', types: ['task'], appIds: ['promopro'], assignedTo: 'ryan',
        link: { type: 'po', id: 'po_a', label: '26-66608-9' } },
      ['promopro', 'general'], ['ryan']
    );
    t.assert(ok, 'a PO link should validate');
    t.equal(record.link.type, 'po', 'the link type should survive validation');
    t.equal(record.link.id, 'po_a', 'the id should survive validation');
  });

  t.test('a notification can carry a link to a sticky', () => {
    const { ok, record } = validateNew(
      { title: 'This one graduated', types: ['task'], appIds: ['stickies'], assignedTo: 'ryan',
        link: { type: 'sticky', id: 'SN-00002', label: 'Capacity view' } },
      ['stickies', 'general'], ['ryan']
    );
    t.assert(ok, 'a sticky link should validate');
    t.equal(record.link.id, 'SN-00002', 'the id should survive validation');
  });

  /* ---- where a link opens ---------------------------------------------- */

  t.test('every link type has somewhere to open', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'apps/notifications.js'), 'utf8');
    const table = src.slice(src.indexOf('const LINK_ROUTE'), src.indexOf('const LINK_SEARCH_HINT'));
    LINK_TYPES.forEach((type) => {
      t.assert(new RegExp('\\b' + type + ':\\s*\\{').test(table),
        'LINK_ROUTE has no destination for link type ' + type);
    });
  });

  t.test('the pill checks access before offering to open anything', () => {
    // Notifications are visible to the team; StickySituations is not. Without
    // this the whole team sees an arrow that only ever produces a refusal.
    const src = require('fs').readFileSync(path.join(ROOT, 'apps/notifications.js'), 'utf8');
    t.assert(src.includes('canAccess(ctx.perms'),
      'the link pill should ask canAccess before rendering as a button');
    t.assert(src.includes('linkOpenable'),
      'there should be a single decision about whether the link is openable');
  });

  t.test('StickySituations can open one note from a route param', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'apps/stickies.js'), 'utf8');
    t.assert(/showView\(view,\s*param\)/.test(src),
      'stickies needs showView(view, param) or a link into it lands on the board and stops');
    t.assert(src.includes('_openNote'), 'no way in from outside the mount closure');
    t.assert(src.includes("filterApp = 'all'"),
      'arriving at a filtered board with the linked note hidden reads exactly like a broken link');
  });
})();
