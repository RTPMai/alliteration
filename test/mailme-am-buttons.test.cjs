// PUT IN: test/mailme-am-buttons.test.cjs
/**
 * MailMe Seasonal: every account manager in one email (Oct 1 2026).
 *
 * Ryan wanted one send to one list with every account manager's button in it,
 * like the sales director's original, so the reader picks theirs. Each button
 * goes through /api/mailme/am so the click is counted, labelled with whether
 * it was the reader's own account manager. Reports turns that into "do our
 * clients know who their account manager is".
 *
 * Real calls: the template, the public page over a fake Upstash, and the
 * report math.
 */

const path = require('path');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

const kv = new Map();
const ok = (result) => ({ ok: true, status: 200, json: async () => result });
global.fetch = async (url, opts) => {
  const raw = String(url);
  if (/\/pipeline$/.test(raw)) {
    return ok(JSON.parse(opts.body).map(([op, key]) => (op === 'GET' ? { result: kv.has(key) ? kv.get(key) : null } : { result: 'OK' })));
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  return ok({ result: kv.has(key) ? kv.get(key) : null });
};
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

const SETTINGS = { replyToDomain: 'pmapparel.com', unsubscribeUrl: 'https://alliteration.pmapparel.com/unsubscribe.html' };
const BASE = 'https://alliteration.pmapparel.com';

function fakeRes() {
  return {
    statusCode: null, body: '', headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

(async () => {
  const S = (await import(path.join(ROOT, 'lib/mailme/templates/index.js'))).TEMPLATES.seasonal;
  const schema = await import(path.join(ROOT, 'lib/mailme/schema.js'));
  const ctx = (o) => Object.assign({ campaignId: 'MM-00099', settings: SETTINGS, unsubToken: 't', assetBase: BASE }, o || {});
  const amLinks = (html) => (html.match(/href="https:\/\/[^"]*\/api\/mailme\/am\?[^"]*"/g) || []).map((h) => h.slice(6, -1).replace(/&amp;/g, '&'));

  /* ---- the email ---- */

  await t.test('new seasonal emails show every account manager by default', () => {
    t.equal(S.defaults().contactMode, 'all');
    t.equal(S.normalize({}).contactMode, 'all', 'a draft from before today gets the new default');
    t.equal(S.normalize({ contactMode: 'theirs' }).contactMode, 'theirs');
    t.equal(S.normalize({ contactMode: 'nonsense' }).contactMode, 'all');
  });

  await t.test('one email, a button per name, same buttons for every reader', () => {
    const forHannahs = S.renderHtml({ people: ['Abby', 'Alexis', 'Hannah'] }, ctx({ accountManager: 'Hannah Posey' }));
    const forNobody = S.renderHtml({ people: ['Abby', 'Alexis', 'Hannah'] }, ctx({ accountManager: '' }));
    const names = (h) => amLinks(h).map((u) => new URL(u).searchParams.get('to')).join(',');
    t.equal(names(forHannahs), 'abby,alexis,hannah');
    t.equal(names(forNobody), 'abby,alexis,hannah', 'readers with no account manager still get every button');
    t.assert(/>hannah\.<\/a>/.test(forHannahs), 'labelled with the name, the brand way');
    t.assert(forHannahs.includes("Click your account manager"), 'the line above the buttons');
    t.assert(forHannahs.includes('>start a project.</a>'), 'the inquiry form is still there');
  });

  await t.test('each click says whether it was the reader\'s own account manager', () => {
    const html = S.renderHtml({ people: ['Abby', 'Hannah'] }, ctx({ accountManager: 'Hannah Posey' }));
    const tags = amLinks(html).map((u) => new URL(u).searchParams.get('utm_content'));
    t.equal(tags.join(','), 'am-abby-other,am-hannah-own');
    const none = S.renderHtml({ people: ['Abby'] }, ctx({ accountManager: 'House Account' }));
    t.equal(new URL(amLinks(none)[0]).searchParams.get('utm_content'), 'am-abby-none', 'an owner not on the list has no right answer');
  });

  await t.test('the button carries the subject and never a domain', () => {
    const u = new URL(amLinks(S.renderHtml({ people: ['Abby'] }, ctx()))[0]);
    t.equal(u.searchParams.get('s'), "Let's start my holiday project");
    t.assert(!u.search.includes('pmapparel.com'), 'the address is built on our side, not carried in the link');
  });

  await t.test('without a site to point at, the buttons fall back to plain email links', () => {
    const html = S.renderHtml({ people: ['Abby', 'Hannah'] }, ctx({ assetBase: '' }));
    t.equal(amLinks(html).length, 0);
    t.equal((html.match(/href="mailto:/g) || []).length, 2);
  });

  await t.test('no reply-to domain in Settings means no buttons at all, not guessed ones', () => {
    const html = S.renderHtml({}, ctx({ settings: { ...SETTINGS, replyToDomain: '' } }));
    t.equal(amLinks(html).length + (html.match(/href="mailto:/g) || []).length, 0);
  });

  await t.test('the plain-text version lists everyone\'s address', () => {
    const text = S.renderText({ people: ['Abby', 'Hannah'] }, ctx());
    t.assert(text.includes('Abby: abby@pmapparel.com') && text.includes('Hannah: hannah@pmapparel.com'), text);
  });

  await t.test('every-account-manager mode with an empty list is flagged before sending', () => {
    t.assert(S.problems({ people: [] }).some((p) => /at least one account manager/.test(p)));
    t.equal(S.problems({ people: [], contactMode: 'theirs' }).some((p) => /at least one account manager/.test(p)), false);
  });

  /* ---- the page the button opens ---- */

  await t.test('amMailto only ever builds firstname@ our own domain', () => {
    t.equal(schema.amMailto('hannah', "Let's go", 'pmapparel.com').href, 'mailto:hannah@pmapparel.com?subject=Let%27s%20go');
    t.equal(schema.amMailto('Hannah', '', 'pmapparel.com').name, 'Hannah');
    ['hannah@evil.com', 'han nah', '', 'x', 'a'.repeat(21), '<script>', 'hannah?cc=x'].forEach((bad) => {
      t.equal(schema.amMailto(bad, '', 'pmapparel.com'), null, 'accepted ' + JSON.stringify(bad));
    });
    t.equal(schema.amMailto('hannah', '', ''), null, 'no domain, no address');
    t.assert(!schema.amMailto('hannah', 'a\r\nbcc: x@y.com', 'pmapparel.com').href.includes('%0A'), 'no header injection through the subject');
  });

  const route = (await import(path.join(ROOT, 'api/mailme/am.js'))).default;
  kv.set('mailme_data:settings', JSON.stringify(SETTINGS));

  await t.test('the page opens an email to that account manager, no login needed', async () => {
    const res = fakeRes();
    await route({ method: 'GET', query: { to: 'hannah', s: "Let's start my holiday project" }, headers: {} }, res);
    t.equal(res.statusCode, 200);
    t.assert(res.body.includes('hannah@pmapparel.com'), 'says the address out loud');
    t.assert(res.body.includes('location.replace("mailto:hannah@pmapparel.com?subject=Let%27s%20start'), 'opens the email');
  });

  await t.test('the page refuses anything that is not a first name', async () => {
    const res = fakeRes();
    await route({ method: 'GET', query: { to: 'x@evil.com' }, headers: {} }, res);
    t.equal(res.statusCode, 400);
    t.assert(!res.body.includes('mailto:'), 'no email link on a bad request');
  });

  /* ---- Reports ---- */

  const click = (who, content) => ({ type: 'click', contactId: who, linkUrl: `${BASE}/api/mailme/am?to=x&utm_content=${content}` });

  await t.test('Reports: per button, and how many people picked their own', () => {
    const events = [
      click('c1', 'am-hannah-own'), click('c1', 'am-hannah-own'),   // one person, twice
      click('c2', 'am-hannah-other'),                              // Alexis's client picked Hannah
      click('c3', 'am-abby-own'),
      click('p4', 'am-abby-none'),                                 // prospect, no AM
      click('c5', 'am-abby-other'), click('c5', 'am-jacob-own'),   // wrong first, then right
      { type: 'click', contactId: 'c6', linkUrl: 'https://forms.monday.com/x?utm_content=form' },
    ];
    const r = schema.aggregateEvents(events, 10);
    const hannah = r.byAm.find((x) => x.name === 'Hannah');
    t.equal(hannah.people, 2); t.equal(hannah.clicks, 3); t.equal(hannah.own, 1); t.equal(hannah.other, 1);
    t.equal(JSON.stringify(r.knewAm), JSON.stringify({ own: 2, other: 2, none: 1 }), 'counted by each person\'s FIRST pick');
    t.assert(!r.byAm.some((x) => /form/i.test(x.name)), 'the inquiry form is not an account manager');
  });

  await t.test('a hand-typed tag that only looks like a button is ignored', () => {
    t.equal(schema.clickSpotFromUrl(`${BASE}/x?utm_content=am-hannah-maybe`), null);
    t.equal(schema.clickSpotFromUrl(`${BASE}/x?utm_content=am-h4nnah-own`), null);
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
