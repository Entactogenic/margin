/**
 * gestures.js — telling a deliberate gesture from ordinary touching.
 *
 * Pure decisions over positions and times; main.js feeds them events.
 */

/**
 * Multi-finger taps: two fingers, three fingers.
 *
 * A tap is fingers that land together, barely move, and lift soon. The
 * same touches also begin every two-finger scroll and every pinch, so
 * the detector only speaks once all fingers are up, and stays silent if
 * any of them travelled, lingered, or arrived late.
 *
 * Feed it every touch event: `kind` is 'start' | 'move' | 'end' |
 * 'cancel', `touches` is every touch still down as { id, x, y, type }.
 */
export function createTapDetector({ onTap, maxMs = 350, maxMove = 14, maxStagger = 160 } = {}) {
  let g = null; // the gesture in progress

  return function feed(kind, touches, t) {
    if (kind === 'start') {
      // A lone finger is always the first of a new gesture, and so are
      // fingers the last gesture never saw. (Ids alone cannot be trusted:
      // some browsers hand the same small numbers out again.)
      if (g && (touches.length === 1 || !touches.some((p) => g.origin.has(p.id)))) g = null;
      g ??= { t0: t, origin: new Map(), most: 0, ok: true };
      if (t - g.t0 > maxStagger) g.ok = false; // a finger that joins late is not part of a tap
      for (const p of touches) {
        if (p.type === 'stylus') g.ok = false;
        if (!g.origin.has(p.id)) g.origin.set(p.id, { x: p.x, y: p.y });
      }
      g.most = Math.max(g.most, touches.length);
      return;
    }
    if (!g) return;

    if (kind === 'move') {
      for (const p of touches) {
        const o = g.origin.get(p.id);
        if (o && Math.hypot(p.x - o.x, p.y - o.y) > maxMove) g.ok = false;
      }
      return;
    }

    // The browser took the touches over: it is scrolling or zooming, and
    // may not report these fingers again, even when they lift.
    if (kind === 'cancel') { g = null; return; }

    if (touches.length === 0) {
      const done = g;
      g = null;
      if (done.ok && t - done.t0 <= maxMs && (done.most === 2 || done.most === 3)) onTap(done.most);
    }
  };
}

/**
 * Has the pen been resting at the end of its stroke?
 *
 * True when the stroke travelled somewhere and then every point for the
 * last `holdMs` stayed within `radius` of where it is now. A digitizer
 * never reports a perfectly still pen, hence a radius rather than zero.
 */
export function heldStill(pts, now, { holdMs = 500, radius = 0.004 } = {}) {
  if (pts.length < 8) return false;
  const last = pts[pts.length - 1];
  for (let i = pts.length - 2; i >= 0; i--) {
    if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) > radius) {
      // pts[i + 1] is where the pen came to rest
      return now - pts[i + 1].t >= holdMs;
    }
  }
  return false; // it never went anywhere: a dot, not a stroke
}

/**
 * The stroke without the points piled up where the pen came to rest.
 * Left in, that pile drags the centroid toward one end and a held
 * circle stops looking like a circle.
 */
export function trimRest(pts, radius = 0.004) {
  const last = pts[pts.length - 1];
  let end = pts.length - 1;
  while (end > 0 && Math.hypot(pts[end - 1].x - last.x, pts[end - 1].y - last.y) <= radius) end--;
  return pts.slice(0, end + 1);
}
