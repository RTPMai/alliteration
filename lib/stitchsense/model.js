// lib/stitchsense/model.js — the calibrated stitch count model.
//
// PURE FUNCTIONS ONLY. No Node built-ins, no fetch, no KV. This file is
// imported by BOTH apps/stitchsense.js (browser) and api/stitchsense/*.js
// (server), which is why it can contain nothing environment-specific. The
// alternative was two copies plus a parity test, the way vendor/scoring-engine
// is handled; one shared pure module is simpler and cannot drift.
//
// WHERE THE NUMBERS COME FROM
// Fitted Aug 2026 on 5,904 DST files from the Creative Studio archive
// (2006 through 2026), the full stitch-archive.csv export. Validated with
// grouped cross validation: every multi-file job and every repeat design was
// kept entirely inside one fold, so a design could never be trained on and
// tested on at the same time.
//
//   median absolute error   18.6 %
//   within 20 %             53 %
//   within 30 %             72 %
//
// The rule this replaces (covered area x 1666, calibrated on 25 January 2026
// jobs) scored 23.0 % / 44 % / 66 % on the same 5,904 designs. January 2026
// happens to sit unusually close to 1666, which is why the old sample looked
// better than it was.
//
// HONEST CAVEAT, KEEP THIS IN THE UI
// Those figures use coverage measured from the DST file itself, which is a
// clean input. Coverage measured from a customer PNG is noisier, so live
// accuracy will be worse until real estimate-versus-actual pairs are logged.
// That is what the accuracy view exists to find out.
//
// ESM. Do NOT convert to module.exports.

export const MODEL_VERSION = 'archive-2026-08';

// Fitted constants. Do not hand tune these without rerunning validation on the
// archive; they were chosen together and moving one alone makes things worse.
const C = 1773;           // scale constant
const B_AREA = 0.882;     // exponent on covered thread area
const B_COLORS = 0.200;   // exponent on colour count

// Band multipliers, read straight off the out-of-fold error distribution.
// LOW is the 20th percentile: the finished design lands under it 20 % of the
// time. WORST is the 95th: it lands over that 5 % of the time. Ryan's rule is
// quote low, show the worst case anyway, so the UI leads with LOW and prints
// WORST beside it rather than hiding it behind a toggle.
export const BAND = { low: 0.765, likely: 1.0, worst: 1.515 };

// Within-design resize exponent, measured on 109 matched pairs of the same
// artwork digitised at two genuinely different sizes (found by job number, not
// by filename guessing). Stitch count scales with area to the power 0.66, NOT
// 1.0. Doubling the area adds about 58 % more stitches, not 100 %.
//
// The old tool assumed 1.0 because it multiplied area by a density. That
// overquoted scale-ups by roughly a quarter and underquoted scale-downs by
// about a fifth, and it was a bigger error than the constants ever were.
export const RESIZE_EXPONENT = 0.66;

// Rescaling a design we already own is a much smaller guess than estimating a
// design we have never seen: the only thing left uncertain is the digitiser's
// rework, not the whole design. Narrower bands, measured on the same pairs.
export const RESIZE_BAND = { low: 0.88, likely: 1.0, worst: 1.18 };

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Round to the nearest 50. A stitch estimate printed as 4,187 claims a
// precision the model does not have, and an AM will read it as a measurement
// rather than a guess.
function round50(n) {
  return Math.max(50, Math.round(n / 50) * 50);
}

/**
 * Estimate stitch count from measured artwork.
 *
 * @param {object} input
 * @param {number} input.coveredSqIn  thread-covered area in square inches.
 *                                    This is the magenta overlay area, NOT the
 *                                    bounding box. Passing the bounding box
 *                                    here roughly doubles every estimate.
 * @param {number} input.colors       thread colour count, minimum 1
 * @returns {{low:number, likely:number, worst:number, version:string}}
 */
export function estimate(input) {
  const i = input && typeof input === 'object' ? input : {};
  const area = Math.max(0.01, num(i.coveredSqIn));
  const colors = Math.max(1, Math.round(num(i.colors, 1)));

  const centre = C * Math.pow(area, B_AREA) * Math.pow(colors, B_COLORS);

  return {
    low: round50(centre * BAND.low),
    likely: round50(centre * BAND.likely),
    worst: round50(centre * BAND.worst),
    version: MODEL_VERSION
  };
}

/**
 * Rescale a KNOWN stitch count to a new finished size. Always prefer this over
 * estimate() when the design already exists: it is far more accurate, because
 * the artwork-reading step (the noisy part) is skipped entirely.
 *
 * @param {object} input
 * @param {number} input.knownStitches  actual count of the existing design
 * @param {number} input.oldW  existing finished width in inches
 * @param {number} input.oldH  existing finished height in inches
 * @param {number} input.newW  requested width in inches
 * @param {number} input.newH  requested height in inches
 */
export function rescale(input) {
  const i = input && typeof input === 'object' ? input : {};
  const known = Math.max(1, num(i.knownStitches));
  const oldArea = Math.max(0.01, num(i.oldW) * num(i.oldH));
  const newArea = Math.max(0.01, num(i.newW) * num(i.newH));

  const centre = known * Math.pow(newArea / oldArea, RESIZE_EXPONENT);

  return {
    low: round50(centre * RESIZE_BAND.low),
    likely: round50(centre * RESIZE_BAND.likely),
    worst: round50(centre * RESIZE_BAND.worst),
    version: MODEL_VERSION
  };
}

/**
 * Confidence flag for the UI.
 *
 * These are the conditions where held-out error was materially worse than the
 * 18.6 % headline. The AM should be told BEFORE they quote, not after, because
 * a cap estimate and a left-chest estimate look identical on screen and are
 * not equally trustworthy.
 *
 * @returns {{level:'good'|'fair'|'poor', reasons:string[]}}
 */
export function confidence(input) {
  const i = input && typeof input === 'object' ? input : {};
  const area = num(i.coveredSqIn);
  const fill = i.fill == null ? null : num(i.fill);
  const colors = Math.max(1, Math.round(num(i.colors, 1)));
  const placement = typeof i.placement === 'string' ? i.placement : '';

  const reasons = [];

  if (area > 8) {
    reasons.push('Very large design. Above 8 square inches the model reads about 15 % high.');
  }
  if (area > 0 && area < 0.5) {
    reasons.push('Very small design. Small-area estimates are the least stable in validation.');
  }
  if (fill != null && fill > 0 && fill < 0.25) {
    reasons.push('Mostly empty bounding box. Coverage measurement is fragile on thin line art.');
  }
  if (colors <= 1) {
    reasons.push('Single colour. This could be a light outline or a solid fill, and the artwork cannot tell us which.');
  }
  if (/cap|hat|visor|beanie/i.test(placement)) {
    reasons.push('Cap designs ran 30 % median error in validation. Treat this as indicative only.');
  }

  const level = reasons.length === 0 ? 'good' : reasons.length === 1 ? 'fair' : 'poor';
  return { level, reasons };
}

/**
 * Score a guess (human or model) against the truth. Shared so the game board
 * and the accuracy view can never disagree about what "within 20 %" means.
 */
export function scoreGuess(guess, actual) {
  const g = num(guess);
  const a = num(actual);
  if (!(a > 0) || !(g > 0)) return { errorPct: null, points: 0, band: 'invalid' };

  const errorPct = Math.abs(g - a) / a;

  // Points curve, deliberately steep near the middle so a 5 % guess feels
  // meaningfully better than a 15 % one. Anything past 50 % scores zero
  // rather than going negative: this is a training game, not a punishment.
  let points = 0;
  if (errorPct <= 0.5) points = Math.round(100 * Math.pow(1 - errorPct / 0.5, 1.6));

  let band = 'cold';
  if (errorPct <= 0.05) band = 'bullseye';
  else if (errorPct <= 0.10) band = 'close';
  else if (errorPct <= 0.20) band = 'fair';
  else if (errorPct <= 0.35) band = 'wide';

  return { errorPct, points, band };
}
