// PUT IN: test/crewcore-anniversary.test.cjs
/**
 * CrewCore anniversaries: the date, not just the countdown (Sep 30 2026).
 *
 * The admin Upcoming anniversaries list read "13 years · 9d". Ryan wanted
 * the actual date. Putting the date next to the count exposed a second bug:
 * days were counted from the current clock time and rounded, so an
 * afternoon view said 9d for an anniversary ten days out.
 *
 * Real function calls through a dynamic import, with `now` pinned so the
 * tests do not depend on the day they run.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

import(path.join(ROOT, 'lib/crewcore/schema.js')).then((schema) => {
  const { daysUntilAnniversary, anniversaryLabel } = schema;

  // Wed Sep 30 2026, 4:53 PM local: the moment the screenshot was taken.
  const AFTERNOON = new Date(2026, 8, 30, 16, 53);
  const MORNING = new Date(2026, 8, 30, 0, 5);

  t.test('the list shows the date and the countdown together', () => {
    const ann = daysUntilAnniversary('2013-10-10', AFTERNOON);
    t.equal(ann.years, 13, 'reaching year 13');
    t.equal(ann.dateLabel, 'Oct 10', 'the date it lands on');
    t.equal(anniversaryLabel(ann), 'Oct 10 · 10d', 'date then countdown');
  });

  t.test('the countdown does not change with the time of day', () => {
    const a = daysUntilAnniversary('2013-10-10', AFTERNOON);
    const b = daysUntilAnniversary('2013-10-10', MORNING);
    t.equal(a.days, 10, 'afternoon: Oct 10 is 10 days after Sep 30');
    t.equal(b.days, 10, 'just after midnight: still 10');
  });

  t.test('the day itself says Today', () => {
    const ann = daysUntilAnniversary('2020-09-30', AFTERNOON);
    t.equal(ann.days, 0, 'zero days');
    t.equal(ann.years, 6, 'sixth anniversary');
    t.equal(anniversaryLabel(ann), 'Today', 'no date needed on the day');
  });

  t.test('an anniversary already past this year points at next year, with the year shown', () => {
    const ann = daysUntilAnniversary('2022-02-14', AFTERNOON);
    t.equal(ann.years, 5, 'Amanda: fifth, not sixth');
    t.equal(ann.dateLabel, 'Feb 14, 2027', 'next year gets its year printed');
  });

  t.test('a Feb 29 start lands on Feb 28 in a non-leap year', () => {
    const ann = daysUntilAnniversary('2020-02-29', AFTERNOON);
    t.equal(ann.dateLabel, 'Feb 28, 2027', 'not Mar 1');
    t.equal(ann.years, 7, 'seventh');
  });

  t.test('no start date, or a junk one, gives nothing rather than a guess', () => {
    t.equal(daysUntilAnniversary('', AFTERNOON), null, 'blank');
    t.equal(daysUntilAnniversary(null, AFTERNOON), null, 'null');
    t.equal(daysUntilAnniversary('someday', AFTERNOON), null, 'junk');
    t.equal(anniversaryLabel(null), '', 'label of nothing is empty');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
}).catch((e) => {
  console.log('  FAIL could not import lib/crewcore/schema.js: ' + e.message);
  process.exit(1);
});
