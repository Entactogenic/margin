/** Synthetic ink for the tests. Everything is seeded, so runs are repeatable. */

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}

export function box(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

export const stddev = (xs) => {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
};

/**
 * A round letter (an "o") sitting on `baseline`, `height` tall, with
 * its left edge at `x`. `tail` hangs a descender below the baseline.
 */
export function letter(x, baseline, height, { width = height * 0.8, tail = 0, n = 24 } = {}) {
  const pts = [];
  const cx = x + width / 2, cy = baseline - height / 2;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + (Math.cos(t) * width) / 2, y: cy + (Math.sin(t) * height) / 2, w: 0.003 });
  }
  if (tail > 0) {
    for (let i = 1; i <= 6; i++) pts.push({ x: x + width, y: baseline + (tail * i) / 6, w: 0.003 });
  }
  return { k: 'pen', c: '--pen-1', w: 0.003, pts };
}

/** A line of letters from a list of { height, gap, tail } descriptions. */
export function lineOf(specs, { x = 0.1, baseline = 0.3 } = {}) {
  const out = [];
  let cursor = x;
  for (const s of specs) {
    cursor += s.gap ?? 0;
    const l = letter(cursor, baseline, s.height, { width: s.width ?? 0.016, tail: s.tail ?? 0 });
    out.push(l);
    cursor += s.width ?? 0.016;
  }
  return out;
}

/** Horizontal gaps between consecutive strokes, left to right. */
export function gapsOf(strokes) {
  const boxes = strokes.map((s) => box(s.pts)).sort((a, b) => a.x0 - b.x0);
  return boxes.slice(1).map((b, i) => b.x0 - boxes[i].x1);
}
