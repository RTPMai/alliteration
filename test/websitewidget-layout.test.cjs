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

Promise.all([
  import(path.join(ROOT, 'lib/websitewidget/chart.js')),
  // Importing the screen itself is the only way to prove the styles template
  // literal is still balanced. A stray backtick in a CSS comment inside it
  // ends the string, and the app fails to load with nothing wrong on sight.
  import(path.join(ROOT, 'apps/websitewidget.js')).then((m) => m, (e) => ({ loadError: e })),
]).then(([chart, screen]) => {
  const { trendLabelStep, showsTrendLabel, isDenseTrend, MAX_TREND_LABELS } = chart;

  t.test('apps/websitewidget.js loads as a module', () => {
    t.assert(!screen.loadError,
      'the app file will not import: ' + (screen.loadError && screen.loadError.message));
    t.equal(screen.default.id, 'websitewidget', 'the module should export the app');
    t.assert(typeof screen.default.styles === 'string' && screen.default.styles.length > 500,
      'the styles block should have survived intact');
  });

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
    t.assert(/\.ww-trend\s+\.wwcol\s*\{[^}]*min-width:\s*0/.test(app),
      '.ww-trend .wwcol needs min-width: 0');
    t.assert(/\.ww-trend\s+\.wwlbl\s*\{[^}]*width:\s*0/.test(app),
      '.ww-trend .wwlbl must be a zero-width box so a date cannot set the column width');
    t.assert(/\.ww-trend\s+\.wwbar\s*\{[^}]*min-width:\s*0/.test(app),
      '.ww-trend .wwbar needs min-width: 0, in case a bare .bar rule ever reaches it again');
  });

  t.test('a label with no text still holds its column height', () => {
    // Otherwise the eight labelled columns sit a line lower than the rest and
    // their bars stop lining up.
    t.assert(/\.ww-trend\s+\.wwlbl\s*\{[^}]*height:\s*\d/.test(app),
      '.ww-trend .wwlbl needs a fixed height');
  });

  t.test('a spaceless failure message cannot set the card width', () => {
    t.assert(/\.ww-cardfail\s+\.why\s*\{[^}]*overflow-wrap:\s*anywhere/.test(app),
      '.ww-cardfail .why needs overflow-wrap: anywhere; break-word alone does not reduce the intrinsic width');
  });

  /* ---- the class-name collision ---------------------------------------- */

  t.test('the chart owns its class names, none shared with the shell', () => {
    // css/shell.css is not scoped to an app. Its bare `.bar` sets
    // min-width: 90px for the little progress bars on the shell's own
    // screens. A chart column called `bar` picked that up, a minimum beats a
    // maximum, and every 6px bar became 90px: one solid block painting out
    // over the next card. Same trap waits in col, stack, lbl, ghost, sub and
    // bar-row, all of which the shell also styles bare.
    const shellCss = fs.readFileSync(path.join(ROOT, 'css/shell.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const bare = new Set();
    (shellCss.match(/[^{}]+\{/g) || []).forEach((chunk) => {
      chunk.slice(0, -1).split(',').forEach((sel) => {
        const m = /^\s*\.([A-Za-z0-9_-]+)\s*$/.exec(sel);
        if (m) bare.add(m[1]);
      });
    });
    t.assert(bare.size > 10, 'could not read the shell stylesheet, the check would pass by accident');

    const mine = (app.match(/class="([^"'<>+{}]+)"/g) || [])
      .map((s) => s.slice(7, -1)).join(' ').split(/\s+/).filter(Boolean);
    const clash = [...new Set(mine)].filter((c) => bare.has(c));
    t.assert(clash.length === 0,
      'these WebsiteWidget class names are also styled globally in shell.css: ' + clash.join(', '));
  });

  t.test('the old unprefixed chart class names are gone', () => {
    ['bar', 'col', 'stack', 'ghost', 'bar-row'].forEach((name) => {
      t.assert(!app.includes('class="' + name + '"'),
        'class="' + name + '" is back in the chart markup and will collide with shell.css');
    });
  });

  t.test('the screen asks the shared helper rather than counting for itself', () => {
    t.assert(app.includes("from '../lib/websitewidget/chart.js'"),
      'the dashboard should import the thinning helpers, not repeat the arithmetic');
    t.assert(app.includes('showsTrendLabel(i, trendCount)'),
      'the label should be drawn from showsTrendLabel');
  });

  process.exit(t.report());
});
