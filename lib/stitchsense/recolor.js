// lib/stitchsense/recolor.js - find the colours in flat artwork and swap them.
//
// Used by the Colorway view when the file dropped is a PNG, JPG, PDF or AI
// rather than a DST. Pure functions over raw RGBA pixels, no DOM, so the tests
// call them directly instead of grepping for their names.
//
// WHY THIS IS HARDER THAN THE DST PATH
// A DST arrives with its thread blocks already separated and no colours in it.
// Artwork is the opposite: every colour is baked in, and every edge between two
// colours is a soft ramp of in-between pixels (anti-aliasing), plus JPEG noise
// on top. A naive "swap every pixel that is exactly red" leaves a halo of the
// old colour around every shape. So the work is in three steps:
//
//   1. analyze()  find the handful of real colours. Edge pixels are many
//                 different shades but each one is rare, so they never win a
//                 spot on the palette. Only colours with real area do.
//   2.            for every pixel, record which two palette colours it sits
//                 between and how far along. A pure pixel is 0 of the way. An
//                 edge pixel halfway from red to white is 50%.
//   3. render()   repaint each pixel as the same blend of the NEW colours. The
//                 edge stays soft, and the halo never appears.
//
// BACKGROUND REMOVAL IS BY CONNECTION, NOT BY COLOUR
// Customer logos usually arrive on a white box. Knocking out "every white
// pixel" would also delete the white lettering inside a red badge. So only the
// background colour that is CONNECTED to the edge of the image is removed. An
// island of the same colour enclosed by the design stays.
//
// WHAT THIS IS NOT
// A separations tool. It flattens shading and gradients into the nearest flat
// colour, which is right for a logo and wrong for a photo. The view says so.
//
// ESM. Do NOT convert to module.exports.

export const MAX_COLORS = 12;
export const DEFAULT_COLORS = 8;
export const MIN_SHARE = 0.004;      // a colour under 0.4% of the art is noise
export const MAX_WORK_EDGE = 2400;   // longest side we process at

const ALPHA_SOLID = 128;             // at or above this, a pixel counts as art
const MERGE_DIST = 38;               // two palette colours closer than this are one colour
const BLEND_SLACK = 0.28;            // how far off the line between two colours a pixel may sit

/** Perceptual-ish RGB distance ("redmean"). Cheap and much closer to what an eye sees than plain RGB. */
export function colorDistance(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * How many distinct colours the artwork will actually print or sew with.
 *
 * Two swatches set to the same colour are one ink. A removed background is not
 * an ink, UNLESS the same colour also shows inside the design (white lettering
 * in a red badge): that white still gets printed, so it still counts.
 */
export function colorsInUse(analysis, targets, removeBg) {
  const skip = removeBg && analysis.bgIndex >= 0 && analysis.bgInsideShare < MIN_SHARE
    ? analysis.bgIndex : -1;
  const seen = new Set();
  targets.forEach((t, i) => { if (i !== skip) seen.add(String(t).toLowerCase()); });
  return seen.size;
}

/**
 * Find the palette.
 *
 * image: { width, height, data } where data is RGBA, 4 bytes per pixel.
 * Returns colours sorted by how much of the art they cover, biggest first.
 */
export function findPalette(image, opts = {}) {
  const want = Math.max(1, Math.min(MAX_COLORS, Math.round(opts.maxColors || DEFAULT_COLORS)));
  const { data } = image;

  // 1. Histogram at 5 bits per channel. 32,768 buckets holds every logo ever
  //    drawn and keeps the search below tiny no matter how big the image is.
  const count = new Uint32Array(32768);
  const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_SOLID) continue;
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    count[k]++; sr[k] += data[i]; sg[k] += data[i + 1]; sb[k] += data[i + 2];
    total++;
  }
  if (!total) return { palette: [], total: 0 };

  const buckets = [];
  for (let k = 0; k < 32768; k++) {
    if (count[k]) buckets.push({ n: count[k], rgb: [sr[k] / count[k], sg[k] / count[k], sb[k] / count[k]] });
  }
  buckets.sort((a, b) => b.n - a.n);

  // 2. Seed greedily: the most common colour, then the most common colour that
  //    is clearly different from everything already picked. Edge shades are
  //    individually rare, so they lose to real fills every time.
  const floor = total * MIN_SHARE;
  let centers = [];
  for (const b of buckets) {
    if (centers.length >= want) break;
    if (b.n < floor && centers.length) break;
    if (centers.every((c) => colorDistance(c, b.rgb) > MERGE_DIST)) centers.push(b.rgb.slice());
  }

  // 3. Refine. Each centre moves to the average of the buckets nearest to it,
  //    but a bucket sitting BETWEEN two centres (an edge blend) is left out, or
  //    it would drag both centres towards muddy midpoints.
  for (let iter = 0; iter < 6; iter++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const b of buckets) {
      let best = -1, bd = Infinity, second = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = colorDistance(centers[c], b.rgb);
        if (d < bd) { second = bd; bd = d; best = c; } else if (d < second) second = d;
      }
      if (centers.length > 1 && bd > 0.35 * second) continue;
      const a = acc[best];
      a[0] += b.rgb[0] * b.n; a[1] += b.rgb[1] * b.n; a[2] += b.rgb[2] * b.n; a[3] += b.n;
    }
    centers = centers.map((c, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : c));
  }

  // 4. Measure each colour's real share, merge near-duplicates, drop noise.
  const share = new Float64Array(centers.length);
  for (const b of buckets) share[nearest(centers, b.rgb)] += b.n;
  let palette = centers.map((rgb, i) => ({ rgb: rgb.map(Math.round), n: share[i] }));
  palette.sort((a, b) => b.n - a.n);
  const merged = [];
  for (const p of palette) {
    const twin = merged.find((m) => colorDistance(m.rgb, p.rgb) <= MERGE_DIST);
    if (twin) twin.n += p.n; else merged.push(p);
  }
  palette = merged.filter((p, i) => i === 0 || p.n >= floor)
    .map((p) => ({ rgb: p.rgb, share: p.n / total }));

  return { palette, total };
}

function nearest(centers, rgb) {
  let best = 0, bd = Infinity;
  for (let c = 0; c < centers.length; c++) {
    const d = colorDistance(centers[c], rgb);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/**
 * Work out, once, where every pixel sits relative to the palette, and which
 * pixels are background connected to the edge. render() then only has to mix.
 */
export function analyze(image, opts = {}) {
  const { width: w, height: h, data } = image;
  const { palette } = findPalette(image, opts);
  const n = w * h;
  const A = new Uint8Array(n), B = new Uint8Array(n), T = new Uint8Array(n);
  const P = palette.map((p) => p.rgb);
  const memo = new Map();

  for (let px = 0, i = 0; px < n; px++, i += 4) {
    if (data[i + 3] === 0 || !P.length) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = locate(P, [data[i], data[i + 1], data[i + 2]]);
      memo.set(key, hit);
    }
    A[px] = hit >> 16; B[px] = (hit >> 8) & 255; T[px] = hit & 255;
  }

  // Background: the palette colour covering most of the solid border pixels.
  // An already-transparent PNG has no background to remove.
  let bgIndex = -1;
  if (P.length > 1) {
    const votes = new Uint32Array(P.length);
    let edge = 0, solid = 0;
    const vote = (px) => {
      edge++;
      if (data[px * 4 + 3] < ALPHA_SOLID) return;
      solid++;
      if (T[px] < 64) votes[A[px]]++;
    };
    for (let x = 0; x < w; x++) { vote(x); vote((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { vote(y * w); vote(y * w + w - 1); }
    let top = 0;
    for (let c = 1; c < P.length; c++) if (votes[c] > votes[top]) top = c;
    if (solid > edge * 0.5 && votes[top] > solid * 0.6) bgIndex = top;
  }

  // Flood from the border through pure background pixels only. 1 = background,
  // 2 = a soft edge pixel touching the background, which fades out rather than
  // leaving a white fringe.
  const mask = new Uint8Array(n);
  if (bgIndex >= 0) {
    const isBg = (px) => data[px * 4 + 3] >= ALPHA_SOLID && A[px] === bgIndex && T[px] < 64;
    const stack = [];
    const seed = (px) => { if (!mask[px] && isBg(px)) { mask[px] = 1; stack.push(px); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const px = stack.pop();
      const x = px % w, y = (px - x) / w;
      if (x > 0) seed(px - 1);
      if (x < w - 1) seed(px + 1);
      if (y > 0) seed(px - w);
      if (y < h - 1) seed(px + w);
    }
    for (let px = 0; px < n; px++) {
      if (mask[px] || (A[px] !== bgIndex && B[px] !== bgIndex) || A[px] === B[px]) continue;
      const x = px % w, y = (px - x) / w;
      for (let dy = -1; dy <= 1 && mask[px] !== 2; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (mask[ny * w + nx] === 1) { mask[px] = 2; break; }
        }
      }
    }
  }

  // How much of the art is the background colour sitting INSIDE the design,
  // untouched by the flood. That is what keeps it counted as an ink.
  let inside = 0, solidTotal = 0;
  for (let px = 0; px < n; px++) {
    if (data[px * 4 + 3] < ALPHA_SOLID) continue;
    solidTotal++;
    if (bgIndex >= 0 && !mask[px] && A[px] === bgIndex && T[px] < 64) inside++;
  }
  const bgInsideShare = solidTotal ? inside / solidTotal : 0;

  return { width: w, height: h, palette, bgIndex, bgInsideShare, A, B, T, mask, alpha: alphaOf(data, n) };
}

function alphaOf(data, n) {
  const a = new Uint8Array(n);
  for (let px = 0; px < n; px++) a[px] = data[px * 4 + 3];
  return a;
}

/**
 * Nearest two palette colours and how far along the line between them this
 * pixel sits. Packed as (a << 16) | (b << 8) | t, where t is 0..255.
 * A pixel that is not on any line between two colours (a genuine third colour
 * too small to make the palette) snaps to the nearest one.
 */
function locate(P, p) {
  let a = 0, b = 0, da = Infinity, db = Infinity;
  for (let c = 0; c < P.length; c++) {
    const d = colorDistance(P[c], p);
    if (d < da) { db = da; b = a; da = d; a = c; } else if (d < db) { db = d; b = c; }
  }
  if (P.length < 2 || da < 6) return (a << 16) | (a << 8);
  const pa = P[a], pb = P[b];
  const v = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (!len2) return (a << 16) | (a << 8);
  let t = ((p[0] - pa[0]) * v[0] + (p[1] - pa[1]) * v[1] + (p[2] - pa[2]) * v[2]) / len2;
  t = Math.max(0, Math.min(1, t));
  const on = [pa[0] + v[0] * t, pa[1] + v[1] * t, pa[2] + v[2] * t];
  const off = Math.hypot(p[0] - on[0], p[1] - on[1], p[2] - on[2]);
  if (off > BLEND_SLACK * Math.sqrt(len2) + 10) return (a << 16) | (a << 8);
  return (a << 16) | (b << 8) | Math.round(t * 255);
}

/**
 * Repaint. targets is one [r,g,b] per palette colour. Returns fresh RGBA.
 * removeBg drops the connected background and fades the edges touching it.
 */
export function render(analysis, targets, opts = {}) {
  const { width: w, height: h, A, B, T, mask, alpha, bgIndex } = analysis;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const removeBg = !!opts.removeBg && bgIndex >= 0;
  for (let px = 0, i = 0; px < n; px++, i += 4) {
    let al = alpha[px];
    if (!al || !targets.length) continue;
    const ta = targets[A[px]] || targets[0];
    const tb = targets[B[px]] || ta;
    const t = T[px] / 255;
    if (removeBg && mask[px] === 1) continue;
    if (removeBg && mask[px] === 2) {
      // Keep the design colour, fade by how much of the pixel was background.
      const designIsA = A[px] !== bgIndex;
      const keep = designIsA ? ta : tb;
      const weight = designIsA ? 1 - t : t;
      out[i] = keep[0]; out[i + 1] = keep[1]; out[i + 2] = keep[2];
      out[i + 3] = al * weight;
      continue;
    }
    out[i] = ta[0] + (tb[0] - ta[0]) * t;
    out[i + 1] = ta[1] + (tb[1] - ta[1]) * t;
    out[i + 2] = ta[2] + (tb[2] - ta[2]) * t;
    out[i + 3] = al;
  }
  return out;
}
