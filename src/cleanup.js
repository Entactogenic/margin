/**
 * cleanup.js — making messy ink neat.
 *
 * Independent passes, each usable alone:
 *
 *   smooth()            shaky lines -> clean curves        (always safe)
 *   recognize()         scribbled shape -> perfect shape   (opt-in, undoable)
 *   straighten()        sloping handwriting -> level       (region select)
 *   normalizeSize()     letters that drift in size -> even
 *   normalizeSpacing()  ragged gaps -> even letter and word spacing
 *   tidyPage()          all of the above over a page
 *
 * Everything works on NORMALIZED page coordinates (0..1) and is pure
 * geometry — no model, no network, runs offline on any device.
 *
 * Points are { x, y, p?, t?, w?, a? }. Width (w) and pencil opacity (a)
 * are preserved where they exist so cleaned strokes keep their variation.
 */

/* ------------------------------------------------------------------ */
/* small vector helpers                                                */
/* ------------------------------------------------------------------ */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (u, v, t) => (u != null && v != null ? u + (v - u) * t : u ?? v);
const lerp = (a, b, t) => {
  const p = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: mix(a.w, b.w, t),
  };
  const alpha = mix(a.a, b.a, t);
  if (alpha != null) p.a = alpha;
  return p;
};
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function centroid(pts) {
  return { x: mean(pts.map((p) => p.x)), y: mean(pts.map((p) => p.y)) };
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/* ------------------------------------------------------------------ */
/* 1. SMOOTHING                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ramer-Douglas-Peucker: drop points that sit close to the line their
 * neighbours already describe. This is what removes sensor jitter —
 * a 400-point scribble often carries only ~40 points of real shape.
 */
export function simplify(pts, eps = 0.0015) {
  if (pts.length < 3) return pts.slice();

  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;

  // iterative rather than recursive: a long stroke can blow the stack
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > eps) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Chaikin corner-cutting. Each pass replaces every corner with two
 * points a quarter in from each side, converging on a quadratic
 * B-spline. Two passes is usually the sweet spot: enough to kill the
 * wobble, not so much that letters lose their shape.
 */
export function chaikin(pts, iterations = 2, closed = false) {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    if (out.length < 3) break;
    const next = [];
    if (!closed) next.push(out[0]);
    for (let i = 0; i < out.length - 1; i++) {
      next.push(lerp(out[i], out[i + 1], 0.25), lerp(out[i], out[i + 1], 0.75));
    }
    if (closed) {
      const last = out[out.length - 1], first = out[0];
      next.push(lerp(last, first, 0.25), lerp(last, first, 0.75));
    } else {
      next.push(out[out.length - 1]);
    }
    out = next;
  }
  return out;
}

/**
 * Moving average over positions. Endpoints stay pinned so the stroke
 * keeps its length — an unpinned average pulls the ends inward and
 * letters visibly shrink after a few passes.
 */
export function movingAverage(pts, half = 2) {
  if (half < 1 || pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || i === pts.length - 1) { out.push({ ...pts[i] }); continue; }
    const lo = Math.max(0, i - half), hi = Math.min(pts.length - 1, i + half);
    let sx = 0, sy = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sx += pts[j].x; sy += pts[j].y; n++; }
    out.push({ ...pts[i], x: sx / n, y: sy / n });
  }
  return out;
}

/**
 * Three passes, each doing one job:
 *
 *   1. simplify      drop duplicate and collinear points
 *   2. movingAverage remove sensor noise — this is what kills the shake
 *   3. chaikin       round whatever corners remain
 *
 * Chaikin alone barely touches jitter: with densely sampled input its
 * corner cuts are tiny, so the noise survives and the point count
 * quadruples. The averaging pass is what actually does the work.
 *
 * strength 0   — untouched
 * strength 0.5 — light tidy, keeps handwriting character  (default)
 * strength 1   — aggressive, good for diagrams and underlines
 */
export function smooth(pts, strength = 0.5) {
  if (!pts || pts.length < 3 || strength <= 0) return pts;
  const bb = bbox(pts);
  const scale = Math.max(Math.hypot(bb.w, bb.h), 1e-4);

  let out = simplify(pts, scale * 0.0008);
  out = movingAverage(out, 1 + Math.round(strength * 4));
  out = chaikin(out, strength > 0.6 ? 2 : 1);
  return simplify(out, scale * 0.0006);
}

/* ------------------------------------------------------------------ */
/* 2. SHAPE RECOGNITION                                                */
/* ------------------------------------------------------------------ */

function lineResidual(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  return mean(pts.map((p) => perpDist(p, a, b)));
}

function pathLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/**
 * Chord / path ratio. A straight stroke travels almost exactly the
 * distance between its endpoints, so the ratio sits near 1. A wavy
 * scribble covers far more ground than it spans, so the ratio drops —
 * which catches handwriting that happens to average out straight.
 */
function straightness(pts) {
  const len = pathLength(pts);
  if (len < 1e-9) return 0;
  return dist(pts[0], pts[pts.length - 1]) / len;
}

function isClosed(pts, diag) {
  return dist(pts[0], pts[pts.length - 1]) < diag * 0.25;
}

function circleScore(pts) {
  const c = centroid(pts);
  const rs = pts.map((p) => dist(p, c));
  const rm = mean(rs);
  if (rm < 1e-6) return { score: Infinity };
  return { score: mean(rs.map((r) => Math.abs(r - rm))) / rm, c, r: rm };
}

function rectScore(pts, bb) {
  // how far, on average, each point sits from the nearest edge of its
  // own bounding box — a real rectangle hugs it
  const d = pts.map((p) =>
    Math.min(
      Math.abs(p.x - bb.x0), Math.abs(p.x - bb.x1),
      Math.abs(p.y - bb.y0), Math.abs(p.y - bb.y1)
    )
  );
  return mean(d) / Math.max(Math.hypot(bb.w, bb.h), 1e-6);
}

/**
 * Guess what a stroke was meant to be. Returns null when nothing fits
 * well — which is most of the time, and deliberately so. Replacing
 * handwriting with a shape the user did not intend is far worse than
 * leaving a scribble alone.
 */
export function recognize(pts, { minSize = 0.02, strict = true } = {}) {
  if (!pts || pts.length < 6) return null;
  const bb = bbox(pts);
  const diag = Math.hypot(bb.w, bb.h);
  if (diag < minSize) return null;

  const tol = strict ? 1 : 1.6;
  const closed = isClosed(pts, diag);

  if (!closed) {
    // both tests must pass: low deviation from the chord AND an actual
    // path that does not wander
    const flat = lineResidual(pts) < diag * 0.025 * tol;
    const direct = straightness(pts) > (strict ? 0.93 : 0.88);
    if (flat && direct) {
      return { type: 'line', pts: [pts[0], pts[pts.length - 1]] };
    }
    return null;
  }

  const circ = circleScore(pts);
  if (circ.score < 0.14 * tol) {
    return { type: 'ellipse', cx: circ.c.x, cy: circ.c.y, rx: bb.w / 2, ry: bb.h / 2 };
  }
  if (rectScore(pts, bb) < 0.10 * tol) {
    return { type: 'rect', ...bb };
  }
  return null;
}

/** Turn a recognized shape back into a point list the renderer can draw. */
export function shapeToPoints(shape, samples = 64) {
  if (shape.type === 'line') return shape.pts.map((p) => ({ ...p }));

  if (shape.type === 'rect') {
    const { x0, y0, x1, y1 } = shape;
    return [
      { x: x0, y: y0 }, { x: x1, y: y0 },
      { x: x1, y: y1 }, { x: x0, y: y1 },
      { x: x0, y: y0 },
    ];
  }

  if (shape.type === 'ellipse') {
    const out = [];
    for (let i = 0; i <= samples; i++) {
      const t = (i / samples) * Math.PI * 2;
      out.push({
        x: shape.cx + Math.cos(t) * shape.rx,
        y: shape.cy + Math.sin(t) * shape.ry,
      });
    }
    return out;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 3. BASELINE STRAIGHTENING                                           */
/* ------------------------------------------------------------------ */

/**
 * Group strokes into lines of text by vertical overlap. Two strokes
 * belong to the same line when their vertical extents overlap by more
 * than `overlap` of the smaller one — which is how letters, dots and
 * crossbars stay with their own line.
 */
export function groupIntoLines(strokes, overlap = 0.22) {
  const items = strokes
    .map((s, i) => ({ i, s, bb: bbox(s.pts) }))
    .filter((it) => it.s.pts && it.s.pts.length > 1)
    .sort((a, b) => a.bb.y0 - b.bb.y0);

  const lines = [];
  for (const it of items) {
    let placed = false;
    for (const line of lines) {
      const lo = Math.max(line.bb.y0, it.bb.y0);
      const hi = Math.min(line.bb.y1, it.bb.y1);
      const inter = Math.max(0, hi - lo);
      const smaller = Math.min(line.bb.h, it.bb.h) || 1e-6;
      if (inter / smaller > overlap) {
        line.items.push(it);
        line.bb.y0 = Math.min(line.bb.y0, it.bb.y0);
        line.bb.y1 = Math.max(line.bb.y1, it.bb.y1);
        line.bb.h = line.bb.y1 - line.bb.y0;
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ items: [it], bb: { ...it.bb } });
  }
  return lines;
}

/** Ordinary least-squares slope through a set of points. */
function fitLine(pts) {
  if (pts.length < 2) return { m: 0, b: pts[0]?.y ?? 0 };
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  const m = den < 1e-9 ? 0 : num / den;
  return { m, b: my - m * mx };
}

/**
 * Anchor points for a line's baseline. With several strokes, the
 * bottom-centre of each word describes the baseline well. With a single
 * stroke there are no word positions to fit, so fall back to the
 * stroke's own points — which handles a lone underline or a long word.
 */
function baselineAnchors(items) {
  if (items.length >= 2) {
    return items.map((it) => ({ x: (it.bb.x0 + it.bb.x1) / 2, y: it.bb.y1 }));
  }
  return items[0].s.pts.map((p) => ({ x: p.x, y: p.y }));
}

function rotatePt(p, cx, cy, cos, sin) {
  const dx = p.x - cx, dy = p.y - cy;
  return { ...p, x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/**
 * The lines of text in a set of strokes. When the user has selected a
 * region, they have already said these strokes belong together —
 * grouping them again can only get it wrong, so `asOneLine` skips it.
 */
function linesOf(strokes, asOneLine) {
  if (!asOneLine) return groupIntoLines(strokes);
  return [{
    items: strokes
      .map((s, i) => ({ i, s, bb: bbox(s.pts) }))
      .filter((it) => it.s.pts?.length > 1),
    bb: bbox(strokes.flatMap((s) => s.pts ?? [])),
  }];
}

/**
 * Level each line of handwriting by rotating it onto a horizontal
 * baseline. Caps the correction — a large rotation means the grouping
 * was probably wrong, and silently spinning someone's notes is worse
 * than leaving them crooked.
 */
export function straighten(strokes, { maxDegrees = 12, asOneLine = false } = {}) {
  const out = strokes.map((s) => ({ ...s, pts: s.pts.slice() }));

  // a selection is levelled as selected; a whole page only has its
  // handwriting levelled, never the highlighter or placed shapes on it
  for (const line of linesOf(asOneLine ? strokes : writingOnly(strokes), asOneLine)) {
    if (!line.items.length) continue;

    const { m } = fitLine(baselineAnchors(line.items));
    const theta = Math.atan(m);
    if (Math.abs(theta) > (maxDegrees * Math.PI) / 180) continue;
    if (Math.abs(theta) < 0.004) continue; // already level

    const cx = (line.bb.x0 + line.bb.x1) / 2;
    const cy = (line.bb.y0 + line.bb.y1) / 2;
    const cos = Math.cos(-theta), sin = Math.sin(-theta);

    for (const it of line.items) {
      out[it.i].pts = out[it.i].pts.map((p) => rotatePt(p, cx, cy, cos, sin));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. SIZE AND SPACING                                                 */
/* ------------------------------------------------------------------ */

/**
 * Handwriting only: highlighter passes and placed shapes are not
 * letters, and resizing or respacing them is never what was meant.
 * Masking keeps the indices aligned with the caller's array.
 */
const isWriting = (s) => s.k !== 'hi' && !s.shape && s.pts?.length > 1;
const writingOnly = (strokes) => strokes.map((s) => (isWriting(s) ? s : { pts: [] }));

/**
 * The baseline under a line of letters: a least-squares fit through the
 * bottom of each stroke, refitted once without the strokes that hang
 * well below it, so a few descenders do not drag the line down.
 */
function fitBaseline(items, tolerance) {
  const anchors = items.map((it) => ({ x: (it.bb.x0 + it.bb.x1) / 2, y: it.bb.y1 }));
  const first = fitLine(anchors);
  const sitting = anchors.filter((p) => Math.abs(p.y - (first.m * p.x + first.b)) <= tolerance);
  return sitting.length >= 2 ? fitLine(sitting) : first;
}

/**
 * Even out letters that drift larger or smaller across a line.
 *
 * Each stroke's x-height is measured from its top down to the baseline,
 * not to its own lowest point — so the tail of a g, y or p does not
 * count as height and is never "corrected". Strokes far from the
 * line's typical height (ascenders, dots, crossbars) are left alone.
 */
export function normalizeSize(strokes, { maxScale = 0.25, strength = 1, asOneLine = false } = {}) {
  const out = strokes.map((s) => ({ ...s, pts: s.pts.slice() }));

  for (const line of linesOf(writingOnly(strokes), asOneLine)) {
    if (line.items.length < 3) continue;
    const rough = median(line.items.map((it) => it.bb.h));
    if (rough < 1e-6) continue;
    const base = fitBaseline(line.items, rough * 0.3);

    const body = [];
    for (const it of line.items) {
      const baseY = base.m * ((it.bb.x0 + it.bb.x1) / 2) + base.b;
      const descends = it.bb.y1 - baseY > rough * 0.3;
      const anchorY = descends ? baseY : it.bb.y1;
      const xh = anchorY - it.bb.y0;
      if (xh > rough * 0.45 && xh < rough * 1.6) body.push({ it, anchorY, xh });
    }
    if (body.length < 3) continue;

    const target = median(body.map((m) => m.xh));
    for (const { it, anchorY, xh } of body) {
      const f = clamp(1 + (target / xh - 1) * strength, 1 - maxScale, 1 + maxScale);
      if (Math.abs(f - 1) < 0.02) continue; // close enough already
      const ax = (it.bb.x0 + it.bb.x1) / 2;
      out[it.i].pts = out[it.i].pts.map((p) => ({
        ...p,
        x: ax + (p.x - ax) * f,
        y: anchorY + (p.y - anchorY) * f,
      }));
    }
  }
  return out;
}

/**
 * Split gaps into letter gaps and word gaps with 1-D k-means (k = 2).
 * Returns null unless the two clusters are clearly apart — a single
 * long word has one kind of gap, and inventing a word break in it
 * would be worse than leaving the spacing as written.
 */
export function classifyGaps(gaps) {
  if (gaps.length < 3) return null;
  let lo = Math.min(...gaps), hi = Math.max(...gaps);
  if (hi - lo < 1e-9) return null;

  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    const nlo = mean(gaps.filter((g) => g <= mid));
    const nhi = mean(gaps.filter((g) => g > mid));
    if (Math.abs(nlo - lo) + Math.abs(nhi - hi) < 1e-12) break;
    lo = nlo; hi = nhi;
  }

  const threshold = (lo + hi) / 2;
  const small = gaps.filter((g) => g <= threshold);
  const big = gaps.filter((g) => g > threshold);
  if (!small.length || !big.length) return null;
  if (hi < Math.max(lo, 1e-9) * 1.8) return null;
  if (Math.min(...big) < Math.max(...small) * 1.3) return null;

  return { threshold, intra: lo, inter: hi, isWord: gaps.map((g) => g > threshold) };
}

/**
 * Even out the horizontal gaps along a line: letter gaps move to the
 * mean letter gap and word gaps to the mean word gap. Because each
 * class moves to its own mean the line keeps its overall width, and
 * since every gap stays positive nothing is ever reordered.
 */
export function normalizeSpacing(strokes, { strength = 1, asOneLine = false } = {}) {
  const out = strokes.map((s) => ({ ...s, pts: s.pts.slice() }));

  for (const line of linesOf(writingOnly(strokes), asOneLine)) {
    // strokes that overlap horizontally (an i and its dot, a t and its
    // crossbar) are one glyph and must move together
    const glyphs = [];
    for (const it of [...line.items].sort((a, b) => a.bb.x0 - b.bb.x0)) {
      const g = glyphs[glyphs.length - 1];
      if (g && it.bb.x0 <= g.x1) {
        g.items.push(it);
        g.x1 = Math.max(g.x1, it.bb.x1);
      } else {
        glyphs.push({ items: [it], x0: it.bb.x0, x1: it.bb.x1 });
      }
    }

    const gaps = glyphs.slice(1).map((g, i) => g.x0 - glyphs[i].x1);
    const cls = classifyGaps(gaps);
    if (!cls) continue;

    let shift = 0;
    glyphs.slice(1).forEach((g, i) => {
      shift += ((cls.isWord[i] ? cls.inter : cls.intra) - gaps[i]) * strength;
      if (Math.abs(shift) < 1e-9) return;
      const dx = shift;
      for (const it of g.items) {
        out[it.i].pts = out[it.i].pts.map((p) => ({ ...p, x: p.x + dx }));
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 5. WHOLE-PAGE TIDY                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run the full pipeline over one page's strokes. Returns a NEW array
 * and never mutates its input, so the caller can keep the original for
 * undo or for a preview that might be cancelled.
 */
export function tidyPage(strokes, {
  smoothStrength = 0.5,
  shapes = false,
  level = false,
  size = false,
  spacing = false,
} = {}) {
  let out = strokes.map((s) => {
    // leave highlighter and placed shapes alone: they are already clean
    if (s.k === 'hi' || s.shape) return { ...s };
    const pts = smooth(s.pts, smoothStrength);

    if (shapes) {
      const shape = recognize(s.pts);
      const sp = shape && shapeToPoints(shape);
      if (sp) return { ...s, shape: shape.type, pts: sp.map((p) => ({ ...p, w: s.w })) };
    }
    return { ...s, pts };
  });

  if (level) out = straighten(out);
  if (size) out = normalizeSize(out);
  if (spacing) out = normalizeSpacing(out);
  return out;
}
