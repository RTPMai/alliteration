// PUT IN: test/mailme-images.test.cjs
/**
 * Images in a MailMe email body, plain and clickable (Sep 24 2026).
 *
 * Four parts, all real function calls:
 *   1. Upload rules in lib/mailme/images.js (type, size, where it lands).
 *   2. What the SENDER renders (lib/mailme/send.js buildHtml / buildText).
 *   3. The composer's PREVIEW copy of that renderer, evaluated out of
 *      apps/mailme.js and checked against the sender on the same inputs.
 *   4. The upload ROUTE, called with real requests against a mocked store and
 *      a mocked blob service. Steps aside only if node_modules is missing.
 *
 * Also covers the "&amp;amp;" fix: links with a query string used to go out
 * broken, which matters more now that a clickable image usually carries one.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';

/* ---- mocked KV + blob service, at the fetch layer ---------------------- */

const kv = new Map();
const puts = [];

global.fetch = async (url, opts) => {
  const u = String(url);
  if (/vercel\.com\/api\/blob|blob\.vercel-storage\.com/.test(u)) {
    const method = (opts && opts.method) || 'GET';
    const pathname = decodeURIComponent((u.match(/[?&]pathname=([^&]*)/) || [])[1] || '');
    if (method === 'PUT') {
      const headers = (opts && opts.headers) || {};
      puts.push({ pathname, headers });
      const blobUrl = 'https://store.public.blob.vercel-storage.com/' + pathname;
      return { ok: true, status: 200, json: async () => ({
        url: blobUrl, downloadUrl: blobUrl, pathname,
        contentType: headers['x-content-type'] || 'application/octet-stream',
      }) };
    }
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
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-mailme-images';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_faketoken_forthetests';

function seed() {
  kv.clear();
  puts.length = 0;
  kv.set(P + 'users', JSON.stringify({
    ryan:   { username: 'ryan',   name: 'Ryan',   superuser: true, access: { apps: [] } },
    abby:   { username: 'abby',   name: 'Abby',   access: { apps: ['mailme'], can_edit: true } },
    viewer: { username: 'viewer', name: 'Viewer', access: { apps: ['mailme'], can_edit: false } },
    amanda: { username: 'amanda', name: 'Amanda', access: { apps: ['crewcore'], can_edit: true } },
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

async function call(handler, { as, method = 'POST', body = null }) {
  const req = { method, query: {}, body, headers: as ? { cookie: await makeCookie(as) } : {} };
  const res = fakeRes();
  // A request that gets past the gates calls @vercel/blob, which cannot be
  // mocked and hangs offline. So a hang here MEANS "reached storage", and is
  // reported as that instead of freezing the suite.
  let timer;
  const hung = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the request reached storage (it did not stop at the gate)')), 3000);
  });
  try { await Promise.race([handler(req, res), hung]); } finally { clearTimeout(timer); }
  return res;
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

const PNG_1PX = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = 'https://store.public.blob.vercel-storage.com/mailme/images/2026-09/abc-catalog.png';

(async () => {
  const img = await import(path.join(ROOT, 'lib/mailme/images.js'));
  const send = await import(path.join(ROOT, 'lib/mailme/send.js'));
  const settings = { companyName: 'P&M', postalAddress: {}, unsubscribeUrl: '' };
  const html = (body) => send.buildHtml({ body }, {}, settings, 'tok');
  const text = (body) => send.buildText({ body }, {}, settings, 'tok');

  /* ---- 1. upload rules ------------------------------------------------ */

  await check('a PNG is accepted and its size is computed, not trusted', () => {
    const r = img.parseEmailImage(PNG_1PX);
    t.assert(r.ok, 'a tiny PNG should pass');
    t.equal(r.mediaType, 'image/png');
    t.assert(r.bytes > 0 && r.bytes < 200, 'bytes should come from the payload');
  });

  await check('image/jpg is normalized to image/jpeg', () => {
    const r = img.parseEmailImage(PNG_1PX.replace('image/png', 'image/jpg'));
    t.equal(r.mediaType, 'image/jpeg');
  });

  await check('SVG is refused with a reason a person can act on', () => {
    const r = img.parseEmailImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    t.assert(!r.ok, 'SVG must be refused');
    t.assert(/PNG/.test(r.error), 'the message should say what to do instead');
  });

  await check('non-images and junk are refused', () => {
    t.assert(!img.parseEmailImage('data:application/pdf;base64,AAAA').ok, 'PDF');
    t.assert(!img.parseEmailImage('hello').ok, 'plain text');
    t.assert(!img.parseEmailImage(null).ok, 'null');
  });

  await check('anything over 3 MB is refused', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((img.MAX_EMAIL_IMAGE_BYTES + 10) * 4 / 3));
    const r = img.parseEmailImage(big);
    t.assert(!r.ok, 'oversize must be refused');
    t.assert(/3 MB/.test(r.error), 'the message should name the limit');
  });

  await check('an image lands under mailme/images with a random, unguessable name', () => {
    const p = img.emailImagePath('Fall Catalog (final).PNG', 'image/png', 'a1b2c3d4e5f6a7b8c9d0e1f2', new Date('2026-09-24T12:00:00Z'));
    t.equal(p, 'mailme/images/2026-09/a1b2c3d4e5f6a7b8c9d0e1f2-fall-catalog-final.png');
  });

  await check('a short random id is refused, since the store is public', () => {
    let threw = false;
    try { img.emailImagePath('x', 'image/png', 'short'); } catch (e) { threw = true; }
    t.assert(threw, 'emailImagePath must refuse a guessable id');
  });

  await check('display width is clamped to what an email can show', () => {
    t.equal(img.clampDisplayWidth(900), 600);
    t.equal(img.clampDisplayWidth(300), 300);
    t.equal(img.clampDisplayWidth(2), 16);
    t.equal(img.clampDisplayWidth('abc'), null);
    t.equal(img.clampDisplayWidth(0), null);
  });

  await check('images are stored PUBLIC and never overwritten, since sent emails point at them forever', () => {
    const o = img.emailImagePutOptions('image/png', 'tok');
    t.equal(o.access, 'public', 'a private image is a broken image in every inbox');
    t.equal(o.allowOverwrite, false, 'overwriting would change emails already sent');
    t.equal(o.contentType, 'image/png');
    t.equal(o.token, 'tok');
    t.assert(!('token' in img.emailImagePutOptions('image/png', undefined)),
      'no token means leave it out, so the SDK can use OIDC');
  });

  await check('the route stores with those options, not its own', () => {
    const r = fs.readFileSync(path.join(ROOT, 'api/mailme/images.js'), 'utf8');
    t.assert(/emailImagePutOptions\(parsed\.mediaType/.test(r), 'route must use emailImagePutOptions');
    t.assert(!/access:\s*"private"/.test(r), 'route must not store private');
  });

  await check('imageMarkdown writes plain and clickable images, and keeps the description from breaking the syntax', () => {
    t.equal(img.imageMarkdown({ src: IMG, alt: 'Fall catalog', width: 600 }), `![Fall catalog|600](${IMG})`);
    t.equal(img.imageMarkdown({ src: IMG, alt: 'Fall catalog', width: 600, href: 'https://pmapparel.com/fall' }),
      `[![Fall catalog|600](${IMG})](https://pmapparel.com/fall)`);
    t.equal(img.imageMarkdown({ src: IMG, alt: 'A [big] | sale', width: null }), `![A big sale](${IMG})`);
  });

  /* ---- 2. what actually gets sent -------------------------------------- */

  await check('an image renders as an img tag with its width, inside the email', () => {
    const out = html(`Hi\n\n![Fall catalog|600](${IMG})`);
    t.assert(out.includes(`<img src="${IMG}" alt="Fall catalog" width="600"`), 'img tag missing or wrong:\n' + out);
    t.assert(/max-width:100%/.test(out), 'must shrink on phones');
    t.assert(!out.includes('!['), 'no leftover markdown');
  });

  await check('a clickable image is wrapped in a link to the click-through address', () => {
    const out = html(`[![Shop now|400](${IMG})](https://pmapparel.com/fall)`);
    t.assert(/<a href="https:\/\/pmapparel\.com\/fall"[^>]*><img src="[^"]+" alt="Shop now" width="400"/.test(out),
      'clickable image not rendered:\n' + out);
    t.assert(!/\]\(/.test(out), 'no leftover markdown');
  });

  await check('a width over 600 is clamped at send time too, so hand-typed markdown cannot blow out Outlook', () => {
    t.assert(html(`![x|1200](${IMG})`).includes('width="600"'), 'should clamp to 600');
  });

  await check('no width means no width attribute, not width="null"', () => {
    const out = html(`![Logo](${IMG})`);
    t.assert(!/width="/.test(out.replace(/max-width/g, '')), 'unexpected width attribute:\n' + out);
  });

  await check('an http image or a javascript: link never becomes an img or a live link', () => {
    t.assert(!/<img/.test(html('![x](http://example.com/a.png)')), 'http image must not render as an image');
    const js = html(`[![x](${IMG})](javascript:alert(1))`);
    t.assert(!/href="javascript/i.test(js), 'javascript: must never become an href');
  });

  await check('quotes and markup in a description cannot break out of the alt attribute', () => {
    const out = html(`![say "hi" <b>x</b> P&M's|300](${IMG})`);
    t.assert(!/<b>/.test(out), 'markup must be escaped');
    t.assert(out.includes('alt="say &quot;hi&quot; &lt;b&gt;x&lt;/b&gt; P&amp;M&#39;s"'), 'alt not escaped as expected:\n' + out);
  });

  await check('bold inside a description stays text and does not become a tag in the attribute', () => {
    t.assert(!/<strong>/.test(html(`![**Sale**](${IMG})`)), 'bold must not reach inside alt');
  });

  await check('an image sits alongside ordinary links, bold and bullets without disturbing them', () => {
    const out = html(`**Big** news\n\n[![x](${IMG})](https://a.com)\n\nSee [the site](https://b.com) or www.c.com\n\n- one\n- two`);
    t.assert(out.includes('<strong>Big</strong>'), 'bold');
    t.assert(out.includes('>the site</a>'), 'explicit link');
    t.assert(out.includes('href="https://www.c.com"'), 'bare www link');
    t.assert(out.includes('<li>one</li>'), 'bullets');
    t.equal((out.match(/<img /g) || []).length, 1, 'exactly one image');
  });

  await check('links with a query string go out intact (was "&amp;amp;", which broke every UTM link)', () => {
    const out = html('[shop](https://a.com/?utm_source=mail&utm_medium=email) and https://b.com/?x=1&y=2');
    t.assert(out.includes('href="https://a.com/?utm_source=mail&amp;utm_medium=email"'), 'explicit link:\n' + out);
    t.assert(out.includes('href="https://b.com/?x=1&amp;y=2"'), 'bare link:\n' + out);
    t.assert(!/&amp;amp;/.test(out), 'double-escaped ampersand is back');
    const clicky = html(`[![x](${IMG})](https://a.com/?a=1&b=2)`);
    t.assert(clicky.includes('href="https://a.com/?a=1&amp;b=2"'), 'clickable image link:\n' + clicky);
  });

  await check('the plain-text version turns images into words and a link, not raw markdown', () => {
    const out = text(`Hi\n\n[![Shop the fall catalog|600](${IMG})](https://pmapparel.com/fall)\n\n![Logo|200](${IMG})\n\n[![|600](${IMG})](https://x.com)`);
    t.assert(out.includes('Shop the fall catalog: https://pmapparel.com/fall'), 'clickable image text:\n' + out);
    t.assert(out.includes('[Logo]'), 'plain image text');
    t.assert(out.includes('https://x.com'), 'a clickable image with no description still gives the link');
    t.assert(!out.includes('!['), 'no raw image markdown in plain text:\n' + out);
  });

  /* ---- 3. the composer's preview agrees with the sender ---------------- */

  const src = fs.readFileSync(path.join(ROOT, 'apps/mailme.js'), 'utf8');
  const escSrc = src.slice(src.indexOf('function esc(s)'), src.indexOf('function fmtDate'));
  const pvSrc = src.slice(src.indexOf('function escapeAttr(s)'), src.indexOf('export default'));
  // eslint-disable-next-line no-new-func
  const pv = new Function(escSrc + pvSrc + '; return { previewBody, imageMarkdown };')();

  await check('the preview renders images exactly as the sender does', () => {
    const samples = [
      `![Fall catalog|600](${IMG})`,
      `[![Shop now|400](${IMG})](https://pmapparel.com/fall)`,
      `![Logo](${IMG})`,
      `![x|1200](${IMG})`,
      `![P&M's "fall"|300](${IMG})`,
      `Text before\n\n[![x](${IMG})](https://a.com/?a=1&b=2)\n\nText after`,
      '[shop](https://a.com/?utm_source=mail&utm_medium=email)',
      'Visit https://b.com/?x=1&y=2 today',
    ];
    const norm = (s) => s.replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
    samples.forEach((input) => {
      const sent = norm(html(input));
      const shown = norm(pv.previewBody(input));
      t.assert(sent.includes(shown),
        'preview and sender disagree on: ' + JSON.stringify(input) + '\n  sender:  ' + sent + '\n  preview: ' + shown);
    });
  });

  await check('a URL typed against an image cannot break out of its href (Sep 24 review)', () => {
    const attack = 'https://a.com![x](https://b.co/onmouseover=alert`1`//)';
    [html(attack), pv.previewBody(attack)].forEach((out, i) => {
      t.assert(!/href="[^"]*<img/.test(out), (i ? 'preview' : 'sender') + ' put a tag inside an href:\n' + out);
      t.assert(!/<a [^>]*onmouseover/i.test(out), (i ? 'preview' : 'sender') + ' grew an event attribute');
    });
    const inLink = html('[x](https://a.com![y](https://b.co/c.png))');
    t.assert(!/href="[^"]*<img/.test(inLink), 'a link URL must not swallow an image either');
  });

  await check('an image inside link text renders, and no placeholder leaks into an email', () => {
    const out = html(`[see ![a](${IMG})](https://z.co)`);
    t.assert(out.includes(`<a href="https://z.co"`) && out.includes(`<img src="${IMG}"`), 'nested image should render:\n' + out);
    t.assert(!/\u0000|LINK\d/.test(out), 'placeholder leaked');
    const forged = html('![\u0000LINK0\u0000](https://x.co/i.png) ![a](https://x.co/b.png)');
    t.assert(!/\u0000/.test(forged) && !/alt="<|alt="[^"]*<img/.test(forged), 'a typed NUL must not forge a placeholder:\n' + forged);
    t.assert(forged.includes('<img src="https://x.co/i.png"'), 'the NUL is dropped and the image still renders:\n' + forged);
    t.equal(pv.previewBody(`[see ![a](${IMG})](https://z.co)`).replace(/ style="[^"]*"/g, ''),
      html(`[see ![a](${IMG})](https://z.co)`).replace(/ style="[^"]*"/g, '').match(/<p>[\s\S]*?<\/p>/)[0], 'preview agrees');
  });

  await check("the Image button writes the same markdown lib/mailme/images.js would", () => {
    const cases = [
      { src: IMG, alt: 'Fall catalog', width: 600 },
      { src: IMG, alt: 'A [big] | sale', width: 900, href: 'https://pmapparel.com' },
      { src: IMG, alt: '', width: null },
    ];
    cases.forEach((c) => t.equal(pv.imageMarkdown(c), img.imageMarkdown(c), JSON.stringify(c)));
  });

  await check('the composer has an Image button and posts through the seam, not fetch', () => {
    t.assert(/data-ins="image"/.test(src), 'Image button missing');
    t.assert(/api\.post\(ENDPOINTS\.mmImages/.test(src), 'upload must go through ctx.api and ENDPOINTS');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8');
    t.assert(/mmImages:\s*'\/api\/mailme\/images'/.test(apiSrc), 'ENDPOINTS.mmImages missing');
  });

  /* ---- 4. the upload route ---------------------------------------------- */

  let route = null;
  try {
    route = (await import(path.join(ROOT, 'api/mailme/images.js'))).default;
  } catch (e) {
    if (!/Cannot find package/.test(String(e && e.message))) throw e;
    console.log('  note: mailme image ROUTE tests skipped, node_modules not installed');
  }

  if (route) {
    // A SUCCESSFUL upload is not exercised: @vercel/blob opens its own
    // network connection (undici), so it cannot be mocked here and hangs
    // offline. Same gap as sitework-attachments; the parts that matter are
    // checked above (emailImagePutOptions) and below (every refusal happens
    // before storage is touched).
    const ABBY = { username: 'abby', name: 'Abby' };
    const VIEWER = { username: 'viewer', name: 'Viewer' };
    const AMANDA = { username: 'amanda', name: 'Amanda' };

    await check('view-only MailMe access cannot upload, and nothing is stored', async () => {
      seed();
      const res = await call(route, { as: VIEWER, body: { dataUrl: PNG_1PX, name: 'x.png' } });
      t.equal(res.statusCode, 403);
      t.equal(puts.length, 0, 'nothing may reach storage');
    });

    await check('no MailMe access at all cannot upload', async () => {
      seed();
      const res = await call(route, { as: AMANDA, body: { dataUrl: PNG_1PX, name: 'x.png' } });
      t.equal(res.statusCode, 403);
      t.equal(puts.length, 0, 'nothing may reach storage');
    });

    await check('signed out cannot upload', async () => {
      seed();
      const res = await call(route, { as: null, body: { dataUrl: PNG_1PX, name: 'x.png' } });
      t.equal(res.statusCode, 401);
      t.equal(puts.length, 0, 'nothing may reach storage');
    });

    await check('an SVG is refused before storage is touched', async () => {
      seed();
      const res = await call(route, { as: ABBY, body: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', name: 'x.svg' } });
      t.equal(res.statusCode, 400);
      t.equal(puts.length, 0, 'nothing may reach storage');
    });

    await check('GET is not an upload', async () => {
      seed();
      const res = await call(route, { as: ABBY, method: 'GET' });
      t.equal(res.statusCode, 405);
    });

  }

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run mailme image tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
