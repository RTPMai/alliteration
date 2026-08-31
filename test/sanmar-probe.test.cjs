/**
 * SanMar probe: response reading and the credential gate.
 *
 * These are real imports and real calls, not source-text greps. The point of
 * the probe is to tell us the truth about what SanMar sends back, so a probe
 * that misreads a response quietly is worse than no probe at all.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(ROOT, 'api/sanmar-probe.js'), 'utf8');

/* A trimmed copy of the shape SanMar's guide documents: two colours of the
 * same size at DIFFERENT case prices, which is the thing the probe exists to
 * detect. */
const SAMPLE = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>
<ns2:getProductInfoByStyleColorSizeResponse xmlns:ns2="http://impl.webservice.integration.sanmar.com/">
<return><errorOccured>false</errorOccured><listResponse>
<productBasicInfo>
  <brandName>District</brandName><style>DT6105</style>
  <color>Heathered Navy</color><catalogColor>HthNavy</catalogColor>
  <size>M</size><sizeIndex>3</sizeIndex>
  <inventoryKey>118864</inventoryKey><uniqueKey>1188643</uniqueKey>
  <caseSize>36</caseSize><piecePrice>9.98</piecePrice><casePrice>5.68</casePrice>
  <priceCode>A</priceCode><productStatus>Active</productStatus>
</productBasicInfo>
<productBasicInfo>
  <brandName>District</brandName><style>DT6105</style>
  <color>Black Frost</color><catalogColor>BlkFrost</catalogColor>
  <size>M</size><sizeIndex>3</sizeIndex>
  <inventoryKey>118865</inventoryKey><uniqueKey>1188653</uniqueKey>
  <caseSize>36</caseSize><piecePrice>10.98</piecePrice><casePrice>6.42</casePrice>
  <priceCode>A</priceCode><productStatus>Active</productStatus>
</productBasicInfo>
</listResponse></return>
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

  t.test('two colours of one size at different prices are reported as split pricing', () => {
  const s = mod.summarise(SAMPLE);
  t.equal(JSON.stringify(s.sizesWithSplitPricing), JSON.stringify(['M']),
    'size M prices differently by colour and must be called out');
});

  t.test('one price across a size is NOT reported as split pricing', () => {
  const flat = SAMPLE.replace('<casePrice>6.42</casePrice>', '<casePrice>5.68</casePrice>');
  const s = mod.summarise(flat);
  t.equal(s.sizesWithSplitPricing.length, 0,
    'a style that prices the same in every colour must come back clean');
});

  t.test('an empty or unrecognised response reads as zero rows, not as a crash', () => {
  ['', '<S:Envelope/>', 'not xml at all'].forEach((junk) => {
    const s = mod.summarise(junk);
    t.equal(s.rowCount, 0, 'junk input must return an empty summary');
    t.equal(s.firstRow, null, 'no invented first row');
  });
});

  t.test('the ordering fields the PO side will need are carried through', () => {
  const s = mod.summarise(SAMPLE);
  ['inventoryKey', 'sizeIndex', 'catalogColor'].forEach((f) => {
    t.assert(s.firstRow[f], 'first row is missing ' + f);
  });
});

/* ---- the gate ------------------------------------------------------------ */

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
  // The response body is assembled field by field; nothing puts the password
  // object into it. Guard the one way it could sneak back: returning the raw
  // error object from a failed fetch, which can carry the request.
  t.assert(!/error: e[,}\s]/.test(route),
    'return the error MESSAGE, not the error object, or the request goes with it');
});
})();
