// PUT IN: test/promopro-search.test.cjs
/**
 * The search box on PromoPro's Purchase Orders screen.
 *
 * A search that quietly misses reads as "we never raised one", and somebody
 * raises a second. So every field a person might have in hand is checked, and
 * so is every way a PO number gets written.
 */

const t = require('./harness.cjs');

const PO = {
  poNumber: '26-66608-9',
  printavo: {
    invoiceNumber: '66608',
    companyName: 'Hy-Vee',
    customerName: 'Hy-Vee',
    contactName: 'Jill Stevens',
  },
  lines: [
    { itemNumber: 'PC54-BLK', description: 'Core Cotton Tee', imprint: 'Left chest', detail: 'Black' },
    { itemNumber: '1234', description: 'Koozie', imprint: '', detail: '' },
  ],
  trackingNumber: '1Z999AA10123456784',
  carrier: 'UPS',
  shipTo: '1500 W Bridge Rd, Polk City',
  notes: 'Rush for the Ankeny store opening',
};
const NAMES = { customer: 'Hy-Vee', vendor: 'PowerTek', am: 'Hannah Posey' };

(async () => {
  const s = await import('../lib/promopro/search.js');
  const text = s.poSearchText(PO, NAMES);
  const hit = (term) => s.matchesSearch(text, term);

  t.test('an empty box matches everything and is not a search', () => {
    t.assert(hit(''));
    t.assert(hit('   '));
    t.equal(s.isSearching('  '), false);
    t.equal(s.isSearching('x'), true);
  });

  t.test('every field a person might have in hand is searched', () => {
    [
      '26-66608-9',        // PO number
      '66608',             // Printavo invoice
      'hy-vee',            // customer company
      'jill',              // the contact, who calls with her own name
      'powertek',          // vendor, by name not id
      'hannah',            // account manager, by name not id
      'pc54-blk',          // item number
      'cotton tee',        // description
      'left chest',        // imprint
      'koozie',            // a line that is not the first one
      '1z999aa10123456784',// tracking
      'ups',               // carrier
      'bridge rd',         // ship to
      'ankeny',            // notes
    ].forEach((term) => t.assert(hit(term), 'should match: ' + term));
  });

  t.test('case does not matter', () => {
    t.assert(hit('HY-VEE'));
    t.assert(hit('PowerTEK'));
  });

  t.test('a PO number matches however it was written', () => {
    t.assert(hit('26 66608 9'), 'spaces');
    t.assert(hit('26666089'), 'no punctuation');
    t.assert(hit('66608-9'), 'partial with dash');
    t.assert(hit('hyvee'), 'company without the dash');
  });

  t.test('every word has to match, in any order', () => {
    t.assert(hit('koozie hy-vee'));
    t.assert(hit('hannah powertek'));
    t.equal(hit('koozie walmart'), false);
  });

  t.test('something that is not there does not match', () => {
    t.equal(hit('walmart'), false);
    t.equal(hit('26-77777'), false);
  });

  t.test('a bare or broken purchase order does not throw', () => {
    t.equal(s.poSearchText(null, null), '');
    t.equal(s.poSearchText({ lines: [null, 'x', {}] }, {}), '');
    t.equal(s.matchesSearch('', 'anything'), false);
    t.assert(s.matchesSearch(s.poSearchText({ poNumber: 'Draft' }), 'draft'));
  });

  t.test('a word that is only punctuation matches nothing, not everything', () => {
    // "-" stripped is empty; it must not make every order match.
    t.equal(s.matchesSearch('abc', '- walmart'), false);
  });

  process.exit(t.report());
})();
