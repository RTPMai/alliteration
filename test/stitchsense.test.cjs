/**
 * StitchSense tests (Aug 19, 2026).
 *
 * Two things are being locked in here, and they matter for different reasons.
 *
 * THE MODEL. The constants in lib/stitchsense/model.js were fitted on 5,904
 * archive DST files with grouped cross validation. They are not adjustable
 * taste; changing one silently changes every quote the shop makes. These tests
 * assert the shape of the model (how it responds to area, colour count and
 * resizing) rather than just its constants, so a "small tidy-up" that reverts
 * stitch count to scaling linearly with area fails loudly.
 *
 * THE ACCESS RULE. The guessing game is meant to be playable by production
 * staff who are on the self-serve employee role. That role must reach
 * StitchSense's guess view and NOTHING else in the app: not the quoting tool,
 * not the archive import, not the accuracy log.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// Same helper shell.test.cjs uses. A file that documents a rule must not fail
// the scan for that rule.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

Promise.all([
  import(path.join(ROOT, 'lib/stitchsense/model.js')),
  import(path.join(ROOT, 'lib/stitchsense/schema.js')),
  import(path.join(ROOT, 'js/registry.js')),
  import(path.join(ROOT, 'js/api.js')),
]).then(([model, schema, reg, api]) => {
  const {
    estimate, rescale, confidence, scoreGuess,
    RESIZE_EXPONENT, BAND, MODEL_VERSION
  } = model;
  const {
    validateDesign, validateEstimate, validateActual, validateRound,
    CHARACTERS, CHARACTER_KEYS, agreedCharacter, keys, KEY_PREFIX
  } = schema;
  const { APPS, canAccess, allowedViews, getApp } = reg;
  const { ENDPOINTS } = api;

  /* ---- files exist ----------------------------------------------------- */

  t.test('every StitchSense file is present', () => {
    [
      'lib/stitchsense/model.js',
      'lib/stitchsense/schema.js',
      'lib/stitchsense/store.js',
      'api/stitchsense/designs.js',
      'api/stitchsense/estimates.js',
      'api/stitchsense/rounds.js',
      'api/stitchsense/settings.js',
      'apps/stitchsense.js'
    ].forEach((p) => t.assert(exists(p), 'missing ' + p));
  });

  t.test('the API lives in a folder, not as a flat api/stitchsense.js', () => {
    // Vercel treats a file and a same-named folder as a route conflict once
    // the .js is stripped. WebsiteWidget and PromoPro both learned this.
    t.assert(!exists('api/stitchsense.js'),
      'api/stitchsense.js would collide with the api/stitchsense/ folder');
  });

  /* ---- the model: shape, not just constants ---------------------------- */

  t.test('estimate grows with covered area, but slower than area does', () => {
    const small = estimate({ coveredSqIn: 2, colors: 2 }).likely;
    const big = estimate({ coveredSqIn: 4, colors: 2 }).likely;
    t.assert(big > small, 'doubling the area must raise the estimate');
    t.assert(big < small * 2,
      'stitch count must not scale one-for-one with area; that is the old rule');
  });

  t.test('estimate grows with colour count', () => {
    const one = estimate({ coveredSqIn: 3, colors: 1 }).likely;
    const six = estimate({ coveredSqIn: 3, colors: 6 }).likely;
    t.assert(six > one,
      'colour count was the only design-character split that survived validation');
  });

  t.test('the bands lean low and still show a worst case', () => {
    const out = estimate({ coveredSqIn: 3, colors: 2 });
    t.assert(out.low < out.likely, 'the quoting figure must sit below the likely figure');
    t.assert(out.worst > out.likely, 'the worst case must sit above the likely figure');
    t.assert(BAND.low < 1 && BAND.worst > 1, 'band multipliers are the wrong way round');
  });

  t.test('estimates are rounded, never printed to the stitch', () => {
    const out = estimate({ coveredSqIn: 2.7183, colors: 3 });
    [out.low, out.likely, out.worst].forEach((n) =>
      t.equal(n % 50, 0, 'a four-digit-precise estimate claims accuracy the model does not have'));
  });

  t.test('a nonsense input does not produce a nonsense number', () => {
    const out = estimate({ coveredSqIn: 0, colors: 0 });
    t.assert(out.likely > 0 && Number.isFinite(out.likely), 'must degrade, not return NaN');
    const junk = estimate({ coveredSqIn: 'banana', colors: null });
    t.assert(Number.isFinite(junk.likely), 'must survive a bad value from the UI');
  });

  /* ---- the resize path, which is the biggest correction over the old tool */

  t.test('resizing uses the measured exponent, not one-for-one with area', () => {
    // 109 matched pairs of the same artwork at two genuinely different sizes
    // gave 0.66. The old tool assumed 1.0 and overquoted every scale-up.
    t.assert(RESIZE_EXPONENT > 0.5 && RESIZE_EXPONENT < 0.8,
      'RESIZE_EXPONENT is outside the measured range; rerun the pair analysis before changing it');

    const out = rescale({ knownStitches: 10000, oldW: 3, oldH: 2, newW: 6, newH: 2 });
    // Area doubles. A one-for-one rule would say 20,000.
    t.assert(out.likely < 18000,
      'doubling the area must not double the stitch count');
    t.assert(out.likely > 14000,
      'doubling the area must still raise the count substantially');
  });

  t.test('resizing down reduces the count by less than the area drops', () => {
    const out = rescale({ knownStitches: 10000, oldW: 4, oldH: 2, newW: 2, newH: 2 });
    t.assert(out.likely > 5000,
      'halving the area must not halve the count; outlines and underlay do not shrink with area');
    t.assert(out.likely < 10000, 'a smaller design must still cost fewer stitches');
  });

  t.test('a resize keeps tighter bands than a cold estimate', () => {
    const cold = estimate({ coveredSqIn: 3, colors: 2 });
    const warm = rescale({ knownStitches: 6000, oldW: 3, oldH: 2, newW: 3.5, newH: 2 });
    const coldSpread = cold.worst / cold.low;
    const warmSpread = warm.worst / warm.low;
    t.assert(warmSpread < coldSpread,
      'requoting a design we own is a smaller guess than reading a picture, and must show as one');
  });

  /* ---- confidence flags ------------------------------------------------ */

  t.test('an ordinary design reports good confidence', () => {
    const c = confidence({ coveredSqIn: 3, fill: 0.5, colors: 4, placement: 'left_chest' });
    t.equal(c.level, 'good', 'a plain multi-colour left chest should not be flagged');
    t.equal(c.reasons.length, 0, 'no reasons expected');
  });

  t.test('caps are flagged, because they validated at 30 percent error', () => {
    const c = confidence({ coveredSqIn: 3, fill: 0.5, colors: 4, placement: 'cap_front' });
    t.assert(c.reasons.some((r) => /cap/i.test(r)), 'cap placement must warn');
  });

  t.test('thin line art and single colours are flagged', () => {
    const c = confidence({ coveredSqIn: 3, fill: 0.1, colors: 1 });
    t.assert(c.reasons.length >= 2, 'both conditions should raise a reason');
    t.equal(c.level, 'poor', 'two or more reasons is poor confidence');
  });

  /* ---- game scoring ---------------------------------------------------- */

  t.test('a perfect guess scores the maximum and a wild one scores zero', () => {
    t.equal(scoreGuess(5000, 5000).band, 'bullseye', 'an exact guess is a bullseye');
    t.equal(scoreGuess(5000, 5000).points, 100, 'an exact guess is worth full points');
    t.equal(scoreGuess(50000, 5000).points, 0, 'a tenfold miss scores nothing');
    t.assert(scoreGuess(50000, 5000).points >= 0, 'points must never go negative');
  });

  t.test('scoring is symmetric around the truth', () => {
    const over = scoreGuess(6000, 5000).errorPct;
    const under = scoreGuess(4000, 5000).errorPct;
    t.equal(Math.round(over * 100), Math.round(under * 100),
      'guessing 20 percent high and 20 percent low are equally wrong');
  });

  t.test('scoring refuses to grade against a missing truth', () => {
    t.equal(scoreGuess(5000, 0).band, 'invalid', 'no truth means no score');
    t.equal(scoreGuess(0, 5000).band, 'invalid', 'no guess means no score');
  });

  /* ---- schema validation ----------------------------------------------- */

  t.test('a design with an impossible stitch count is rejected', () => {
    const base = { name: 'x', stitches: 5000, w: 3, h: 2, coveredSqIn: 2, colors: 2 };
    t.equal(validateDesign(base).ok, true, 'a normal design must pass');
    t.equal(validateDesign({ ...base, stitches: 0 }).ok, false, 'zero stitches is not a design');
    t.equal(validateDesign({ ...base, stitches: 900000 }).ok, false, 'that is not a stitch count');
    t.equal(validateDesign({ ...base, name: '   ' }).ok, false, 'a design needs a name');
    t.equal(validateDesign({ ...base, w: 0 }).ok, false, 'a design needs a real width');
  });

  t.test('a thumbnail must be a data URI or nothing', () => {
    const base = { name: 'x', stitches: 5000, w: 3, h: 2, coveredSqIn: 2, colors: 2 };
    t.equal(validateDesign({ ...base, thumb: '' }).ok, true, 'no thumbnail is allowed');
    t.equal(validateDesign({ ...base, thumb: 'https://example.com/a.png' }).ok, false,
      'a remote URL would let an import point the game at anything');
  });

  t.test('an estimate cannot be filed with its own answer already in it', () => {
    const r = validateEstimate({
      source: 'image', likely: 5000, low: 3800, worst: 7500, actualStitches: 5000
    });
    t.equal(r.ok, true, 'the estimate itself is fine');
    t.equal(r.record.actualStitches, null,
      'actualStitches must arrive later, or the accuracy view can be made to lie');
  });

  t.test('an estimate needs a known source', () => {
    t.equal(validateEstimate({ source: 'vibes', likely: 5000 }).ok, false, 'unknown source');
    t.equal(validateEstimate({ source: 'image' }).ok, false, 'a likely figure is required');
    ['image', 'dst', 'rescale'].forEach((s) =>
      t.equal(validateEstimate({ source: s, likely: 100 }).ok, true, s + ' must be accepted'));
  });

  t.test('a recorded actual has to be a plausible count', () => {
    t.equal(validateActual({ actualStitches: 4200 }).ok, true, 'a real count passes');
    t.equal(validateActual({ actualStitches: 2 }).ok, false, 'two stitches is a typo');
    t.equal(validateActual({}).ok, false, 'a blank is not an answer');
  });

  t.test('a round needs a design and a guess, but the tag is optional', () => {
    t.equal(validateRound({ designId: 'SD-000001', guess: 5000 }).ok, true,
      'playing without tagging must be allowed, or people tag at random to move on');
    t.equal(validateRound({ guess: 5000 }).ok, false, 'a round needs a design');
    t.equal(validateRound({ designId: 'SD-000001' }).ok, false, 'a round needs a guess');
    t.equal(validateRound({ designId: 'SD-1', guess: 100, character: 'nonsense' }).record.character, '',
      'an unknown character is dropped, not stored');
  });

  t.test('the character list is short enough to actually get answered', () => {
    t.assert(CHARACTERS.length <= 10,
      'a long taxonomy gets answered at random after the third round');
    t.assert(CHARACTER_KEYS.includes('text_only') && CHARACTER_KEYS.includes('puff'),
      'the two ends of the density range must both be nameable');
  });

  t.test('agreed character reads the vote, and is empty until someone votes', () => {
    t.equal(agreedCharacter({ characterVotes: {} }), '', 'no votes means no answer');
    t.equal(agreedCharacter({ characterVotes: { text_only: 2, puff: 5 } }), 'puff', 'majority wins');
    t.equal(agreedCharacter(null), '', 'a missing design must not throw');
  });

  t.test('every KV key stays under the app prefix', () => {
    const all = [
      keys.design('a'), keys.designIndex(), keys.estimate('a'), keys.estimateIndex(),
      keys.round('a'), keys.roundIndex(), keys.counter('design')
    ];
    all.forEach((k) => t.assert(String(k).startsWith(KEY_PREFIX + ':'),
      k + ' escapes the stitchsense_data prefix'));
  });

  /* ---- registry and the seam ------------------------------------------- */

  t.test('StitchSense is registered as a real app, not a stub', () => {
    const app = getApp('stitchsense');
    t.assert(app, 'stitchsense is missing from the registry');
    t.equal(app.stub, false, 'it is built, so it must not be marked a stub');
    t.assert(exists('apps/' + app.id + '.js'), 'the registry entry has no module');
    ['estimate', 'library', 'guess', 'accuracy'].forEach((v) =>
      t.assert(app.views.some((pair) => pair[0] === v), 'missing view: ' + v));
  });

  t.test('the app has an accent block in tokens.css', () => {
    t.assert(read('css/tokens.css').includes('body[data-app="stitchsense"]'),
      'without a tokens block the app inherits another app\'s colour');
  });

  t.test('every StitchSense endpoint is declared and marked live', () => {
    ['ssenseDesigns', 'ssenseEstimates', 'ssenseRounds', 'ssenseSettings']
      .forEach((k) => t.assert(ENDPOINTS[k], 'ENDPOINTS.' + k + ' is missing'));
    const src = read('js/api.js');
    t.assert(src.includes("'/api/stitchsense/'"),
      'the routes are deployed, so the prefix must be in LIVE_PREFIXES or the app runs on mocks');
  });

  t.test('the app file calls no fetch of its own', () => {
    const src = read('apps/stitchsense.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    t.assert(!/\bfetch\s*\(/.test(src),
      'apps/stitchsense.js must go through ctx.api, not fetch directly');
  });

  t.test('the app file carries no server imports', () => {
    const src = read('apps/stitchsense.js');
    ['fs', 'path', 'crypto', 'http'].forEach((b) => {
      const re = new RegExp('from\\s+["\'](node:)?' + b + '["\']');
      t.assert(!re.test(src), 'apps/stitchsense.js imports the Node built-in ' + b);
    });
    t.assert(!src.includes('export const config'),
      'that is a Vercel handler signature; a route has been dropped into apps/');
  });

  t.test('the shared model file is environment-free', () => {
    // It is imported by BOTH the browser app and the serverless routes, so
    // anything environment-specific in it breaks one side or the other.
    const src = read('lib/stitchsense/model.js');
    t.assert(!/\bfetch\s*\(/.test(src), 'model.js must not do I/O');
    t.assert(!/process\.env/.test(src), 'model.js must not read env vars');
    t.assert(!/\brequire\s*\(/.test(src), 'model.js is ESM');
    t.assert(!/document\.|window\./.test(src), 'model.js must not touch the DOM');
  });

  t.test('lib never imports from api', () => {
    ['lib/stitchsense/model.js', 'lib/stitchsense/schema.js', 'lib/stitchsense/store.js']
      .forEach((p) => t.assert(!read(p).includes('../../api/'), p + ' imports from api/'));
  });

  /* ---- access ---------------------------------------------------------- */

  t.test('an account manager can open the app', () => {
    t.equal(canAccess({ tabs: ['backbone', 'stitchsense'] }, 'stitchsense'), true,
      'quoting embroidery is the reason this app exists');
  });

  t.test('a granted-but-unlisted user cannot open it', () => {
    t.equal(canAccess({ tabs: ['backbone', 'shopstock'] }, 'stitchsense'), false,
      'apps are opt-in, not opt-out');
  });

  t.test('the self-serve employee role reaches the game and nothing else', () => {
    // This is the whole reason the game can exist: production staff are on the
    // employee role, which otherwise only opens CrewCore.
    const perms = {
      tabs: ['crewcore', 'stitchsense', 'crewcore:handbook', 'stitchsense:guess'],
      superuser: false
    };
    t.equal(canAccess(perms, 'stitchsense'), true, 'the employee role must open the app');
    const views = allowedViews(perms, 'stitchsense');
    t.assert(views.includes('guess'), 'the game must be reachable');
    t.assert(!views.includes('estimate'), 'production staff do not need the quoting tool');
    t.assert(!views.includes('accuracy'), 'production staff do not need the accuracy log');
    t.assert(!views.includes('library'), 'the archive import lives behind Library');
  });

  t.test('the shipped employee role actually carries that grant', () => {
    // Reading the file rather than importing it: lib/users.js reads KV at
    // import time in some paths, and the point here is what the DEFAULTS say.
    const src = read('lib/users.js');
    t.assert(src.includes('"stitchsense:guess"'),
      'DEFAULT_ROLES.employee must scope StitchSense down to the game');
  });

  /* ---- route gating ---------------------------------------------------- */

  t.test('every route requires a session', () => {
    ['designs', 'estimates', 'rounds', 'settings'].forEach((r) => {
      const src = read('api/stitchsense/' + r + '.js');
      t.assert(src.includes('requireAuth(req, res)'),
        'api/stitchsense/' + r + '.js does not require a session');
    });
  });

  t.test('importing, wiping and calibrating are admin only', () => {
    const designs = read('api/stitchsense/designs.js');
    t.assert(designs.includes('callerIsAdmin'), 'designs.js has no admin check');
    t.assert(/POST[\s\S]{0,400}callerIsAdmin/.test(designs),
      'the import path must be gated before it writes');
    const settings = read('api/stitchsense/settings.js');
    t.assert(settings.includes('callerIsAdmin'),
      'calibration changes every estimate everyone makes, so it cannot be open');
  });

  t.test('the game never ships the answer before the guess is in', () => {
    // The reveal comes from the POST response. Sending the true count with the
    // question and trusting the UI not to render it would put the answer in
    // the network tab, one keypress from anybody who wanted to top the board.
    //
    // Comments are stripped first, the same way the seam test does it: the
    // block explains WHY coveredSqIn is withheld, and a naive scan reads that
    // explanation as the violation it is warning about.
    const designs = stripComments(read('api/stitchsense/designs.js'));
    const randomBlock = designs.slice(
      designs.indexOf('if (q.random)'),
      designs.indexOf("if (req.method === 'POST')")
    );
    t.assert(randomBlock.length > 100, 'could not find the random-pick block to check');
    t.assert(!/stitches/.test(randomBlock),
      'the random pick must not ship the stitch count');
    t.assert(!/coveredSqIn|fill/.test(randomBlock),
      'coverage plus the published model reconstructs the answer, so it goes too');
    t.assert(/thumb/.test(randomBlock) && /colors/.test(randomBlock),
      'the player still needs the picture, the size and the colour count');

    const rounds = read('api/stitchsense/rounds.js');
    t.assert(rounds.includes('scoreGuess'), 'the server must do the scoring');
  });

  t.test('the game view scores from the server response, not from the design', () => {
    const app = stripComments(read('apps/stitchsense.js'));
    // Anchored on the section banner, not on renderAccuracy(: that name also
    // appears up in showView(), far ABOVE submitGuess, which silently sliced
    // an empty string and made this test pass on nothing.
    const gameBlock = app.slice(app.indexOf('async submitGuess('), app.indexOf('VIEW: ACCURACY'));
    t.assert(gameBlock.length > 100, 'could not find the guess-submission block to check');
    t.assert(!/\.stitches/.test(gameBlock),
      'the game must take the truth from the POST response, never off the design record');
  });

  t.test('the round record stores what the model said at the time', () => {
    const src = read('api/stitchsense/rounds.js');
    t.assert(src.includes('modelGuess') && src.includes('modelVersion'),
      'a later recalibration must not be able to rewrite the head-to-head history');
  });

  t.test('the model version is stamped so old numbers stay readable', () => {
    t.assert(typeof MODEL_VERSION === 'string' && MODEL_VERSION.length > 3,
      'estimates recorded under a different calibration must be identifiable');
  });

  /* ---- the honest caveat stays on screen -------------------------------- */

  t.test('the app tells people the archive figure is not the live figure', () => {
    const app = read('apps/stitchsense.js');
    t.assert(app.includes('18.6'),
      'the validated archive error should be visible, not folklore');
    t.assert(/customer artwork|customer PNG/i.test(app),
      'the app must say the model was never fitted on customer artwork');
  });

  process.exit(t.report());
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
