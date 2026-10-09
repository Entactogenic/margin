/**
 * zoombox.js — geometry for the zoom writing box.
 *
 * The box is a strip at the bottom of the screen showing a small
 * rectangle of the page — the target — magnified. Ink written in the
 * strip is mapped straight into page coordinates, so what is stored is
 * an ordinary stroke; nothing downstream knows it was written large.
 *
 * A target is { x, y, w, h } in normalized page coordinates.
 */

/** Strip position (fractions 0..1 of the strip) -> page coordinates. */
export function stripToPage(target, fx, fy) {
  return { x: target.x + fx * target.w, y: target.y + fy * target.h };
}

/** Page coordinates -> strip position (fractions of the strip). */
export function pageToStrip(target, x, y) {
  return { fx: (x - target.x) / target.w, fy: (y - target.y) / target.h };
}

// keep a span of `size` within 0..max
const clampSpan = (v, size, max = 1) => Math.min(max - size, Math.max(0, v));

/**
 * The target that a strip of stripW x stripH pixels shows at `zoom`,
 * centred on (cx, cy) where it fits. The target has the strip's shape,
 * so ink is never stretched.
 */
export function targetFor({ stripW, stripH, pageW, pageH, zoom, cx, cy, xmax = 1 }) {
  // never wider or taller than the page: on a narrow page, magnify more
  const k = Math.max(zoom, stripW / (pageW * xmax), stripH / pageH);
  const w = stripW / k / pageW, h = stripH / k / pageH;
  return { x: clampSpan(cx - w / 2, w, xmax), y: clampSpan(cy - h / 2, h), w, h };
}

/** How many strip pixels one page pixel occupies. */
export function magnification(target, stripW, pageW) {
  return stripW / (target.w * pageW);
}

/**
 * Move the target along as writing fills it: `step` is 'right', 'left'
 * or 'line'. Stepping right off the edge of the page starts a new line.
 */
export function advance(target, step, { overlap = 0.25, margin = 0.04, xmax = 1 } = {}) {
  const stride = target.w * (1 - overlap);
  const line = () => ({ ...target, x: clampSpan(margin, target.w, xmax), y: clampSpan(target.y + target.h * 0.85, target.h) });

  if (step === 'line') return line();
  if (step === 'left') return { ...target, x: clampSpan(target.x - stride, target.w, xmax) };
  if (target.x + target.w >= xmax - 1e-9) return line();
  return { ...target, x: clampSpan(target.x + stride, target.w, xmax) };
}
