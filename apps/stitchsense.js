/**
 * StitchSense — stitch count estimating for quoting embroidery.
 *
 * FOUR VIEWS
 *   estimate   the AM tool. Drop artwork, enter the finished size, get a
 *              stitch range to price against.
 *   library    every design we own, with its true count. Also where a design
 *              gets requoted at a new size, and where the archive gets
 *              imported from (admin only).
 *   guess      Stitch Guess, the training game for the embroidery team.
 *   accuracy   how the tool is actually doing on real jobs, plus the
 *              human-versus-model board.
 *
 * THREE INPUT PATHS, IN ORDER OF HOW MUCH THEY SHOULD BE TRUSTED
 *   1. We already have the DST         exact. No estimating at all.
 *   2. We have the design at another   rescale from the known count. Accurate,
 *      size                            because the artwork-reading step is
 *                                      skipped.
 *   3. Customer sent a PNG or JPG      estimate. This is the common case and
 *                                      the least accurate one, and the UI says
 *                                      so rather than printing four confident
 *                                      digits.
 *
 * WHY THE HEAVY LIFTING IS IN THE BROWSER
 * Decoding a DST and measuring ink coverage on an image both happen here, on
 * the client, not in a serverless function. Two reasons: a 500 KB artwork file
 * never has to be uploaded just to be measured, and the AM can SEE the magenta
 * overlay of exactly which pixels were counted as thread. An estimate you can
 * sanity check beats a better estimate you cannot.
 *
 * No fetch() here — everything goes through ctx.api and ENDPOINTS, per the seam
 * rule. No hex colors — tokens.css owns theming via data-app="stitchsense".
 */

import { ENDPOINTS } from '../js/api.js';
import {
  estimate as modelEstimate,
  rescale as modelRescale,
  confidence as modelConfidence,
  MODEL_VERSION
} from '../lib/stitchsense/model.js';
import { CHARACTERS, characterLabel } from '../lib/stitchsense/schema.js';

/* ------------------------------------------------------------------ *
 * SMALL HELPERS
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function pct(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '--';
  return (n * 100).toFixed(digits) + '%';
}

/**
 * Is this a colour the canvas will actually accept?
 *
 * Asked by setting it and seeing whether it took. An invalid strokeStyle is
 * silently IGNORED by canvas, leaving the previous colour in place, so a typo
 * would render as "the picker did nothing" rather than as an error.
 */
/* TOKEN-EXEMPT: canvas-rendered images. Two known-different colours used only
   as a probe; nothing is ever painted with them. They must be literal values,
   since the whole test is whether canvas CHANGED from a known starting point. */
const PROBE_COLORS = ['#000000', '#ffffff'];

function isColor(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const probe = document.createElement('canvas').getContext('2d');
  // Set twice from two different starting points. A value canvas rejects
  // leaves strokeStyle untouched, so it reads back as whichever probe colour
  // preceded it, and the two reads disagree. A value canvas accepts overwrites
  // both, and they agree.
  probe.strokeStyle = PROBE_COLORS[0];
  probe.strokeStyle = v;
  const first = probe.strokeStyle;
  probe.strokeStyle = PROBE_COLORS[1];
  probe.strokeStyle = v;
  return probe.strokeStyle === first;
}

/* TOKEN-EXEMPT: canvas-rendered images. The transparency checkerboard behind a
   colourway preview. Rendered as a data URI rather than themed, because it has
   to mean "nothing here" in both light and dark mode. */
const CHECKER = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'>" +
  "<rect width='16' height='16' fill='%23ffffff'/><rect width='8' height='8' fill='%23e6e6e6'/>" +
  "<rect x='8' y='8' width='8' height='8' fill='%23e6e6e6'/></svg>\")";

function inches(units10thMm) {
  // DST coordinates are tenths of a millimetre.
  return (units10thMm * 0.1) / 25.4;
}

/* ------------------------------------------------------------------ *
 * DST DECODING
 *
 * Tajima DST: a 512 byte header, then three byte records until 0xF3.
 * Coordinates are tenths of a millimetre, stored as a sum of bit-weighted
 * offsets across the three bytes. This is the same format archive-scanner.html
 * reads; it is decoded again here so the shell app does not depend on a local
 * HTML file that lives on one laptop.
 *
 * VERIFY THIS BEFORE TRUSTING A BULK IMPORT. The Library import view compares
 * every decoded count against stitch-archive.csv when that file is supplied,
 * and refuses to call the run clean if they disagree. A decoder that is subtly
 * wrong produces plausible looking numbers, which is the worst failure mode
 * available, so it gets checked against data we already have rather than
 * assumed correct.
 * ------------------------------------------------------------------ */

function decodeDst(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 515) return null;

  let x = 0, y = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  let stitches = 0, jumps = 0, colorChanges = 0;
  let totalLen = 0;
  // [x, y, penDown, block]. The block index is what makes recolouring possible:
  // a DST stores stitch coordinates and colour-CHANGE commands, but no colours
  // at all (those live in the .emb or a companion file Wilcom keeps). So the
  // file tells us where one thread stops and the next starts, and nothing about
  // what either of them looked like. That is why a colourway picker is easy
  // here: there is no baked-in colour to fight, only unnamed blocks.
  const path = [];
  let block = 0;
  let started = false;

  for (let i = 512; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    if (b2 === 0xF3) break;

    // AXIS ORDER. These two accumulators were the wrong way round in the first
    // version, which transposed every design: it rendered as if mirrored and
    // rotated a quarter turn, and reported width and height swapped.
    //
    // Checked against Wilcom's own preview bitmap, which OFM files carry
    // alongside the design. Measuring the ink in those previews gives width to
    // height ratios of 0.71, 2.83 and 3.17 for three sample designs; this
    // decoder now gives 0.71, 2.95 and 3.20 for the same three. It gave the
    // reciprocals before. That is the check, not an assumption about the spec.
    let dx = 0, dy = 0;
    if (b0 & 0x01) dx += 1;
    if (b0 & 0x02) dx -= 1;
    if (b0 & 0x04) dx += 9;
    if (b0 & 0x08) dx -= 9;
    if (b0 & 0x10) dy -= 9;
    if (b0 & 0x20) dy += 9;
    if (b0 & 0x40) dy -= 1;
    if (b0 & 0x80) dy += 1;

    if (b1 & 0x01) dx += 3;
    if (b1 & 0x02) dx -= 3;
    if (b1 & 0x04) dx += 27;
    if (b1 & 0x08) dx -= 27;
    if (b1 & 0x10) dy -= 27;
    if (b1 & 0x20) dy += 27;
    if (b1 & 0x40) dy -= 3;
    if (b1 & 0x80) dy += 3;

    if (b2 & 0x04) dx += 81;
    if (b2 & 0x08) dx -= 81;
    if (b2 & 0x10) dy -= 81;
    if (b2 & 0x20) dy += 81;

    // Record type. Colour change is checked BEFORE jump: a colour change
    // record also has the jump bit set, so testing jump first would classify
    // every colour change as a jump and undercount the colours.
    const isColorChange = (b2 & 0xC3) === 0xC3;
    const isJump = !isColorChange && (b2 & 0x83) === 0x83;

    x += dx;
    y += dy;

    if (!started) { minX = maxX = x; minY = maxY = y; started = true; }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    if (isColorChange) {
      colorChanges++;
      block++;
      path.push([x, y, false, block]);
    } else if (isJump) {
      jumps++;
      path.push([x, y, false, block]);
    } else {
      stitches++;
      totalLen += Math.sqrt(dx * dx + dy * dy);
      path.push([x, y, true, block]);
    }
  }

  if (!stitches) return null;

  return {
    stitches,
    jumps,
    // A colour change record sits BETWEEN colours, so n changes means n+1
    // colours. A single colour design has none.
    colors: colorChanges + 1,
    path,
    minX, maxX, minY, maxY,
    wIn: inches(maxX - minX),
    hIn: inches(maxY - minY),
    meanLenMm: (totalLen / stitches) * 0.1
  };
}

/**
 * Measure how much of the bounding box a stitch path actually covers.
 *
 * Walks the path onto a grid, stamping a thread-width band along each stitch
 * segment, then counts the filled cells. This is what makes coverage a useful
 * predictor: bounding box area alone spans a 6.7x range of densities across
 * our own jobs, while covered area cuts that to about 2.8x.
 */
function measureDstCoverage(design, threadWidthMm) {
  const GRID = 320;   // cells across the longer side
  const wUnits = Math.max(1, design.maxX - design.minX);
  const hUnits = Math.max(1, design.maxY - design.minY);
  const scale = GRID / Math.max(wUnits, hUnits);
  const gw = Math.max(1, Math.ceil(wUnits * scale));
  const gh = Math.max(1, Math.ceil(hUnits * scale));
  const grid = new Uint8Array(gw * gh);

  // Thread width in grid cells, at least one so a thin design is not measured
  // as covering nothing at all.
  const halfCells = Math.max(0, Math.round(((threadWidthMm * 10) * scale) / 2));

  let px = null, py = null;
  for (const [ux, uy, penDown] of design.path) {
    const cx = (ux - design.minX) * scale;
    const cy = (uy - design.minY) * scale;
    if (penDown && px != null) stampSegment(grid, gw, gh, px, py, cx, cy, halfCells);
    px = cx; py = cy;
  }

  let filled = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i]) filled++;

  const cellSqIn = (wUnits / gw) * (hUnits / gh) * (0.1 / 25.4) * (0.1 / 25.4);
  return {
    coveredSqIn: filled * cellSqIn,
    bboxSqIn: design.wIn * design.hIn,
    grid, gw, gh
  };
}

function stampSegment(grid, gw, gh, x0, y0, x1, y1, half) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const gx = Math.round(x0 + (x1 - x0) * t);
    const gy = Math.round(y0 + (y1 - y0) * t);
    for (let dy = -half; dy <= half; dy++) {
      const yy = gy + dy;
      if (yy < 0 || yy >= gh) continue;
      for (let dx = -half; dx <= half; dx++) {
        const xx = gx + dx;
        if (xx < 0 || xx >= gw) continue;
        grid[yy * gw + xx] = 1;
      }
    }
  }
}

/** Render a decoded design to a small PNG data URI for the library and game. */
// TOKEN-EXEMPT: canvas-rendered images. These paint into a <canvas>, not into
// CSS, so var(--token) resolves to nothing here. The thumbnail is also STORED
// and shown back to other people in the game, so it has to look the same for
// everyone rather than inheriting whatever theme it was generated under. Same
// exemption class as ShopStock's QR codes, declared in test/shell.test.cjs.
const CANVAS_INK = {
  paper: '#ffffff',
  thread: '#222222',
  // The shadow a stitch casts onto the fabric, drawn at low alpha.
  shadow: '#000000',
  // The coverage overlay magenta. Matches StitchSense's accent in tokens.css
  // on purpose: the AM sees the same colour on the artwork and in the app.
  overlay: [214, 31, 122]
};

/**
 * Default thread palette for a fresh colourway.
 *
 * TOKEN-EXEMPT: these are thread colours painted onto a canvas, not app chrome.
 * They have to survive being exported as a PNG and mailed to a customer, so
 * they cannot follow the person's theme. Deliberately spread across the wheel
 * rather than harmonised: the point of the first render is telling the blocks
 * apart, and the AM recolours from there.
 */
const DEFAULT_THREADS = [
  '#1B3A6B', '#C8102E', '#F2A900', '#0F7B4F',
  '#4B2E83', '#E36325', '#00A3AD', '#8C8279',
  '#111111', '#FFFFFF', '#7A1F3D', '#5B8F22'
];

/** How many separate thread blocks a decoded design actually has. */
function blockCount(design) {
  let max = 0;
  for (const pt of design.path) if (pt[3] > max) max = pt[3];
  return max + 1;
}

/**
 * Render a decoded design to a canvas.
 *
 * One function for every render in the app: the library thumbnail, the estimate
 * preview, and the colourway export. They differ only in options, so there is
 * no second renderer that can drift and make the exported PNG disagree with
 * what was on screen when the customer approved it.
 *
 * opts:
 *   size         longest edge in pixels
 *   colors       array of CSS colours, one per block; short arrays wrap
 *   garment      background colour, or null for transparent
 *   thickness    thread weight multiplier, 1 is normal
 */
function renderDesign(design, opts) {
  const o = opts || {};
  const size = o.size || 260;
  const pad = Math.max(8, Math.round(size * 0.04));

  const wUnits = Math.max(1, design.maxX - design.minX);
  const hUnits = Math.max(1, design.maxY - design.minY);
  const scale = (size - pad * 2) / Math.max(wUnits, hUnits);

  // Quarter turns, plus an optional mirror. Cap designs in particular get
  // digitised sideways as a matter of course, so a design arriving rotated is
  // normal rather than a fault in the file.
  const turns = ((Math.round((o.rotate || 0) / 90) % 4) + 4) % 4;
  const swap = turns === 1 || turns === 3;

  const drawW = Math.round(wUnits * scale);
  const drawH = Math.round(hUnits * scale);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, (swap ? drawH : drawW) + pad * 2);
  canvas.height = Math.max(1, (swap ? drawW : drawH) + pad * 2);
  const g = canvas.getContext('2d');

  // Left transparent when no garment colour is set, which is what makes the
  // export droppable onto a mockup.
  if (o.garment) {
    g.fillStyle = o.garment;
    g.fillRect(0, 0, canvas.width, canvas.height);
    // A perfectly flat fill reads as paper. A faint weave reads as cloth, and
    // it costs one tiled pattern. Skipped entirely when the export is
    // transparent, since there is no garment to texture.
    if (o.style === 'thread') paintWeave(g, canvas.width, canvas.height);
  }

  // Rotation and mirroring are applied as a canvas transform rather than by
  // rewriting every coordinate: one place to get right, and the stitch data
  // itself is never altered, so the exported PNG and the measurements still
  // describe the same design.
  g.save();
  g.translate(canvas.width / 2, canvas.height / 2);
  if (turns) g.rotate(turns * Math.PI / 2);
  if (o.mirror) g.scale(-1, 1);
  g.translate(-drawW / 2, -drawH / 2);

  g.lineWidth = Math.max(0.6, scale * 3 * (o.thickness || 1));
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const colors = (o.colors && o.colors.length) ? o.colors : [CANVAS_INK.thread];
  const total = blockCount(design);
  const width = Math.max(0.6, scale * 3 * (o.thickness || 1));

  // Project one path point into canvas space. DST measures Y upward from the
  // origin; a canvas measures it downward. Mapping straight across renders
  // every design vertically mirrored, which is subtle enough on a symmetrical
  // logo to survive review and obvious on anything with text or a figure in it.
  const pt = (ux, uy) => [(ux - design.minX) * scale, (design.maxY - uy) * scale];

  // CONNECTING STITCHES.
  //
  // A design is not one continuous line. The needle travels between elements,
  // and those travels are real stitches in the file that get trimmed on the
  // machine. Drawn, they are thin lines cutting across the middle of the logo,
  // which is the first thing a customer asks about.
  //
  // The file does not mark them, so they have to be identified by shape.
  //
  // LENGTH ALONE IS NOT ENOUGH, and this is worth stating because a fixed
  // 6 mm cut-off was tried first and gutted a design: wide satin columns are
  // legitimately long, and on a 4 inch wordmark 662 real stitches exceeded
  // 6 mm. Filtering on length alone hollowed out every letter.
  //
  // Two signals together:
  //
  //   1. Long RELATIVE TO THIS DESIGN. The threshold scales off the median
  //      stitch, so a dense fill and an open wordmark are judged on their own
  //      terms rather than against a number picked from one sample.
  //   2. ISOLATED. Satin stitches arrive in runs, so a long stitch sitting
  //      between two other long ones is fill. A connector is a single long
  //      stitch with short stitches either side of it.
  //
  // On the same wordmark that goes from 662 false positives to 26 real
  // connectors, while a dense logo is untouched.
  const lengths = [];
  {
    let prev = null;
    for (const [ux, uy, penDown] of design.path) {
      if (penDown && prev) lengths.push(Math.hypot(ux - prev[0], uy - prev[1]));
      else lengths.push(null);
      prev = [ux, uy];
    }
  }
  const realLengths = lengths.filter((v) => v != null).sort((a2, b2) => a2 - b2);
  const median = realLengths.length ? realLengths[Math.floor(realLengths.length / 2)] : 0;
  // 60 units is 6 mm, the floor for a sparse design where the median is tiny.
  const cutoff = Math.max(60, median * 2.5);

  const hide = new Array(lengths.length).fill(false);
  if (o.hideConnectors !== false) {
    const neighbour = (from, step) => {
      for (let i = from + step; i >= 0 && i < lengths.length; i += step) {
        if (lengths[i] != null) return lengths[i];
      }
      return null;
    };
    for (let i = 0; i < lengths.length; i++) {
      const v = lengths[i];
      if (v == null || v <= cutoff) continue;
      const before = neighbour(i, -1);
      const after = neighbour(i, 1);
      if ((before == null || before <= cutoff) && (after == null || after <= cutoff)) hide[i] = true;
    }
  }

  if (o.style === 'thread') {
    drawThreaded(g, design, { colors, total, width, pt, hide, drawW, drawH });
  } else {
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // One pass per block, in stitch order. Drawing block by block rather than
    // in one path is what makes overlaps land the way the machine will
    // actually sew them: a later colour covering an earlier one on screen
    // means it covers it on the garment too.
    for (let b = 0; b < total; b++) {
      g.strokeStyle = colors[b % colors.length];
      g.beginPath();
      let px = null;
      for (let i = 0; i < design.path.length; i++) {
        const [ux, uy, penDown, blk] = design.path[i];
        const [cx, cy] = pt(ux, uy);
        if (blk === b && penDown && px != null && !hide[i]) { g.moveTo(px[0], px[1]); g.lineTo(cx, cy); }
        px = [cx, cy];
      }
      g.stroke();
    }
  }

  g.restore();
  return canvas;
}

/* ------------------------------------------------------------------ *
 * THREAD RENDERING
 *
 * Flat mode draws one line per stitch and stops. That reads as a diagram.
 * Real thread reads as thread because of three things, and none of them need
 * a 3D engine:
 *
 *   1. Each stitch is a little cylinder, so it has a dark edge, a body, and a
 *      highlight running down its length.
 *   2. Stitches sit ON the fabric, so they cast a shadow onto it.
 *   3. Thread is not one flat colour. Neighbouring stitches catch the light
 *      differently and the eye reads that variation as texture.
 *
 * So each stitch is drawn as four short strokes: a shadow offset down-right, a
 * dark full-width base, the body slightly narrower, and a thin highlight offset
 * along the light direction. Cheap, and no gradients, which matters because a
 * full-back design is ten thousand stitches and a gradient object per stitch
 * would take minutes.
 *
 * THIS IS STILL NOT A WILCOM PROOF. Real thread has fibre, sheen that shifts
 * with the viewing angle, and satin columns that catch light as one surface
 * rather than as separate stitches. This gets close enough for a customer to
 * picture the finished garment, and no closer.
 * ------------------------------------------------------------------ */

/**
 * A faint fabric weave, drawn over the garment fill.
 *
 * Deliberately almost invisible. Anything stronger competes with the design,
 * and the job here is only to stop the background reading as paper.
 */
function paintWeave(g, w, h) {
  // A 4 pixel checker at 5 % reads as a visible diagonal pattern, which is
  // worse than a flat fill: it looks like a rendering artefact rather than
  // cloth. Two pixel threads at a third of that opacity sit below the
  // threshold where the eye resolves the pattern and above the one where it
  // stops reading as texture.
  const tile = document.createElement('canvas');
  tile.width = tile.height = 2;
  const t = tile.getContext('2d');
  t.fillStyle = 'rgba(255,255,255,0.018)';  // TOKEN-EXEMPT: canvas-rendered images
  t.fillRect(0, 0, 1, 2);
  t.fillStyle = 'rgba(0,0,0,0.018)';        // TOKEN-EXEMPT: canvas-rendered images
  t.fillRect(1, 0, 1, 2);
  const pattern = g.createPattern(tile, 'repeat');
  if (!pattern) return;
  g.save();
  g.fillStyle = pattern;
  g.fillRect(0, 0, w, h);
  g.restore();
}

/** Shift a colour toward white (positive) or black (negative). */
function shade(hex, amount) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const parts = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  });
  return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
}

function drawThreaded(g, design, ctx) {
  const { colors, total, width, pt, hide } = ctx;

  // Light from the upper left, which is what every rendering convention
  // assumes and therefore what looks "right" without anyone thinking about it.
  const lx = -0.45, ly = -0.45;
  const shadowOffset = Math.max(0.5, width * 0.35);

  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (let b = 0; b < total; b++) {
    const base = colors[b % colors.length];
    const dark = shade(base, -0.45);
    const body = base;
    const light = shade(base, 0.42);

    // Collect this block's stitches once rather than re-walking the path four
    // times per block.
    const segs = [];
    let px = null;
    for (let i = 0; i < design.path.length; i++) {
      const [ux, uy, penDown, blk] = design.path[i];
      const c = pt(ux, uy);
      if (blk === b && penDown && px != null && !hide[i]) segs.push([px[0], px[1], c[0], c[1]]);
      px = c;
    }
    if (!segs.length) continue;

    // Pass 1: the shadow the thread casts onto the fabric.
    g.globalAlpha = 0.22;
    g.strokeStyle = CANVAS_INK.shadow;
    g.lineWidth = width * 1.05;
    g.beginPath();
    for (const [x0, y0, x1, y1] of segs) {
      g.moveTo(x0 + shadowOffset, y0 + shadowOffset);
      g.lineTo(x1 + shadowOffset, y1 + shadowOffset);
    }
    g.stroke();
    g.globalAlpha = 1;

    // Pass 2: the dark outer edge of the thread cylinder.
    g.strokeStyle = dark;
    g.lineWidth = width;
    g.beginPath();
    for (const [x0, y0, x1, y1] of segs) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
    g.stroke();

    // Pass 3: the body, narrower so the dark edge survives on both sides.
    g.strokeStyle = body;
    g.lineWidth = width * 0.72;
    g.beginPath();
    for (const [x0, y0, x1, y1] of segs) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
    g.stroke();

    // Pass 4: the highlight running down the length of each stitch.
    //
    // Offset PERPENDICULAR to the stitch, not along a fixed light vector. A
    // fixed offset displaces a stitch lying parallel to the light by almost
    // nothing, so half the design ends up with no highlight at all and the
    // fills look flat while the outlines look round. Perpendicular offset,
    // signed by which way the stitch faces, gives every stitch a highlight on
    // its lit side regardless of the direction it was sewn.
    g.strokeStyle = light;
    g.lineWidth = Math.max(0.5, width * 0.34);
    for (let i = 0; i < segs.length; i++) {
      const [x0, y0, x1, y1] = segs[i];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      // Unit perpendicular, flipped so it always points toward the light.
      let nx = -dy / len;
      let ny = dx / len;
      if (nx * lx + ny * ly < 0) { nx = -nx; ny = -ny; }

      // Deterministic jitter, so the same design renders identically every
      // time. A customer comparing yesterday's proof to today's should not see
      // the sheen move. The variation is what reads as texture: a perfectly
      // even highlight looks like plastic piping, not thread.
      const j = ((i * 2654435761) % 1000) / 1000;
      g.globalAlpha = 0.45 + j * 0.4;

      const off = width * 0.2;
      g.beginPath();
      g.moveTo(x0 + nx * off, y0 + ny * off);
      g.lineTo(x1 + nx * off, y1 + ny * off);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}

/**
 * Small library thumbnail. JPEG rather than PNG: a stitch render is thousands
 * of short strokes, which PNG compresses badly, and one design record has to
 * fit comfortably in KV.
 */
function renderDstThumb(design, size = 260) {
  const canvas = renderDesign(design, {
    size,
    garment: CANVAS_INK.paper,
    colors: [CANVAS_INK.thread]
  });
  return canvas.toDataURL('image/jpeg', 0.72);
}

/* ------------------------------------------------------------------ *
 * IMAGE COVERAGE
 *
 * The common case: a customer sends a PNG or a JPEG. There is no stitch path
 * to walk, so coverage means "how much of this picture is artwork rather than
 * background".
 *
 * Transparent PNGs are read from the alpha channel, which is exact. Everything
 * else is thresholded against the background colour sampled from the corners,
 * which is a guess, and a logo photographed on a grey desk will defeat it.
 * That is why the overlay is shown: the AM can see when it has gone wrong.
 * ------------------------------------------------------------------ */

function measureImageCoverage(img, opts) {
  const MAXDIM = 700;
  const scale = Math.min(1, MAXDIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;

  // Is there real transparency to work with?
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 32) transparent++;
  const useAlpha = transparent > (w * h) * 0.02;

  // Background colour, sampled from the four corners. If a logo genuinely
  // reaches all four corners this will be wrong, which is exactly the case the
  // overlay makes visible.
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let br = 0, bg = 0, bb = 0;
  for (const [cx, cy] of corners) {
    const i = (cy * w + cx) * 4;
    br += data[i]; bg += data[i + 1]; bb += data[i + 2];
  }
  br /= 4; bg /= 4; bb /= 4;

  const tol = opts && opts.tolerance != null ? opts.tolerance : 60;
  const mask = new Uint8Array(w * h);
  let ink = 0;
  let minX = w, maxX = -1, minY = h, maxY = -1;

  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    let isInk;
    if (useAlpha) {
      isInk = data[i + 3] > 128;
    } else {
      const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb);
      isInk = d > tol;
    }
    if (isInk) {
      mask[p] = 1;
      ink++;
      const px = p % w, py = (p / w) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }

  if (maxX < 0) return null;   // nothing found

  return {
    mask, w, h, ink,
    // Fraction of the ARTWORK's own bounding box that is ink, not of the
    // whole image. A logo with a lot of white space around it in the file
    // would otherwise report a misleadingly low fill.
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    inkFractionOfBox: ink / ((maxX - minX + 1) * (maxY - minY + 1)),
    useAlpha
  };
}

/** Paint the measured pixels in accent magenta so the AM can check the read. */
function paintOverlay(canvas, img, measured) {
  const { mask, w, h } = measured;
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const layer = g.getImageData(0, 0, w, h);
  const d = layer.data;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    d[i] = Math.round(d[i] * 0.25 + CANVAS_INK.overlay[0] * 0.75);
    d[i + 1] = Math.round(d[i + 1] * 0.25 + CANVAS_INK.overlay[1] * 0.75);
    d[i + 2] = Math.round(d[i + 2] * 0.25 + CANVAS_INK.overlay[2] * 0.75);
    d[i + 3] = 255;
  }
  g.putImageData(layer, 0, 0);
}

/* ------------------------------------------------------------------ *
 * PLACEMENT PRESETS
 *
 * Standard finished sizes, so an AM quoting a left chest does not have to
 * remember that it is about 3.5 inches wide. Picking one fills the size boxes;
 * they stay editable, because a customer who wants a 4 inch left chest is not
 * a data entry error.
 * ------------------------------------------------------------------ */

const PLACEMENTS = [
  { key: 'left_chest', label: 'Left chest', w: 3.5, h: 2 },
  { key: 'full_front', label: 'Full front', w: 10, h: 8 },
  { key: 'full_back', label: 'Full back', w: 11, h: 9 },
  { key: 'cap_front', label: 'Cap front', w: 4.5, h: 2.25 },
  { key: 'cap_back', label: 'Cap back', w: 3.5, h: 1 },
  { key: 'sleeve', label: 'Sleeve', w: 3, h: 2 },
  { key: 'beanie', label: 'Beanie', w: 3.5, h: 1.75 },
  { key: 'bag', label: 'Bag panel', w: 6, h: 4 },
  { key: 'custom', label: 'Custom', w: null, h: null }
];

/* ------------------------------------------------------------------ *
 * THE APP
 * ------------------------------------------------------------------ */

export default {
  id: 'stitchsense',

  styles: `
    .ss-page { padding: 24px 32px 60px; max-width: 1180px; }
    .ss-hd { margin-bottom: 20px; }
    .ss-hd h1 { font-size: 28px; font-weight: 800; letter-spacing: -.02em; }
    .ss-hd .sub { font-size: 13px; color: var(--muted); margin-top: 3px; max-width: 720px; line-height: 1.5; }

    .ss-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 18px 20px; margin-bottom: 16px; }
    .ss-card h2 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
    .ss-card h3 { font-size: 13px; font-weight: 700; margin: 16px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }

    .ss-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
    @media (max-width: 900px) { .ss-cols { grid-template-columns: 1fr; } }

    .ss-drop {
      border: 2px dashed var(--line); border-radius: var(--radius-md);
      padding: 30px 20px; text-align: center; cursor: pointer; transition: .12s;
      background: var(--bg);
    }
    .ss-drop:hover, .ss-drop.over { border-color: var(--accent); background: var(--accent-tint); }
    .ss-drop .big { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
    .ss-drop .small { font-size: 12.5px; color: var(--muted); line-height: 1.5; }

    .ss-preview { position: relative; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px; text-align: center; }
    .ss-preview canvas, .ss-preview img { max-width: 100%; max-height: 300px; border-radius: 4px; }
    .ss-overlay-note { font-size: 11.5px; color: var(--muted); margin-top: 8px; line-height: 1.5; }

    .ss-field { margin-bottom: 12px; }
    .ss-field label { display: block; font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 4px; }
    .ss-field input, .ss-field select, .ss-field textarea {
      width: 100%; padding: 8px 10px; font-size: 14px; font-family: inherit;
      border: 1px solid var(--line); border-radius: var(--radius-sm);
      background: var(--card); color: var(--ink);
    }
    .ss-field input:focus, .ss-field select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .ss-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

    .ss-btn {
      background: var(--accent); color: var(--on-accent); border: none;
      border-radius: var(--radius-sm); padding: 9px 16px; font-size: 13.5px;
      font-weight: 700; cursor: pointer; font-family: inherit;
    }
    .ss-btn:disabled { opacity: .45; cursor: default; }
    .ss-btn.ghost { background: var(--card); color: var(--muted); border: 1px solid var(--line); }
    .ss-btn.ghost:hover { color: var(--ink); }
    .ss-btnrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

    .ss-result { text-align: center; padding: 6px 0 2px; }
    .ss-result .quote { font-size: 44px; font-weight: 800; letter-spacing: -.03em; color: var(--accent-deep); line-height: 1.05; }
    .ss-result .quote-lbl { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-top: 2px; }
    .ss-band { display: flex; justify-content: center; gap: 24px; margin-top: 16px; }
    .ss-band .b .v { font-size: 20px; font-weight: 700; }
    .ss-band .b .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }

    .ss-flag { border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12.5px; line-height: 1.55; margin-top: 14px; }
    .ss-flag.good { background: var(--accent-tint); color: var(--accent-deep); }
    .ss-flag.fair { background: var(--warn-tint, var(--bg)); color: var(--ink); border: 1px solid var(--line); }
    .ss-flag.poor { background: var(--bg); color: var(--ink); border: 1px solid var(--danger); }
    .ss-flag ul { margin: 6px 0 0; padding-left: 18px; }
    .ss-flag li { margin-bottom: 3px; }

    .ss-exact { background: var(--accent-tint); border-radius: var(--radius-sm); padding: 12px 14px; font-size: 13px; color: var(--accent-deep); line-height: 1.5; margin-bottom: 14px; }

    .ss-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .ss-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line); }
    .ss-table td { padding: 8px; border-bottom: 1px solid var(--line); }
    .ss-table tr:hover td { background: var(--bg); }
    .ss-table .num { text-align: right; font-variant-numeric: tabular-nums; }

    .ss-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
    .ss-tile { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px; cursor: pointer; text-align: center; }
    .ss-tile:hover { border-color: var(--accent); }
    .ss-tile img { width: 100%; height: 110px; object-fit: contain; background: var(--bg); border-radius: 3px; }
    .ss-tile .n { font-size: 11.5px; font-weight: 600; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ss-tile .s { font-size: 11px; color: var(--muted); }

    .ss-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .ss-kpi { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px 16px; }
    .ss-kpi .lbl { font-size: 11px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .ss-kpi .val { font-size: 26px; font-weight: 800; margin-top: 3px; }
    .ss-kpi .sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }

    /* ---- the game ---- */
    .ss-game { max-width: 620px; margin: 0 auto; }
    .ss-gamefig { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 16px; text-align: center; margin-bottom: 14px; }
    .ss-gamefig img { max-width: 100%; max-height: 300px; }
    .ss-gamefig .dims { font-size: 12.5px; color: var(--muted); margin-top: 10px; }
    .ss-guessrow { display: flex; gap: 8px; align-items: flex-end; }
    .ss-guessrow .ss-field { flex: 1; margin-bottom: 0; }
    .ss-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .ss-chip {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-pill);
      padding: 5px 11px; font-size: 12px; font-weight: 600; color: var(--muted);
      cursor: pointer; font-family: inherit;
    }
    .ss-chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .ss-reveal { text-align: center; padding: 14px 0; }
    .ss-reveal .verdict { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
    .ss-reveal .truth { font-size: 36px; font-weight: 800; letter-spacing: -.02em; }
    .ss-reveal .vs { font-size: 13px; color: var(--muted); margin-top: 10px; line-height: 1.6; }
    .ss-score { display: flex; justify-content: center; gap: 20px; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
    .ss-score b { color: var(--ink); font-size: 15px; }

    .ss-check { display: flex; align-items: center; gap: 7px; font-size: 13px; margin-bottom: 6px; cursor: pointer; }
    .ss-check input { width: 15px; height: 15px; accent-color: var(--accent); }

    .ss-muted { color: var(--muted); font-size: 12.5px; line-height: 1.6; }
    .ss-empty { text-align: center; color: var(--muted); font-size: 13px; padding: 30px 10px; line-height: 1.6; }
    .ss-err { color: var(--danger); font-size: 12.5px; margin-top: 8px; }
    .ss-ok { color: var(--accent-deep); font-size: 12.5px; margin-top: 8px; }
    .ss-progress { font-size: 12.5px; color: var(--muted); margin-top: 8px; }
    .ss-hidden { display: none; }
  `,

  template: `
    <div class="ss-page">
      <div id="ssEstimate"></div>
      <div id="ssLibrary" class="ss-hidden"></div>
      <div id="ssColorway" class="ss-hidden"></div>
      <div id="ssGuess" class="ss-hidden"></div>
      <div id="ssAccuracy" class="ss-hidden"></div>
    </div>
  `,

  async mount(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;
    this.isAdmin = !!(ctx.perms && (ctx.perms.data_scope === 'all' || ctx.perms.superuser));

    // Calibration factors. If the settings route is unreachable the app still
    // works at 1.0 rather than refusing to open, because an uncalibrated
    // estimate is more useful than a blank screen.
    this.settings = { dstCoverageScale: 1, imageCoverageScale: 1, threadWidthMm: 0.4 };
    try {
      const s = await ctx.api.get(ENDPOINTS.ssenseSettings);
      if (s && s.settings) this.settings = { ...this.settings, ...s.settings };
    } catch (e) { /* defaults stand */ }

    this.state = {
      measured: null,      // current artwork measurement
      decoded: null,       // current DST decode, if any
      lastEstimate: null,
      designs: [],
      seenDesignIds: [],
      currentDesign: null,
      cwDesign: null,        // decoded design loaded in the colourway view
      cwColors: [],
      cwGarment: '#F2F2F2',  // TOKEN-EXEMPT: canvas paint, not app chrome
      cwRotate: 0,
      cwStyle: 'thread',
      cwHideConnectors: true,
      cwMirror: false,
            session: { rounds: 0, points: 0, beats: 0 }
    };

    this.renderEstimate();
    this.showView(ctx.view || 'estimate');
  },

  showView(view) {
    const map = {
      estimate: 'ssEstimate',
      library: 'ssLibrary',
      colorway: 'ssColorway',
      guess: 'ssGuess',
      accuracy: 'ssAccuracy'
    };
    for (const [key, id] of Object.entries(map)) {
      const el = this.root.querySelector('#' + id);
      if (el) el.classList.toggle('ss-hidden', key !== view);
    }
    if (view === 'library') this.renderLibrary();
    // Re-rendered only when there is nothing loaded, so switching tabs does not
    // throw away a colourway somebody is part way through picking.
    if (view === 'colorway' && !this.state.cwDesign) this.renderColorway();
    if (view === 'guess') this.renderGuess();
    if (view === 'accuracy') this.renderAccuracy();
  },

  /* ================================================================ *
   * VIEW: ESTIMATE
   * ================================================================ */

  renderEstimate() {
    const el = this.root.querySelector('#ssEstimate');
    el.innerHTML = `
      <div class="ss-hd">
        <h1>Estimate</h1>
        <div class="sub">
          Drop the customer's artwork, set the finished size, and get a stitch range to price
          against. If we already have the DST, drop that instead and you get the exact count
          with no estimating at all.
        </div>
      </div>

      <div class="ss-cols">
        <div>
          <div class="ss-card">
            <div class="ss-drop" id="ssDrop">
              <div class="big">Drop artwork or a DST here</div>
              <div class="small">PNG, JPG, GIF, WEBP or SVG for an estimate.<br>DST for an exact count.</div>
            </div>
            <input type="file" id="ssFile" accept=".dst,image/*" style="display:none">

            <div id="ssPreviewWrap" class="ss-hidden" style="margin-top:14px">
              <div class="ss-preview">
                <canvas id="ssCanvas"></canvas>
                <div class="ss-overlay-note" id="ssOverlayNote"></div>
              </div>
            </div>
          </div>

          <div class="ss-card">
            <h2>Finished size</h2>
            <div class="ss-field">
              <label for="ssPlacement">Placement</label>
              <select id="ssPlacement">
                ${PLACEMENTS.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join('')}
              </select>
            </div>
            <div class="ss-pair">
              <div class="ss-field">
                <label for="ssW">Width (inches)</label>
                <input type="number" id="ssW" step="0.05" min="0.2" max="20" value="3.5">
              </div>
              <div class="ss-field">
                <label for="ssH">Height (inches)</label>
                <input type="number" id="ssH" step="0.05" min="0.2" max="20" value="2">
              </div>
            </div>
            <div class="ss-field">
              <label for="ssColors">Thread colours</label>
              <input type="number" id="ssColors" step="1" min="1" max="30" value="2">
            </div>
            <div class="ss-btnrow">
              <button class="ss-btn" id="ssRun" disabled>Estimate</button>
              <button class="ss-btn ghost" id="ssReset">Start over</button>
            </div>
            <div class="ss-err ss-hidden" id="ssErr"></div>
          </div>
        </div>

        <div>
          <div class="ss-card" id="ssResultCard">
            <div class="ss-empty">
              Nothing measured yet. Drop artwork on the left and press Estimate.
            </div>
          </div>
        </div>
      </div>
    `;

    this.wireEstimate();
  },

  wireEstimate() {
    const root = this.root;
    const drop = root.querySelector('#ssDrop');
    const file = root.querySelector('#ssFile');

    drop.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.takeFile(f);
    });
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) this.takeFile(file.files[0]);
    });

    root.querySelector('#ssPlacement').addEventListener('change', (e) => {
      const p = PLACEMENTS.find((x) => x.key === e.target.value);
      if (p && p.w) {
        root.querySelector('#ssW').value = p.w;
        root.querySelector('#ssH').value = p.h;
      }
    });

    root.querySelector('#ssRun').addEventListener('click', () => this.runEstimate());
    root.querySelector('#ssReset').addEventListener('click', () => this.renderEstimate());
  },

  showEstimateError(msg) {
    const el = this.root.querySelector('#ssErr');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('ss-hidden', !msg);
  },

  async takeFile(f) {
    this.showEstimateError('');
    const isDst = /\.dst$/i.test(f.name);
    try {
      if (isDst) await this.takeDst(f);
      else await this.takeImage(f);
      this.root.querySelector('#ssRun').disabled = false;
    } catch (err) {
      this.showEstimateError(String((err && err.message) || err));
    }
  },

  async takeDst(f) {
    const buf = await f.arrayBuffer();
    const decoded = decodeDst(buf);
    if (!decoded) throw new Error('That DST could not be decoded. Check it is a Tajima DST and not a renamed file.');

    this.state.decoded = decoded;
    this.state.measured = null;
    this.state.fileName = f.name;

    // Fill the size boxes from the file, because the file knows better than
    // anybody typing.
    this.root.querySelector('#ssW').value = decoded.wIn.toFixed(2);
    this.root.querySelector('#ssH').value = decoded.hIn.toFixed(2);
    this.root.querySelector('#ssColors').value = decoded.colors;

    const wrap = this.root.querySelector('#ssPreviewWrap');
    wrap.classList.remove('ss-hidden');
    const canvas = this.root.querySelector('#ssCanvas');
    const thumb = renderDstThumb(decoded, 420);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = thumb;

    this.root.querySelector('#ssOverlayNote').textContent =
      `${fmt(decoded.stitches)} stitches, ${decoded.colors} colour${decoded.colors === 1 ? '' : 's'}, ` +
      `${decoded.wIn.toFixed(2)} by ${decoded.hIn.toFixed(2)} inches. Read directly from the file.`;
  },

  async takeImage(f) {
    const url = URL.createObjectURL(f);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file could not be opened as an image.'));
      i.src = url;
    });

    const measured = measureImageCoverage(img);
    if (!measured) throw new Error('No artwork found in that image. It may be blank, or the background may fill the whole frame.');

    this.state.measured = measured;
    this.state.decoded = null;
    this.state.fileName = f.name;
    this.state.image = img;

    const wrap = this.root.querySelector('#ssPreviewWrap');
    wrap.classList.remove('ss-hidden');
    paintOverlay(this.root.querySelector('#ssCanvas'), img, measured);

    this.root.querySelector('#ssOverlayNote').innerHTML =
      `Magenta is what was counted as thread. If it has caught the background, or missed part of the ` +
      `logo, the estimate will be off and you should not trust it.<br>` +
      `Read from the ${measured.useAlpha ? 'transparency channel, which is exact' : 'background colour, which is a guess'}. ` +
      `Artwork fills ${pct(measured.inkFractionOfBox, 1)} of its own bounding box.`;
  },

  runEstimate() {
    this.showEstimateError('');
    const root = this.root;
    const w = Number(root.querySelector('#ssW').value);
    const h = Number(root.querySelector('#ssH').value);
    const colors = Math.max(1, Math.round(Number(root.querySelector('#ssColors').value) || 1));
    const placement = root.querySelector('#ssPlacement').value;

    if (!(w > 0) || !(h > 0)) return this.showEstimateError('Enter a finished width and height.');

    const card = root.querySelector('#ssResultCard');

    // PATH 1: we have the DST. No estimating.
    if (this.state.decoded) {
      const d = this.state.decoded;
      const sameSize = Math.abs(d.wIn - w) < 0.05 && Math.abs(d.hIn - h) < 0.05;

      if (sameSize) {
        card.innerHTML = `
          <div class="ss-exact">
            This is a digitised file, so there is nothing to estimate. The count below is read
            straight out of the stitch path.
          </div>
          <div class="ss-result">
            <div class="quote">${fmt(d.stitches)}</div>
            <div class="quote-lbl">stitches, exact</div>
          </div>
          <div class="ss-muted" style="margin-top:14px">
            ${d.colors} colour${d.colors === 1 ? '' : 's'}, ${fmt(d.jumps)} jumps,
            ${d.wIn.toFixed(2)} by ${d.hIn.toFixed(2)} inches,
            average stitch length ${d.meanLenMm.toFixed(2)} mm.
          </div>
        `;
        this.state.lastEstimate = null;
        return;
      }

      // Different size requested: rescale from the known count, which is the
      // accurate path, not re-measure the artwork.
      const out = modelRescale({
        knownStitches: d.stitches, oldW: d.wIn, oldH: d.hIn, newW: w, newH: h
      });
      card.innerHTML = `
        <div class="ss-exact">
          Rescaled from the real count in the file (${fmt(d.stitches)} stitches at
          ${d.wIn.toFixed(2)} by ${d.hIn.toFixed(2)} inches). This is the accurate path:
          we are not re-reading artwork, only allowing for the resize.
        </div>
        ${this.resultBlock(out, { level: 'good', reasons: [] })}
      `;
      this.state.lastEstimate = {
        source: 'rescale', w, h, colors, placement,
        coveredSqIn: 0, fill: null,
        low: out.low, likely: out.likely, worst: out.worst,
        designName: this.state.fileName || ''
      };
      this.wireSave();
      return;
    }

    // PATH 3: customer artwork.
    const m = this.state.measured;
    if (!m) return this.showEstimateError('Drop artwork first.');

    // The measured mask is in pixels. Scale it onto the finished size the AM
    // typed, using the ARTWORK's bounding box rather than the whole image, so
    // padding in the file does not shrink the estimate.
    const boxPixels = m.box.w * m.box.h;
    const inkFraction = m.ink / boxPixels;
    const coveredSqIn = inkFraction * (w * h) * (this.settings.imageCoverageScale || 1);

    const out = modelEstimate({ coveredSqIn, colors });
    const conf = modelConfidence({
      coveredSqIn, fill: inkFraction, colors,
      placement: PLACEMENTS.find((p) => p.key === placement) ? placement : ''
    });

    card.innerHTML = this.resultBlock(out, conf, { coveredSqIn, inkFraction });
    this.state.lastEstimate = {
      source: 'image', w, h, colors, placement,
      coveredSqIn, fill: inkFraction,
      low: out.low, likely: out.likely, worst: out.worst,
      designName: this.state.fileName || ''
    };
    this.wireSave();
  },

  resultBlock(out, conf, extra) {
    const flagText = conf.reasons.length
      ? `<div class="ss-flag ${conf.level}">
           <b>Read this before you quote.</b>
           <ul>${conf.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
         </div>`
      : `<div class="ss-flag good">Nothing unusual about this design. The estimate is as good as this tool gets.</div>`;

    const measuredNote = extra
      ? `<div class="ss-muted" style="margin-top:12px">
           Measured ${extra.coveredSqIn.toFixed(2)} square inches of thread coverage,
           ${pct(extra.inkFraction, 1)} of the finished area.
         </div>`
      : '';

    return `
      <div class="ss-result">
        <div class="quote">${fmt(out.low)}</div>
        <div class="quote-lbl">quote against this</div>
      </div>
      <div class="ss-band">
        <div class="b"><div class="v">${fmt(out.likely)}</div><div class="l">likely</div></div>
        <div class="b"><div class="v">${fmt(out.worst)}</div><div class="l">worst case</div></div>
      </div>
      ${measuredNote}
      ${flagText}
      <div class="ss-muted" style="margin-top:12px">
        Quote low, on purpose. The design lands under the quoting figure about one time in five,
        and over the worst case about one time in twenty. On a big run, price the worst case.
      </div>
      <div class="ss-card" style="margin-top:16px;background:var(--bg)">
        <h3>Log this estimate</h3>
        <div class="ss-muted" style="margin-bottom:10px">
          Worth thirty seconds. The model was fitted on our finished DST files, never on customer
          artwork, so logged jobs are the only thing that can tell us how well this really works.
        </div>
        <div class="ss-pair">
          <div class="ss-field"><label for="ssCustomer">Customer</label><input id="ssCustomer" type="text" placeholder="optional"></div>
          <div class="ss-field"><label for="ssJob">Job number</label><input id="ssJob" type="text" placeholder="optional"></div>
        </div>
        <div class="ss-btnrow">
          <button class="ss-btn" id="ssSave">Save to the log</button>
        </div>
        <div id="ssSaveMsg"></div>
      </div>
    `;
  },

  wireSave() {
    const btn = this.root.querySelector('#ssSave');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const est = this.state.lastEstimate;
      if (!est) return;
      const msg = this.root.querySelector('#ssSaveMsg');
      btn.disabled = true;
      try {
        const payload = {
          ...est,
          customer: (this.root.querySelector('#ssCustomer') || {}).value || '',
          jobNumber: (this.root.querySelector('#ssJob') || {}).value || '',
          modelVersion: MODEL_VERSION
        };
        const res = await this.ctx.api.post(ENDPOINTS.ssenseEstimates, payload);
        msg.innerHTML = `<div class="ss-ok">Saved as ${esc(res.estimate.id)}. When the design is digitised, open Accuracy and fill in the real count.</div>`;
      } catch (err) {
        btn.disabled = false;
        msg.innerHTML = `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
      }
    });
  },

  /* ================================================================ *
   * VIEW: LIBRARY
   * ================================================================ */

  async renderLibrary() {
    const el = this.root.querySelector('#ssLibrary');
    el.innerHTML = `
      <div class="ss-hd">
        <h1>Library</h1>
        <div class="sub">
          Every design we have imported, with the true stitch count from its DST. Search for a
          design here before estimating one: requoting a design we already own at a new size is
          far more accurate than reading a picture.
        </div>
      </div>
      <div class="ss-card">
        <div class="ss-field">
          <input type="search" id="ssSearch" placeholder="Search by name, job number or folder">
        </div>
        <div id="ssLibList"><div class="ss-empty">Loading the library...</div></div>
      </div>
      ${this.isAdmin ? this.importPanel() : ''}
    `;

    if (this.isAdmin) this.wireImport();

    try {
      const res = await this.ctx.api.get(ENDPOINTS.ssenseDesigns);
      this.state.designs = (res && res.designs) || [];
    } catch (err) {
      this.root.querySelector('#ssLibList').innerHTML =
        `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
      return;
    }

    const search = this.root.querySelector('#ssSearch');
    const draw = () => this.drawLibraryList(String(search.value || '').toLowerCase());
    search.addEventListener('input', draw);
    draw();
  },

  drawLibraryList(q) {
    const el = this.root.querySelector('#ssLibList');
    if (!el) return;
    const all = this.state.designs;

    if (!all.length) {
      el.innerHTML = `<div class="ss-empty">
        No designs imported yet.${this.isAdmin ? ' Use the import panel below to read your DST archive.' : ' Ask Ryan to run the archive import.'}
      </div>`;
      return;
    }

    const hits = (q
      ? all.filter((d) =>
          String(d.name).toLowerCase().includes(q) ||
          String(d.jobNumber).toLowerCase().includes(q) ||
          String(d.folder).toLowerCase().includes(q))
      : all
    ).slice(0, 200);

    el.innerHTML = `
      <div class="ss-muted" style="margin-bottom:10px">
        ${fmt(all.length)} design${all.length === 1 ? '' : 's'} in the library, showing ${fmt(hits.length)}.
      </div>
      <table class="ss-table">
        <thead><tr>
          <th>Design</th><th>Job</th><th class="num">Stitches</th>
          <th class="num">Size</th><th class="num">Colours</th><th></th>
        </tr></thead>
        <tbody>
          ${hits.map((d) => `
            <tr>
              <td>${esc(d.name)}${d.character ? `<div class="ss-muted">${esc(characterLabel(d.character))}</div>` : ''}</td>
              <td>${esc(d.jobNumber || '')}</td>
              <td class="num">${fmt(d.stitches)}</td>
              <td class="num">${Number(d.w).toFixed(1)} x ${Number(d.h).toFixed(1)}"</td>
              <td class="num">${d.colors}</td>
              <td><button class="ss-btn ghost" data-requote="${esc(d.id)}">Requote at a new size</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div id="ssRequote"></div>
    `;

    el.querySelectorAll('[data-requote]').forEach((btn) => {
      btn.addEventListener('click', () => this.openRequote(btn.getAttribute('data-requote')));
    });
  },

  openRequote(id) {
    const d = this.state.designs.find((x) => x.id === id);
    if (!d) return;
    const box = this.root.querySelector('#ssRequote');
    box.innerHTML = `
      <div class="ss-card" style="margin-top:16px;background:var(--bg)">
        <h2>Requote ${esc(d.name)}</h2>
        <div class="ss-muted" style="margin-bottom:12px">
          ${fmt(d.stitches)} stitches at ${Number(d.w).toFixed(2)} by ${Number(d.h).toFixed(2)} inches.
          Enter the new finished size.
        </div>
        <div class="ss-pair">
          <div class="ss-field"><label for="ssRqW">New width</label><input id="ssRqW" type="number" step="0.05" value="${Number(d.w).toFixed(2)}"></div>
          <div class="ss-field"><label for="ssRqH">New height</label><input id="ssRqH" type="number" step="0.05" value="${Number(d.h).toFixed(2)}"></div>
        </div>
        <div class="ss-btnrow"><button class="ss-btn" id="ssRqRun">Requote</button></div>
        <div id="ssRqOut"></div>
      </div>
    `;
    this.root.querySelector('#ssRqRun').addEventListener('click', () => {
      const nw = Number(this.root.querySelector('#ssRqW').value);
      const nh = Number(this.root.querySelector('#ssRqH').value);
      if (!(nw > 0) || !(nh > 0)) return;
      const out = modelRescale({ knownStitches: d.stitches, oldW: d.w, oldH: d.h, newW: nw, newH: nh });
      const ratio = (nw * nh) / (d.w * d.h);
      this.root.querySelector('#ssRqOut').innerHTML = `
        <div class="ss-result" style="margin-top:14px">
          <div class="quote">${fmt(out.low)}</div>
          <div class="quote-lbl">quote against this</div>
        </div>
        <div class="ss-band">
          <div class="b"><div class="v">${fmt(out.likely)}</div><div class="l">likely</div></div>
          <div class="b"><div class="v">${fmt(out.worst)}</div><div class="l">worst case</div></div>
        </div>
        <div class="ss-muted" style="margin-top:12px">
          The finished area changes by ${ratio.toFixed(2)} times, and the stitch count by
          ${Math.pow(ratio, 0.66).toFixed(2)} times. Stitches do not scale with area one for one:
          fills grow with area, but outlines, underlay and detail grow with length.
        </div>
      `;
    });
  },

  /* ---------------- import (admin only) ---------------- */

  importPanel() {
    return `
      <div class="ss-card">
        <h2>Import the DST archive</h2>
        <div class="ss-muted" style="margin-bottom:12px">
          Pick the folder holding your DST files. Everything is read here in the browser: the files
          themselves never leave this machine, only the measurements and a small preview image.
          Expect a few minutes for a few thousand files.
        </div>

        <div class="ss-field">
          <label for="ssImportDir">DST folder</label>
          <input type="file" id="ssImportDir" webkitdirectory directory multiple>
        </div>

        <div class="ss-field">
          <label for="ssImportCsv">stitch-archive.csv (optional, but do this the first time)</label>
          <input type="file" id="ssImportCsv" accept=".csv">
        </div>
        <div class="ss-muted" style="margin-bottom:12px">
          Supplying the CSV turns the import into a self-check. This app decodes DST files with its
          own code, and archive-scanner.html decoded them with different code. If the two disagree,
          every number in this app is quietly wrong, and comparing them is the only way to find out
          before it matters.
        </div>

        <div class="ss-btnrow">
          <button class="ss-btn" id="ssImportRun">Read and import</button>
          <button class="ss-btn ghost" id="ssImportCheck">Check only, import nothing</button>
          <button class="ss-btn ghost" id="ssImportClear">Wipe the library</button>
        </div>
        <div id="ssImportOut"></div>
      </div>
    `;
  },

  wireImport() {
    const root = this.root;
    root.querySelector('#ssImportRun').addEventListener('click', () => this.runImport(true));
    root.querySelector('#ssImportCheck').addEventListener('click', () => this.runImport(false));
    root.querySelector('#ssImportClear').addEventListener('click', async () => {
      if (!window.confirm('Delete every design in the library? The DST files on disk are untouched.')) return;
      const out = root.querySelector('#ssImportOut');
      out.innerHTML = '<div class="ss-progress">Wiping...</div>';
      try {
        const res = await this.ctx.api.del(ENDPOINTS.ssenseDesigns + '?all=1');
        out.innerHTML = `<div class="ss-ok">Removed ${fmt(res.cleared)} designs.</div>`;
        this.state.designs = [];
      } catch (err) {
        out.innerHTML = `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
      }
    });
  },

  async runImport(doWrite) {
    const root = this.root;
    const out = root.querySelector('#ssImportOut');
    const dirInput = root.querySelector('#ssImportDir');
    const csvInput = root.querySelector('#ssImportCsv');

    const files = Array.from(dirInput.files || []).filter((f) => /\.dst$/i.test(f.name));
    if (!files.length) {
      out.innerHTML = '<div class="ss-err">No DST files found in that folder.</div>';
      return;
    }

    // Reference counts from the CSV, keyed by filename, for the self-check.
    let reference = null;
    if (csvInput.files && csvInput.files[0]) {
      reference = await this.readReferenceCsv(csvInput.files[0]);
    }

    out.innerHTML = `<div class="ss-progress">Reading 0 of ${fmt(files.length)}...</div>`;

    const scale = this.settings.dstCoverageScale || 1;
    const threadWidth = this.settings.threadWidthMm || 0.4;
    const batch = [];
    let saved = 0, failed = 0, checked = 0, mismatched = 0;
    const coverageRatios = [];
    const problems = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const decoded = decodeDst(await f.arrayBuffer());
        if (!decoded) { failed++; problems.push(`${f.name}: could not decode`); continue; }

        const cov = measureDstCoverage(decoded, threadWidth);

        if (reference) {
          const ref = reference[f.name.toLowerCase()];
          if (ref) {
            checked++;
            // Stitch count is exact or the decoder is broken. No tolerance
            // band here on purpose: a decoder that is 3 % off is still broken.
            if (ref.stitches !== decoded.stitches) {
              mismatched++;
              if (problems.length < 40) {
                problems.push(`${f.name}: decoded ${fmt(decoded.stitches)} stitches, the CSV says ${fmt(ref.stitches)}`);
              }
            }
            if (ref.covered > 0 && cov.coveredSqIn > 0) {
              coverageRatios.push(cov.coveredSqIn / ref.covered);
            }
          }
        }

        if (doWrite) {
          batch.push({
            name: f.name.replace(/\.dst$/i, ''),
            folder: (f.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
            jobNumber: (f.name.match(/(\d{4}-\d{2}-\d{2,3})/) || [])[1] || '',
            stitches: decoded.stitches,
            colors: decoded.colors,
            w: decoded.wIn,
            h: decoded.hIn,
            coveredSqIn: cov.coveredSqIn * scale,
            fill: cov.bboxSqIn > 0 ? (cov.coveredSqIn / cov.bboxSqIn) : null,
            thumb: renderDstThumb(decoded, 240),
            source: 'archive'
          });
        }
      } catch (err) {
        failed++;
        if (problems.length < 40) problems.push(`${f.name}: ${String((err && err.message) || err)}`);
      }

      if (doWrite && batch.length >= 100) {
        const res = await this.ctx.api.post(ENDPOINTS.ssenseDesigns, { designs: batch.splice(0, batch.length) });
        saved += res.saved || 0;
      }

      if (i % 25 === 0 || i === files.length - 1) {
        out.innerHTML = `<div class="ss-progress">Reading ${fmt(i + 1)} of ${fmt(files.length)}${doWrite ? `, saved ${fmt(saved)}` : ''}...</div>`;
        // Yield so the progress line actually paints. Without this the whole
        // run happens inside one frame and the page looks frozen, which is
        // what made the TravelTrack CSV import look like it had failed.
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (doWrite && batch.length) {
      const res = await this.ctx.api.post(ENDPOINTS.ssenseDesigns, { designs: batch });
      saved += res.saved || 0;
    }

    // The verdict.
    let verdict = '';
    if (reference && checked) {
      const medianRatio = coverageRatios.length ? median(coverageRatios) : null;
      if (mismatched === 0) {
        verdict = `<div class="ss-ok">
          Decoder check passed. ${fmt(checked)} files compared against the CSV, every stitch count matched exactly.
        </div>`;
      } else {
        verdict = `<div class="ss-err">
          Decoder check FAILED. ${fmt(mismatched)} of ${fmt(checked)} files disagree with the CSV.
          Do not trust any estimate from this app until that is fixed.
        </div>`;
      }
      if (medianRatio != null) {
        const suggested = Math.round((1 / medianRatio) * 1000) / 1000;
        verdict += `<div class="ss-muted" style="margin-top:8px">
          Coverage measured here is <b>${medianRatio.toFixed(3)}</b> times what the CSV reports.
          ${Math.abs(medianRatio - 1) < 0.03
            ? 'That is close enough to leave alone.'
            : `Set <b>dstCoverageScale</b> to <b>${suggested}</b> so this app's coverage matches the numbers the model was fitted on. Until then every estimate is off by a fixed factor.`}
        </div>`;
      }
    } else if (doWrite) {
      verdict = `<div class="ss-muted">
        No CSV supplied, so nothing was checked. The stitch counts in this library are only as good
        as the decoder, and nobody has verified it.
      </div>`;
    }

    out.innerHTML = `
      <div style="margin-top:10px">
        <div class="ss-muted">
          Read ${fmt(files.length)} files${doWrite ? `, saved ${fmt(saved)}` : ' (nothing saved)'}.
          ${failed ? `${fmt(failed)} could not be read.` : ''}
        </div>
        ${verdict}
        ${problems.length ? `<h3>Problems</h3><div class="ss-muted">${problems.map((p) => esc(p)).join('<br>')}</div>` : ''}
      </div>
    `;

    if (doWrite) {
      try {
        const res = await this.ctx.api.get(ENDPOINTS.ssenseDesigns);
        this.state.designs = (res && res.designs) || [];
        this.drawLibraryList('');
      } catch (e) { /* the list will refresh on next open */ }
    }
  },

  async readReferenceCsv(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const header = (lines[0] || '').split(',').map((s) => s.trim().toLowerCase());
    const iFile = header.indexOf('file');
    const iStitches = header.indexOf('stitches');
    const iCovered = header.indexOf('covered');
    if (iFile < 0 || iStitches < 0) return null;

    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      if (cells.length < 3) continue;
      const name = String(cells[iFile] || '').trim().toLowerCase();
      if (!name) continue;
      map[name] = {
        stitches: Number(cells[iStitches]),
        covered: iCovered >= 0 ? Number(cells[iCovered]) : 0
      };
    }
    return map;
  },

  /* ================================================================ *
   * VIEW: COLORWAY
   *
   * Drop an embroidery file, see the design, assign a thread colour to each
   * block, set a garment colour behind it, export a PNG.
   *
   * WHY THIS IS EASY, WHICH IS NOT OBVIOUS
   * A DST does not store thread colours. It stores stitch coordinates and
   * colour-CHANGE commands, nothing more; the actual colours live in Wilcom's
   * .emb or a companion file. So the file hands us cleanly separated blocks
   * with no opinion about what any of them should look like. There is no baked
   * in colour to strip out or fight, which is exactly the shape a colourway
   * picker wants.
   *
   * WHAT THIS IS NOT
   * Not a Wilcom-quality proof. No thread sheen, no texture, no dimension.
   * It reads accurately at mockup size and will not pass as a photograph of a
   * sewn garment up close. The view says so on screen, because an AM emailing
   * it to a customer as a finished proof is the one way this causes trouble.
   * ================================================================ */

  renderColorway() {
    const el = this.root.querySelector('#ssColorway');
    el.innerHTML = `
      <div class="ss-hd">
        <h1>Colorway</h1>
        <div class="sub">
          Drop an embroidery file to see the design and try thread colours against a garment
          colour. Export a PNG when you have something to show the customer.
        </div>
      </div>
      <div class="ss-card">
        <div class="ss-drop" id="ssCwDrop">
          <div class="big">Drop a DST here</div>
          <div class="small">The file tells us where each thread block starts and stops.<br>It does not carry any colours, so you pick them.</div>
        </div>
        <input type="file" id="ssCwFile" accept=".dst" style="display:none">
        <div class="ss-err ss-hidden" id="ssCwErr"></div>
      </div>
      <div id="ssCwEditor"></div>
    `;

    const drop = el.querySelector('#ssCwDrop');
    const file = el.querySelector('#ssCwFile');
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.loadColorway(f);
    });
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) this.loadColorway(file.files[0]);
    });
  },

  async loadColorway(f) {
    const err = this.root.querySelector('#ssCwErr');
    err.classList.add('ss-hidden');
    try {
      if (!/\.dst$/i.test(f.name)) throw new Error('That is not a DST. Colorway needs the embroidery file, not the artwork.');
      const decoded = decodeDst(await f.arrayBuffer());
      if (!decoded) throw new Error('That DST could not be decoded. Check it is a Tajima DST and not a renamed file.');

      this.state.cwDesign = decoded;
      this.state.cwName = f.name.replace(/\.dst$/i, '');
      // Seed each block from the default palette so the first render is
      // legible. Every block a different colour is not a suggestion, it is the
      // fastest way to see how many there are and where each one sits.
      const n = blockCount(decoded);
      this.state.cwColors = Array.from({ length: n }, (_, i) => DEFAULT_THREADS[i % DEFAULT_THREADS.length]);
      this.state.cwRotate = 0;
      this.state.cwMirror = false;
      this.drawColorwayEditor();
    } catch (e) {
      err.textContent = String((e && e.message) || e);
      err.classList.remove('ss-hidden');
    }
  },

  drawColorwayEditor() {
    const d = this.state.cwDesign;
    const box = this.root.querySelector('#ssCwEditor');
    const n = this.state.cwColors.length;

    box.innerHTML = `
      <div class="ss-cols">
        <div>
          <div class="ss-card">
            <h2>Preview</h2>
            <div class="ss-preview" id="ssCwStage"></div>
            <div class="ss-overlay-note">
              ${esc(this.state.cwName)} &middot; ${fmt(d.stitches)} stitches &middot;
              ${n} thread block${n === 1 ? '' : 's'} &middot;
              ${d.wIn.toFixed(2)} by ${d.hIn.toFixed(2)} inches
            </div>
          </div>
          <div class="ss-flag fair">
            Close enough for a customer to picture the garment, not a Wilcom proof. Real
            thread has fibre, sheen that shifts as you turn it, and satin columns that catch
            light as one surface rather than as separate stitches. This will not hold up at
            full size, so do not send it as a final proof.
          </div>
        </div>

        <div>
          <div class="ss-card">
            <h2>Threads</h2>
            <div class="ss-muted" style="margin-bottom:10px">
              Blocks are listed in sewing order. A block further down covers the ones above it,
              on screen and on the garment.
            </div>
            <div id="ssCwBlocks"></div>

            <h3>Orientation</h3>
            <div class="ss-muted" style="margin-bottom:8px">
              Cap designs are routinely digitised sideways, so a design arriving rotated is normal
              rather than a fault in the file.
            </div>
            <div class="ss-btnrow" style="margin-bottom:14px">
              <button class="ss-btn ghost" id="ssCwRotL">Rotate left</button>
              <button class="ss-btn ghost" id="ssCwRotR">Rotate right</button>
              <button class="ss-btn ghost" id="ssCwMirror" aria-pressed="false">Mirror</button>
            </div>

            <h3>Garment</h3>
            <div class="ss-guessrow">
              <div class="ss-field" style="flex:0 0 70px">
                <input type="color" id="ssCwGarment" value="${esc(this.state.cwGarment)}">
              </div>
              <div class="ss-field">
                <label for="ssCwGarmentHex">Colour</label>
                <input type="text" id="ssCwGarmentHex" value="${esc(this.state.cwGarment)}">
              </div>
              <button class="ss-btn ghost" id="ssCwClear">No background</button>
            </div>

            <h3>Export</h3>
            <div class="ss-pair">
              <div class="ss-field">
                <label for="ssCwSize">Size (pixels)</label>
                <select id="ssCwSize">
                  <option value="600">600, on screen</option>
                  <option value="1200" selected>1200, email</option>
                  <option value="2400">2400, print</option>
                </select>
              </div>
              <div class="ss-field">
                <label for="ssCwThick">Thread weight</label>
                <select id="ssCwThick">
                  <option value="0.8">Light</option>
                  <option value="1" selected>Normal</option>
                  <option value="1.3">Heavy</option>
                </select>
              </div>
            </div>
            <div class="ss-field">
              <label for="ssCwStyle">Render</label>
              <select id="ssCwStyle">
                <option value="thread" selected>Stitched, with depth</option>
                <option value="flat">Flat line work</option>
              </select>
            </div>
            <label class="ss-check">
              <input type="checkbox" id="ssCwConnect" checked>
              Hide connecting stitches
            </label>
            <div class="ss-muted" style="margin-bottom:12px">
              The needle travels between elements and those travels get trimmed on the machine.
              Shown, they are thin lines cutting across the logo.
            </div>
            <div class="ss-btnrow">
              <button class="ss-btn" id="ssCwPng">Download PNG</button>
              <button class="ss-btn ghost" id="ssCwReset">Reset colours</button>
            </div>
            <div class="ss-muted" style="margin-top:8px">
              With no background set the PNG exports transparent, so it drops straight onto a
              garment mockup.
            </div>
          </div>
        </div>
      </div>
    `;

    this.drawColorwayBlocks();
    this.wireColorway();
    this.paintColorway();
  },

  drawColorwayBlocks() {
    const box = this.root.querySelector('#ssCwBlocks');
    box.innerHTML = this.state.cwColors.map((c, i) => `
      <div class="ss-guessrow" style="margin-bottom:8px">
        <div class="ss-field" style="flex:0 0 70px;margin-bottom:0">
          <input type="color" data-block="${i}" value="${esc(c)}">
        </div>
        <div class="ss-field" style="margin-bottom:0">
          <label for="ssCwHex${i}">Block ${i + 1}</label>
          <input type="text" id="ssCwHex${i}" data-blockhex="${i}" value="${esc(c)}">
        </div>
      </div>
    `).join('');

    box.querySelectorAll('[data-block]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.getAttribute('data-block'));
        this.state.cwColors[i] = inp.value;
        const hex = box.querySelector(`[data-blockhex="${i}"]`);
        if (hex) hex.value = inp.value;
        this.paintColorway();
      });
    });

    box.querySelectorAll('[data-blockhex]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.getAttribute('data-blockhex'));
        // Typed values get validated before they reach the canvas: an invalid
        // colour makes strokeStyle silently keep the PREVIOUS block's colour,
        // so a typo would look like the picker had ignored the click.
        if (!isColor(inp.value)) { inp.value = this.state.cwColors[i]; return; }
        this.state.cwColors[i] = inp.value;
        const pick = box.querySelector(`[data-block="${i}"]`);
        if (pick && /^#[0-9a-f]{6}$/i.test(inp.value)) pick.value = inp.value;
        this.paintColorway();
      });
    });
  },

  wireColorway() {
    const root = this.root;

    // ---- orientation ----
    const bump = (deg) => {
      this.state.cwRotate = (((this.state.cwRotate + deg) % 360) + 360) % 360;
      this.paintColorway();
    };
    root.querySelector('#ssCwRotL').addEventListener('click', () => bump(-90));
    root.querySelector('#ssCwRotR').addEventListener('click', () => bump(90));
    const mirror = root.querySelector('#ssCwMirror');
    mirror.addEventListener('click', () => {
      this.state.cwMirror = !this.state.cwMirror;
      mirror.setAttribute('aria-pressed', String(this.state.cwMirror));
      this.paintColorway();
    });

    root.querySelector('#ssCwThick').addEventListener('change', () => this.paintColorway());
    root.querySelector('#ssCwStyle').addEventListener('change', (e) => {
      this.state.cwStyle = e.target.value;
      this.paintColorway();
    });
    root.querySelector('#ssCwConnect').addEventListener('change', (e) => {
      this.state.cwHideConnectors = e.target.checked;
      this.paintColorway();
    });
    root.querySelector('#ssCwReset').addEventListener('click', () => {
      this.state.cwColors = this.state.cwColors.map((_, i) => DEFAULT_THREADS[i % DEFAULT_THREADS.length]);
      this.drawColorwayBlocks();
      this.paintColorway();
    });
    root.querySelector('#ssCwPng').addEventListener('click', () => this.exportColorway());
  },

  paintColorway() {
    const stage = this.root.querySelector('#ssCwStage');
    if (!stage || !this.state.cwDesign) return;
    const thickness = Number((this.root.querySelector('#ssCwThick') || {}).value || 1);
    const canvas = renderDesign(this.state.cwDesign, {
      size: 520,
      colors: this.state.cwColors,
      garment: this.state.cwGarment,
      thickness,
      rotate: this.state.cwRotate,
      mirror: this.state.cwMirror,
      style: this.state.cwStyle,
      hideConnectors: this.state.cwHideConnectors
    });
    // A transparent export over a white card looks like a white garment, which
    // is misleading. The checker makes "no background" visibly mean no
    // background rather than accidentally reading as white.
    stage.style.backgroundImage = this.state.cwGarment ? 'none' : CHECKER;
    stage.innerHTML = '';
    stage.appendChild(canvas);
  },

  exportColorway() {
    const size = Number((this.root.querySelector('#ssCwSize') || {}).value || 1200);
    const thickness = Number((this.root.querySelector('#ssCwThick') || {}).value || 1);
    const canvas = renderDesign(this.state.cwDesign, {
      size,
      colors: this.state.cwColors,
      garment: this.state.cwGarment,
      thickness,
      rotate: this.state.cwRotate,
      mirror: this.state.cwMirror,
      style: this.state.cwStyle,
      hideConnectors: this.state.cwHideConnectors
    });
    const a = document.createElement('a');
    a.download = (this.state.cwName || 'design') + '-colorway.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  },

  /* ================================================================ *
   * VIEW: GUESS (the game)
   * ================================================================ */

  async renderGuess() {
    const el = this.root.querySelector('#ssGuess');
    el.innerHTML = `
      <div class="ss-hd">
        <h1>Stitch Guess</h1>
        <div class="sub">
          A real design from our archive, at its real finished size. Guess the stitch count, then
          say what kind of design it is. You are scored against the actual count from the DST, and
          so is the estimator, on the same design at the same moment.
        </div>
      </div>
      <div class="ss-game">
        <div class="ss-score" id="ssScore"></div>
        <div class="ss-card" id="ssRound"><div class="ss-empty">Dealing a design...</div></div>
      </div>
    `;
    this.drawScore();
    this.nextRound();
  },

  drawScore() {
    const el = this.root.querySelector('#ssScore');
    if (!el) return;
    const s = this.state.session;
    el.innerHTML = `
      <div>rounds <b>${s.rounds}</b></div>
      <div>points <b>${fmt(s.points)}</b></div>
      <div>beat the tool <b>${s.beats}</b></div>
    `;
  },

  async nextRound() {
    const box = this.root.querySelector('#ssRound');
    if (!box) return;
    box.innerHTML = '<div class="ss-empty">Dealing a design...</div>';

    try {
      const seen = this.state.seenDesignIds.slice(-40).join(',');
      const res = await this.ctx.api.get(ENDPOINTS.ssenseDesigns + '?random=1&seen=' + encodeURIComponent(seen));
      const d = res && res.design;
      if (!d) {
        box.innerHTML = `<div class="ss-empty">
          There is nothing to guess yet. The library needs designs with preview images in it before
          the game has any questions to ask. ${this.isAdmin ? 'Run the archive import from the Library view.' : 'Ryan needs to run the archive import.'}
        </div>`;
        return;
      }
      this.state.currentDesign = d;
      this.state.seenDesignIds.push(d.id);
      this.drawRound(d);
    } catch (err) {
      box.innerHTML = `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
    }
  },

  drawRound(d) {
    const box = this.root.querySelector('#ssRound');
    box.innerHTML = `
      <div class="ss-gamefig">
        <img src="${esc(d.thumb)}" alt="design">
        <div class="dims">
          ${Number(d.w).toFixed(2)} by ${Number(d.h).toFixed(2)} inches,
          ${d.colors} colour${d.colors === 1 ? '' : 's'}
        </div>
      </div>
      <div class="ss-guessrow">
        <div class="ss-field">
          <label for="ssGuessN">How many stitches?</label>
          <input type="number" id="ssGuessN" min="1" step="50" placeholder="e.g. 6500">
        </div>
        <button class="ss-btn" id="ssGuessGo">Lock it in</button>
      </div>
      <div style="margin-top:12px">
        <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px">
          What kind of design is it? (optional, but it is the part that improves the tool)
        </label>
        <div class="ss-chips" id="ssChips">
          ${CHARACTERS.map(([k, label]) =>
            `<button class="ss-chip" data-char="${esc(k)}" aria-pressed="false">${esc(label)}</button>`
          ).join('')}
        </div>
      </div>
      <div id="ssRoundOut"></div>
    `;

    let picked = '';
    box.querySelectorAll('[data-char]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.getAttribute('data-char');
        picked = picked === key ? '' : key;
        box.querySelectorAll('[data-char]').forEach((c) => {
          c.setAttribute('aria-pressed', String(c.getAttribute('data-char') === picked));
        });
      });
    });

    const go = box.querySelector('#ssGuessGo');
    const input = box.querySelector('#ssGuessN');
    const submit = () => this.submitGuess(Number(input.value), picked);
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  },

  async submitGuess(guess, character) {
    if (!(guess > 0)) return;
    const d = this.state.currentDesign;
    const out = this.root.querySelector('#ssRoundOut');
    const btn = this.root.querySelector('#ssGuessGo');
    if (btn) btn.disabled = true;

    try {
      const res = await this.ctx.api.post(ENDPOINTS.ssenseRounds, {
        designId: d.id, guess, character
      });

      const s = this.state.session;
      s.rounds++;
      s.points += res.points || 0;
      if (res.beatTheModel) s.beats++;
      this.drawScore();

      const verdicts = {
        bullseye: 'Bullseye.',
        close: 'Close.',
        fair: 'Not bad.',
        wide: 'Wide.',
        cold: 'Way off.'
      };

      out.innerHTML = `
        <div class="ss-reveal">
          <div class="verdict">${esc(verdicts[res.band] || '')}</div>
          <div class="truth">${fmt(res.actualStitches)}</div>
          <div class="ss-muted">actual stitches</div>
          <div class="vs">
            You said ${fmt(guess)}, off by ${pct(res.errorPct, 1)}. Worth ${fmt(res.points)} points.<br>
            The estimator said ${fmt(res.model.guess)}, off by ${pct(res.model.errorPct, 1)}.
            <b>${res.beatTheModel ? 'You beat it.' : 'It beat you.'}</b>
          </div>
        </div>
        <div class="ss-btnrow" style="justify-content:center">
          <button class="ss-btn" id="ssNext">Next design</button>
        </div>
      `;
      this.root.querySelector('#ssNext').addEventListener('click', () => this.nextRound());
      this.root.querySelector('#ssNext').focus();
    } catch (err) {
      if (btn) btn.disabled = false;
      out.innerHTML = `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
    }
  },

  /* ================================================================ *
   * VIEW: ACCURACY
   * ================================================================ */

  async renderAccuracy() {
    const el = this.root.querySelector('#ssAccuracy');
    el.innerHTML = `
      <div class="ss-hd">
        <h1>Accuracy</h1>
        <div class="sub">
          How the estimator is actually doing on real jobs, which is a different question from how
          it did on the archive. Fill in the real stitch count once a job is digitised.
        </div>
      </div>
      <div id="ssAccBody"><div class="ss-empty">Loading...</div></div>
    `;

    let estimates = [];
    let game = null;
    try {
      const res = await this.ctx.api.get(ENDPOINTS.ssenseEstimates);
      estimates = (res && res.estimates) || [];
    } catch (err) {
      this.root.querySelector('#ssAccBody').innerHTML =
        `<div class="ss-err">${esc(String((err && err.message) || err))}</div>`;
      return;
    }
    try { game = await this.ctx.api.get(ENDPOINTS.ssenseRounds); } catch (e) { game = null; }

    const closed = estimates.filter((e) => e.actualStitches != null);
    const errs = closed.map((e) => Math.abs(e.likely - e.actualStitches) / e.actualStitches);
    const med = errs.length ? median(errs) : null;
    const within20 = errs.length ? errs.filter((x) => x <= 0.2).length / errs.length : null;
    // Did the quoting figure hold? That is the number Ryan actually cares
    // about: how often did we quote under what it came in at.
    const underQuoted = closed.length
      ? closed.filter((e) => e.actualStitches > e.low).length / closed.length
      : null;

    this.root.querySelector('#ssAccBody').innerHTML = `
      <div class="ss-kpis">
        <div class="ss-kpi">
          <div class="lbl">Estimates logged</div>
          <div class="val">${fmt(estimates.length)}</div>
          <div class="sub">${fmt(closed.length)} closed out with a real count</div>
        </div>
        <div class="ss-kpi">
          <div class="lbl">Live median error</div>
          <div class="val">${med == null ? '--' : pct(med, 1)}</div>
          <div class="sub">${closed.length < 20 ? 'needs about 20 jobs to mean anything' : 'archive validation was 18.6%'}</div>
        </div>
        <div class="ss-kpi">
          <div class="lbl">Within 20%</div>
          <div class="val">${within20 == null ? '--' : pct(within20)}</div>
          <div class="sub">archive validation was 53%</div>
        </div>
        <div class="ss-kpi">
          <div class="lbl">Came in over the quote</div>
          <div class="val">${underQuoted == null ? '--' : pct(underQuoted)}</div>
          <div class="sub">should sit near 80% by design</div>
        </div>
      </div>

      ${closed.length && closed.length < 20 ? `
        <div class="ss-flag fair">
          Too few closed jobs to read anything into these numbers yet. ${20 - closed.length} more and
          they start to mean something.
        </div>` : ''}

      <div class="ss-card">
        <h2>Estimates</h2>
        ${estimates.length ? `
          <table class="ss-table">
            <thead><tr>
              <th>Id</th><th>Customer</th><th>Design</th>
              <th class="num">Quoted at</th><th class="num">Likely</th>
              <th class="num">Actual</th><th class="num">Off by</th><th></th>
            </tr></thead>
            <tbody>
              ${estimates.slice(0, 100).map((e) => {
                const off = e.actualStitches != null
                  ? Math.abs(e.likely - e.actualStitches) / e.actualStitches : null;
                return `<tr>
                  <td>${esc(e.id)}</td>
                  <td>${esc(e.customer || '')}</td>
                  <td>${esc(e.designName || '')}<div class="ss-muted">${esc(e.source)}</div></td>
                  <td class="num">${fmt(e.low)}</td>
                  <td class="num">${fmt(e.likely)}</td>
                  <td class="num">${e.actualStitches == null ? '' : fmt(e.actualStitches)}</td>
                  <td class="num">${off == null ? '' : pct(off, 1)}</td>
                  <td>${e.actualStitches == null
                    ? `<button class="ss-btn ghost" data-close="${esc(e.id)}">Enter actual</button>`
                    : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        ` : `<div class="ss-empty">
          Nothing logged yet. Every estimate saved from the Estimate view lands here, and closing
          them out is the only way this tool ever gets better than it is today.
        </div>`}
      </div>

      ${this.gameBoard(game)}
    `;

    this.root.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.promptActual(btn.getAttribute('data-close')));
    });
  },

  gameBoard(game) {
    if (!game || !game.totalRounds) return '';
    const h = game.headToHead;
    return `
      <div class="ss-card">
        <h2>Stitch Guess</h2>
        ${h ? `
          <div class="ss-muted" style="margin-bottom:12px">
            Over ${fmt(h.rounds)} rounds, people are off by a median of ${pct(h.humanMedianErrorPct, 1)}
            and the estimator by ${pct(h.modelMedianErrorPct, 1)}. People won
            ${fmt(h.humanWins)} of those rounds.
            ${h.humanMedianErrorPct < h.modelMedianErrorPct
              ? 'The shop is reading something the tool is not, which is worth digging into.'
              : 'The tool is holding its own so far.'}
          </div>` : ''}
        <table class="ss-table">
          <thead><tr><th>Player</th><th class="num">Rounds</th><th class="num">Avg points</th><th class="num">Median error</th><th class="num">Bullseyes</th></tr></thead>
          <tbody>
            ${game.leaderboard.map((p) => `
              <tr>
                <td>${esc(p.username)}</td>
                <td class="num">${fmt(p.rounds)}</td>
                <td class="num">${fmt(p.avgPoints)}</td>
                <td class="num">${pct(p.medianErrorPct, 1)}</td>
                <td class="num">${fmt(p.bullseyes)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <h3>Design character labels collected</h3>
        <div class="ss-muted">
          ${game.tagCoverage.map((t) => `${esc(characterLabel(t.character))}: ${fmt(t.count)}`).join(' &middot; ')}
          <br>These are the labels that let the per-category corrections be retested properly.
          Filename keywords were tried for this and failed validation. Roughly 200 per category
          is where it becomes worth rerunning.
        </div>
      </div>
    `;
  },

  async promptActual(id) {
    const raw = window.prompt('What did it actually come in at, in stitches?');
    if (raw == null) return;
    const n = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (!(n > 0)) return;
    try {
      await this.ctx.api.patch(ENDPOINTS.ssenseEstimates + '?id=' + encodeURIComponent(id), { actualStitches: n });
      this.renderAccuracy();
    } catch (err) {
      window.alert(String((err && err.message) || err));
    }
  }
};

/* Local median, used by the import self-check and the accuracy view. Kept out
 * of lib/stitchsense/model.js because it is a display concern, not a model
 * constant, and model.js is imported by server routes that do not need it. */
function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
