/**
 * SanMar product feed: pricing, parsing and failure behaviour.
 *
 * This module puts dollar figures on a sheet that goes to a vendor and on an
 * employee's apparel stipend, so the arithmetic is covered properly rather
 * than eyeballed once.
 *
 * The numbers below are real values pulled from the live feed on Aug 31 2026
 * for PC61 and DT6105, not invented fixtures. If SanMar changes what these
 * styles cost these tests still pass: they check the arithmetic and the
 * reading, not today's prices.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* Real response shape: three sibling blocks per item in one <listResponse>. */
function item({ color, code, size, sizeIndex, invKey, casePrice, sale }) {
  return `<listResponse>
  <productBasicInfo>
    <brandName>Port &amp; Co</brandName><style>PC61</style>
    <productTitle>Port &amp; Co Essential Tee. PC61</productTitle>
    <category>T-Shirts</category><productStatus>Active</productStatus>
    <color>${color}</color><catalogColor>${code}</catalogColor>
    <size>${size}</size><sizeIndex>${sizeIndex}</sizeIndex>
    <inventoryKey>${invKey}</inventoryKey><uniqueKey>${invKey}${sizeIndex}</uniqueKey>
    <caseSize>72</caseSize>
  </productBasicInfo>
  <productImageInfo>
    <colorSquareImage>https://cdnm.sanmar.com/swatch/gifs/port_${code}.gif</colorSquareImage>
    <colorProductImage>https://cdnm.sanmar.com/catalog/PC61_${code}.jpg</colorProductImage>
    <productImage>https://cdnm.sanmar.com/catalog/images/PC61.jpg</productImage>
  </productImageInfo>
  <productPriceInfo>
    <casePrice>${casePrice}</casePrice><piecePrice>4.12</piecePrice>
    <priceCode>A/P</priceCode>
    ${sale ? `<caseSalePrice>${sale}</caseSalePrice><saleStartDate>2026-08-31</saleStartDate>` : ''}
    <mapPrice>4.99</mapPrice>
  </productPriceInfo>
</listResponse>`;
}

const PC61 = `<S:Envelope><S:Body><ns2:getProductInfoByStyleColorSizeResponse>
<return><errorOccured>false</errorOccured>` +
  // White is one of the two cheap colours. Size S carries index 2 here.
  item({ color: 'White', code: 'White', size: 'S', sizeIndex: '2', invKey: '11803', casePrice: '3.12', sale: '2.67' }) +
  item({ color: 'White', code: 'White', size: 'XXL', sizeIndex: '1', invKey: '11807', casePrice: '4.67', sale: '4.10' }) +
  // Navy is one of the 60 dearer colours, and it uses the OTHER index scheme.
  item({ color: 'Navy', code: 'Navy', size: 'S', sizeIndex: '1', invKey: '266777', casePrice: '3.45', sale: '2.95' }) +
  `<message>Product Info sent successfully.</message></return>
</ns2:getProductInfoByStyleColorSizeResponse></S:Body></S:Envelope>`;

const EMPTY = `<S:Envelope><S:Body><return><errorOccured>false</errorOccured>
<message>Product Info sent successfully.</message></return></S:Body></S:Envelope>`;

const ERRORED = `<S:Envelope><S:Body><return><errorOccured>true</errorOccured>
<message>ERROR: User authenticating failed</message></return></S:Body></S:Envelope>`;

(async () => {
  const m = await import('file://' + path.join(ROOT, 'lib/crewcore/sanmar.js'));

  /* ---- pricing ---------------------------------------------------------- */

  t.test('a 50% sample is half the case price, with the half-cent dropped', () => {
    // DT6105: case 11.37, so 5.685, which SanMar invoices as 5.68.
    t.equal(m.samplePrice(11.37, 50), 5.68);
    t.equal(m.samplePrice(3.45, 50), 1.72);   // 1.725 down to 1.72
    t.equal(m.samplePrice(3.12, 50), 1.56);   // exact, unchanged
  });

  t.test('a 25% sample takes a quarter off the case price', () => {
    t.equal(m.samplePrice(11.37, 25), 8.52);  // 8.5275 down to 8.52
    t.equal(m.samplePrice(3.12, 25), 2.34);
  });

  t.test('rounding is always down, never to nearest', () => {
    // 5.685 to nearest is 5.69. Getting this wrong overcharges every person
    // on every half-cent line, and matches nothing SanMar sends back.
    t.assert(m.samplePrice(11.37, 50) !== 5.69, 'must not round the half up');
  });

  t.test('a missing or nonsense price prices nothing rather than zero', () => {
    [null, undefined, 0, -4, 'abc'].forEach((bad) => {
      t.equal(m.samplePrice(bad, 50), null, 'bad price must not become a number');
    });
    t.equal(m.samplePrice(11.37, 100), null, 'a 100% discount is not a tier');
    t.equal(m.samplePrice(11.37, null), null);
  });

  t.test('the price code reproduces MSRP, which is how the feed was checked', () => {
    // Case 11.37 at code A/P (50% off) implies MSRP 22.74, and SanMar's own
    // mapPrice for that row is 18.19, which is 80% of 22.74. Two independent
    // fields agreeing on a number neither one states.
    t.equal(m.impliedMsrp(11.37, 'A/P'), 22.74);
    t.equal(Math.round(22.74 * 0.8 * 100) / 100, 18.19);
    t.equal(m.impliedMsrp(3.12, 'A/P'), 6.24);
  });

  t.test('a price code whose halves disagree is refused, not picked from', () => {
    t.equal(m.impliedMsrp(11.37, 'A/Q'), null, 'A is 50% and Q is 45%: say nothing');
    t.equal(m.impliedMsrp(11.37, 'Z'), null, 'unknown code');
    t.equal(m.impliedMsrp(11.37, ''), null);
  });

  /* ---- tiers ------------------------------------------------------------ */

  t.test('brands land in the right tier despite naming drift', () => {
    t.equal(m.tierForBrand('Port & Co'), 50, 'what the feed calls it');
    t.equal(m.tierForBrand('Port & Company'), 50, 'what the order form calls it');
    t.equal(m.tierForBrand('Sport-Tek'), 50);
    t.equal(m.tierForBrand('District'), 50);
    t.equal(m.tierForBrand('The North Face'), 25);
    t.equal(m.tierForBrand('TravisMathew'), 25);
    t.equal(m.tierForBrand('Stanley/Stella'), 25);
  });

  t.test('an unrecognised brand gets no tier rather than the cheaper one', () => {
    // Defaulting to 50 would quietly halve a price nobody checked.
    t.equal(m.tierForBrand('Gildan'), null);
    t.equal(m.tierForBrand(''), null);
    t.equal(m.tierForBrand(null), null);
  });

  /* ---- style lists ------------------------------------------------------ */

  t.test('a pasted order-form line yields just the style number', () => {
    const out = m.parseStyleList('F180 Port Authority Therma-Tek Fleece Jacket', 50);
    t.equal(out.length, 1);
    t.equal(out[0].style, 'F180');
    t.equal(out[0].tier, 50);
  });

  t.test('bare style numbers, long ones and lowercase all parse', () => {
    const out = m.parseStyleList('NF0A8JEV\nct106432\nMM1040', 25);
    t.equal(out.map((r) => r.style).join(','), 'NF0A8JEV,CT106432,MM1040');
  });

  t.test('blank lines and duplicates are dropped', () => {
    const out = m.parseStyleList('PC61\n\n  \nPC61\nDT6105', 50);
    t.equal(out.length, 2, 'a style pasted twice is one style');
  });

  t.test('a line with no digits is not a style number', () => {
    // Headings off the order form ("New Arrivals", "50% OFF") come along with
    // the paste and must not become styles.
    t.equal(m.parseStyleList('New Arrivals\nFall Catalog', 50).length, 0);
  });

  /* ---- sizes ------------------------------------------------------------ */

  t.test('the two spellings of one size normalise together', () => {
    // PC61 says 2XL, DT6105 says XXL, same garment.
    t.equal(m.normSize('XXL'), '2XL');
    t.equal(m.normSize('xxxl'), '3XL');
    t.equal(m.normSize(' 2XL '), '2XL');
  });

  t.test('sizes sort in wearing order, not alphabetically', () => {
    t.equal(m.sortSizes(['2XL', 'S', 'XL', 'XS', 'M', 'L']).join(','), 'XS,S,M,L,XL,2XL');
  });

  t.test('an unknown size sorts last instead of disappearing', () => {
    const out = m.sortSizes(['OSFA', 'M', 'S']);
    t.equal(out.join(','), 'S,M,OSFA');
  });

  /* ---- building a style ------------------------------------------------- */

  t.test('a response becomes colours with size runs under them', () => {
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    t.equal(s.colors.length, 2, 'White and Navy');
    t.equal(s.style, 'PC61');
    t.equal(s.brand, 'Port & Co', 'the entity is decoded');
    const white = s.colors.find((c) => c.name === 'White');
    t.equal(white.sizes.length, 2);
    t.equal(white.sizes[0].size, 'S', 'sizes sort in wearing order');
    t.equal(white.sizes[1].size, '2XL', 'and XXL normalised on the way in');
  });

  t.test('each size carries its own sample price off its own case price', () => {
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    const white = s.colors.find((c) => c.name === 'White');
    const navy = s.colors.find((c) => c.name === 'Navy');
    t.equal(white.sizes[0].price, 1.56, 'White S: half of 3.12');
    t.equal(white.sizes[1].price, 2.33, '2XL steps up: half of 4.67, half-cent dropped');
    t.equal(navy.sizes[0].price, 1.72, 'Navy S is dearer than White S at the same size');
  });

  t.test('two colours priced differently is reported, not flattened', () => {
    // PC61 really does this: White and Natural undercut the other 60 colours.
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    t.equal(s.summary.split_pricing, true);
    t.equal(s.summary.from_price, 1.56);
    t.equal(s.summary.to_price, 2.33);
  });

  t.test('the ordering keys are carried verbatim, never derived from the size', () => {
    // The feed uses two index schemes, sometimes inside one style: White S is
    // index 2 and Navy S is index 1. A PO is keyed on this pair, so computing
    // it from a size name would order the wrong garment and look correct.
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    const white = s.colors.find((c) => c.name === 'White');
    const navy = s.colors.find((c) => c.name === 'Navy');
    t.equal(white.sizes[0].size_index, '2');
    t.equal(navy.sizes[0].size_index, '1');
    t.equal(white.sizes[0].inventory_key, '11803');
    t.equal(navy.sizes[0].inventory_key, '266777');
  });

  t.test('the colour code an order has to carry is kept', () => {
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    t.assert(s.colors.every((c) => c.code), 'catalogColor is what a PO names, not the pretty name');
  });

  t.test('a sale is recorded for display but never priced from', () => {
    const s = m.buildStyle(PC61, { style: 'PC61', tier: 50 });
    t.equal(s.on_sale, true, 'the sale is visible');
    const white = s.colors.find((c) => c.name === 'White');
    t.equal(white.sizes[0].sale_case_price, 2.67, 'and carried');
    t.equal(white.sizes[0].price, 1.56,
      'but the price comes off the regular 3.12, not the 2.67 sale: Ryan\'s call');
  });

  t.test('a style with no products returns null rather than an empty shell', () => {
    t.equal(m.buildStyle(EMPTY, { style: 'PC61', tier: 50 }), null);
    t.equal(m.buildStyle('', { style: 'PC61', tier: 50 }), null);
  });

  /* ---- fetching --------------------------------------------------------- */

  const creds = { customerNumber: '71892', user: 'u', password: 'secret-pw' };

  await t.test('a good response comes back built', async () => {
    const res = await m.fetchStyle('PC61', {
      tier: 50, creds,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => PC61 }),
    });
    t.equal(res.ok, true);
    t.equal(res.record.colors.length, 2);
  });

  await t.test('a network failure is reported, not thrown', async () => {
    // 138 styles must not lose 137 because one call failed.
    const res = await m.fetchStyle('PC61', {
      tier: 50, creds,
      fetchImpl: async () => { throw new Error('socket hang up'); },
    });
    t.equal(res.ok, false);
    t.assert(res.error.includes('socket hang up'), 'the reason survives');
  });

  await t.test('a failure never carries the password back', async () => {
    const res = await m.fetchStyle('PC61', {
      tier: 50, creds,
      fetchImpl: async () => {
        // A real fetch error can carry the request, and the request carries
        // the credentials. Returning the error OBJECT would leak them.
        const e = new Error('bad request');
        e.request = { body: m.buildEnvelope({ style: 'PC61', ...creds }) };
        throw e;
      },
    });
    t.assert(!JSON.stringify(res).includes('secret-pw'), 'password must not be in the result');
  });

  await t.test('SanMar answering with its own error is reported with its message', async () => {
    const res = await m.fetchStyle('PC61', {
      tier: 50, creds,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => ERRORED }),
    });
    t.equal(res.ok, false);
    t.assert(res.error.includes('authenticating failed'));
  });

  await t.test('a non-2xx is reported with its status', async () => {
    const res = await m.fetchStyle('PC61', {
      tier: 50, creds,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    });
    t.equal(res.ok, false);
    t.assert(res.error.includes('503'));
  });

  await t.test('a retired style is reported by name rather than silently skipped', async () => {
    const res = await m.fetchStyle('OLD1', {
      tier: 50, creds,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => EMPTY }),
    });
    t.equal(res.ok, false);
    t.equal(res.style, 'OLD1');
  });

  await t.test('missing credentials are named, and no call is attempted', async () => {
    let called = false;
    const res = await m.fetchStyle('PC61', {
      tier: 50,
      creds: { customerNumber: '', user: '', password: '' },
      fetchImpl: async () => { called = true; return { ok: true, status: 200, text: async () => PC61 }; },
    });
    t.equal(res.ok, false);
    t.equal(called, false, 'do not call SanMar with empty credentials');
    t.assert(res.error.includes('SANMAR_WS_USER'));
  });

  t.test('the envelope carries the style and the credentials in SanMar\'s shape', () => {
    const xml = m.buildEnvelope({ style: 'PC61', ...creds });
    t.assert(xml.includes('<style>PC61</style>'));
    t.assert(xml.includes('<sanMarCustomerNumber>71892</sanMarCustomerNumber>'));
    t.assert(xml.includes('getProductInfoByStyleColorSize'));
  });
})();
