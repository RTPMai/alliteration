/**
 * WebsiteWidget trend chart: which day labels actually get drawn.
 *
 * The daily sessions chart draws one column per day in the range, up to 90 of
 * them. Every column used to carry its own date label. Past a couple of weeks
 * those labels are unreadable, and worse, they set the width of the page: a
 * nowrap label is a floor the column can never shrink below, so a month of
 * them made the chart wider than its card, which dragged the whole two-column
 * dashboard grid out past the right edge of the screen.
 *
 * Labels are thinned to at most MAX_TREND_LABELS, counted BACK FROM THE LAST
 * DAY rather than forward from the first. The most recent day is the one
 * people look for, and the full range is already printed in words above the
 * chart, so the newest end is the one worth anchoring to.
 *
 * Pure functions, no DOM, so the screen and the tests ask the same code.
 */

export const MAX_TREND_LABELS = 8;

/** How many columns apart the drawn labels sit. Always at least 1. */
export function trendLabelStep(count, maxLabels = MAX_TREND_LABELS) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const cap = Math.max(1, Math.floor(Number(maxLabels) || MAX_TREND_LABELS));
  if (n <= cap) return 1;
  return Math.ceil(n / cap);
}

/** Does the column at `index` of `count` get a visible date under it? */
export function showsTrendLabel(index, count, maxLabels = MAX_TREND_LABELS) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const i = Math.floor(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= n) return false;
  return (n - 1 - i) % trendLabelStep(n, maxLabels) === 0;
}

/**
 * Past this many columns the 3px gaps eat more room than the bars do, so the
 * chart tightens up rather than drawing a picket fence of whitespace.
 */
export function isDenseTrend(count) {
  return Math.max(0, Math.floor(Number(count) || 0)) > 45;
}
