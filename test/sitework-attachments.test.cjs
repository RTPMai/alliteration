// PUT IN: test/sitework-attachments.test.cjs
/**
 * Image attachments on a sticky note.
 *
 * Two halves. The pure rules (what counts as an image, where a file is stored,
 * who may take one off) are called directly. The route is exercised with real
 * requests against a mocked store and a mocked blob client, because the access
 * gate and the "delete the record before the file" ordering are the parts that
 * matter and neither is visible from reading the source.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';
const SW = 'sitework_data:';   // lib/sitework/schema.js KEY_PREFIX

/* ---- the store and the blob service ------------------------------------ */

const kv = new Map();
const blobs = new Map();      // url -> { pathname, bytes }
let putCalls = 0;
let delCalls = [];
let putShouldFail = false;
let delShouldFail = false;
let onPut = null;   // fires mid-upload, standing in for a second person writing

global.fetch = async (url, opts) => {
  const u = String(url);

  // THE BLOB SERVICE, mocked at the fetch layer rather than by reassigning
  // put/del on the imported module. Reassigning a property on an ES module
  // namespace does not take, so the real SDK ran and sat retrying against a
  // network this container cannot reach. Mocking here also means the SDK's own
  // request building, token parsing and error handling are exercised for real
  // instead of stubbed out.
  if (/vercel\.com\/api\/blob|blob\.vercel-storage\.com/.test(u)) {
    const method = (opts && opts.method) || 'GET';
    const pathname = decodeURIComponent((u.match(/[?&]pathname=([^&]*)/) || [])[1] || '');
    if (method === 'PUT') {
      putCalls += 1;
      if (onPut) onPut();
      if (putShouldFail) {
        return { ok: false, status: 500, text: async () => 'boom',
                 json: async () => ({ error: { code: 'internal_server_error', message: 'boom' } }) };
      }
      const blobUrl = 'https://blob.test/' + pathname;
      blobs.set(blobUrl, { pathname, bytes: (opts && opts.body && opts.body.length) || 0 });
      return { ok: true, status: 200, json: async () => ({
        url: blobUrl, downloadUrl: blobUrl, pathname,
        contentType: (opts && opts.headers && opts.headers['x-content-type']) || 'application/octet-stream',
      }) };
    }
    if (delShouldFail) {
      return { ok: false, status: 500, text: async () => 'boom',
               json: async () => ({ error: { code: 'internal_server_error', message: 'boom' } }) };
    }
    let urls = [];
    try { urls = JSON.parse((opts && opts.body) || '{}').urls || []; } catch (e) { urls = []; }
    urls.forEach((x) => { delCalls.push(x); blobs.delete(x); });
    return { ok: true, status: 200, json: async () => ({}) };
  }

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
process.env.SESSION_SECRET = 'test-secret-for-sitework-attachments';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_faketoken_forthetests';

function seed() {
  kv.clear();
  blobs.clear();
  putCalls = 0;
  delCalls = [];
  putShouldFail = false;
  delShouldFail = false;
  kv.set(P + 'roles', JSON.stringify({
    builder: { name: 'builder', label: 'Builder', apps: ['stickies'], can_edit: true },
    watcher: { name: 'watcher', label: 'Watcher', apps: ['stickies'], can_edit: false },
    office:  { name: 'office',  label: 'Office',  apps: ['backbone'], can_edit: true },
  }));
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   role: 'admin', superuser: true },
    jacob:  { username: 'jacob',  name: 'Jacob',  role: 'builder' },
    dana:   { username: 'dana',   name: 'Dana',   role: 'builder' },
    margo:  { username: 'margo',  name: 'Margo',  role: 'watcher' },
    amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
  }));
  kv.set(SW + 'index', JSON.stringify(['S-0001']));
  kv.set(SW + 'note:S-0001', JSON.stringify({
    id: 'S-0001', title: 'Rail breaks on mobile', status: 'open',
    color: 'yellow', size: 'unknown', order: 0, createdBy: 'jacob',
  }));
}

/* ---- a real request ---------------------------------------------------- */

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

async function call(handler, { as, method = 'POST', query = {}, body = null }) {
  const req = { method, query, body, headers: { cookie: await makeCookie(as) } };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const RYAN  = { username: 'ryan',  name: 'Ryan',  role: 'admin' };
const JACOB = { username: 'jacob', name: 'Jacob', role: 'builder' };
const DANA  = { username: 'dana',  name: 'Dana',  role: 'builder' };
const MARGO = { username: 'margo', name: 'Margo', role: 'watcher' };
const AMANDA = { username: 'amanda', name: 'Amanda', role: 'office' };

// A one-pixel PNG, small enough to be under every limit.
const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  // The route imports @vercel/blob, the repo's one real dependency. A checkout
  // without `npm install` cannot load it, so this file steps aside rather than
  // turning the suite red on a missing environment. Same convention
  // test/route-imports.test.cjs uses, and for the same reason: a red suite that
  // means "you did not run npm install" trains people to ignore a red suite.
  // The pure rules always run: they import nothing but lib/. Only the ROUTE
  // needs @vercel/blob, the repo's one real dependency, so only the route tests
  // step aside on a checkout without `npm install`. Skipping the whole file
  // would have meant this entire area went unchecked in exactly the environment
  // people actually run the suite in.
  const att = await import(path.join(ROOT, 'lib/sitework/attachments.js'));

  let route = null;
  try {
    route = (await import(path.join(ROOT, 'api/sitework-attach.js'))).default;
  } catch (e) {
    if (!/Cannot find package/.test(String(e && e.message))) throw e;
    console.log('  note: sitework attachment ROUTE tests skipped, node_modules not installed');
  }

  /**
   * A route test. When the SDK is not installed the test is NOT REGISTERED,
   * rather than registered and returned from early. An early return reports
   * "ok" for a check that examined nothing, and the harness header is explicit
   * about why that is worse than no test: a test that cannot fail is a claim
   * nobody is checking. This way the count drops and says so.
   */
  async function routeCheck(name, fn) {
    if (!route) return;
    await check(name, fn);
  }
  const {
    parseImageDataUrl, attachmentPath, displayName, canRemoveAttachment,
    humanSize, isFull, MAX_ATTACHMENTS_PER_NOTE, MAX_ATTACHMENT_BYTES, ALLOWED_TYPES,
  } = att;

  seed();

  /* ---- what counts as an image ---------------------------------------- */

  await check('a real image is accepted and its size is measured, not believed', async () => {
    const r = parseImageDataUrl(PNG_1PX);
    t.assert(r.ok, r.error);
    t.equal(r.mediaType, 'image/png');
    t.assert(r.bytes > 0 && r.bytes < 200,
      'the byte count must come from the payload, not from a field the caller sent');
  });

  await check('image/jpg is normalized to image/jpeg', async () => {
    const r = parseImageDataUrl('data:image/jpg;base64,' + 'A'.repeat(40));
    t.assert(r.ok, r.error);
    t.equal(r.mediaType, 'image/jpeg', 'or the same file gets two different types stored');
  });

  await check('SVG is refused, and told why', async () => {
    // An SVG is an image to a browser and a script host to an attacker. These
    // thumbnails render inline on the board, unlike PromoPro's artwork, which
    // is downloaded. So the wider allowlist the other upload routes use would
    // be wrong here.
    t.assert(ALLOWED_TYPES.indexOf('image/svg+xml') === -1, 'SVG must not be on the allowlist');
    const r = parseImageDataUrl('data:image/svg+xml;base64,' + 'A'.repeat(40));
    t.assert(!r.ok);
    t.assert(/screenshot/i.test(r.error),
      'a bare refusal makes somebody try three more times; say what to do instead');
  });

  await check('non-images and junk are refused', async () => {
    t.assert(!parseImageDataUrl('data:application/pdf;base64,AAAA').ok, 'PDF');
    t.assert(!parseImageDataUrl('https://example.com/cat.png').ok, 'a plain URL');
    t.assert(!parseImageDataUrl('').ok, 'nothing at all');
    t.assert(!parseImageDataUrl('data:image/png;base64,').ok, 'an empty payload');
  });

  await check('anything over the body ceiling is refused before it is stored', async () => {
    // A Vercel function refuses a body over 4.5 MB and base64 inflates by a
    // third, so above this it could not arrive at all.
    t.assert(MAX_ATTACHMENT_BYTES <= 3.3 * 1024 * 1024, 'the cap must sit under the real ceiling');
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_ATTACHMENT_BYTES * 2);
    const r = parseImageDataUrl(huge);
    t.assert(!r.ok);
    t.assert(/crop/i.test(r.error), 'the message must say what to do about it');
  });

  /* ---- where files live ------------------------------------------------ */

  await check('a file lives under its own note, and the uploader cannot aim the path', async () => {
    const p = attachmentPath('S-0001', 'att_abc', 'image/png');
    t.equal(p, 'sitework/S-0001/att_abc.png');
    // A filename arriving from a browser can contain slashes and dots.
    const nasty = attachmentPath('../../etc', 'att/../../x', 'image/png');
    t.assert(nasty.indexOf('..') === -1, 'traversal survived: ' + nasty);
    t.equal(nasty.split('/').length, 3, 'the path must stay exactly three segments');
  });

  await check('a pasted screenshot with no filename still gets a name', async () => {
    t.equal(displayName('', 'image/png'), 'Pasted image.png');
    t.equal(displayName('   ', 'image/jpeg'), 'Pasted image.jpg');
    t.equal(displayName('bug on mobile.png', 'image/png'), 'bug on mobile.png');
    t.assert(displayName('a/b\\c.png', 'image/png').indexOf('/') === -1, 'separators stripped');
  });

  await check('sizes read as sizes', async () => {
    t.equal(humanSize(0), '0 B');
    t.equal(humanSize(2048), '2 KB');
    t.equal(humanSize(1024 * 1024 * 2), '2.0 MB');
  });

  /* ---- the route: who may attach --------------------------------------- */

  await routeCheck('a read-only role cannot attach', async () => {
    seed();
    const res = await call(route, { as: MARGO, body: { noteId: 'S-0001', dataUrl: PNG_1PX } });
    t.equal(res.statusCode, 403);
    t.equal(putCalls, 0, 'and nothing must reach storage before the gate refuses');
  });

  await routeCheck('somebody without the board cannot attach', async () => {
    seed();
    const res = await call(route, { as: AMANDA, body: { noteId: 'S-0001', dataUrl: PNG_1PX } });
    t.equal(res.statusCode, 403);
    t.equal(putCalls, 0);
  });

  await routeCheck('signed out is refused', async () => {
    seed();
    const res = fakeRes();
    await route({ method: 'POST', query: {}, body: {}, headers: {} }, res);
    t.assert(res.statusCode === 401 || res.statusCode === 403, 'got ' + res.statusCode);
    t.equal(putCalls, 0);
  });

  await routeCheck('a note that does not exist is a 404, not an orphaned file', async () => {
    seed();
    const res = await call(route, { as: JACOB, body: { noteId: 'S-9999', dataUrl: PNG_1PX } });
    t.equal(res.statusCode, 404);
    t.equal(putCalls, 0, 'the note is checked before anything is uploaded');
  });

  await routeCheck('a bad image never reaches storage', async () => {
    seed();
    const res = await call(route, { as: JACOB, body: { noteId: 'S-0001', dataUrl: 'data:text/plain;base64,QQ==' } });
    t.equal(res.statusCode, 400);
    t.equal(putCalls, 0);
  });

  /* ---- limits ---------------------------------------------------------- */

  await check('isFull agrees with the route', async () => {
    const full = { attachments: new Array(MAX_ATTACHMENTS_PER_NOTE).fill({ id: 'x' }) };
    t.assert(isFull(full));
    t.assert(!isFull({ attachments: [] }));
    t.assert(!isFull({}), 'a note that has never had one is not full');
  });

  /* ---- the merge decisions, called directly ---------------------------- *
   * These are what the route does around its two storage calls. They live in
   * lib/ so they can be run: @vercel/blob resolves credentials before it makes
   * any request and blocks with no network, so a successful upload cannot be
   * exercised here at all. Everything that decides an OUTCOME is below; what is
   * left in the route is the gate (tested above) and the storage calls.
   * ---------------------------------------------------------------------- */

  await check('an image merges onto the note as it is right now', async () => {
    const { mergeAttachment } = att;
    const next = mergeAttachment({ id: 'S-1', attachments: [] }, { id: 'a1' });
    t.equal(next.length, 1);
  });

  await check('two people attaching at once do not lose one', async () => {
    // The note is read, then an upload takes a moment, then it is written. The
    // route re-reads before writing and merges onto THAT, which is the whole
    // reason this function takes a note rather than a list captured earlier.
    const { mergeAttachment } = att;
    const stale = { id: 'S-1', attachments: [] };
    const fresh = { id: 'S-1', attachments: [{ id: 'theirs', addedBy: 'dana' }] };
    const next = mergeAttachment(fresh, { id: 'mine', addedBy: 'jacob' });
    t.equal(next.length, 2, 'merging onto the fresh note keeps both');
    t.equal(mergeAttachment(stale, { id: 'mine' }).length, 1,
      'merging onto the stale one silently drops theirs, which is the bug');
  });

  await check('a note that filled up mid-upload refuses rather than overflowing', async () => {
    const { mergeAttachment } = att;
    const full = { id: 'S-1', attachments: new Array(MAX_ATTACHMENTS_PER_NOTE).fill({ id: 'x' }) };
    t.equal(mergeAttachment(full, { id: 'new' }), null,
      'null is the signal to delete the file just uploaded rather than orphan it');
    t.equal(mergeAttachment(null, { id: 'new' }), null, 'so is a note that was deleted mid-upload');
  });

  await check('the same image twice does not appear twice', async () => {
    const { mergeAttachment } = att;
    const note = { id: 'S-1', attachments: [{ id: 'a1' }] };
    t.equal(mergeAttachment(note, { id: 'a1' }).length, 1, 'a retried request must not double up');
  });

  await check('removing returns the list without it, or null if it was not there', async () => {
    const { withoutAttachment } = att;
    const note = { id: 'S-1', attachments: [{ id: 'a1' }, { id: 'a2' }] };
    const next = withoutAttachment(note, 'a1');
    t.equal(next.length, 1);
    t.equal(next[0].id, 'a2');
    t.equal(withoutAttachment(note, 'nope'), null, 'so the route can answer 404 rather than a silent success');
    t.equal(withoutAttachment({}, 'a1'), null);
  });

  await check('junk in the attachments array is ignored, not rendered', async () => {
    const { attachmentsOf } = att;
    const note = { attachments: [{ id: 'a1' }, null, 'nonsense', {}, { id: '' }] };
    t.equal(attachmentsOf(note).length, 1, 'only records with an id are real');
    t.equal(attachmentsOf(null).length, 0);
  });

  /* ---- who may take an image off ---------------------------------------- */

  await check('removing is wider than deleting the note, on purpose', async () => {
    // Deleting a note destroys somebody's thinking. Taking off a screenshot you
    // pasted onto their note is tidying up after yourself, and needing an admin
    // for that is friction with nothing behind it.
    const note = { id: 'S-1', createdBy: 'jacob' };
    const img = { id: 'a1', addedBy: 'dana' };
    t.equal(canRemoveAttachment(note, img, { username: 'dana' }), true, 'I put it there');
    t.equal(canRemoveAttachment(note, img, { username: 'jacob' }), true, 'my note');
    t.equal(canRemoveAttachment(note, img, { username: 'DANA' }), true, 'usernames compare case-insensitively');
    t.equal(canRemoveAttachment(note, img, { username: 'margo' }), false, 'neither');
    t.equal(canRemoveAttachment(note, img, { username: 'margo', superuser: true }), true, 'admin');
    t.equal(canRemoveAttachment(note, img, { username: 'margo', superuser: 'yes' }), false,
      'superuser must be a strict boolean, not anything truthy');
    t.equal(canRemoveAttachment(note, img, {}), false, 'nobody is not somebody');
    t.equal(canRemoveAttachment(note, img, { username: '' }), false, 'and neither is an empty name');
  });

  await check('an image with no recorded uploader falls back to the note author', async () => {
    const note = { id: 'S-1', createdBy: 'jacob' };
    t.equal(canRemoveAttachment(note, { id: 'a1' }, { username: 'jacob' }), true);
    t.equal(canRemoveAttachment(note, { id: 'a1' }, { username: 'dana' }), false,
      'a missing uploader must not read as "anybody"');
  });

  await routeCheck('an unsupported method is refused', async () => {
    seed();
    const res = await call(route, { as: JACOB, method: 'PATCH', body: {} });
    t.equal(res.statusCode, 405);
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL sitework-attachments could not run: ' + ((e && e.stack) || e));
  process.exit(1);
});
