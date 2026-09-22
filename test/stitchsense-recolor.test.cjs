/* test/stitchsense-recolor.test.cjs */
/**
 * StitchSense Colorway, artwork path (Sep 22, 2026).
 *
 * Every check here calls lib/stitchsense/recolor.js on real pixels. The test
 * logo is drawn the way real artwork arrives: a red disc with a soft,
 * anti-aliased edge on a white box, a white square INSIDE the disc, and a
 * navy bar. That one picture carries the three things that go wrong in a
 * naive recolor: a halo of the old colour on every edge, the white lettering
 * inside a logo vanishing along with the background, and edge shades turning
 * up as colours of their own.
 */

'use strict';

const path = require('path');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');

const WHITE = [255, 255, 255], RED = [200, 16, 46], NAVY = [27, 58, 107], GREEN = [0, 160, 0];

function mix(a, b, k) { return a.map((v, i) => v + (b[i] - v) * k); }

/** The test logo. noise adds JPEG-style speckle, seeded so runs agree. */
function logo(noise = 0) {
  const w = 200, h = 200, data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 100, y - 100);
      let c = mix(WHITE, RED, Math.max(0, Math.min(1, 70.5 - r)));
      if (Math.abs(x - 100) < 15 && Math.abs(y - 100) < 15) c = WHITE;   // island inside the disc
      if (y >= 180 && y < 190 && x > 20 && x < 180) c = NAVY;
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = Math.round(c[k] + (noise ? (rnd() * 2 - 1) * noise : 0));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function at(rgba, w, x, y) { const i = (y * w + x) * 4; return Array.from(rgba.slice(i, i + 4)); }
function near(a, b, tol = 12) { return a.every((v, i) => Math.abs(v - b[i]) <= tol); }

import(path.join(ROOT, 'lib/stitchsense/recolor.js')).then((R) => {
  const img = logo();
  const a = R.analyze(img, {});
  const idx = (rgb) => a.palette.findIndex((p) => near(p.rgb, rgb));

  t.test('finds the three real colours and nothing else', () => {
    t.equal(a.palette.length, 3, 'edge shades must not become swatches');
    t.assert(idx(WHITE) >= 0 && idx(RED) >= 0 && idx(NAVY) >= 0, 'white, red and navy all found');
  });

  t.test('JPEG-style noise does not add colours', () => {
    const noisy = R.analyze(logo(8), {});
    t.equal(noisy.palette.length, 3, 'speckle must fold into the colour it sits on');
  });

  t.test('colours come biggest first, with shares that add up', () => {
    const shares = a.palette.map((p) => p.share);
    t.assert(shares[0] >= shares[1] && shares[1] >= shares[2], 'sorted by share');
    const sum = shares.reduce((x, y) => x + y, 0);
    t.assert(Math.abs(sum - 1) < 0.01, 'shares cover the art, got ' + sum);
  });

  t.test('the white box is detected as the background', () => {
    t.equal(a.bgIndex, idx(WHITE));
  });

  t.test('with nothing changed, the art comes back as it went in', () => {
    const out = R.render(a, a.palette.map((p) => p.rgb), {});
    t.assert(near(at(out, 200, 100, 50), [...RED, 255]), 'disc unchanged');
    t.assert(near(at(out, 200, 0, 0), [...WHITE, 255]), 'background unchanged');
  });

  t.test('changing one colour changes it and nothing else', () => {
    const targets = a.palette.map((p) => p.rgb);
    targets[idx(RED)] = GREEN;
    const out = R.render(a, targets, {});
    t.assert(near(at(out, 200, 100, 50), [...GREEN, 255]), 'disc is green');
    t.assert(near(at(out, 200, 100, 185), [...NAVY, 255]), 'bar still navy');
    t.assert(near(at(out, 200, 100, 100), [...WHITE, 255]), 'island still white');
  });

  t.test('soft edges blend into the NEW colour, no halo of the old one', () => {
    const targets = a.palette.map((p) => p.rgb);
    targets[idx(RED)] = GREEN;
    const out = R.render(a, targets, {});
    // The half-covered pixel on the disc edge, originally halfway red to white.
    const src = at(img.data, 200, 170, 100);
    t.assert(src[1] > 60 && src[1] < 200, 'fixture: 170,100 is an edge pixel');
    const px = at(out, 200, 170, 100);
    // Halfway green to white has a high green channel and a LOW red channel.
    // A leftover red halo would push red up.
    t.assert(px[0] < px[1], 'edge pixel is a green blend, not a red one: ' + px);
  });

  t.test('removing the background clears the box and keeps the island', () => {
    const out = R.render(a, a.palette.map((p) => p.rgb), { removeBg: true });
    t.equal(at(out, 200, 0, 0)[3], 0, 'corner is transparent');
    t.equal(at(out, 200, 100, 100)[3], 255, 'white inside the disc stays solid');
    t.equal(at(out, 200, 100, 50)[3], 255, 'the disc itself stays');
  });

  t.test('the edge against a removed background fades instead of leaving a white fringe', () => {
    const targets = a.palette.map((p) => p.rgb);
    targets[idx(RED)] = GREEN;
    const out = R.render(a, targets, { removeBg: true });
    const px = at(out, 200, 170, 100);
    t.assert(px[3] > 40 && px[3] < 220, 'edge pixel is part transparent, alpha ' + px[3]);
    t.assert(near(px.slice(0, 3), GREEN, 30), 'and coloured as the design, not white: ' + px);
  });

  t.test('an already transparent PNG has no background to remove', () => {
    const clear = logo();
    for (let i = 0; i < clear.data.length; i += 4) {
      if (clear.data[i] > 250 && clear.data[i + 1] > 250) clear.data[i + 3] = 0;
    }
    const ca = R.analyze(clear, {});
    t.equal(ca.bgIndex, -1);
    t.assert(ca.palette.every((p) => !near(p.rgb, WHITE, 20)), 'transparent pixels are not a colour');
  });

  t.test('colours to find caps the palette', () => {
    t.equal(R.analyze(img, { maxColors: 2 }).palette.length, 2);
    t.assert(R.findPalette(img, { maxColors: 99 }).palette.length <= R.MAX_COLORS, 'never past the maximum');
  });

  t.test('a blank image finds nothing rather than inventing a colour', () => {
    const blank = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
    t.equal(R.analyze(blank, {}).palette.length, 0);
  });

  t.test('colours in use counts merged swatches once', () => {
    const fake = { bgIndex: -1, bgInsideShare: 0 };
    t.equal(R.colorsInUse(fake, ['#ff0000', '#FF0000', '#0000ff'], false), 2, 'two swatches set alike are one colour');
  });

  t.test('a removed background is not an ink, unless it also shows inside the design', () => {
    const hex = a.palette.map((p) => R.rgbToHex(p.rgb));
    // The test logo has a white square inside the disc, so white still prints.
    t.assert(a.bgInsideShare > R.MIN_SHARE, 'fixture: white shows inside the disc');
    t.equal(R.colorsInUse(a, hex, true), 3, 'white island keeps white counted');
    t.equal(R.colorsInUse(a, hex, false), 3);

    // Same logo, no island: white is only background, so removing it drops a colour.
    const plain = logo();
    for (let y = 86; y < 115; y++) for (let x = 86; x < 115; x++) plain.data.set(RED, (y * 200 + x) * 4);
    const pa = R.analyze(plain, {});
    const phex = pa.palette.map((p) => R.rgbToHex(p.rgb));
    t.equal(R.colorsInUse(pa, phex, true), 2, 'background only, not an ink once removed');
    t.equal(R.colorsInUse(pa, phex, false), 3, 'kept background is an ink');
  });

  t.test('hex round trip', () => {
    t.equal(R.rgbToHex([200, 16, 46]), '#c8102e');
    t.equal(JSON.stringify(R.hexToRgb('#C8102E')), JSON.stringify([200, 16, 46]));
    t.equal(R.hexToRgb('red'), null);
  });

  process.exit(t.report());
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
