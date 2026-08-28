/**
 * CrewCore stipend: year scoping and corrections.
 *
 * The apparel allotment re-ups every Jan 1, so every figure on the stipend
 * screen is meaningless without a year attached to it. That scoping used to
 * be written out longhand in three places (the store's usedStipendThisYear,
 * the API route's balance block, and the screen's own filter). Three copies
 * of one rule is how the store and the screen end up disagreeing about what
 * counts as "in 2026", so the math moved into lib/crewcore/schema.js and
 * these tests cover it there.
 *
 * The other half is editing. A mistyped amount used to mean deleting the
 * entry and re-keying it, which loses the original record. validateStipendSpend
 * already had a partial mode; these tests lock the behaviour the PATCH route
 * depends on, because a partial validator that quietly blanks the fields you
 * did not send would wipe real data on every correction.
 *
 * These are real function calls through a dynamic import, not source-text
 * matching. Grepping for a function name proves the letters are there, not
 * that the code runs.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

import(path.join(ROOT, 'lib/crewcore/schema.js')).then((schema) => {
  const {
    validateStipendSpend, spendYear, spendsFor, stipendBalance, stipendYears,
    spendLabel, isOverStipend,
  } = schema;

  // A small fixture standing in for two people across two stipend years.
  const SPENDS = [
    { id: 'STP-1', employee_id: 'E1', date: '2026-02-10', amount: 60, category: 'apparel' },
    { id: 'STP-2', employee_id: 'E1', date: '2026-11-02', amount: 40, category: 'apparel' },
    { id: 'STP-3', employee_id: 'E1', date: '2025-12-30', amount: 200, category: 'apparel' },
    { id: 'STP-4', employee_id: 'E2', date: '2026-03-01', amount: 15, category: 'other' },
  ];

  /* ---- year scoping --------------------------------------------------- */

  t.test('spendYear reads the calendar year off an entry', () => {
    t.equal(spendYear({ date: '2026-02-10' }), 2026, 'should read 2026');
    t.equal(spendYear({ date: '2025-12-30' }), 2025, 'should read 2025');
  });

  t.test('an entry with no usable date reports no year rather than guessing one', () => {
    t.equal(spendYear({ date: '' }), null, 'empty date should be null');
    t.equal(spendYear({}), null, 'missing date should be null');
    t.equal(spendYear(null), null, 'a null entry should not throw');
  });

  t.test('a dateless entry is left out of a year, not swept into the current one', () => {
    // The old longhand did String(s.date || '').slice(0,4) === String(year),
    // which is a non-match for a blank date, so this preserves the behaviour
    // rather than changing it. Worth pinning: counting undated purchases into
    // whatever year is on screen would silently inflate somebody's spend.
    const withJunk = SPENDS.concat([{ id: 'STP-X', employee_id: 'E1', date: '', amount: 999 }]);
    const rows = spendsFor(withJunk, 'E1', 2026);
    t.equal(rows.length, 2, 'the undated entry should not appear in 2026');
    const bal = stipendBalance(250, spendsFor(withJunk, 'E1', 2026), 2026);
    t.equal(bal.used, 100, 'and it should not reach the total either');
  });

  t.test('spendsFor scopes to one person and one year', () => {
    const rows = spendsFor(SPENDS, 'E1', 2026);
    t.equal(rows.length, 2, 'E1 has two entries in 2026');
    t.assert(rows.every((s) => s.employee_id === 'E1'), 'no other person should leak in');
    t.assert(rows.every((s) => spendYear(s) === 2026), 'no other year should leak in');
  });

  t.test('a null employee id means everyone, a null year means every year', () => {
    t.equal(spendsFor(SPENDS, null, 2026).length, 3, 'three entries across the team in 2026');
    t.equal(spendsFor(SPENDS, 'E1', null).length, 3, 'E1 has three entries all told');
    t.equal(spendsFor(SPENDS, null, null).length, 4, 'everything, unfiltered');
  });

  t.test('spendsFor survives junk input instead of throwing', () => {
    t.equal(spendsFor(null, 'E1', 2026).length, 0, 'a null log is an empty log');
    t.equal(spendsFor([null, undefined], null, null).length, 0, 'holes are dropped');
  });

  /* ---- balances ------------------------------------------------------- */

  t.test('a balance is scoped to its year, so Jan 1 starts clean', () => {
    const y2026 = stipendBalance(250, spendsFor(SPENDS, 'E1', 2026), 2026);
    t.equal(y2026.used, 100, '2026 spend is 60 + 40');
    t.equal(y2026.remaining, 150, '250 allotted less 100 used');

    const y2025 = stipendBalance(250, spendsFor(SPENDS, 'E1', 2025), 2025);
    t.equal(y2025.used, 200, "last year's 200 stays in last year");
    t.equal(y2025.remaining, 50, 'and does not carry into this year');
  });

  t.test('going over is reported as over, not as negative remaining', () => {
    // A screen needs to say "nothing left" and "went past it by 50" as two
    // separate facts. A negative remaining renders as -$50 left, which reads
    // like a credit.
    const bal = stipendBalance(150, spendsFor(SPENDS, 'E1', 2025), 2025);
    t.equal(bal.used, 200, 'spent 200');
    t.equal(bal.remaining, 0, 'remaining floors at zero');
    t.equal(bal.over, 50, 'and the overage is its own number');
  });

  t.test('a balance under the allotment reports no overage', () => {
    const bal = stipendBalance(250, spendsFor(SPENDS, 'E1', 2026), 2026);
    t.equal(bal.over, 0, 'no overage when under');
  });

  t.test('a missing allotment is zero, not a crash', () => {
    const bal = stipendBalance(undefined, spendsFor(SPENDS, 'E2', 2026), 2026);
    t.equal(bal.allotted, 0, 'no allotment on record reads as zero');
    t.equal(bal.used, 15, 'spend still counts');
    t.equal(bal.over, 15, 'and all of it is over');
  });

  t.test('money is rounded to cents, so thirds do not print fifteen decimals', () => {
    const thirds = [
      { employee_id: 'E9', date: '2026-01-01', amount: 33.333 },
      { employee_id: 'E9', date: '2026-01-02', amount: 33.333 },
    ];
    const bal = stipendBalance(100, spendsFor(thirds, 'E9', 2026), 2026);
    t.equal(bal.used, 66.67, 'used rounds to cents');
    t.equal(bal.remaining, 33.33, 'remaining rounds to cents');
  });

  t.test('the balance carries the year it was computed for', () => {
    const bal = stipendBalance(250, spendsFor(SPENDS, 'E1', 2025), 2025);
    t.equal(bal.year, 2025, 'a balance with no year attached means nothing');
  });

  /* ---- the year picker ------------------------------------------------ */

  t.test('the year list covers every year that has an entry', () => {
    const years = stipendYears(SPENDS, new Date('2026-06-01T12:00:00Z'));
    t.assert(years.includes(2026), '2026 has entries');
    t.assert(years.includes(2025), '2025 has entries');
  });

  t.test('the current year is offered even before anything is logged in it', () => {
    // Every Jan 1 the allotment re-ups and the log for the new year is empty.
    // If the picker only listed years with entries, nobody could select the
    // year they are standing in until the first purchase landed.
    const years = stipendYears([], new Date('2027-01-02T12:00:00Z'));
    t.equal(years.length, 1, 'exactly one year offered');
    t.equal(years[0], 2027, 'and it is the current one');
  });

  t.test('years come back newest first and without duplicates', () => {
    const years = stipendYears(SPENDS, new Date('2026-06-01T12:00:00Z'));
    const sorted = years.slice().sort((a, b) => b - a);
    t.equal(JSON.stringify(years), JSON.stringify(sorted), 'newest first');
    t.equal(new Set(years).size, years.length, 'no repeats despite four entries');
  });

  /* ---- row labelling -------------------------------------------------- */

  t.test('the description is the heading, not the category', () => {
    // "apparel" is a two-value bucket and every row says it. What somebody
    // actually bought is the thing worth reading down a log.
    const { title, parts } = spendLabel(
      { category: 'apparel', description: 'SanMar Fall 2026' }, null
    );
    t.equal(title, 'SanMar Fall 2026', 'the purchase leads');
    t.equal(JSON.stringify(parts), JSON.stringify(['apparel']), 'the bucket drops to the second line');
  });

  t.test('with no description the category takes the heading rather than leaving it blank', () => {
    const { title, parts } = spendLabel({ category: 'apparel', description: '' }, null);
    t.equal(title, 'apparel', 'falls back to the category');
    t.equal(parts.length, 0, 'and is not then repeated underneath itself');
  });

  t.test('a whitespace-only description counts as no description', () => {
    const { title } = spendLabel({ category: 'other', description: '   ' }, null);
    t.equal(title, 'other', 'spaces should not win the heading and render as blank');
  });

  t.test('an entry with neither still has a heading', () => {
    t.equal(spendLabel({}, null).title, 'Purchase', 'never render an empty heading');
    t.equal(spendLabel(null, null).title, 'Purchase', 'a null entry should not throw');
  });

  t.test('on the all-team log the person is the heading and both details follow', () => {
    // Scanning across people, the name has to lead; the description is still
    // first among the details because it is the informative one.
    const { title, parts } = spendLabel(
      { category: 'apparel', description: 'SanMar Fall 2026' }, 'Alexis Davis'
    );
    t.equal(title, 'Alexis Davis', 'the person leads on the team log');
    t.equal(JSON.stringify(parts), JSON.stringify(['SanMar Fall 2026', 'apparel']),
      'description before category');
  });

  t.test('the team log drops a missing description instead of printing a gap', () => {
    const { parts } = spendLabel({ category: 'apparel' }, 'Alexis Davis');
    t.equal(JSON.stringify(parts), JSON.stringify(['apparel']), 'no empty separator');
  });

  t.test('the heading is never blank for any combination of missing fields', () => {
    const cases = [
      { category: 'apparel', description: 'x' },
      { category: 'apparel' },
      { description: 'x' },
      {},
      { category: '', description: '' },
    ];
    cases.forEach((c) => {
      const { title } = spendLabel(c, null);
      t.assert(String(title).trim().length > 0, 'blank heading for ' + JSON.stringify(c));
    });
  });

  /* ---- corrections (what PATCH depends on) ---------------------------- */

  t.test('a partial update accepts one field on its own', () => {
    const { ok, record } = validateStipendSpend({ amount: 75 }, { partial: true });
    t.assert(ok, 'amount alone should validate in partial mode');
    t.equal(record.amount, 75, 'and carry the new amount');
  });

  t.test('a partial update does not invent the fields it was not given', () => {
    // The PATCH route spreads the validated record over the stored entry. If
    // partial mode returned empty strings for absent fields, every correction
    // to an amount would silently wipe the description and the date.
    const { ok, record } = validateStipendSpend({ amount: 75 }, { partial: true });
    t.assert(ok, 'should validate');
    t.equal('description' in record, false, 'description must be absent, not blank');
    t.equal('date' in record, false, 'date must be absent, not blank');
    t.equal('employee_id' in record, false, 'employee_id must be absent');
    t.equal('category' in record, false, 'category must be absent, not defaulted');
  });

  t.test('spreading a partial record over a stored entry keeps the untouched fields', () => {
    // This is the merge the route performs, run for real.
    const stored = {
      id: 'STP-1', employee_id: 'E1', date: '2026-02-10',
      amount: 60, category: 'apparel', description: 'quarter-zip',
      created_at: '2026-02-10T10:00:00.000Z', logged_by: 'ryan',
    };
    const { ok, record } = validateStipendSpend({ amount: 75 }, { partial: true });
    t.assert(ok, 'partial should validate');
    const merged = { ...stored, ...record, id: stored.id, created_at: stored.created_at };
    t.equal(merged.amount, 75, 'the corrected amount lands');
    t.equal(merged.description, 'quarter-zip', 'the description survives');
    t.equal(merged.date, '2026-02-10', 'the date survives');
    t.equal(merged.employee_id, 'E1', 'the person survives');
    t.equal(merged.created_at, '2026-02-10T10:00:00.000Z', 'the original timestamp survives');
  });

  t.test('a correction cannot move an entry to a different id', () => {
    const stored = { id: 'STP-1', employee_id: 'E1', date: '2026-02-10', amount: 60 };
    const { record } = validateStipendSpend({ amount: 75, id: 'STP-9' }, { partial: true });
    const merged = { ...stored, ...record, id: stored.id };
    t.equal(merged.id, 'STP-1', 'the id is pinned from the stored entry');
  });

  t.test('a partial update still refuses a bad amount', () => {
    t.equal(validateStipendSpend({ amount: 0 }, { partial: true }).ok, false, 'zero is not a purchase');
    t.equal(validateStipendSpend({ amount: -5 }, { partial: true }).ok, false, 'negative is not a purchase');
    t.equal(validateStipendSpend({ amount: 'lots' }, { partial: true }).ok, false, 'text is not an amount');
  });

  t.test('a partial update still refuses an unknown category', () => {
    const { ok, errors } = validateStipendSpend({ category: 'hardware' }, { partial: true });
    t.equal(ok, false, 'an off-list category should be rejected on edit too');
    t.assert(errors.some((e) => /category/i.test(e)), 'the error should name the field');
  });

  t.test('a correction can move a purchase to the right person', () => {
    const { ok, record } = validateStipendSpend({ employee_id: 'E2' }, { partial: true });
    t.assert(ok, 'reassignment should validate');
    t.equal(record.employee_id, 'E2', 'a purchase logged against the wrong person is fixable');
  });

  t.test('a correction can move a purchase into a different stipend year', () => {
    // A December purchase keyed in January belongs to December's allotment.
    const { ok, record } = validateStipendSpend({ date: '2025-12-28' }, { partial: true });
    t.assert(ok, 'a date change should validate');
    const moved = { employee_id: 'E1', amount: 40, ...record };
    t.equal(spendYear(moved), 2025, 'and it lands in the year it was actually bought');
  });

  t.test('a full (non-partial) write is still required to be complete', () => {
    // Partial mode is for PATCH only. POST must not be able to create an
    // entry with no person, date or amount on it.
    t.equal(validateStipendSpend({}).ok, false, 'an empty new entry is rejected');
    t.equal(validateStipendSpend({ employee_id: 'E1' }).ok, false, 'still needs a date and amount');
    t.assert(
      validateStipendSpend({ employee_id: 'E1', date: '2026-02-10', amount: 10 }).ok,
      'a complete entry passes'
    );
  });

  /* ---- the over-stipend flag ------------------------------------------ */
  //
  // The red mark on somebody's card comes off this one function, so what
  // counts as "over" is pinned here rather than being re-decided by each
  // screen that draws a card.

  t.test('going past the allotment reads as over', () => {
    const bal = stipendBalance(250, [
      { employee_id: 'E1', date: '2026-02-10', amount: 290 },
    ], 2026);
    t.equal(bal.over, 40, 'the overage is the amount past the line');
    t.assert(isOverStipend(bal), 'and that flags the card');
  });

  t.test('spending right up to the allotment is not over', () => {
    // Exactly zero left is "nothing remaining", not "went past it". A flag
    // on somebody who spent their stipend correctly would train people to
    // ignore the flag.
    const bal = stipendBalance(250, [
      { employee_id: 'E1', date: '2026-02-10', amount: 250 },
    ], 2026);
    t.equal(bal.remaining, 0, 'nothing left');
    t.equal(isOverStipend(bal), false, 'but not over');
  });

  t.test('somebody with no allotment set is never flagged', () => {
    // apparel_stipend is nullable on the employee record, and a null
    // allotment falls through stipendBalance as 0. Without this guard every
    // purchase by a person whose stipend has not been entered yet would
    // light up red, which is a data-entry gap, not an overage.
    const none = stipendBalance(null, [
      { employee_id: 'E1', date: '2026-02-10', amount: 60 },
    ], 2026);
    t.equal(none.over, 60, 'the math still reports the raw difference');
    t.equal(isOverStipend(none), false, 'but no allotment means no line to cross');
    t.equal(isOverStipend(stipendBalance(0, [
      { employee_id: 'E1', date: '2026-02-10', amount: 60 },
    ], 2026)), false, 'and an explicit zero behaves the same way');
  });

  t.test('the flag is scoped to the year on screen', () => {
    // A blowout in 2025 must not put a red mark on the 2026 card. The
    // allotment re-ups every Jan 1.
    const spends = [
      { employee_id: 'E1', date: '2025-06-01', amount: 400 },
      { employee_id: 'E1', date: '2026-06-01', amount: 20 },
    ];
    t.assert(isOverStipend(stipendBalance(250, spends, 2025)), '2025 is over');
    t.equal(isOverStipend(stipendBalance(250, spends, 2026)), false, '2026 is clean');
  });

  t.test('a missing balance does not throw or flag', () => {
    // The employee's own view renders before its fetch lands, with a null
    // balance. That has to draw an empty card, not a red one.
    t.equal(isOverStipend(null), false, 'null is not over');
    t.equal(isOverStipend(undefined), false, 'undefined is not over');
    t.equal(isOverStipend({}), false, 'an empty object is not over');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
}).catch((e) => {
  console.log('  FAIL could not import lib/crewcore/schema.js: ' + e.message);
  process.exit(1);
});
