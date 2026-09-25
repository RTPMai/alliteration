// PUT IN: test/mailme-seasonal.test.cjs
/**
 * The seasonal announcement design (Sep 25 2026), built from the sales
 * director's 2026 Holiday Stores email.
 *
 * Real function calls throughout. What is locked here:
 *   1. ONE BUTTON PER READER. A client of Hannah gets "Email Hannah" to
 *      hannah@<reply-to domain>, and nobody else's button. A reader whose
 *      account manager is not on the form's list (or has none, or is a
 *      placeholder like "House Account") gets the inquiry form only.
 *   2. HER COPY, AS TEXT. The timelines are text, **bold** works, and
 *      nothing typed can become markup.
 *   3. THE LAW. Postal address and a per-recipient unsubscribe link.
 *   4. CLICKS. The form and calendar links are tagged, and Reports reads them.
 *   5. THE WIRING. A real send and a real test send hand the reader's
 *      account manager to the design; the preview route does too.
 *   6. THE COMPOSER. Its limits match the server's.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';

/* ---- mocked KV (and Resend, for the test-send half) --------------------- */

const kv = new Map();
let resendCalls = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com')) {
    resendCalls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (/\/domains/.test(u)) return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{"data":[]}' };
    return { ok: true, status: 200, json: async () => ({ id: 'resend-test-1' }), text: async () => JSON.stringify({ id: 'resend-test-1' }) };
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
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-mailme-seasonal';

function seedUsers() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    abby:   { username: 'abby',   name: 'Abby',   access: { apps: ['mailme'], can_edit: true } },
    viewer: { username: 'viewer', name: 'Viewer', access: { apps: ['mailme'], can_edit: false } },
  }));
}

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

async function call(handler, { as, method = 'POST', query = {}, body = null }) {
  const req = { method, query, body, headers: as ? { cookie: await makeCookie(as) } : {} };
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await handler(req, res);
  return res;
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

const IMG = 'https://store.public.blob.vercel-storage.com/mailme/images/2026-09/cal.png';
const SETTINGS = {
  companyName: 'P&M Apparel',
  postalAddress: { line1: '1220 W Broadway St', city: 'Polk City', state: 'IA', postalCode: '50226' },
  unsubscribeUrl: 'https://alliteration.pmapparel.com/unsubscribe.html',
  replyToDomain: 'pmapparel.com',
};

(async () => {
  const T = await import(path.join(ROOT, 'lib/mailme/templates/index.js'));
  const S = T.TEMPLATES.seasonal;
  const send = await import(path.join(ROOT, 'lib/mailme/send.js'));
  const schema = await import(path.join(ROOT, 'lib/mailme/schema.js'));

  const ctx = (over) => Object.assign({ campaignId: 'MM-00050', settings: SETTINGS, unsubToken: 'tok123', assetBase: 'https://alliteration.pmapparel.com' }, over || {});
  const mailtos = (html) => (html.match(/href="mailto:[^"]*"/g) || []);

  /* ---- 1. one button per reader ----------------------------------------- */

  await check('the design is offered, and starts from her holiday copy with nothing missing', () => {
    t.assert(T.TEMPLATE_KEYS.includes('seasonal'), 'registered');
    t.assert(T.templateChoices().some((c) => c.key === 'seasonal' && c.label === 'Seasonal announcement'), 'in the picker');
    t.equal(JSON.stringify(S.problems(S.defaults())), '[]');
    const d = S.defaults();
    t.equal(d.timelines.length, 2);
    t.equal(d.timelines[0].steps[0].dates, 'Oct 8 - 21');
    t.equal(d.timelines[1].steps[3].dates, 'Dec 10 - 16');
    t.assert(Buffer.byteLength(JSON.stringify(S.normalize(d))) < T.MAX_TEMPLATE_DATA_BYTES, 'fits the storage cap');
  });

  await check('a client of Hannah gets one button: Email Hannah, to hannah@', () => {
    const html = S.renderHtml({}, ctx({ accountManager: 'Hannah Posey' }));
    const m = mailtos(html);
    t.equal(m.length, 1, 'exactly one mailto: ' + JSON.stringify(m));
    t.assert(m[0].startsWith('href="mailto:hannah@pmapparel.com?subject='), m[0]);
    t.assert(m[0].includes('subject=Let%27s%20start%20my%20holiday%20project'), 'subject rides along, apostrophe encoded like hers: ' + m[0]);
    t.assert(html.includes('>Email Hannah</a>'), 'labelled with her name');
    t.assert(html.includes('Hannah is your account manager.'), '{name} filled in');
    t.assert(!/Email (Abby|Alexis|Jacob)/.test(html), 'nobody else\'s button');
  });

  await check('first name matching ignores case and the last name', () => {
    t.equal(JSON.stringify(S.accountManagerFor('alexis davis', ['Alexis'], 'pmapparel.com')), JSON.stringify({ name: 'Alexis', email: 'alexis@pmapparel.com' }));
    t.equal(S.accountManagerFor('ABBY', ['Abby'], 'PMApparel.com').email, 'abby@pmapparel.com');
    t.equal(S.accountManagerFor('Jacob Whitman', ['jacob'], 'pmapparel.com').name, 'jacob', 'the list spelling is the label');
  });

  await check('an owner not on the list, a placeholder, or nobody gets the inquiry form only', () => {
    for (const am of ['Ryan Toney', 'House Account', 'TBD', '', '-', 'Megan']) {
      const html = S.renderHtml({}, ctx({ accountManager: am }));
      t.equal(mailtos(html).length, 0, `no mailto for ${JSON.stringify(am)}`);
      t.assert(html.includes('Start a Project - Inquiry Form'), `form button for ${JSON.stringify(am)}`);
      t.assert(!/>Email [A-Z]/.test(html), `no Email button for ${JSON.stringify(am)}`);
    }
    const added = S.renderHtml({ people: ['Abby', 'Ryan'] }, ctx({ accountManager: 'Ryan Toney' }));
    t.assert(added.includes('mailto:ryan@pmapparel.com'), 'adding a name to the list gives them a button');
  });

  await check('no reply-to domain in Settings means no guessed address', () => {
    const html = S.renderHtml({}, ctx({ accountManager: 'Hannah Posey', settings: Object.assign({}, SETTINGS, { replyToDomain: '' }) }));
    t.equal(mailtos(html).length, 0);
    t.equal(S.accountManagerFor('Hannah', ['Hannah'], 'not a domain'), null);
  });

  await check('every reader gets the inquiry form, with or without an account manager', () => {
    [S.renderHtml({}, ctx({ accountManager: 'Hannah Posey' })), S.renderHtml({}, ctx())].forEach((html) => {
      t.assert(html.includes('https://forms.monday.com/forms/e8ecf816d4b9d2a116e0b777548f79f3'), 'form link');
    });
  });

  /* ---- 2. her copy, as text ---------------------------------------------- */

  await check('her dates are live text, not a picture', () => {
    const html = S.renderHtml({}, ctx());
    ['Delivered by December 4', 'Get your gear by December 16', 'Oct 8 - 21', 'Nov 30 - Dec 4', 'Dec 10 - 16',
      'Plan Ahead for Early December Delivery', 'November 26-27'].forEach((s) => t.assert(html.includes(s), 'missing ' + s));
    t.assert(!html.includes('PM-Apparel-2026-Holiday-Email.png'), 'not her picture');
  });

  await check('**double stars** make bold; a lone pair of stars stays as typed', () => {
    const html = S.renderHtml({ intro: 'Start **October 8** or ** later' }, ctx());
    t.assert(/<strong[^>]*>October 8<\/strong>/.test(html), 'bold');
    t.assert(html.includes('or ** later'), 'unpaired stars left alone');
    const text = S.renderText({ intro: 'Start **October 8**' }, ctx());
    t.assert(text.includes('Start October 8') && !text.includes('**'), 'stars come off in plain text');
  });

  await check('nothing typed, or personalized in, becomes markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = S.renderHtml({
      headline: evil, eyebrow: evil, intro: `**${evil}**`, amText: `${evil} {name}`, formPrompt: evil, signoff: evil,
      sections: [{ heading: evil, text: `**${evil}**` }],
      timelines: [{ label: evil, title: evil, steps: [{ name: evil, dates: evil }] }],
      calendar: { image: IMG, alt: `"${evil}`, url: '' },
    }, ctx({ accountManager: 'Hannah', t: (s) => String(s).replace('{{company_name}}', evil) }));
    t.assert(!html.includes('<img src=x'), 'raw tag leaked');
    t.assert(!/onerror=alert\(1\)"/.test(html) || html.includes('&lt;img'), 'escaped');
    t.assert(!html.includes('alt=""<'), 'attribute not broken out of');
  });

  await check('a name on the button list that is not a first name blocks the send and never renders', () => {
    const probs = S.problems({ people: ['Hannah', '<b>x</b>', '42'] });
    t.equal(probs.filter((p) => /not a first name/.test(p)).length, 2, JSON.stringify(probs));
    const html = S.renderHtml({ people: ['<b>Hannah</b>'] }, ctx({ accountManager: 'Hannah' }));
    t.assert(!html.includes('<b>Hannah'), 'no markup from the list');
  });

  await check('problems name what is missing, in plain words', () => {
    const p = S.problems({
      headline: '', intro: '',
      timelines: [{ label: '', title: '', steps: [{ name: 'Setup', dates: '' }] }, { title: 'x', steps: [] }],
      sections: [{ heading: 'Why', text: '' }],
      calendar: { image: 'http://insecure.example.com/c.png', alt: '', url: 'ftp://x' },
      formUrl: 'not a link', formLabel: '',
    });
    [/headline/, /intro/, /Timeline 1 needs a title/, /Timeline 1, step 1/, /Timeline 2 needs at least one step/,
      /Section 1 \("Why"\) has no text/, /calendar picture link/, /calendar picture needs a description/,
      /click-through link/, /needs a label/, /inquiry form button needs an https link/].forEach((re) => {
      t.assert(p.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(p)}`);
    });
  });

  await check('limits hold: timelines, steps, sections, button names', () => {
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const d = S.normalize({
      timelines: many(9, () => ({ title: 'x', steps: many(20, () => ({ name: 'a', dates: 'b' })) })),
      sections: many(20, () => ({ heading: 'h', text: 't' })),
      people: many(30, (i) => 'Name' + 'x'.repeat(i)),
    });
    t.equal(d.timelines.length, S.MAX_TIMELINES);
    t.equal(d.timelines[0].steps.length, S.MAX_STEPS);
    t.equal(d.sections.length, S.MAX_SECTIONS);
    t.equal(d.people.length, S.MAX_PEOPLE);
    t.equal(JSON.stringify(S.normalize('garbage')), JSON.stringify(S.normalize({})), 'junk input is defaults, never a throw');
  });

  /* ---- 3. the law --------------------------------------------------------- */

  await check('every copy carries the postal address and its own unsubscribe link', () => {
    const html = S.renderHtml({}, ctx({ unsubToken: 'abc999' }));
    t.assert(html.includes('1220 W Broadway St, Polk City, IA, 50226'), 'address');
    t.assert(html.includes('https://alliteration.pmapparel.com/unsubscribe.html?t=abc999'), 'per-recipient unsubscribe');
  });

  /* ---- 4. clicks ---------------------------------------------------------- */

  await check('form and calendar clicks are tagged, and Reports reads them back', () => {
    const html = S.renderHtml({ calendar: { image: IMG, alt: 'Holiday calendar', url: '' } }, ctx());
    const form = (html.match(/href="(https:\/\/forms\.monday\.com[^"]+)"/) || [])[1].replace(/&amp;/g, '&');
    t.equal(new URL(form).searchParams.get('utm_content'), 'form');
    t.equal(new URL(form).searchParams.get('r'), 'use1', 'the form\'s own parameter is kept');
    t.equal(schema.clickSpotFromUrl(form).label, 'Inquiry form button');
    const cal = (html.match(/<a href="([^"]+)"[^>]*><img src="https:\/\/store/) || [])[1].replace(/&amp;/g, '&');
    t.equal(schema.clickSpotFromUrl(cal).label, 'Calendar picture');
    t.equal(schema.clickSpotFromUrl('https://x.com/?utm_content=bogus'), null, 'unknown tags are still ignored');
  });

  await check('no calendar picture, no calendar block', () => {
    const html = S.renderHtml({}, ctx());
    t.assert(!html.includes('Tap the calendar'), 'nothing to tap');
  });

  /* ---- 5. the wiring ------------------------------------------------------ */

  const campaign = { id: 'MM-00050', subject: 'Holiday stores', template: 'seasonal', templateData: S.defaults() };

  await check('a real send hands each reader\'s own account manager to the design', () => {
    const hannah = send.buildHtml(campaign, { id: 'client:1', email: 'a@b.com', accountManager: 'Hannah Posey' }, SETTINGS, 'tok');
    const alexis = send.buildHtml(campaign, { id: 'client:2', email: 'c@d.com', accountManager: 'Alexis Davis' }, SETTINGS, 'tok');
    const nobody = send.buildHtml(campaign, { id: 'prospect:3', email: 'e@f.com', accountManager: '' }, SETTINGS, 'tok');
    t.assert(hannah.includes('mailto:hannah@pmapparel.com'), 'Hannah\'s client');
    t.assert(alexis.includes('mailto:alexis@pmapparel.com') && !alexis.includes('hannah@'), 'Alexis\'s client');
    t.equal(mailtos(nobody).length, 0, 'no rep, no mailto');
    const text = send.buildText(campaign, { id: 'client:1', email: 'a@b.com', accountManager: 'Hannah Posey' }, SETTINGS, 'tok');
    t.assert(text.includes('hannah@pmapparel.com'), 'plain text has the address too');
  });

  await check('the button and the reply-to reach the same person', () => {
    ['Hannah Posey', 'Alexis Davis', 'abby penton', "O'Brien, Margo"].forEach((am) => {
      const reply = schema.resolveReplyTo({ accountManager: am }, SETTINGS);
      const btn = S.accountManagerFor(am, [am], SETTINGS.replyToDomain);
      t.equal(btn && btn.email, reply, 'mismatch for ' + am);
    });
  });

  const route = (await import(path.join(ROOT, 'api/mailme/campaigns.js'))).default;

  await check('the preview route renders the copy for whichever account manager is picked', async () => {
    seedUsers();
    const before = JSON.stringify([...kv.entries()]);
    const as = await call(route, { as: { username: 'viewer' }, body: { action: 'render', template: 'seasonal', templateData: {}, subject: 's', sample: { accountManager: 'Hannah' } } });
    t.equal(as.statusCode, 200, JSON.stringify(as.body));
    t.assert(as.body.html.includes('>Email Hannah</a>'), 'Hannah\'s copy');
    t.equal(as.body.problems.length, 0, JSON.stringify(as.body.problems));
    const none = await call(route, { as: { username: 'viewer' }, body: { action: 'render', template: 'seasonal', templateData: {}, subject: 's', sample: {} } });
    t.equal(mailtos(none.body.html).length, 0, 'no rep picked, no button');
    t.equal(JSON.stringify([...kv.entries()]), before, 'render writes nothing');
  });

  await check('saving a seasonal draft stores the cleaned content', async () => {
    seedUsers();
    const res = await call(route, { as: { username: 'abby' }, body: { subject: 'Holiday', template: 'seasonal', templateData: { headline: '  Holiday   Stores ', people: 'Abby, Hannah' } } });
    t.assert(res.statusCode === 200 || res.statusCode === 201, JSON.stringify(res.body));
    const c = res.body.campaign;
    t.equal(c.template, 'seasonal');
    t.equal(c.templateData.headline, 'Holiday Stores');
    t.equal(JSON.stringify(c.templateData.people), JSON.stringify(['Abby', 'Hannah']));
  });

  await check('a test send can be the copy a given account manager\'s clients get', async () => {
    seedUsers();
    process.env.RESEND_API_KEY = 're_test_fake';
    kv.set('mailme_data:settings', JSON.stringify(Object.assign({}, SETTINGS, {
      identities: [{ key: 'pm', label: 'P&M Apparel', domain: 'pmapparel.com', fromAddress: 'hello@pmapparel.com', default: true }],
    })));
    kv.set('mailme_data:campaigns', JSON.stringify([Object.assign({ status: 'draft', source: 'client', segmentTags: [] }, campaign)]));
    resendCalls = [];
    const r = await send.sendTestEmail('MM-00050', 'ryan@pmapparel.com', { accountManager: 'Hannah Posey' });
    t.equal(r.ok, true, JSON.stringify(r));
    const sent = resendCalls.find((c) => /\/emails$/.test(c.url));
    t.assert(sent && sent.body.html.includes('mailto:hannah@pmapparel.com'), 'Hannah\'s copy went out');
    t.equal(sent.body.reply_to, 'hannah@pmapparel.com', 'and replies go to her too');
    resendCalls = [];
    const plainTest = await send.sendTestEmail('MM-00050', 'ryan@pmapparel.com');
    t.equal(plainTest.ok, true);
    t.equal(mailtos(resendCalls.find((c) => /\/emails$/.test(c.url)).body.html).length, 0, 'no rep asked for, no button');
    resendCalls = [];
    const res = await call(route, { as: { username: 'abby' }, query: { id: 'MM-00050', action: 'test', to: 'ryan@pmapparel.com' }, body: { accountManager: 'Hannah Posey' } });
    t.equal(res.statusCode, 200, 'route accepts it: ' + JSON.stringify(res.body));
    const viaRoute = resendCalls.find((c) => /\/emails$/.test(c.url));
    t.assert(viaRoute && viaRoute.body.html.includes('mailto:hannah@pmapparel.com'), 'the route passes the pick through');
    delete process.env.RESEND_API_KEY;
  });

  /* ---- 6. the composer ---------------------------------------------------- */

  await check('the composer\'s limits match the server\'s', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/mailme.js'), 'utf8');
    const num = (name) => Number((src.match(new RegExp(`const ${name} = (\\d+);`)) || [])[1]);
    t.equal(num('SEASONAL_MAX_TIMELINES'), S.MAX_TIMELINES);
    t.equal(num('SEASONAL_MAX_STEPS'), S.MAX_STEPS);
    t.equal(num('SEASONAL_MAX_SECTIONS'), S.MAX_SECTIONS);
  });

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run mailme seasonal tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
