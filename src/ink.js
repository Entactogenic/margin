/**
 * ink.js — stroke capture and the width model.
 *
 * The width model adapts to hardware at runtime instead of assuming a
 * stylus. If the pen reports a real pressure range, width follows
 * pressure; otherwise it follows speed, with the speed curve calibrated
 * from how this particular person writes.
 *
 * Widths are baked into each point as it is captured, so later
 * recalibration never retroactively changes ink already on the page.
 */

import { paintPencil } from './tools/pencil.js';

export const pressureStats = { min: 1, max: 0, varied: false, samples: 0 };
export const speedStats = { buf: [], fast: 0.0022, calibrated: false };

export function notePressure(p) {
  if (typeof p !== 'number' || p <= 0 || p >= 1) return;
  pressureStats.samples++;
  if (p < pressureStats.min) pressureStats.min = p;
  if (p > pressureStats.max) pressureStats.max = p;
  if (pressureStats.max - pressureStats.min > 0.08) pressureStats.varied = true;
}

function noteSpeed(v) {
  if (!Number.isFinite(v) || v <= 0) return;
  const S = speedStats;
  S.buf.push(v);
  if (S.buf.length > 800) S.buf.shift();
  // recalibrate off the 85th percentile of real strokes
  if (S.buf.length >= 60 && S.buf.length % 30 === 0) {
    const sorted = [...S.buf].sort((a, b) => a - b);
    const p85 = sorted[Math.floor(sorted.length * 0.85)];
    if (p85 > 0.0002) { S.fast = p85; S.calibrated = true; }
  }
}

/** Width for one point, in normalized page units. */
export function widthFor(pt, prev, base) {
  if (pressureStats.varied && pt.p > 0) {
    const span = Math.max(pressureStats.max - pressureStats.min, 0.01);
    const n = Math.min(1, Math.max(0, (pt.p - pressureStats.min) / span));
    return base * (0.45 + 1.15 * n);
  }
  if (!prev) return base;

  const dt = Math.max(pt.t - prev.t, 1);
  const v = Math.hypot(pt.x - prev.x, pt.y - prev.y) / dt;
  noteSpeed(v);

  let k = Math.min(1, Math.max(0, v / speedStats.fast));
  k = k * k * (3 - 2 * k); // smoothstep: only genuinely fast strokes thin
  return base * (0.52 + 0.9 * (1 - k));
}

export function widthMode() {
  if (pressureStats.varied) {
    return `pressure ${pressureStats.min.toFixed(2)}–${pressureStats.max.toFixed(2)}`;
  }
  return speedStats.calibrated ? 'velocity · calibrated' : 'velocity · calibrating';
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/** Paint one stroke onto a context sized to w x h CSS pixels. */
export function paintStroke(ctx, stroke, w, h, colorOf) {
  const pts = stroke.pts;
  if (!pts || pts.length < 2) return;

  if (stroke.k === 'pencil') {
    paintPencil(ctx, stroke, w, h, colorOf(stroke.c));
    return;
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colorOf(stroke.c);

  if (stroke.k === 'hi') {
    // highlighter: one constant-width pass, multiplied so text shows through
    ctx.globalAlpha = 0.34;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = stroke.w * w;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.quadraticCurveTo(a.x * w, a.y * h, ((a.x + b.x) / 2) * w, ((a.y + b.y) / 2) * h);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.beginPath();
    ctx.lineWidth = (b.w ?? widthFor(b, a, stroke.w)) * w;
    ctx.moveTo(a.x * w, a.y * h);
    ctx.quadraticCurveTo(a.x * w, a.y * h, ((a.x + b.x) / 2) * w, ((a.y + b.y) / 2) * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* hit testing                                                         */
/* ------------------------------------------------------------------ */

export const ERASE_RADIUS = 0.012;

/** Squared distance from p to the segment a-b. */
function segDist2(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-18 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const ex = a.x + dx * t - p.x, ey = a.y + dy * t - p.y;
  return ex * ex + ey * ey;
}

/**
 * Does any part of the stroke pass within `radius` of the point?
 * Measured against segments, not points: a placed line is two points a
 * long way apart, and its middle must still be something you can hit.
 */
function touches(pts, pt, radius) {
  const r2 = radius * radius;
  if (pts.length === 1) return segDist2(pt, pts[0], pts[0]) < r2;
  for (let i = 1; i < pts.length; i++) {
    if (segDist2(pt, pts[i - 1], pts[i]) < r2) return true;
  }
  return false;
}

/** Index of the topmost stroke within `radius` of a point, or -1. */
export function strokeAt(strokes, pt, radius = ERASE_RADIUS) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].pts?.length && touches(strokes[i].pts, pt, radius)) return i;
  }
  return -1;
}

/** Insert points so that no two neighbours are more than `step` apart. */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (a.w != null && b.w != null) p.w = a.w + (b.w - a.w) * t;
      if (a.a != null && b.a != null) p.a = a.a + (b.a - a.a) * t;
      out.push(p);
    }
    out.push(b);
  }
  return out;
}

/**
 * Rub out the part of a stroke within `radius` of a point.
 *
 * Returns null if the stroke is untouched, otherwise the pieces left
 * over — none, one (an end was trimmed) or two (it was cut in the
 * middle). Each piece is a complete stroke in its own right.
 */
export function eraseArea(stroke, pt, radius = ERASE_RADIUS) {
  const pts = stroke.pts;
  if (!pts || pts.length < 2 || !touches(pts, pt, radius)) return null;

  const r2 = radius * radius;
  const pieces = [];
  let run = [], cut = false;
  for (const p of densify(pts, radius / 3)) {
    const dx = p.x - pt.x, dy = p.y - pt.y;
    if (dx * dx + dy * dy < r2) {
      cut = true;
      if (run.length > 1) pieces.push({ ...stroke, pts: run });
      run = [];
    } else {
      run.push(p);
    }
  }
  if (!cut) return null;
  if (run.length > 1) pieces.push({ ...stroke, pts: run });
  return pieces;
}

/** Indices of every stroke whose bounding box falls inside a rectangle. */
export function strokesInRect(strokes, rect) {
  const out = [];
  strokes.forEach((s, i) => {
    if (!s.pts?.length) return;
    const inside = s.pts.every(
      (p) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1
    );
    if (inside) out.push(i);
  });
  return out;
}
