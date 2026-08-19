//
// Three record types, all under the stitchsense_data: prefix:
//
//   design    a real design we own, with its TRUE stitch count read out of the
//             DST file. This is the game's question bank and the library the
//             resize path quotes from. Ground truth, never a guess.
//   estimate  something an AM quoted, and later, what it actually came in at.
//             This is the only record that teaches us anything about the live
//             accuracy of the tool, because it is the only one that includes
//             the messy customer-artwork step.
//   round     one play of the guessing game: who guessed what on which design,
//             and what the model guessed at the same time.
//
// WHY ROUNDS DO NOT TRAIN THE MODEL DIRECTLY
// A human guess is not ground truth. The DST is. So a round can never be a
// training label for stitch count, and any design that says otherwise is
// fooling itself. What rounds DO produce that is worth having:
//
//   1. A human-versus-model benchmark. If the embroidery team beats the model
//      on a category, the model is missing something they can see.
//   2. A character tag per design, supplied by the people who would know.
//      Filename keywords were tried as a source for this and failed
//      validation; a digitiser picking "3D puff" from a list will not.
//
// The tag is the real prize. Once a character has a few hundred labels, the
// per-category correction factors that failed on filename guessing can be
// retested properly.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = 'stitchsense_data';

export const keys = {
  design: (id) => `${KEY_PREFIX}:design:${id}`,
  designIndex: () => `${KEY_PREFIX}:design:index`,
  estimate: (id) => `${KEY_PREFIX}:estimate:${id}`,
  estimateIndex: () => `${KEY_PREFIX}:estimate:index`,
  round: (id) => `${KEY_PREFIX}:round:${id}`,
  roundIndex: () => `${KEY_PREFIX}:round:index`,
  counter: (kind) => `${KEY_PREFIX}:counter:${kind}`
};

/**
 * Design character. The list the embroidery team picks from after a guess.
 *
 * Kept SHORT on purpose. A twenty-option taxonomy gets answered at random
 * after the third round, and a tag nobody thought about is worse than no tag,
 * because it looks like data. Every option here is something a digitiser can
 * decide in under a second by looking at the design.
 */
export const CHARACTERS = [
  ['text_only', 'Text only'],
  ['text_outline', 'Text with outline'],
  ['small_fill', 'Small filled logo'],
  ['large_fill', 'Large filled logo'],
  ['line_art', 'Line art / thin detail'],
  ['emblem', 'Detailed emblem or crest'],
  ['puff', '3D puff'],
  ['applique', 'Applique or twill']
];

export const CHARACTER_KEYS = CHARACTERS.map((c) => c[0]);

/** Where a design record came from. */
export const DESIGN_SOURCES = ['archive', 'manual'];

/** How an estimate was produced. Drives what the accuracy view can compare. */
export const ESTIMATE_SOURCES = ['image', 'dst', 'rescale'];

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickOne(raw, allowed, fallback) {
  const s = str(raw, 40);
  return allowed.includes(s) ? s : fallback;
}

/**
 * Validate one design coming from the importer.
 *
 * Deliberately strict about stitches, width and height: a design with a wrong
 * stitch count is not a harmless bad row, it is a wrong answer in the game and
 * a poisoned reference for the resize path. Better to reject it at the door.
 */
export function validateDesign(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const name = str(b.name, 160);
  if (!name) errors.push('name is required');

  const stitches = num(b.stitches);
  if (stitches == null || stitches < 10 || stitches > 500000) {
    errors.push('stitches must be a real count between 10 and 500,000');
  }

  const w = num(b.w);
  const h = num(b.h);
  if (w == null || w <= 0 || w > 40) errors.push('w must be a width in inches');
  if (h == null || h <= 0 || h > 40) errors.push('h must be a height in inches');

  const coveredSqIn = num(b.coveredSqIn);
  if (coveredSqIn == null || coveredSqIn <= 0) errors.push('coveredSqIn is required');

  const colors = num(b.colors);

  // A thumbnail is optional. Without one the design still works for the resize
  // path and for recalibration; it just cannot appear in the game, because
  // there is nothing to show. The importer says so rather than silently
  // dropping the record.
  const thumb = str(b.thumb, 60000);
  if (thumb && !thumb.startsWith('data:image/')) {
    errors.push('thumb must be a data:image/... URI');
  }

  const record = {
    name,
    jobNumber: str(b.jobNumber, 40),
    folder: str(b.folder, 300),
    stitches: stitches == null ? 0 : Math.round(stitches),
    colors: colors == null ? 1 : Math.max(1, Math.round(colors)),
    w: w == null ? 0 : Math.round(w * 1000) / 1000,
    h: h == null ? 0 : Math.round(h * 1000) / 1000,
    coveredSqIn: coveredSqIn == null ? 0 : Math.round(coveredSqIn * 1000) / 1000,
    fill: num(b.fill) == null ? null : Math.round(num(b.fill) * 10000) / 10000,
    thumb,
    source: pickOne(b.source, DESIGN_SOURCES, 'archive'),
    // Tags accumulate from game rounds. Never supplied at import time, because
    // nobody has looked at the design yet.
    characterVotes: {}
  };

  return { ok: errors.length === 0, errors, record };
}

/**
 * Validate an estimate an AM just produced.
 *
 * actualStitches is NOT accepted here. It arrives later, through the patch
 * path, once the job is digitised. Allowing both at once would let somebody
 * file a perfect estimate after the fact, which would quietly make the
 * accuracy view lie in exactly the direction nobody wants to catch.
 */
export function validateEstimate(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const source = pickOne(b.source, ESTIMATE_SOURCES, '');
  if (!source) errors.push('source must be one of: ' + ESTIMATE_SOURCES.join(', '));

  const likely = num(b.likely);
  if (likely == null || likely <= 0) errors.push('likely is required');

  const low = num(b.low);
  const worst = num(b.worst);

  const record = {
    source,
    customer: str(b.customer, 160),
    jobNumber: str(b.jobNumber, 40),
    designName: str(b.designName, 160),
    placement: str(b.placement, 60),
    w: num(b.w) || 0,
    h: num(b.h) || 0,
    coveredSqIn: num(b.coveredSqIn) || 0,
    fill: num(b.fill),
    colors: Math.max(1, Math.round(num(b.colors) || 1)),
    low: low == null ? 0 : Math.round(low),
    likely: Math.round(likely),
    worst: worst == null ? 0 : Math.round(worst),
    quoted: num(b.quoted) == null ? null : Math.round(num(b.quoted)),
    modelVersion: str(b.modelVersion, 40),
    notes: str(b.notes, 1000),
    actualStitches: null,
    actualAt: null,
    actualBy: ''
  };

  return { ok: errors.length === 0, errors, record };
}

/** Validate the later "here is what it actually came in at" update. */
export function validateActual(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const actual = num(b.actualStitches);
  if (actual == null || actual < 10 || actual > 500000) {
    errors.push('actualStitches must be a real count between 10 and 500,000');
  }
  return { ok: errors.length === 0, errors, actualStitches: actual == null ? null : Math.round(actual) };
}

/** Validate one play of the game. */
export function validateRound(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const designId = str(b.designId, 60);
  if (!designId) errors.push('designId is required');

  const guess = num(b.guess);
  if (guess == null || guess < 1 || guess > 500000) {
    errors.push('guess must be between 1 and 500,000');
  }

  const record = {
    designId,
    guess: guess == null ? 0 : Math.round(guess),
    // Optional: somebody can skip the tag and still play. Forcing it would
    // make people pick anything to get to the next design, which is worse
    // than a blank.
    character: pickOne(b.character, CHARACTER_KEYS, ''),
    secondsTaken: Math.max(0, Math.min(3600, Math.round(num(b.secondsTaken) || 0)))
  };

  return { ok: errors.length === 0, errors, record };
}

/**
 * Which character a design is, by vote, or '' if nobody has said yet.
 * Ties break toward the first-listed character rather than toward whichever
 * key the JS engine happens to enumerate first, so this is stable.
 */
export function agreedCharacter(design) {
  const votes = (design && design.characterVotes) || {};
  let best = '';
  let bestCount = 0;
  for (const [key] of CHARACTERS) {
    const n = Number(votes[key] || 0);
    if (n > bestCount) { best = key; bestCount = n; }
  }
  return bestCount > 0 ? best : '';
}

export function characterLabel(key) {
  const hit = CHARACTERS.find((c) => c[0] === key);
  return hit ? hit[1] : '';
}
