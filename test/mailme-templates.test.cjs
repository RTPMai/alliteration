// PUT IN: test/mailme-templates.test.cjs
/**
 * The sales director's two email designs, built into MailMe (Sep 24 2026):
 * "picks with personality." and the P&M promo-products email.
 *
 * Real function calls throughout. What is locked here:
 *   1. HER RULES. Prices round UP to .00, four colors then "+ add'l", the
 *      exact disclaimer once, no item numbers, MSRP as supplied, nothing
 *      invented. These are the reason the designs were built in rather than
 *      pasted: a pasted email cannot check itself.
 *   2. THE LAW. Every template email carries the postal address and a
 *      working per-recipient unsubscribe link.
 *   3. CLICK TAGS. Every link says which pick and which spot, and Reports
 *      reads that back into clicks per product.
 *   4. SAVING AND SENDING. Template content is cleaned on save, and an
 *      unfinished template email is refused at send with plain reasons.
 *   5. THE COMPOSER. Its two small mirrors (the design list and the price
 *      rule) agree with the server, and the preview asks the server rather
 *      than keeping a second copy of either design.
 *   6. THE ROUTE. The preview render works for view-only access and writes
 *      nothing.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const P = 'alliteration:';

/* ---- mocked KV, for the route half ------------------------------------ */

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
      if (op === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
      return { result: kv.has(key) ? kv.get(key) : null };
    });
    return { ok: true, status: 200, json: async () => out };
  }
  return { ok: true, status: 200, json: async () => ({ result: null }) };
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-mailme-templates';

function seedUsers() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
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

const IMG = 'https://store.public.blob.vercel-storage.com/mailme/images/2026-09/abc-x.png';
const SETTINGS = {
  companyName: 'P&M Apparel',
  postalAddress: { line1: '1220 W Broadway St', city: 'Polk City', state: 'IA', postalCode: '50226' },
  unsubscribeUrl: 'https://alliteration.pmapparel.com/unsubscribe.html',
};

function promoProduct(over) {
  return Object.assign({
    name: 'Cartoon Toothpaste Squeezer', colors: ['Yellow', 'Green', 'Pink'], moreColors: false,
    minimum: '50', price: '7.01', setup: '59.5', url: '', image: IMG, alt: 'Dog-shaped toothpaste squeezer',
  }, over || {});
}

function pwpPick(over) {
  return Object.assign({
    name: 'Softstyle Tee', style: '64000', msrp: '6.28', reason: 'Soft and cheap.',
    url: 'https://www.ssactivewear.com/p/gildan/64000', image: IMG, alt: 'Gildan Softstyle tee',
    colors: [{ name: 'Black', hex: '#111111' }, { name: 'Navy', hex: '#1f2a44' }], colorCount: '',
  }, over || {});
}

(async () => {
  const shared = await import(path.join(ROOT, 'lib/mailme/templates/shared.js'));
  const T = await import(path.join(ROOT, 'lib/mailme/templates/index.js'));
  const promo = T.TEMPLATES.promo;
  const pwp = T.TEMPLATES.pwp;
  const send = await import(path.join(ROOT, 'lib/mailme/send.js'));
  const schema = await import(path.join(ROOT, 'lib/mailme/schema.js'));

  const ctx = (over) => Object.assign({ campaignId: 'MM-00042', settings: SETTINGS, unsubToken: 'tok123', assetBase: 'https://alliteration.pmapparel.com' }, over || {});

  /* ---- 1. her rules: promo ------------------------------------------- */

  await check('prices round UP to the whole dollar and show .00', () => {
    t.equal(shared.ceilDollars('7.01'), '$8.00', '7.01 is 8.00, not 7.00');
    t.equal(shared.ceilDollars('7'), '$7.00');
    t.equal(shared.ceilDollars('7.00'), '$7.00', 'a whole dollar stays put');
    t.equal(shared.ceilDollars('$3.001'), '$4.00', 'never below the source price');
    t.equal(shared.ceilDollars('1,250.5'), '$1,251.00');
    t.equal(shared.ceilDollars('call for price'), null, 'junk is not a price');
    t.equal(shared.ceilDollars(''), null);
  });

  await check('the rendered card shows the rounded price and setup, never the raw ones', () => {
    const html = promo.renderHtml({ products: [promoProduct()] }, ctx());
    t.assert(html.includes('$8.00'), 'price should be $8.00');
    t.assert(html.includes('$60.00'), 'setup 59.5 should be $60.00');
    t.assert(!html.includes('7.01') && !html.includes('59.5'), 'the raw source numbers must not appear');
  });

  await check('four colors, then + add\'l', () => {
    t.equal(promo.colorsText({ colors: ['A', 'B', 'C'], moreColors: false }), 'A, B, C');
    t.equal(promo.colorsText({ colors: ['A', 'B', 'C', 'D', 'E'], moreColors: false }), "A, B, C, D + add'l");
    t.equal(promo.colorsText({ colors: ['A', 'B'], moreColors: true }), "A, B + add'l", 'the checkbox adds it too');
    const n = promo.normalize({ products: [promoProduct({ colors: 'A\nB\nC\nD\nE' })] });
    t.equal(n.products[0].moreColors, true, 'more than four typed sets the flag on save');
  });

  await check('the disclaimer is there exactly once, word for word', () => {
    const html = promo.renderHtml({ products: [promoProduct(), promoProduct(), promoProduct()] }, ctx());
    const count = html.split(promo.DISCLAIMER).length - 1;
    t.equal(count, 1, 'disclaimer count');
    t.equal(promo.DISCLAIMER, '*Setup charge shown is for printing one color only. Prices shown at the listed minimum order.');
  });

  await check('the first quantity is labelled minimum order', () => {
    t.assert(promo.renderHtml({ products: [promoProduct()] }, ctx()).includes('minimum order'), 'label missing');
  });

  await check('a product name carrying an item number is refused', () => {
    ['Squeezer #4471', 'Item 4471 Squeezer', 'Item No. 88 Case', 'Case No. 12'].forEach((name) => {
      const probs = promo.problems({ products: [promoProduct({ name })] });
      t.assert(probs.some((p) => /item number/.test(p)), 'not caught: ' + name);
    });
    t.equal(promo.problems({ products: [promoProduct({ name: '3-in-1 Travel Kit' })] }).length, 0,
      'an ordinary name with a digit is fine');
  });

  await check('nothing is guessed: each missing fact is its own problem', () => {
    const probs = promo.problems({ products: [promoProduct({ minimum: '', price: 'TBD', setup: '', colors: [], image: '', alt: '' })] });
    ['minimum order', 'price', 'setup charge', 'colors', 'mockup photo', 'photo description'].forEach((w) => {
      t.assert(probs.some((p) => p.includes(w)), 'no problem mentions: ' + w);
    });
    t.equal(promo.problems({ products: [promoProduct()] }).length, 0, 'a complete product has none');
  });

  await check('links and images must be https', () => {
    t.assert(promo.problems({ products: [promoProduct({ url: 'http://x.com' })] }).some((p) => /https/.test(p)), 'http link');
    t.assert(promo.problems({ products: [promoProduct({ image: 'http://x.com/a.png' })] }).some((p) => /photo/.test(p)), 'http image');
    t.assert(promo.problems({ ctaUrl: 'javascript:alert(1)', products: [promoProduct()] }).some((p) => /catalog button/.test(p)), 'bad cta');
  });

  /* ---- 1b. her rules: picks with personality ------------------------- */

  await check('MSRP shows exactly as supplied, with a $ added only if missing', () => {
    const a = pwp.renderHtml({ teamMember: 'Jacob', picks: [pwpPick({ msrp: '6.28' })] }, ctx());
    t.assert(a.includes('MSRP $6.28'), 'expected MSRP $6.28');
    const b = pwp.renderHtml({ teamMember: 'Jacob', picks: [pwpPick({ msrp: '$14.98' })] }, ctx());
    t.assert(b.includes('MSRP $14.98') && !b.includes('$$'), 'no double dollar');
    t.assert(!b.includes('$15.00'), 'MSRP is never rounded');
    const c = pwp.renderHtml({ teamMember: 'Jacob', picks: [pwpPick({ msrp: '12' })] }, ctx());
    t.assert(c.includes('MSRP $12<') && !c.includes('$12.00'), 'MSRP is not reformatted either');
  });

  await check('the header says season, year and vendor, and the count matches the picks', () => {
    const html = pwp.renderHtml({ season: 'fall', year: '2027', vendor: 'sanmar', teamMember: 'Abby', picks: [pwpPick(), pwpPick(), pwpPick()] }, ctx());
    t.assert(html.includes('fall 2027<br>SanMar'), 'header');
    t.assert(html.includes('three styles picked by Abby.'), 'count word');
    t.assert(html.includes('browse SanMar.'), 'footer button names the vendor');
    t.assert(html.includes('https://www.sanmar.com/'), 'footer button goes to the vendor');
  });

  await check('swatches use the typed colors, and "+ N more" covers the rest', () => {
    const html = pwp.renderHtml({ teamMember: 'J', picks: [pwpPick({ colorCount: '40' })] }, ctx());
    t.assert(html.includes('background:#1f2a44'), 'navy swatch');
    t.assert(html.includes('available in 40 colors.'), 'total count');
    t.assert(html.includes('Black, Navy + 38 more'), 'remaining count');
  });

  await check('a color with no swatch, and every missing fact, is a problem', () => {
    const probs = pwp.problems({ teamMember: '', picks: [pwpPick({ style: '', msrp: '', reason: '', url: '', image: '', colors: [{ name: 'Navy', hex: '' }] })] });
    ['team member', 'style number', 'MSRP', 'reason', 'link', 'photo', 'swatch color for Navy'].forEach((w) => {
      t.assert(probs.some((p) => p.includes(w)), 'no problem mentions: ' + w);
    });
    t.equal(pwp.problems({ teamMember: 'Jacob', picks: [pwpPick()] }).length, 0, 'a complete pick has none');
  });

  await check('normalize cleans rather than trusts: bad vendor, bad hex, too many picks', () => {
    const n = pwp.normalize({
      vendor: 'amazon', season: 'winter', year: 'soon',
      picks: Array.from({ length: 20 }, () => pwpPick({ colors: [{ name: 'Red', hex: 'red' }, { name: '', hex: '#ffffff' }] })),
    });
    t.equal(n.vendor, 'ss', 'unknown vendor falls back');
    t.assert(['spring', 'fall'].includes(n.season), 'unknown season falls back');
    t.assert(/^\d{4}$/.test(n.year), 'year falls back to a real year');
    t.equal(n.picks.length, pwp.MAX_PICKS, 'picks capped');
    t.equal(n.picks[0].colors.length, 1, 'a nameless color is dropped');
    t.equal(n.picks[0].colors[0].hex, '', 'an invalid hex is dropped, not rendered');
  });

  await check('a fresh design starts with five empty picks and her intro', () => {
    const n = pwp.normalize({});
    t.equal(n.picks.length, 5);
    t.assert(/Five styles I keep coming back to/.test(n.intro), 'her intro');
    t.equal(promo.normalize({}).ctaUrl, 'https://www.promoplace.com/pmapparel', 'promo catalog link');
  });

  /* ---- 2. the law: address and unsubscribe in every template email ---- */

  await check('both designs carry the postal address and this recipient\'s unsubscribe link', () => {
    const a = promo.renderHtml({ products: [promoProduct()] }, ctx());
    const b = pwp.renderHtml({ teamMember: 'J', picks: [pwpPick()] }, ctx());
    [a, b].forEach((html, i) => {
      t.assert(html.includes('1220 W Broadway St, Polk City, IA, 50226'), 'address missing in #' + i);
      t.assert(html.includes('https://alliteration.pmapparel.com/unsubscribe.html?t=tok123'), 'unsubscribe missing in #' + i);
    });
  });

  await check('brand art comes from this site, absolute, so mail clients can load it', () => {
    const html = pwp.renderHtml({ teamMember: 'J', picks: [pwpPick()] }, ctx());
    t.assert(html.includes('https://alliteration.pmapparel.com/assets/email/pm-circle-logo.png'), 'logo');
    t.equal(shared.assetBaseFromSettings(SETTINGS), 'https://alliteration.pmapparel.com');
    t.equal(shared.assetBaseFromSettings({}), '', 'no site means no base, not a crash');
    ['pm-circle-logo.png', 'pm-circle-logo-white.png', 'pm-texture-strip.jpg', 'pm-print-pattern-taupe.png', 'product-placeholder.png']
      .forEach((f) => t.assert(fs.existsSync(path.join(ROOT, 'assets/email', f)), 'missing asset ' + f));
  });

  await check('typed text is escaped, and merge tags cannot inject markup', () => {
    const evil = '<script>alert(1)</script>';
    const html = pwp.renderHtml({ teamMember: evil, intro: 'Hi {{first_name}}', picks: [pwpPick({ name: evil, reason: evil })] },
      ctx({ t: (s) => send.personalize(s, { contact_name: '<b>Dana</b> W' }) }));
    t.assert(!/<script>/i.test(html), 'script must be escaped');
    t.assert(!/<b>Dana/.test(html) && html.includes('&lt;b&gt;Dana&lt;/b&gt;'), 'a name is text, never markup');
  });

  /* ---- 3. click tags ----------------------------------------------------- */

  await check('every product link says which pick and which spot', () => {
    const html = pwp.renderHtml({ teamMember: 'J', picks: [pwpPick(), pwpPick()] }, ctx());
    ['pick-01-photo', 'pick-01-colors', 'pick-01-button', 'pick-02-photo', 'footer'].forEach((c) => {
      t.assert(html.includes('utm_content=' + c), 'missing tag ' + c);
    });
    const p = promo.renderHtml({ products: [promoProduct()] }, ctx());
    ['pick-01-photo', 'hero', 'closing'].forEach((c) => t.assert(p.includes('utm_content=' + c), 'promo missing ' + c));
    t.assert(p.includes('utm_campaign=MM-00042'), 'campaign id tagged');
  });

  await check('a supplier link keeps its own tagging, but always gets the spot', () => {
    const u = shared.tagLink('https://x.com/p?utm_source=partner&a=1', { campaignId: 'MM-1', content: 'pick-01-photo' });
    const q = new URL(u).searchParams;
    t.equal(q.get('utm_source'), 'partner', 'existing source kept');
    t.equal(q.get('a'), '1', 'existing params kept');
    t.equal(q.get('utm_content'), 'pick-01-photo');
  });

  await check('Reports reads the tags back into clicks per pick and per spot', () => {
    const u = (c) => 'https://x.com/?utm_content=' + c;
    const r = schema.aggregateEvents([
      { type: 'click', contactId: 'a', linkUrl: u('pick-01-photo') },
      { type: 'click', contactId: 'a', linkUrl: u('pick-01-button') },
      { type: 'click', contactId: 'b', linkUrl: u('pick-01-colors') },
      { type: 'click', contactId: 'b', linkUrl: u('pick-02-photo') },
      { type: 'click', contactId: 'c', linkUrl: u('hero') },
      { type: 'click', contactId: 'c', linkUrl: 'https://plain.com/' },
    ], 10);
    t.equal(r.byPick.length, 2);
    t.equal(r.byPick[0].slot, 1);
    t.equal(r.byPick[0].clicks, 3);
    t.equal(r.byPick[0].uniqueClicks, 2, 'two different people clicked pick 01');
    t.equal(r.byPick[0].photo, 1);
    t.equal(r.byPick[0].button, 1);
    t.equal(r.byPick[0].colors, 1);
    t.assert(r.bySpot.some((s) => s.spot === 'hero' && s.label === 'Top button'), 'hero spot');
    t.equal(r.stats.clicks, 6, 'totals unchanged');
    t.equal(schema.clickSpotFromUrl('https://plain.com/'), null, 'untagged link has no spot');
    // Sep 24 review: an arbitrary word in the spot used to overwrite the
    // row's own counters and crash the report.
    const odd = schema.aggregateEvents([
      { type: 'click', contactId: 'a', linkUrl: u('pick-01-unique') },
      { type: 'click', contactId: 'a', linkUrl: u('pick-01-clicks') },
      { type: 'click', contactId: 'b', linkUrl: u('pick-01-photo') },
    ], 3);
    t.equal(odd.byPick.length, 1);
    t.equal(odd.byPick[0].clicks, 1, 'only the real spot counts');
    t.equal(schema.clickSpotFromUrl(u('pick-01-unique')), null);
    t.equal(schema.clickSpotFromUrl('not a url'), null);
  });

  /* ---- 4. saving and sending --------------------------------------------- */

  await check('saving cleans template content through the template, not as sent', () => {
    const v = schema.validateCampaignPatch({ template: 'promo', templateData: { products: [{ name: '  Case  ', colors: 'A, B', junk: 'x' }], evil: 1 } });
    t.assert(v.ok, JSON.stringify(v.errors));
    t.equal(v.patch.templateData.products[0].name, 'Case');
    t.equal(v.patch.templateData.products[0].colors.length, 2);
    t.assert(!('junk' in v.patch.templateData.products[0]) && !('evil' in v.patch.templateData), 'unknown fields dropped');
  });

  await check('an unknown design, or content with no design, is refused', () => {
    t.assert(!schema.validateCampaignPatch({ template: 'mystery' }).ok, 'unknown template');
    t.assert(!schema.validateCampaignPatch({ templateData: {} }).ok, 'data without template');
    t.assert(!schema.validateCampaignPatch({ template: 'pwp', templateData: [] }).ok, 'array data');
    const big = { template: 'promo', templateData: { products: Array.from({ length: 12 }, () => promoProduct({ alt: 'x'.repeat(160), url: 'https://x.com/' + 'y'.repeat(590), image: 'https://x.com/' + 'z'.repeat(590) })) } };
    t.assert(schema.validateCampaignPatch(big).ok, 'the largest real email fits');
  });

  await check('a template email is refused at send with plain reasons, not a blank body', () => {
    const probs = send.contentProblems({ subject: 'Hi', template: 'promo', templateData: { products: [promoProduct({ price: '' })] } });
    t.assert(probs.some((p) => /price/.test(p)), 'the missing price is named');
    t.assert(!probs.some((p) => /no body/.test(p)), 'a template email has no body and must not be told it needs one');
    t.equal(send.contentProblems({ subject: 'Hi', template: 'promo', templateData: { products: [promoProduct()] } }).length, 0);
    t.assert(send.contentProblems({ subject: '', template: 'pwp', templateData: { teamMember: 'J', picks: [pwpPick()] } })
      .some((p) => /subject/.test(p)), 'still needs a subject');
  });

  await check('the sender builds a template email with the template, and adds the text footer', () => {
    const campaign = { id: 'MM-00042', subject: 'x', preheader: 'Hello {{first_name}}', template: 'pwp', templateData: { teamMember: 'J', picks: [pwpPick()] } };
    const html = send.buildHtml(campaign, { contact_name: 'Dana Whitmer' }, SETTINGS, 'tok9');
    t.assert(html.startsWith('<!doctype html>') && html.includes('picks with<br>personality.'), 'template html');
    t.assert(html.includes('Hello Dana'), 'preheader personalized');
    t.assert(html.includes('unsubscribe.html?t=tok9'), 'unsubscribe token');
    const text = send.buildText(campaign, {}, SETTINGS, 'tok9');
    t.assert(text.includes('Softstyle Tee | STYLE 64000 | MSRP $6.28'), 'text line');
    t.assert(text.includes('utm_content=pick-01-text'), 'text link tagged');
    t.assert(text.includes('Unsubscribe: https://alliteration.pmapparel.com/unsubscribe.html?t=tok9'), 'text footer');
  });

  await check('a template email with no full https site address is refused, for real and test sends', () => {
    const c = { template: 'pwp', templateData: {} };
    t.equal(send.templateSiteProblem(c, SETTINGS), null, 'a full address is fine');
    t.assert(/https/.test(send.templateSiteProblem(c, { unsubscribeUrl: 'alliteration.pmapparel.com/unsubscribe.html' })), 'no scheme is refused');
    t.assert(send.templateSiteProblem(c, {}), 'no address is refused');
    t.equal(send.templateSiteProblem({ body: 'x' }, {}), null, 'freeform emails do not need it');
  });

  await check('a real send of a template email is refused without the site address (called for real)', async () => {
    seedUsers();
    kv.set('mailme_data:campaigns', JSON.stringify([{
      id: 'MM-00007', status: 'draft', subject: 'picks', source: 'client', segmentTags: [],
      template: 'pwp', templateData: pwp.normalize({ teamMember: 'J', picks: [pwpPick()] }),
    }]));
    kv.set('mailme_data:settings', JSON.stringify({ unsubscribeUrl: 'alliteration.pmapparel.com/unsubscribe.html' }));
    const r = await send.sendCampaign('MM-00007', { username: 'abby' });
    t.equal(r.ok, false);
    const texts = (r.blockers || []).map((b) => (typeof b === 'string' ? b : b.text));
    t.assert(texts.some((x) => /full https:\/\/ link/.test(x)), 'site problem missing from: ' + JSON.stringify(texts));
    const test = await send.sendTestEmail('MM-00007', 'ryan@pmapparel.com');
    const ttexts = (test.blockers || []).map((b) => b.text);
    t.assert(ttexts.some((x) => /full https:\/\/ link/.test(x)), 'test send must refuse too: ' + JSON.stringify(ttexts));
  });

  await check('freeform emails now carry their preheader (it was saved and never sent)', () => {
    const html = send.buildHtml({ subject: 's', preheader: 'Order by Friday', body: 'Hi' }, {}, SETTINGS, 't');
    t.assert(html.includes('Order by Friday'), 'preheader missing');
    t.assert(/display:none/.test(html.slice(0, html.indexOf('Order by Friday'))), 'and hidden');
    const none = send.buildHtml({ subject: 's', body: 'Hi' }, {}, SETTINGS, 't');
    t.assert(!/display:none/.test(none), 'no preheader, no hidden block');
  });

  /* ---- 5. the composer --------------------------------------------------- */

  const src = fs.readFileSync(path.join(ROOT, 'apps/mailme.js'), 'utf8');
  const escSrc = src.slice(src.indexOf('function esc(s)'), src.indexOf('function fmtDate'));
  const pvSrc = src.slice(src.indexOf('function escapeAttr(s)'), src.indexOf('export default'));
  // eslint-disable-next-line no-new-func
  const pv = new Function(escSrc + pvSrc + '; return { TEMPLATE_CHOICES, pvCeilDollars, tfSet, tfGet, PWP_MAX_PICKS, PROMO_MAX_PRODUCTS, PWP_MAX_SWATCHES };')();

  await check('the composer\'s design list matches the server\'s', () => {
    t.equal(JSON.stringify(pv.TEMPLATE_CHOICES.map((c) => c.key)), JSON.stringify(T.templateChoices().map((c) => c.key)));
    t.equal(pv.PWP_MAX_PICKS, pwp.MAX_PICKS);
    t.equal(pv.PROMO_MAX_PRODUCTS, promo.MAX_PRODUCTS);
    t.equal(pv.PWP_MAX_SWATCHES, pwp.MAX_SWATCHES);
  });

  await check('"Shows as" under the price box rounds exactly like the email', () => {
    ['7.01', '7', '7.00', '$3.001', '1,250.5', '0.5', 'abc', '', '99.999'].forEach((v) => {
      t.equal(pv.pvCeilDollars(v), shared.ceilDollars(v), 'disagree on ' + JSON.stringify(v));
    });
  });

  await check('form paths write into nested content', () => {
    const o = {};
    pv.tfSet(o, 'picks.2.colors.0.name', 'Navy');
    t.equal(pv.tfGet(o, 'picks.2.colors.0.name'), 'Navy');
    t.assert(Array.isArray(o.picks) && Array.isArray(o.picks[2].colors), 'numeric keys make arrays');
  });

  await check('the preview asks the server to render; the browser has no copy of either design', () => {
    t.assert(/action: 'render'/.test(src), 'render action');
    t.assert(!/picks with<br>personality/.test(src), 'the pwp markup must not be copied into the app');
    t.assert(!/Setup charge shown is for printing/.test(src), 'the promo markup must not be copied into the app');
    t.assert(/api\.post\(ENDPOINTS\.mmImages/.test(src.slice(src.indexOf('function wireTemplateComposer'))), 'photos use the image upload');
  });

  /* ---- 6. the render route ------------------------------------------------ */

  const route = (await import(path.join(ROOT, 'api/mailme/campaigns.js'))).default;

  await check('view-only MailMe access can render a preview, and nothing is written', async () => {
    seedUsers();
    const before = JSON.stringify([...kv.entries()]);
    const res = await call(route, { as: { username: 'viewer' }, body: { action: 'render', template: 'promo', templateData: { products: [promoProduct()] }, subject: 's' } });
    t.equal(res.statusCode, 200, JSON.stringify(res.body));
    t.assert(res.body.html.includes('$8.00'), 'rendered');
    t.equal(res.body.problems.length, 0, 'complete content has no problems');
    t.equal(JSON.stringify([...kv.entries()]), before, 'render must not write');
  });

  await check('render hands back the cleaned starting content for a new design', async () => {
    seedUsers();
    const res = await call(route, { as: { username: 'abby' }, body: { action: 'render', template: 'pwp', templateData: {} } });
    t.equal(res.statusCode, 200);
    t.equal(res.body.templateData.picks.length, 5);
    t.assert(res.body.problems.length > 0, 'an empty design lists what it needs');
    t.assert(res.body.html.includes('/assets/email/pm-circle-logo.png'), 'preview art is relative to this site');
  });

  await check('render refuses an unknown design, and people without MailMe', async () => {
    seedUsers();
    const bad = await call(route, { as: { username: 'abby' }, body: { action: 'render', template: 'nope' } });
    t.equal(bad.statusCode, 400);
    const none = await call(route, { as: { username: 'amanda' }, body: { action: 'render', template: 'pwp' } });
    t.equal(none.statusCode, 403);
    const out = await call(route, { as: null, body: { action: 'render', template: 'pwp' } });
    t.equal(out.statusCode, 401);
  });

  await check('view-only access still cannot save', async () => {
    seedUsers();
    const res = await call(route, { as: { username: 'viewer' }, body: { subject: 's', template: 'pwp', templateData: {} } });
    t.equal(res.statusCode, 403);
  });

  process.exit(t.report());
})().catch((err) => {
  console.log('  FAIL could not run mailme template tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
