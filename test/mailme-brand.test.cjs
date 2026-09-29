// PUT IN: test/mailme-brand.test.cjs
/**
 * MailMe emails follow the P&M Branding Guidelines, 2026 edition (Sep 29 2026).
 *
 * Real renders of every design, not source-text matching. What is locked:
 *   1. COLOR. Black and white. Nothing but the brand black (#231f20), white
 *      and greys of that black, except the garment swatches a person types.
 *   2. TYPE. Arial and Arial Black only. No serif headline.
 *   3. HEADERS. Lower case, ending in a period, never an exclamation point,
 *      whatever is typed into the form.
 *   4. TEXTURE. Every design sits on the brand's black texture, and the
 *      texture file exists.
 *   5. VOICE. The seasonal design's starting copy has no exclamation points
 *      and no " - " used as a dash.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

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
  replyToDomain: 'pmapparel.com',
};

// Every color written into an email. "&#847;" (the preheader filler) is an
// entity, not a color, so a # right after & is skipped.
function colorsIn(html) {
  return [...new Set((html.match(/(?<!&)#[0-9a-f]{3,6}\b/gi) || []).map((c) => c.toLowerCase()))];
}
function fontsIn(html) {
  const out = new Set();
  (html.match(/font-family:[^;"]+/gi) || []).forEach((m) => out.add(m.replace(/^font-family:/i, '').trim()));
  (html.match(/font:\d+ [\d.]+px\/[\d.]+px [^;"]+/gi) || []).forEach((m) => out.add(m.replace(/^font:\S+ \S+ /i, '').trim()));
  return [...out];
}
function headersIn(html) {
  return (html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi) || []).map((h) => h.replace(/<[^>]+>/g, ''));
}

(async () => {
  const shared = await import(path.join(ROOT, 'lib/mailme/templates/shared.js'));
  const T = await import(path.join(ROOT, 'lib/mailme/templates/index.js'));
  const send = await import(path.join(ROOT, 'lib/mailme/send.js'));
  const { BRAND, brandHead } = shared;

  const ctx = (over) => Object.assign({ campaignId: 'MM-00042', settings: SETTINGS, unsubToken: 'tok123', assetBase: 'https://alliteration.pmapparel.com', accountManager: 'Hannah Posey' }, over || {});

  const SWATCHES = ['#1f2a44', '#8b0000'];
  const renders = {
    promo: T.TEMPLATES.promo.renderHtml({
      headline: 'Great Stuff For Your Team!', closingHeadline: 'Want More!!', ctaLabel: 'Shop Now',
      products: [{ name: 'Squeezer', colors: ['Yellow'], minimum: '50', price: '7', setup: '59', image: IMG, alt: 'x' }],
    }, ctx()),
    pwp: T.TEMPLATES.pwp.renderHtml({
      teamMember: 'Abby',
      picks: [{ name: 'Tee', style: '64000', msrp: '6.28', reason: 'Soft.', url: 'https://www.ssactivewear.com/p/x', image: IMG, alt: 'tee',
        colors: [{ name: 'Navy', hex: SWATCHES[0] }, { name: 'Maroon', hex: SWATCHES[1] }] }],
    }, ctx()),
    seasonal: T.TEMPLATES.seasonal.renderHtml({ calendar: { image: IMG, alt: 'Calendar', url: '' } }, ctx()),
  };
  const freeform = send.buildHtml({ id: 'MM-1', subject: 's', body: 'Hi. See [our site](https://www.pmapparel.com) or www.pmapparel.com.\n\n- one\n- two' },
    { contact_name: 'Dana W' }, SETTINGS, 'tok123');

  const PALETTE = new Set([BRAND.black, BRAND.white, '#fff', BRAND.grey, BRAND.soft, BRAND.rule, BRAND.wash]);

  /* ---- 1. color --------------------------------------------------------- */

  await check('the brand black is the one in the guidelines', () => {
    t.equal(BRAND.black, '#231f20');
    t.equal(BRAND.white, '#ffffff');
  });

  for (const [key, html] of Object.entries(renders)) {
    await check(`${key}: black, white and greys only`, () => {
      const stray = colorsIn(html).filter((c) => !PALETTE.has(c) && !SWATCHES.includes(c));
      t.equal(stray.length, 0, `off-brand colors in ${key}: ${stray.join(', ')}`);
    });
  }

  await check('freeform: black text and links, grey small print, nothing else', () => {
    const stray = colorsIn(freeform).filter((c) => !PALETTE.has(c));
    t.equal(stray.length, 0, 'off-brand colors: ' + stray.join(', '));
    t.assert(freeform.includes('font-family:Arial'), 'Arial, not whatever sans-serif the reader has');
    t.assert(/<a href="https:\/\/www\.pmapparel\.com"[^>]*text-decoration:underline/.test(freeform), 'links read as links without color');
  });

  await check('the old teal, taupe and near-blacks are gone', () => {
    const all = Object.values(renders).join('') + freeform;
    ['#2e7382', '#173c4a', '#e7e4de', '#111111', '#211d1e', '#3a6fb0', '#1c2430'].forEach((c) =>
      t.assert(!all.toLowerCase().includes(c), 'still using ' + c));
  });

  /* ---- 2. type ---------------------------------------------------------- */

  for (const [key, html] of Object.entries(renders)) {
    await check(`${key}: Arial and Arial Black only`, () => {
      const fonts = fontsIn(html);
      t.assert(fonts.length > 0, 'found fonts to check');
      const bad = fonts.filter((f) => !/^'?Arial/.test(f));
      t.equal(bad.length, 0, `other fonts in ${key}: ${bad.join(' | ')}`);
      t.assert(!/Georgia|Times|serif;/i.test(html.replace(/sans-serif/g, '')), 'no serif anywhere');
    });
  }

  /* ---- 3. headers -------------------------------------------------------- */

  await check('brandHead: lower case, period on the end, no exclamation points', () => {
    t.equal(brandHead('P&M Apparel Holiday Stores'), 'p&m apparel holiday stores.');
    t.equal(brandHead("Don't Wait - Get Started Today!"), "don't wait - get started today.");
    t.equal(brandHead('Wow!!! Big news!'), 'wow. big news.');
    t.equal(brandHead('Not seeing the right thing?'), 'not seeing the right thing?');
    t.equal(brandHead('Really?!'), 'really?');
    t.equal(brandHead('already done.'), 'already done.');
    t.equal(brandHead('Here is the list:'), 'here is the list:');
    t.equal(brandHead(''), '', 'nothing stays nothing');
  });

  for (const [key, html] of Object.entries(renders)) {
    await check(`${key}: every headline is lower case, ends in punctuation, never "!"`, () => {
      const hs = headersIn(html);
      if (key !== 'pwp') t.assert(hs.length > 0, 'found headlines to check');
      hs.forEach((h) => {
        const txt = h.replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
        t.equal(txt, txt.toLowerCase(), `not lower case: ${txt}`);
        t.assert(!txt.includes('!'), `exclamation point: ${txt}`);
        t.assert(/[.?:]$/.test(txt), `no closing punctuation: ${txt}`);
      });
    });
  }

  await check('promo: a headline typed in capitals with "!" still goes out on brand', () => {
    const html = renders.promo;
    t.assert(html.includes('great stuff for your team.'), 'hero headline');
    t.assert(html.includes('want more.'), 'closing headline');
    t.assert(html.includes('>shop now.</a>'), 'button label');
    t.assert(!/Great Stuff|Want More|Shop Now/.test(html.replace(/<title>[^<]*<\/title>/, '')), 'nothing left in title case');
  });

  await check('seasonal: buttons are lower case with a period', () => {
    t.assert(renders.seasonal.includes('>email hannah.</a>'), 'rep button');
    t.assert(renders.seasonal.includes('>start a project.</a>'), 'form button');
    t.assert(renders.seasonal.includes('good people. great gear.'), 'the tagline, the way the guidelines set it');
  });

  /* ---- 4. texture -------------------------------------------------------- */

  await check('every design sits on the black texture, with a black fallback', () => {
    t.assert(fs.existsSync(path.join(ROOT, 'assets/email/pm-print-pattern-dark.png')), 'texture file');
    for (const [key, html] of Object.entries(renders)) {
      t.assert(html.includes('https://alliteration.pmapparel.com/assets/email/pm-print-pattern-dark.png'), `${key} uses the texture`);
      t.assert(html.includes(`background-color:${BRAND.black}`), `${key} falls back to black when pictures are off`);
      t.assert(html.includes('v:fill type="tile"'), `${key} tiles it in Outlook too`);
    }
  });

  await check('seasonal carries the logo and the texture strip like the other designs', () => {
    t.assert(renders.seasonal.includes('/assets/email/pm-circle-logo-white.png'), 'logo');
    t.assert(renders.seasonal.includes('/assets/email/pm-texture-strip.jpg'), 'strip');
  });

  /* ---- 5. voice ---------------------------------------------------------- */

  await check('seasonal starting copy: no exclamation points, no spaced hyphen as a dash', () => {
    const d = T.TEMPLATES.seasonal.defaults();
    const words = [d.eyebrow, d.headline, d.intro, d.contactHeadline, d.amText, d.formPrompt, d.formLabel, d.signoff,
      ...d.sections.flatMap((s) => [s.heading, s.text])].join('\n');
    t.assert(!words.includes('!'), 'exclamation point in the starting copy');
    // Date ranges ("Oct 8 - 21") are fine; a hyphen between two words is a dash.
    t.assert(!/[a-z] - [a-z]/i.test(words), 'a spaced hyphen used as a dash');
    t.assert(!/—|–/.test(words), 'no em or en dashes');
  });
})().catch((err) => {
  console.log('  FAIL could not run mailme brand tests');
  console.log('       ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
