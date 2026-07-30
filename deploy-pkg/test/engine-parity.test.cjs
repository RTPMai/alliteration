/**
 * Engine parity.
 *
 * js/scorecard.js and js/giving-engine.js are VERBATIM PORTS of Ryan's real
 * algorithms. This test is what makes "verbatim" enforceable rather than
 * aspirational: it hashes the vendored copy and compares it to a recorded
 * fingerprint.
 *
 * IF THIS TEST FAILS, someone edited the engine in place. That is the wrong
 * fix in every case. The rule is:
 *   1. Change the rule in the SOURCE repo (GivingGauge).
 *   2. Re-copy the file into vendor/.
 *   3. Update FINGERPRINT below, in the same commit, with the reason.
 *
 * Updating the fingerprint without step 1 defeats the point of the test.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE = path.join(__dirname, '..', 'vendor', 'scoring-engine.cjs');
const DIAL = path.join(__dirname, '..', 'vendor', 'gauge.cjs');

// sha256 of GivingGauge/src/scoring-engine.js v1.0 as copied on import.
const FINGERPRINT = '153dc2f00de4551d556619ca95870335c2ac623b64b0355c76aa7ab6f57c4780';
// sha256 of GivingGauge/src/gauge.js as copied on import.
const DIAL_FINGERPRINT = '0b121e63d095b90b5f52a69d62cca7426d3e54756c0ba36c6fe38765b1db3bf4';

const t = require('./harness.cjs');

t.test('vendored engine file exists', () => {
  t.assert(fs.existsSync(ENGINE), 'vendor/scoring-engine.cjs is missing');
});

t.test('vendored engine is byte-identical to the source port', () => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(ENGINE)).digest('hex');
  t.equal(hash, FINGERPRINT,
    'Engine was edited in place. Change it in the source repo and re-copy instead.');
});

t.test('engine still exposes the expected surface', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  ['evaluate', 'computeDaysOut', 'toGrade', 'gaugeColor',
   'LEAD_TIME_FLOOR_DAYS', 'DIMENSION_MAX', 'TOTAL_MAX'].forEach((key) => {
    t.assert(src.includes(key), 'engine no longer exports ' + key);
  });
});

t.test('vendored gauge is byte-identical to the source', () => {
  t.assert(fs.existsSync(DIAL), 'vendor/gauge.cjs is missing');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(DIAL)).digest('hex');
  t.equal(hash, DIAL_FINGERPRINT,
    'gauge.cjs was edited in place. Change it in the source repo and re-copy.');
});

t.test('the gauge renders SVG from a scoring result', () => {
  global.window = global.window || {};
  const engine = require(ENGINE);
  const dial = require(DIAL);
  const result = engine.evaluate(
    { orgType: 'nonprofit', eventDate: '2026-12-01', missionFit: 'core' },
    { found: true },
    { today: '2026-01-01' }
  );
  const svg = dial.renderGauge(result, {});
  t.assert(svg.includes('<svg') && svg.includes('</svg>'), 'renderGauge must return SVG');
});

t.test('engine scores a known request correctly', () => {
  // Loads the CommonJS engine directly, the same way GivingGauge's own tests do.
  const GG = require(ENGINE);

  const result = GG.evaluate(
    { orgType: 'political', isPolitical: true, eventDate: '2026-12-01' },
    { found: false },
    { today: '2026-01-01' }
  );

  t.equal(result.disqualified, true, 'a political org must be disqualified');
  t.equal(result.grade, 'F', 'a disqualified request grades F');
});

t.test('adapter does not redefine engine logic', () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'giving-engine.js'), 'utf8');

  // The adapter is a pass-through. Scoring constants appearing in it would mean
  // logic had leaked out of the engine.
  ['DIMENSION_MAX =', 'GRADE_BANDS', 'LEAD_TIME_FLOOR_DAYS ='].forEach((marker) => {
    t.assert(!adapter.includes(marker),
      'giving-engine.js contains engine logic (' + marker + '); it must only delegate');
  });
});

process.exit(t.report());
