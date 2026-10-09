/**
 * lasso.js — selecting strokes with a loop, and what can be done to them.
 *
 * Everything here returns new strokes and leaves its input alone, so
 * the caller can preview a move or resize on every pointer event and
 * commit only once, as a single undo step.
 */

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Indices of the strokes a lasso encloses. A hand-drawn loop is never
 * exact, so a stroke counts when most of it is inside — but a stroke
 * the loop merely cuts across does not.
 */
export function strokesInLasso(strokes, poly, share = 0.75) {
  if (poly.length < 3) return [];
  const out = [];
  strokes.forEach((s, i) => {
    if (!s.pts?.length) return;
    const inside = s.pts.filter((p) => insidePolygon(p, poly)).length;
    if (inside / s.pts.length >= share) out.push(i);
  });
  return out;
}

export function boundsOf(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (const p of s.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * The move (dx, dy), shortened if needed so the box stays on the page.
 * `xmax` is the page's right edge: 1, or more when it has a margin.
 */
export function clampMove(box, dx, dy, xmax = 1) {
  return {
    dx: Math.min(xmax - box.x1, Math.max(-box.x0, dx)),
    dy: Math.min(1 - box.y1, Math.max(-box.y0, dy)),
  };
}

/**
 * The scale that puts the box's bottom-right corner under the pen, with
 * its top-left corner fixed. Proportions are kept — handwriting
 * stretched one way only is never what was wanted — and the result is
 * limited so the selection neither vanishes nor leaves the page.
 */
export function resizeScale(box, pt, { min = 0.2, max = 6, xmax = 1 } = {}) {
  const bw = Math.max(box.x1 - box.x0, 1e-6), bh = Math.max(box.y1 - box.y0, 1e-6);
  const wanted = Math.max((pt.x - box.x0) / bw, (pt.y - box.y0) / bh);
  const fits = Math.min((xmax - box.x0) / bw, (1 - box.y0) / bh);
  return Math.max(min, Math.min(wanted, fits, max));
}

/**
 * Scale about (ox, oy), then move by (dx, dy). Ink weight scales with
 * the strokes: shrunk handwriting drawn at full weight is a blot.
 */
export function transformStrokes(strokes, { dx = 0, dy = 0, scale = 1, ox = 0, oy = 0 } = {}) {
  return strokes.map((s) => ({
    ...s,
    w: s.w * scale,
    pts: s.pts.map((p) => {
      const q = { ...p, x: ox + (p.x - ox) * scale + dx, y: oy + (p.y - oy) * scale + dy };
      if (p.w != null) q.w = p.w * scale;
      return q;
    }),
  }));
}

/**
 * Recolour. A highlighter colour only applies to highlighter strokes
 * and an ink colour only to ink, so a mixed selection keeps its kinds.
 */
export function recolorStrokes(strokes, token) {
  const forHighlighter = token.startsWith('--hi');
  return strokes.map((s) => ((s.k === 'hi') === forHighlighter ? { ...s, c: token } : s));
}
