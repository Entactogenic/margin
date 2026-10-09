/**
 * scratch.js — scratch-out: a fast back-and-forth scribble that deletes
 * what is under it.
 *
 * The hard part is not recognising a scribble, it is never mistaking
 * handwriting for one. The test that separates them:
 *
 *   Handwriting travels along its long axis and wiggles across it.
 *   A scribble travels back and forth along its long axis.
 *
 * So the stroke is projected onto its own principal axis and the full
 * reversals along that axis are counted. A cursive word has none: it
 * only ever advances. Letters that do zigzag (M, W) reverse three
 * times; a scratch-out needs at least four, quickly, and has to cover
 * something.
 *
 * One more thing goes back and forth along its long axis: circling a
 * word several times for emphasis. That is told apart by being hollow —
 * the pen keeps to the outside and never crosses the middle.
 */

const MIN_REVERSALS = 4;    // five passes or more
const MIN_SWING = 0.35;     // a reversal must come back this share of the extent
const MIN_TRAVEL = 4;       // path length, in extents
const MIN_RATE = 3;         // reversals per second
const MIN_EXTENT = 0.025;   // in page heights: smaller than this is a letter
const COVERED = 0.6;        // share of a stroke that must lie under the scribble
const HOLLOW = 0.7;         // how far out the pen keeps, mid-stroke, for a ring
const FAT = 0.25;           // across / along: thinner than this cannot be a ring

/**
 * Is this stroke a scratch-out? Returns its bounding box if so, else
 * null. `aspect` is page width / height, so distances are measured as
 * they look on screen rather than in stretched page units.
 */
export function scratchOut(pts, aspect = 1) {
  if (!pts || pts.length < 12) return null;
  const xs = pts.map((p) => p.x * aspect), ys = pts.map((p) => p.y);
  const n = pts.length;
  const mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n;

  // principal axis: the direction the stroke is longest in
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ax = Math.cos(theta), ay = Math.sin(theta);
  const along = xs.map((x, i) => (x - mx) * ax + (ys[i] - my) * ay);

  const extent = Math.max(...along) - Math.min(...along);
  if (extent < MIN_EXTENT) return null;

  let travel = 0;
  for (let i = 1; i < n; i++) travel += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  if (travel < extent * MIN_TRAVEL) return null;

  // Count reversals with hysteresis: the stroke has turned round only
  // once it has come back MIN_SWING of the extent from its furthest
  // point. Small backward loops, as in an e or an l, never get that far.
  const swing = extent * MIN_SWING;
  let dir = 0, extreme = along[0], reversals = 0;
  for (const u of along) {
    if (dir === 0) {
      if (Math.abs(u - extreme) >= swing) { dir = Math.sign(u - extreme); extreme = u; }
    } else if ((u - extreme) * dir > 0) {
      extreme = u;
    } else if ((extreme - u) * dir >= swing) {
      reversals++;
      dir = -dir;
      extreme = u;
    }
  }
  if (reversals < MIN_REVERSALS) return null;

  // A ring drawn round and round: wherever the pen is halfway along,
  // it is out at one side or the other, never in between.
  const across = xs.map((x, i) => (ys[i] - my) * ax - (x - mx) * ay);
  const lo = Math.min(...across), hi = Math.max(...across);
  if ((hi - lo) / extent > FAT) {
    const midAlong = (Math.max(...along) + Math.min(...along)) / 2;
    const midAcross = (hi + lo) / 2;
    const central = across.filter((_, i) => Math.abs(along[i] - midAlong) < extent * 0.15);
    const out = central.reduce((a, v) => a + Math.abs(v - midAcross), 0) / (central.length || 1);
    if (central.length && out / ((hi - lo) / 2) > HOLLOW) return null;
  }

  // a scribble is quick; careful zigzags (a resistor, hatching) are not
  const seconds = (pts[n - 1].t - pts[0].t) / 1000;
  if (seconds > 0 && reversals / seconds < MIN_RATE) return null;

  return {
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...ys), y1: Math.max(...ys),
    reversals,
  };
}

/**
 * Indices of the strokes a scratch-out covers: those lying mostly
 * within its box. A stroke that only passes through — the border of a
 * box that was shaded in, a long underline — is left alone.
 */
export function scratchTargets(strokes, box, skip = null) {
  const out = [];
  strokes.forEach((s, i) => {
    if (s === skip || !s.pts?.length) return;
    const under = s.pts.filter((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1).length;
    if (under / s.pts.length >= COVERED) out.push(i);
  });
  return out;
}
