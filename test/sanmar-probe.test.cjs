// PUT IN: test/sanmar-probe.test.cjs
/**
 * SanMar probe: response reading and the credential gate.
 *
 * Real imports and real calls, not source-text greps. The probe exists to tell
 * us the truth about what SanMar sends back, so a probe that misreads a
 * response quietly is worse than no probe at all. The first version did
 * exactly that: it read one of the three blocks SanMar returns per item and
 * reported "no split pricing" for a style whose prices it had never looked at.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(ROOT, 'api/sanmar-probe.js'), 'utf8');

/* The real response shape from SanMar's own guide: three sibling blocks per
 * item inside one <listResponse>. Includes the near-miss tags that broke the
 * first version, <sizeIndex> beside <size> and <colorSquareImage> beside
 * <color>, and two colours of one size at different case prices. */
function item({ color, catalogColor, size, sizeIndex, invKey, casePrice }) {
  return `<listResponse>
  <productBasicInfo>
    <brandName>District &amp; Co</brandName><style>DT6105</style>
    <color>${color}</color><catalogColor>${catalogColor}</catalogColor>
    <size>${size}</size><sizeIndex>${sizeIndex}</sizeIndex>
    <inventoryKey>${invKey}</inventoryKey><uniqueKey>${invKey}${sizeIndex}</uniqueKey>
    <caseSize>36</caseSize><productStatus>Active</productStatus>
  </productBasicInfo>
  <productImageInfo>
    <colorSquareImage>https://cdnm.sanmar.com/swatch/gifs/dt_${catalogColor}.gif</colorSquareImage>
    <frontModel>https://cdnm.sanmar.com/imglib/mresjpg/DT6105_${catalogColor}.jpg</frontModel>
  </productImageInfo>
  <productPriceInfo>
    <casePrice>${casePrice}</casePrice><piecePrice>9.98</piecePrice>
    <priceCode>A/P</priceCode><priceText>Price applies to sizes S-XL</priceText>
    <mapPrice>8.98</mapPrice>
  </productPriceInfo>
</listResponse>`;
}

const SAMPLE = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>
<ns2:getProductInfoByStyleColorSizeResponse xmlns:ns2="http://impl.webservice.integration.sanmar.com/">
<return><errorOccured>false</errorOccured>` +
  item({ color: 'Heathered Navy', catalogColor: 'HthNavy', size: 'M', sizeIndex: '3', invKey: '118864', casePrice: '5.68' }) +
  item({ color: 'Black Frost', catalogColor: 'BlkFrost', size: 'M', sizeIndex: '3', invKey: '118865', casePrice: '6.42' }) +
  `<message>Product Info sent successfully.</message></return>
</ns2:getProductInfoByStyleColorSizeResponse></S:Body></S:Envelope>`;

(async () => {
  const mod = await import('file://' + path.join(ROOT, 'api/sanmar-probe.js'));

  t.test('the probe module loads and exports what the tests call', () => {
    t.assert(typeof mod.default === 'function', 'no default handler export');
    t.assert(typeof mod.summarise === 'function', 'no summarise export');
  });

  t.test('every product row in the response is found', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(s.rowCount, 2, 'both rows read');
    t.equal(s.colorCount, 2, 'both colours read');
  });

  t.test('pricing and images are read, not just the basic block', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(s.firstRow.casePrice, '5.68', 'casePrice lives in productPriceInfo');
    t.equal(s.firstRow.priceCode, 'A/P', 'the price code is the same one the pricelist carries');
    t.assert(s.firstRow.frontModel, 'the image URL lives in productImageInfo');
    t.assert(s.pricingPresent, 'pricingPresent must be true when prices came back');
  });

  t.test('a near-miss tag is not mistaken for the field beside it', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(s.firstRow.size, 'M', 'size must not read <sizeIndex>');
    t.equal(s.firstRow.sizeIndex, '3', 'sizeIndex must survive intact');
    t.equal(s.firstRow.color, 'Heathered Navy', 'color must not read <colorSquareImage>');
  });

  t.test('XML entities are decoded', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(s.firstRow.brandName, 'District & Co', 'the brand name still carries &amp;');
  });

  t.test('two colours of one size at different prices are reported as split pricing', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(Object.keys(s.sizesWithSplitPricing).join(','), 'M',
      'size M prices differently by colour and must be called out');
    t.equal(Object.keys(s.sizesWithSplitPricing.M).sort().join(','), '5.68,6.42',
      'both prices must be reported, with the colours on each');
  });

  t.test('one price across a size is NOT reported as split pricing', () => {
    const flat = SAMPLE.replace('<casePrice>6.42</casePrice>', '<casePrice>5.68</casePrice>');
    const s = mod.summarise(flat);
    t.equal(Object.keys(s.sizesWithSplitPricing).length, 0,
      'a style that prices the same in every colour must come back clean');
    t.assert(s.pricingPresent, 'and it must still say pricing was present');
  });

  t.test('no pricing at all reads as silence, not as a clean answer', () => {
    const noPrice = SAMPLE.replace(/<productPriceInfo>[\s\S]*?<\/productPriceInfo>/g, '');
    const s = mod.summarise(noPrice);
    t.equal(Object.keys(s.sizesWithSplitPricing).length, 0, 'nothing to split');
    t.equal(s.pricingPresent, false,
      'an empty split-pricing result with no prices must not read as clean');
  });

  t.test('a differently shaped response still yields rows rather than zero', () => {
    const odd = SAMPLE.replace(/<\/?listResponse>/g, '');
    t.equal(mod.summarise(odd).rowCount, 2, 'fallback chunking must still find both');
  });

  t.test('an empty or unrecognised response reads as zero rows, not as a crash', () => {
    ['', '<S:Envelope/>', 'not xml at all'].forEach((junk) => {
      const s = mod.summarise(junk);
      t.equal(s.rowCount, 0, 'junk input must return an empty summary');
      t.equal(s.firstRow, null, 'no invented first row');
    });
  });

  t.test('the fields a purchase order will need are carried through', () => {
    const s = mod.summarise(SAMPLE);
    ['inventoryKey', 'sizeIndex', 'catalogColor'].forEach((f) => {
      t.assert(s.firstRow[f], 'first row is missing ' + f);
    });
  });

  t.test('the size to sizeIndex map is reported, since a PO is keyed on it', () => {
    const s = mod.summarise(SAMPLE);
    t.equal(JSON.stringify(s.sizeIndexBySize), JSON.stringify({ M: ['3'] }));
  });

  /* ---- the gate ---------------------------------------------------------- */

  t.test('the route is superuser-gated with a strict boolean, not data_scope', () => {
    t.assert(route.includes('superuser === true'),
      'must require superuser === true, the CrewCore lesson');
    t.assert(!route.includes('data_scope'),
      'data_scope is a BackBone sales setting, never a permission gate');
    t.assert(route.includes('requireAuth'), 'must authenticate');
  });

  t.test('the probe never writes anything', () => {
    ['kvSet', 'kvDel', 'put(', 'store.js'].forEach((w) => {
      t.assert(!route.includes(w), 'a probe must not write: found ' + w);
    });
  });

  t.test('credentials are read from env and never echoed back', () => {
    ['SANMAR_CUSTOMER_NUMBER', 'SANMAR_WS_USER', 'SANMAR_WS_PASSWORD'].forEach((v) => {
      t.assert(route.includes('process.env.' + v), 'missing env var ' + v);
    });
    t.assert(!/error: e[,}\s]/.test(route),
      'return the error MESSAGE, not the error object, or the request goes with it');
  });

  // Without this the file prints its results and exits 0, so every check in
  // it is decorative: a real failure would never turn the suite red.
  process.exit(t.report());
})();
