/**
 * GivingGauge — the gauge.
 * Replaces the linear bar in the hero card.
 *
 * Renders a 240° arc, 0 on the left, 100 on the right, with the arc
 * segmented at the grade thresholds (40 / 55 / 70 / 85). The needle
 * lands on the score. Colour is not decorative: the needle and the
 * score take the colour of the band they land in.
 *
 * Brand gold: #d5a029 (from the GivingGauge mark).
 */

'use strict';

const PALETTE = {
  green: '#3D9A5C',
  gold:  '#D5A029',
  red:   '#C0392B',
  track: '#E4E8EC',
  muted: '#6B7684',
  ink:   '#1C2430'
};

// Grade bands as arc segments, in score order.
const SEGMENTS = [
  { from: 0,  to: 40,  color: PALETTE.red },
  { from: 40, to: 55,  color: PALETTE.gold },
  { from: 55, to: 70,  color: PALETTE.gold },
  { from: 70, to: 85,  color: PALETTE.green },
  { from: 85, to: 100, color: PALETTE.green }
];

// Grade boundaries get a full-height rule. Derived from the same numbers
// the engine grades on — keep these in sync with GRADE_BANDS.
const GRADE_TICKS = [40, 55, 70, 85];

const START_ANGLE = 150; // degrees, 0 score
const SWEEP = 240;       // total arc

function scoreToAngle(score) {
  const s = Math.max(0, Math.min(100, score));
  return START_ANGLE + (s / 100) * SWEEP;
}

function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

/**
 * @param {object} result  Output of GivingGauge.evaluate()
 * @param {object} opts    { size, printSize, showTicks }
 * @returns {string} SVG markup
 */
function renderGauge(result, opts) {
  const o = Object.assign({ size: 200, strokeWidth: null, showTicks: true }, opts || {});
  const size = o.size;
  const cx = size / 2;
  const cy = size * 0.335;
  // Heavier band. Radius pulled in so the thicker arc still clears the end labels.
  const sw = o.strokeWidth != null ? o.strokeWidth : size * 0.105;
  const r = size * 0.365;

  const score = result.disqualified ? 0 : result.total;
  const active = PALETTE[result.gaugeColor] || PALETTE.gold;
  const needleAngle = scoreToAngle(score);
  const tip = polar(cx, cy, r - sw * 0.82, needleAngle);
  const hubR = size * 0.035;

  // ViewBox derived from actual geometry, not a guessed multiplier. The arc
  // sweeps through straight-up (270°), so the crown reaches cy-(r+sw/2); a
  // fixed multiplier clipped it. Pad, then shift all drawing down by padTop.
  const pad = size * 0.02;
  const crown = cy - (r + sw / 2);
  const padTop = Math.max(0, pad - crown);
  const vbW = size;
  const vbH = padTop + cy + (r + sw / 2) + size * 0.245;

  const parts = [];

  parts.push(
    `<svg class="gauge" viewBox="0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}" width="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="Score ${score} out of 100, grade ${result.grade}">`
  );
  parts.push(`<g transform="translate(0 ${padTop.toFixed(2)})">`);

  // Full track underneath, so unfilled arc still reads as a dial.
  parts.push(
    `<path d="${arcPath(cx, cy, r, START_ANGLE, START_ANGLE + SWEEP)}" ` +
    `fill="none" stroke="${PALETTE.track}" stroke-width="${sw}" stroke-linecap="butt"/>`
  );

  // Coloured band segments, drawn at low opacity so the needle carries the verdict.
  SEGMENTS.forEach(seg => {
    const a0 = scoreToAngle(seg.from);
    const a1 = scoreToAngle(seg.to);
    parts.push(
      `<path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${seg.color}" ` +
      `stroke-width="${sw}" stroke-linecap="butt" opacity="0.16"/>`
    );
  });

  // Filled arc up to the score, in the verdict colour.
  if (score > 0) {
    parts.push(
      `<path d="${arcPath(cx, cy, r, START_ANGLE, needleAngle)}" fill="none" ` +
      `stroke="${active}" stroke-width="${sw}" stroke-linecap="butt"/>`
    );
  }

  // Graduated ticks across the full arc — a dial should read as a dial.
  //   minor  (every 5)   short, inset from the outer edge
  //   major  (every 20)  spans the band
  //   grade thresholds   full height, and they overrule a coincident major
  if (o.showTicks) {
    const outer = r + sw / 2;
    const inner = r - sw / 2;

    for (let t = 0; t <= 100; t += 5) {
      const isThreshold = GRADE_TICKS.includes(t);
      const isMajor = t % 20 === 0;
      const a = scoreToAngle(t);

      let from, to, width, opacity;
      if (isThreshold) {
        from = inner - 1; to = outer + 1; width = size * 0.011; opacity = 0.95;
      } else if (isMajor) {
        from = inner;     to = outer;     width = size * 0.008; opacity = 0.75;
      } else {
        from = outer - sw * 0.42; to = outer; width = size * 0.006; opacity = 0.5;
      }

      const p0 = polar(cx, cy, from, a);
      const p1 = polar(cx, cy, to, a);
      parts.push(
        `<line x1="${p0.x.toFixed(2)}" y1="${p0.y.toFixed(2)}" ` +
        `x2="${p1.x.toFixed(2)}" y2="${p1.y.toFixed(2)}" ` +
        `stroke="#ffffff" stroke-width="${width.toFixed(2)}" ` +
        `stroke-linecap="butt" opacity="${opacity}"/>`
      );
    }
  }

  // Needle — tapered blade matching the mark: wide at the pivot, coming to a
  // point at the tip. No counterweight tail; on a 240° dial the tail swings
  // down into the readout at low scores. The hub disc reads as the pivot.
  {
    const halfBase = size * 0.028;
    const perp     = needleAngle + 90;

    const baseL = polar(cx, cy, halfBase, perp);
    const baseR = polar(cx, cy, halfBase, perp + 180);

    const pts = [
      `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`,
      `${baseL.x.toFixed(2)},${baseL.y.toFixed(2)}`,
      `${baseR.x.toFixed(2)},${baseR.y.toFixed(2)}`
    ].join(' ');

    parts.push(
      `<polygon points="${pts}" fill="${active}" stroke="${active}" ` +
      `stroke-width="${(size * 0.004).toFixed(2)}" stroke-linejoin="round"/>`
    );
  }

  // Hub — solid disc with a white centre, as on the mark.
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${hubR.toFixed(2)}" fill="${active}"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${(hubR * 0.40).toFixed(2)}" fill="#ffffff"/>`);

  // Score + grade sit BELOW the dial. A needle long enough to point will
  // always sweep the dial centre, so the readout cannot live there.
  const dialBottom = cy + (r + sw / 2);
  parts.push(
    `<text x="${cx}" y="${(dialBottom + size * 0.147).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Inter,system-ui,sans-serif" ` +
    `font-size="${(size * 0.20).toFixed(1)}" font-weight="800" fill="${active}" ` +
    `letter-spacing="-1.5">${score}<tspan font-size="${(size * 0.078).toFixed(1)}" ` +
    `fill="${PALETTE.muted}" font-weight="600" dx="1">/100</tspan></text>`
  );
  parts.push(
    `<text x="${cx}" y="${(dialBottom + size * 0.227).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Inter,system-ui,sans-serif" ` +
    `font-size="${(size * 0.058).toFixed(1)}" font-weight="700" fill="${PALETTE.ink}" ` +
    `letter-spacing="2.6">GRADE ${result.grade}</text>`
  );

  // End labels.
  const l0 = polar(cx, cy, r + sw * 0.78, START_ANGLE - 7);
  const l1 = polar(cx, cy, r + sw * 0.78, START_ANGLE + SWEEP + 7);
  const lblSize = (size * 0.05).toFixed(1);
  parts.push(
    `<text x="${l0.x.toFixed(2)}" y="${(l0.y + 4).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Inter,system-ui,sans-serif" font-size="${lblSize}" font-weight="600" ` +
    `fill="${PALETTE.muted}">0</text>`
  );
  parts.push(
    `<text x="${l1.x.toFixed(2)}" y="${(l1.y + 4).toFixed(2)}" text-anchor="middle" ` +
    `font-family="Inter,system-ui,sans-serif" font-size="${lblSize}" font-weight="600" ` +
    `fill="${PALETTE.muted}">100</text>`
  );

  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('\n');
}

const Gauge = { renderGauge, PALETTE, scoreToAngle };

if (typeof module !== 'undefined' && module.exports) module.exports = Gauge;
if (typeof window !== 'undefined') window.GivingGaugeDial = Gauge;
