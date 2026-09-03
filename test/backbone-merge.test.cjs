/**
 * Merged clients: folding, suggesting, and the write-back guard.
 * Sep 3, 2026.
 *
 * THE BUG THIS EXISTS FOR. KBS, CRS and Kitchen Bath Solutions were merged in
 * real life, but BackBone keys everything on Printavo's customer id, so the
 * roster still held three rows and that company's revenue, order count and
 * scoring split three ways. Every screen under-reported them.
 *
 * THE THREE THINGS WORTH BREAKING A BUILD OVER, in order:
 *
 *   1. THE MONEY ADDS UP ONCE. A fold that double-counts, or that loses a
 *      member's revenue, is worse than the split it replaced, because the
 *      number now looks authoritative.
 *   2. THE ORIGINAL ROWS SURVIVE A WRITE. The browser holds a FOLDED roster
 *      and BackBone writes the whole roster back when a lead is promoted. With
 *      no guard that write deletes every absorbed customer and stores a
 *      primary whose revenue is already the group total, which the next read
 *      folds again. Neither has a visible symptom on the day it happens.
 *   3. NOTHING MERGES WITHOUT A PERSON. A wrong merge welds two real customers
 *      into one and there is no symptom at all.
 *
 * Every check calls the real function.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

import(path.join(ROOT, 'lib/backbone-merge.js')).then((m) => {
  const {
    normaliseName, acronymOf, scorePair, suggestDuplicates,
    foldRoster, mergeCustomerRows, memberIndex, validateGroup,
    restoreAbsorbed, pairKey,
  } = m;

  /* ---- fixtures --------------------------------------------------------- */

  const KBS_FULL = {
    customer_id: '1', company_name: 'Kitchen Bath Solutions',
    total_revenue: 50000, invoice_count: 20,
    revenue_by_year: { 2025: 30000, 2026: 20000 },
    invoices_by_year: { 2025: 12, 2026: 8 },
    last_invoice_date: '2026-08-01', median_gap_days: 40, zip: '50023',
    contacts: [{ name: 'Deb', email: 'deb@kbsiowa.com' }],
    top_categories: [{ name: 'Tees', count: 10 }],
  };
  const KBS_SHORT = {
    customer_id: '2', company_name: 'KBS',
    total_revenue: 12000, invoice_count: 5,
    revenue_by_year: { 2026: 12000 }, invoices_by_year: { 2026: 5 },
    last_invoice_date: '2026-08-20', median_gap_days: 90,
    contacts: [{ name: 'Tom', email: 'tom@kbsiowa.com' }],
    top_categories: [{ name: 'Tees', count: 3 }, { name: 'Hats', count: 1 }],
  };
  const CRS = {
    customer_id: '3', company_name: 'CRS',
    total_revenue: 3000, invoice_count: 2,
    revenue_by_year: { 2026: 3000 }, invoices_by_year: { 2026: 2 },
    contacts: [{ name: 'Deb', email: 'deb@kbsiowa.com' }],
  };
  const OTHER = { customer_id: '9', company_name: 'Ankeny Fire Department', total_revenue: 500, invoice_count: 1 };

  const ROSTER = {
    synced: [KBS_FULL, KBS_SHORT, CRS, OTHER],
    enrichment: {
      1: { account_manager: 'Alexis Davis', industry: '' },
      2: { account_manager: 'Jacob Whitman', industry: 'Construction', notes: 'Second account' },
      9: { account_manager: 'Hannah Posey' },
    },
    lastSynced: '2026-09-01T11:00:00Z',
  };

  const GROUP = {
    id: 'MRG-1', primaryId: '1', memberIds: ['2', '3'],
    name: 'Kitchen Bath Solutions', mergedBy: 'Ryan', mergedAt: '2026-09-03T00:00:00Z',
  };

  /* ---- names ------------------------------------------------------------ */

  t.test('paperwork words and punctuation do not make two names different', () => {
    t.equal(normaliseName('Smith & Sons, Inc.'), normaliseName('Smith and Sons LLC'),
      'Inc, LLC, commas and ampersands are not part of who a company is');
    t.equal(normaliseName('  SAYDEL   SCHOOLS  '), 'saydel schools', 'case and spacing collapse');
  });

  t.test('a name made only of paperwork words does not normalise to nothing', () => {
    t.assert(normaliseName('The Company').length > 0,
      'returning empty would make every such row look identical to every other');
  });

  t.test('initials are computed so KBS can be matched to Kitchen Bath Solutions', () => {
    t.equal(acronymOf('Kitchen Bath Solutions'), 'kbs', 'the case this was built for');
    t.equal(acronymOf('Saydel'), '', 'a one-word name has no initials worth comparing');
  });

  /* ---- suggesting ------------------------------------------------------- */

  t.test('an acronym is matched to the name it stands for', () => {
    const s = scorePair(KBS_SHORT, KBS_FULL);
    t.assert(s, 'KBS and Kitchen Bath Solutions must be proposed');
    t.assert(s.score >= 80, 'and proposed with confidence, got ' + (s && s.score));
    t.assert(s.reasons.join(' ').indexOf('initials') >= 0,
      'the reason must say WHY, or it is not confirmable');
  });

  t.test('a shared contact email is enough on its own', () => {
    // CRS and Kitchen Bath Solutions share nothing in their names at all.
    const s = scorePair(CRS, KBS_FULL);
    t.assert(s && s.score >= 80, 'the same person on both records is strong evidence');
    t.assert(s.reasons.join(' ').indexOf('deb@kbsiowa.com') >= 0,
      'and the evidence names the address, so it can be checked');
  });

  t.test('two unrelated companies are not proposed', () => {
    t.equal(scorePair(OTHER, KBS_FULL), null, 'nothing in common is not a duplicate');
    t.equal(scorePair({ company_name: 'Ankeny Fire Department' }, { company_name: 'Ankeny Public Library' }), null,
      'one shared town name is not evidence of anything');
  });

  t.test('a free email provider is not treated as evidence', () => {
    const a = { customer_id: 'a', company_name: 'Northside Booster Club', contacts: [{ email: 'x@gmail.com' }] };
    const b = { customer_id: 'b', company_name: 'Westside Robotics Team', contacts: [{ email: 'y@gmail.com' }] };
    t.equal(scorePair(a, b), null, 'half of Iowa shares gmail.com');
  });

  t.test('the scan finds the real duplicates and leaves everything else alone', () => {
    const out = suggestDuplicates(ROSTER.synced, {});
    const keys = out.map((s) => s.key);
    t.assert(keys.indexOf(pairKey('1', '2')) >= 0, 'KBS and Kitchen Bath Solutions');
    t.assert(keys.indexOf(pairKey('1', '3')) >= 0, 'CRS, on the shared contact');
    t.equal(keys.indexOf(pairKey('1', '9')) >= 0, false, 'the fire department is nobody twice');
    t.assert(out.every((s) => s.reasons.length > 0), 'every suggestion carries its evidence');
    t.assert(out.every((s) => ['high', 'medium', 'low'].indexOf(s.confidence) >= 0),
      'and a confidence a person can weigh');
  });

  t.test('the scan finds an acronym pair with no other evidence at all', () => {
    // The blocking step is what makes this possible: KBS and Kitchen Bath
    // Solutions share no words, no substring and no contacts, so unless they
    // are put in the same bucket by their initials they are never compared and
    // the scan silently misses the case it was built for. This test fails if
    // that bucket is removed, which the shared-email fixtures above do not
    // catch.
    const bare = [
      { customer_id: 'p1', company_name: 'Kitchen Bath Solutions', total_revenue: 40000, invoice_count: 10 },
      { customer_id: 'p2', company_name: 'KBS', total_revenue: 9000, invoice_count: 3 },
      { customer_id: 'p3', company_name: 'Ankeny Fire Department', total_revenue: 100, invoice_count: 1 },
    ];
    const out = suggestDuplicates(bare, {});
    t.assert(out.some((sg) => sg.key === pairKey('p1', 'p2')),
      'the initials pair must be compared, not just scoreable in isolation');

    // And the other way round, since which record is listed first is an
    // accident of the roster order.
    const flipped = suggestDuplicates([bare[1], bare[0], bare[2]], {});
    t.assert(flipped.some((sg) => sg.key === pairKey('p1', 'p2')),
      'roster order must not decide whether a duplicate is found');
  });

  /* ---- a record is never its own duplicate -------------------------------
   * THE FIRST REAL SCAN, Sep 3 2026: all 60 suggestions were a record paired
   * with itself. Same name, same revenue, same invoice count, same contact
   * email, same ZIP, scored as a near-certainty and sitting on top of every
   * genuine duplicate.
   *
   * The cause: a customer with two contacts at the same company domain was
   * added to that domain's bucket once per contact, and the pair loop then
   * compared the row with itself. Perfectly ordinary data, and the blocking
   * step turned it into a confident wrong answer.
   * ---------------------------------------------------------------------- */

  t.test('a row with two contacts on one domain is not proposed against itself', () => {
    const rows = [
      {
        customer_id: 'f1', company_name: 'Foth & VanDyke LLC',
        total_revenue: 514096, invoice_count: 560, zip: '50021',
        contacts: [
          { name: 'Shani', email: 'shani.wahl@foth.com' },
          { name: 'Pat', email: 'pat@foth.com' },
          { name: 'Lee', email: 'lee@foth.com' },
        ],
      },
      { customer_id: 'f2', company_name: 'Ankeny Fire Department', total_revenue: 100, invoice_count: 1 },
    ];
    const out = suggestDuplicates(rows, {});
    t.equal(out.length, 0, 'one company with three contacts is one company');
  });

  t.test('no suggestion ever names the same record twice', () => {
    // The general form of the same bug: whatever the blocking does, a pair of
    // one is not a pair. A self-pair scores as a certainty and buries the real
    // duplicates underneath it.
    const rows = [
      {
        customer_id: 'a', company_name: 'Housby', total_revenue: 163642, invoice_count: 241, zip: '50313',
        contacts: [{ email: 'aswanson@housby.com' }, { email: 'b@housby.com' }],
      },
      {
        customer_id: 'b', company_name: 'HOUSBY MACK', total_revenue: 12000, invoice_count: 9, zip: '50313',
        contacts: [{ email: 'c@housby.com' }, { email: 'd@housby.com' }],
      },
    ];
    const out = suggestDuplicates(rows, {});
    out.forEach((sg) => {
      t.assert(String(sg.rows[0].customer_id) !== String(sg.rows[1].customer_id),
        'suggested ' + sg.rows[0].customer_id + ' against itself');
    });
    t.assert(out.some((sg) => sg.key === pairKey('a', 'b')),
      'and the genuine pair between the two records is still found');
  });

  t.test('a common first word does not make everyone a duplicate of everyone', () => {
    // "t:school" would otherwise hold half the roster, and comparing every
    // school with every other school is the quadratic scan blocking exists to
    // avoid. Capped tighter than the precise keys for that reason.
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push({ customer_id: 's' + i, company_name: 'School District ' + i, total_revenue: 1000 });
    }
    const started = Date.now();
    const out = suggestDuplicates(rows, {});
    t.assert(Date.now() - started < 2000, 'a common token must not blow the scan up');
    t.assert(out.length < 60, 'and must not fill the list with 300 unrelated schools');
  });

  t.test('names that differ only by a number are not proposed', () => {
    const a = { customer_id: 'n1', company_name: 'Ankeny Elementary 1' };
    const b = { customer_id: 'n2', company_name: 'Ankeny Elementary 2' };
    t.equal(scorePair(a, b), null,
      'two thirds of the words match, and the third word is the whole point');
  });

  t.test('the same words in a different order are still proposed', () => {
    const a = { customer_id: 'k1', company_name: 'Ankeny Kiwanis Club' };
    const b = { customer_id: 'k2', company_name: 'Kiwanis Club of Ankeny' };
    const sc = scorePair(a, b);
    t.assert(sc && sc.score >= 70, 'nothing else here would connect these two');
    t.assert(sc.reasons.join(' ').indexOf('different order') >= 0, 'and it says why');
  });

  t.test('partial overlap corroborates a real signal instead of standing alone', () => {
    const a = { customer_id: 'c1', company_name: 'Saydel Community Schools', zip: '50313',
                contacts: [{ email: 'a@saydel.org' }] };
    const b = { customer_id: 'c2', company_name: 'Saydel Community School District', zip: '50313',
                contacts: [{ email: 'b@saydel.org' }] };
    const sc = scorePair(a, b);
    t.assert(sc && sc.score >= 70, 'a shared domain and a prefix is a real pair');
    t.assert(sc.reasons.length >= 2, 'and the corroborating reasons are listed too');
  });

  t.test('a pair already merged is not suggested again', () => {
    const out = suggestDuplicates(ROSTER.synced, { groups: [GROUP] });
    t.equal(out.some((s) => s.key === pairKey('1', '2')), false,
      'suggesting what you already did is how a list stops being read');
  });

  t.test('a pair somebody said was not a duplicate stays dismissed', () => {
    const out = suggestDuplicates(ROSTER.synced, { dismissed: [['1', '2']] });
    t.equal(out.some((s) => s.key === pairKey('1', '2')), false, 'a no must stick');
    t.assert(out.some((s) => s.key === pairKey('1', '3')), 'without silencing the others');
  });

  t.test('suggestions come back best first', () => {
    const out = suggestDuplicates(ROSTER.synced, {});
    const scores = out.map((s) => s.score);
    t.assert(scores.every((v, i) => i === 0 || scores[i - 1] >= v), 'descending by score');
  });

  t.test('a roster of thousands does not turn into a quadratic scan', () => {
    const big = [];
    for (let i = 0; i < 4000; i++) {
      big.push({ customer_id: 'x' + i, company_name: 'Company Number ' + i, total_revenue: i });
    }
    big.push(KBS_FULL, KBS_SHORT);
    const started = Date.now();
    const out = suggestDuplicates(big, {});
    const ms = Date.now() - started;
    t.assert(ms < 4000, 'the scan took ' + ms + 'ms, which will time out on a real roster');
    t.assert(out.some((s) => s.key === pairKey('1', '2')),
      'and blocking must not lose the pair it exists to find');
  });

  /* ---- folding: the money ----------------------------------------------- */

  t.test('a merged client counts once, with everything added up', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    const row = folded.synced.find((r) => String(r.customer_id) === '1');

    t.equal(folded.synced.length, 2, 'three records became one, plus the unrelated client');
    t.equal(row.total_revenue, 65000, '50000 + 12000 + 3000');
    t.equal(row.invoice_count, 27, '20 + 5 + 2');
    t.equal(row.revenue_by_year[2026], 35000, 'the year buckets add too');
    t.equal(row.revenue_by_year[2025], 30000, 'and a year only one record has survives');
    t.equal(row.invoices_by_year[2026], 15, 'invoice counts per year as well');
  });

  t.test('folding twice does not double anything', () => {
    const once = foldRoster(ROSTER, [GROUP]);
    const twice = foldRoster(once, [GROUP]);
    const a = once.synced.find((r) => String(r.customer_id) === '1');
    const b = twice.synced.find((r) => String(r.customer_id) === '1');
    t.equal(b.total_revenue, a.total_revenue,
      'the members are already gone, so a second fold has nothing to add');
  });

  t.test('the name is the one the human picked, not the biggest or the longest', () => {
    const folded = foldRoster(ROSTER, [{ ...GROUP, name: 'Kitchen Bath' }]);
    const row = folded.synced.find((r) => String(r.customer_id) === '1');
    t.equal(row.company_name, 'Kitchen Bath',
      'the chosen name wins over every record in the group');
  });

  t.test('the most recent order anywhere in the group is the one that counts', () => {
    const row = foldRoster(ROSTER, [GROUP]).synced.find((r) => String(r.customer_id) === '1');
    t.equal(row.last_invoice_date, '2026-08-20',
      'a customer who ordered last week on either record is not dormant');
  });

  t.test('order cadence is the smallest in the group and is flagged as approximate', () => {
    const row = foldRoster(ROSTER, [GROUP]).synced.find((r) => String(r.customer_id) === '1');
    t.equal(row.median_gap_days, 40, 'medians do not add; the group orders at least this often');
    t.equal(row.median_gap_estimated, true,
      'and it must be marked, because it is the one figure that cannot be recomputed here');
  });

  t.test('contacts and categories are combined, not replaced', () => {
    const row = foldRoster(ROSTER, [GROUP]).synced.find((r) => String(r.customer_id) === '1');
    const emails = row.contacts.map((c) => c.email);
    t.assert(emails.indexOf('tom@kbsiowa.com') >= 0, "the other record's contact comes along");
    t.equal(emails.filter((e) => e === 'deb@kbsiowa.com').length, 1,
      'and the same person on two records appears once');
    const tees = row.top_categories.find((c) => c.name === 'Tees');
    t.equal(tees.count, 13, 'category counts add up');
  });

  t.test('the row says what went into it', () => {
    const row = foldRoster(ROSTER, [GROUP]).synced.find((r) => String(r.customer_id) === '1');
    t.equal(row.merged, true, 'so a screen can say this is more than one record');
    t.equal(row.merged_from.length, 2, 'and name them');
    t.assert(row.merged_from.some((f) => f.company_name === 'KBS'), 'by the name they had');
  });

  t.test('enrichment merges with the primary winning, and blanks filled from members', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    t.equal(folded.enrichment['1'].account_manager, 'Alexis Davis',
      "the primary's AM is the answer, not the other record's");
    t.equal(folded.enrichment['1'].industry, 'Construction',
      'but a blank on the primary is filled rather than lost');
    t.equal(folded.enrichment['2'], undefined,
      'an absorbed record must not still carry its own entry, or the payload describes a row nobody can see');
  });

  t.test('a group whose primary is gone from the roster is skipped, not promoted', () => {
    const withoutPrimary = { ...ROSTER, synced: [KBS_SHORT, CRS, OTHER] };
    const folded = foldRoster(withoutPrimary, [GROUP]);
    t.equal(folded.foldedGroups, 0, 'nothing folds');
    t.equal(folded.synced.length, 3,
      'the members stay visible rather than silently vanishing into a record that is not there');
  });

  t.test('a group whose members are all gone folds nothing and breaks nothing', () => {
    // What happens once Printavo merges them for real: the old ids stop
    // appearing, and the group should just quietly stop mattering.
    const afterPrintavo = { ...ROSTER, synced: [KBS_FULL, OTHER] };
    const folded = foldRoster(afterPrintavo, [GROUP]);
    t.equal(folded.foldedGroups, 0, 'self-healing, no cleanup needed');
    const row = folded.synced.find((r) => String(r.customer_id) === '1');
    t.equal(row.total_revenue, 50000, 'and the surviving record is untouched');
  });

  t.test('no groups at all is the roster, unchanged', () => {
    const folded = foldRoster(ROSTER, []);
    t.equal(folded.synced.length, 4, 'nothing removed');
    t.equal(folded.synced[0].merged, undefined, 'and nothing marked');
  });

  /* ---- the write-back guard --------------------------------------------- */

  t.test('saving the folded roster back does not delete the absorbed records', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    // Exactly what BackBone does when a lead is promoted: it posts the roster
    // it is holding, which is the folded one.
    const safe = restoreAbsorbed(ROSTER, { synced: folded.synced }, [GROUP]);
    const ids = safe.synced.map((r) => String(r.customer_id)).sort();
    t.equal(ids.join(','), '1,2,3,9', 'all four originals are still in storage');
    t.equal(safe.restored.rows, 2, 'and the guard says it put two back');
  });

  t.test('saving the folded roster back does not store the summed totals', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    const safe = restoreAbsorbed(ROSTER, { synced: folded.synced }, [GROUP]);
    const primary = safe.synced.find((r) => String(r.customer_id) === '1');
    t.equal(primary.total_revenue, 50000,
      'storing 65000 here would fold again on the next read and show 130000');
    t.equal(primary.merged, undefined, 'and the fold markers never reach storage');
    t.equal(safe.restored.unfolded, 1, 'the guard reports the row it unfolded');
  });

  t.test('a genuinely new row still saves', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    const withNew = folded.synced.concat([
      { customer_id: 'NEW-1', company_name: 'Promoted Lead', total_revenue: 0, invoice_count: 0 },
    ]);
    const safe = restoreAbsorbed(ROSTER, { synced: withNew }, [GROUP]);
    t.assert(safe.synced.some((r) => r.customer_id === 'NEW-1'),
      'the guard must not swallow the write it was protecting');
  });

  t.test('saving folded enrichment does not delete an absorbed record enrichment', () => {
    const folded = foldRoster(ROSTER, [GROUP]);
    const safe = restoreAbsorbed(ROSTER, { enrichment: folded.enrichment }, [GROUP]);
    t.assert(safe.enrichment['2'], "the absorbed record's own AM and notes survive");
    t.equal(safe.enrichment['2'].account_manager, 'Jacob Whitman', 'unchanged');
    t.equal(safe.restored.enrichments, 1, 'and the guard says so');
  });

  t.test('the guard keeps partial writes partial', () => {
    const safe = restoreAbsorbed(ROSTER, { enrichment: {} }, [GROUP]);
    t.equal(safe.synced, undefined,
      'sending enrichment alone must not cause synced to be written too');
  });

  t.test('with no merges the guard changes nothing', () => {
    const safe = restoreAbsorbed(ROSTER, { synced: ROSTER.synced }, []);
    t.equal(safe.synced.length, 4, 'same rows');
    t.equal(safe.restored.rows, 0, 'nothing to restore');
  });

  /* ---- validation ------------------------------------------------------- */

  t.test('a merge needs a target and at least one other record', () => {
    t.equal(validateGroup({ primaryId: '1', memberIds: [] }, ROSTER.synced, []).ok, false,
      'merging a record into itself is not a merge');
    t.equal(validateGroup({ memberIds: ['2'] }, ROSTER.synced, []).ok, false,
      'and something has to be merged into');
  });

  t.test('a record that is not in the roster is refused, not invented', () => {
    const r = validateGroup({ primaryId: '1', memberIds: ['404'] }, ROSTER.synced, []);
    t.equal(r.ok, false, 'refused');
    t.assert(r.errors.join(' ').indexOf('404') >= 0, 'and it says which one');
  });

  t.test('a record cannot be merged into two different clients', () => {
    const r = validateGroup({ primaryId: '9', memberIds: ['2'] }, ROSTER.synced, [GROUP]);
    t.equal(r.ok, false,
      'double counting would depend on which fold ran first, which is not an answer');
    t.assert(r.errors.join(' ').toLowerCase().indexOf('already merged') >= 0, 'and says why');
  });

  t.test('the name defaults to the chosen record but a typed name is kept', () => {
    const auto = validateGroup({ primaryId: '1', memberIds: ['2'] }, ROSTER.synced, []);
    t.equal(auto.group.name, 'Kitchen Bath Solutions', 'defaulted, not demanded');
    const typed = validateGroup(
      { primaryId: '1', memberIds: ['2'], name: 'Kitchen & Bath Solutions of Iowa' }, ROSTER.synced, []);
    t.equal(typed.group.name, 'Kitchen & Bath Solutions of Iowa',
      'a name matching none of the records is allowed: the company may go by it');
  });

  t.test('the primary is never left in its own member list', () => {
    const r = validateGroup({ primaryId: '1', memberIds: ['1', '2', '2'] }, ROSTER.synced, []);
    t.equal(r.group.memberIds.join(','), '2',
      'a duplicate or a self-reference would add the same revenue twice');
  });

  /* ---- the wiring ------------------------------------------------------- */

  t.test('every roster reader goes through the folded reader', () => {
    t.assert(/readRoster\(/.test(read('api/data.js')),
      'the roster endpoint must fold, or nothing downstream sees a merge');
    t.assert(/readRoster\(/.test(read('api/customer-match.js')),
      "GivingGauge's matching must fold, or a donation is scored against a fraction of the spend");
    t.assert(/readRoster\(/.test(read('lib/giving.js')), 'and so must auto-matching on intake');
    t.assert(/readRoster\(/.test(read('api/notifications.js')),
      'or a merged client shows twice in the link picker');
  });

  t.test('the write path is guarded on the SERVER, not by asking callers to be careful', () => {
    const save = read('api/save.js');
    t.assert(/restoreAbsorbed/.test(save),
      'api/save.js must unfold, because BackBone posts the roster it is holding');
    t.assert(/readMergeGroups/.test(save), 'and it needs the groups to know what is hidden');
  });

  t.test('the merge route exists, is gated, and never merges on its own', () => {
    t.assert(exists('api/merges.js'), 'the route must exist');
    const route = read('api/merges.js');
    t.assert(/superuser === true/.test(route),
      'the admin flag is the gate; that strict check is the standard here');
    t.equal(/data_scope/.test(route.replace(/\/\/.*$/gm, '')), false,
      'data_scope defaults to "all" on every new role and is NOT an admin permission');
    t.assert(/suggestDuplicates/.test(route), 'suggestions are offered');
    t.equal(/validateGroup[\s\S]{0,400}auto/i.test(route), false,
      'and never applied without a request from a person');
  });

  t.test('the seam carries the endpoint and marks it live', () => {
    const api = read('js/api.js');
    t.assert(/bbMerges:\s*'\/api\/merges'/.test(api), 'ENDPOINTS.bbMerges is missing');
    t.assert(api.slice(api.indexOf('LIVE_PREFIXES'), api.indexOf('ENDPOINTS')).indexOf("'/api/merges'") > 0,
      '/api/merges must be in LIVE_PREFIXES or the screen reads mock data');
  });

  t.test('the screen goes through the seam and lets a person pick the name', () => {
    const main = read('apps/backbone/main.js');
    t.assert(/ENDPOINTS\.bbMerges/.test(main), 'the settings card must call the seam');
    t.assert(/mergeName/.test(main), 'there must be a name field, because the human picks the name');
    t.assert(/name="mergePrimary"/.test(main), 'and a control for which record the others fold into');
    t.assert(/confirm\(/.test(main), 'unmerging asks first');
    const tpl = read('apps/backbone/template.js');
    t.assert(/mergeScanBtn/.test(tpl) && /mergeList/.test(tpl), 'the card needs its markup');
  });

  t.test('no hex colours leaked into the merge styles', () => {
    const styles = read('apps/backbone/styles.js');
    const block = styles.slice(styles.indexOf('Merged clients (Settings)'));
    t.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false,
      'colours live in css/tokens.css only');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error('merge tests failed to load:', e);
  process.exit(1);
});
