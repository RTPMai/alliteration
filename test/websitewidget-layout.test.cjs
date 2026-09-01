/**
 * WebsiteWidget dashboard layout: the chart cannot widen the page.
 *
 * Sep 1, 2026. The dashboard was running off the right edge of the screen
 * behind a horizontal scrollbar, with the whole right-hand column of cards
 * pushed out of sight. The cause was intrinsic width: CSS grid tracks and
 * flex items default to min-width:auto, so the widest unshrinkable thing
 * inside a card sets a floor for its grid track, and because both tracks are
 * fr units they both scale up to hold the 1.4:1 ratio.
 *
 * Three things could push that floor: a row of nowrap date labels, one per
 * day, up to 90 of them; a Google failure message with a long unbroken URL
 * in it; and nothing stopping either from doing so.
 *
 * The label thinning is tested here as real function calls through a dynamic
 * import. The CSS guards are checked as text, because there is no layout
 * engine in this harness, and a rule that is absent is the whole bug.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'apps/websitewidget.js'), 'utf8');

import(path.join(ROOT, 'lib/websitewidget/chart.js')).then((chart) => {
  const { trendLabelStep, showsTrendLabel, isDenseTrend, MAX_TREND_LABELS } = chart;

  const drawn = (n) => {
    let count = 0;
    for (let i = 0; i < n; i += 1) if (showsTrendLabel(i, n)) count += 1;
    return count;
  };

  /* ---- how many labels ------------------------------------------------- */

  t.test('a week of columns keeps every label', () => {
    t.equal(trendLabelStep(7), 1, 'seven days should not be thinned');
    t.equal(drawn(7), 7, 'all seven days should be labelled');
  });

  t.test('no range draws more labels than the cap', () => {
    [1, 7, 8, 9, 14, 30, 31, 45, 60, 90, 365].forEach((n) => {
      t.assert(drawn(n) <= MAX_TREND_LABELS,
        n + ' columns drew ' + drawn(n) + ' labels, over the cap of ' + MAX_TREND_LABELS);
    });
  });

  t.test('a month and a quarter both stay readable', () => {
    t.equal(drawn(30), 8, '30 days should draw 8 labels');
    t.equal(drawn(90), 8, '90 days should draw 8 labels');
  });

  /* ---- which labels ---------------------------------------------------- */

  t.test('the last day is always labelled', () => {
    // The newest bar is the one people look for, and it is the end of the
    // range, so it is the end the thinning counts back from.
    [1, 7, 30, 45, 90].forEach((n) => {
      t.assert(showsTrendLabel(n - 1, n), n + ' columns left the last day unlabelled');
    });
  });

  t.test('labels are evenly spaced, not clustered', () => {
    const n = 30;
    const at = [];
    for (let i = 0; i < n; i += 1) if (showsTrendLabel(i, n)) at.push(i);
    const gaps = at.slice(1).map((v, k) => v - at[k]);
    gaps.forEach((g) => t.equal(g, trendLabelStep(n), 'uneven gap between labels'));
  });

  /* ---- edges ----------------------------------------------------------- */

  t.test('an empty or absent trend asks for nothing', () => {
    t.equal(drawn(0), 0, 'no columns means no labels');
    t.equal(showsTrendLabel(0, 0), false, 'index 0 of 0 columns is not a column');
    t.equal(trendLabelStep(0), 1, 'step should never be zero, it is a divisor');
    t.equal(trendLabelStep(undefined), 1, 'a missing count should not produce NaN');
  });

  t.test('an index off the end of the range is never labelled', () => {
    t.equal(showsTrendLabel(30, 30), false, 'index 30 of 30 is past the end');
    t.equal(showsTrendLabel(-1, 30), false, 'a negative index is not a column');
  });

  t.test('only long ranges tighten the gaps', () => {
    t.equal(isDenseTrend(7), false, 'a week has room to breathe');
    t.equal(isDenseTrend(30), false, 'a month has room to breathe');
    t.equal(isDenseTrend(90), true, 'a quarter needs the tighter gap');
  });

  /* ---- the CSS guards -------------------------------------------------- */

  t.test('grid columns can be narrower than their contents', () => {
    t.assert(/\.ww-grid\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(app),
      'apps/websitewidget.js must give .ww-grid children min-width: 0, or one wide card widens the page');
  });

  t.test('a trend column can be narrower than its date', () => {
    t.assert(/\.ww-trend\s+\.col\s*\{[^}]*min-width:\s*0/.test(app),
      '.ww-trend .col needs min-width: 0');
    t.assert(/\.ww-trend\s+\.lbl\s*\{[^}]*width:\s*0/.test(app),
      '.ww-trend .lbl must be a zero-width box so a date cannot set the column width');
  });

  t.test('a label with no text still holds its column height', () => {
    // Otherwise the eight labelled columns sit a line lower than the rest and
    // their bars stop lining up.
    t.assert(/\.ww-trend\s+\.lbl\s*\{[^}]*height:\s*\d/.test(app),
      '.ww-trend .lbl needs a fixed height');
  });

  t.test('a spaceless failure message cannot set the card width', () => {
    t.assert(/\.ww-cardfail\s+\.why\s*\{[^}]*overflow-wrap:\s*anywhere/.test(app),
      '.ww-cardfail .why needs overflow-wrap: anywhere; break-word alone does not reduce the intrinsic width');
  });

  t.test('the screen asks the shared helper rather than counting for itself', () => {
    t.assert(app.includes("from '../lib/websitewidget/chart.js'"),
      'the dashboard should import the thinning helpers, not repeat the arithmetic');
    t.assert(app.includes('showsTrendLabel(i, trendCount)'),
      'the label should be drawn from showsTrendLabel');
  });

  process.exit(t.report());
});
