/**
 * shapes.js — drag-to-place shapes.
 *
 * A placed shape is an ordinary stroke: a point list in normalized page
 * coordinates. Nothing downstream — rendering, erasing, undo, saving,
 * export — knows or cares that it was not drawn freehand.
 *
 * Pages are not square, so "square", "circle" and "45°" only mean
 * anything on screen. `aspect` is the page's width / height in pixels;
 * constraints are worked out in a space where both axes share a unit.
 */

import { shapeToPoints } from '../cleanup.js';

const HEAD_FRACTION = 0.22;   // arrow head length, as a share of the line
const HEAD_MAX = 0.05;        // ...capped, in page heights
const HEAD_ANGLE = Math.PI / 7;

/** Where the drag should end once Shift constrains it. */
export function constrainEnd(kind, a, b, aspect = 1) {
  const dx = (b.x - a.x) * aspect, dy = b.y - a.y;

  if (kind === 'rect' || kind === 'ellipse') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: a.x + ((dx < 0 ? -side : side) / aspect),
      y: a.y + (dy < 0 ? -side : side),
    };
  }

  const len = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const theta = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + (Math.cos(theta) * len) / aspect, y: a.y + Math.sin(theta) * len };
}

/** On-screen length of the drag, in page heights. Used to reject taps. */
export function dragLength(a, b, aspect = 1) {
  return Math.hypot((b.x - a.x) * aspect, b.y - a.y);
}

/**
 * The point list for a shape dragged from `a` to `b`.
 * Rectangles and ellipses are drawn corner to corner.
 */
export function dragShape(kind, a, b, { constrain = false, aspect = 1 } = {}) {
  const from = { x: a.x, y: a.y };
  const to = constrain ? constrainEnd(kind, a, b, aspect) : { x: b.x, y: b.y };

  const x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x);
  const y0 = Math.min(from.y, to.y), y1 = Math.max(from.y, to.y);

  if (kind === 'rect') return shapeToPoints({ type: 'rect', x0, y0, x1, y1 });

  if (kind === 'ellipse') {
    return shapeToPoints({
      type: 'ellipse',
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      rx: (x1 - x0) / 2, ry: (y1 - y0) / 2,
    });
  }

  const line = shapeToPoints({ type: 'line', pts: [from, to] });
  if (kind !== 'arrow') return line;

  // the head: out to one barb, back to the tip, out to the other
  const dx = (to.x - from.x) * aspect, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return line;
  const head = Math.min(len * HEAD_FRACTION, HEAD_MAX);
  const back = Math.atan2(dy, dx) + Math.PI;
  const barb = (turn) => ({
    x: to.x + (Math.cos(back + turn) * head) / aspect,
    y: to.y + Math.sin(back + turn) * head,
  });
  return [...line, barb(HEAD_ANGLE), { ...to }, barb(-HEAD_ANGLE)];
}
