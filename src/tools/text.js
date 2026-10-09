/**
 * text.js — typed notes.
 *
 * A text box is stored in a page's stroke list like any stroke:
 *
 *   { k: 'text', shape: 'text', c, w, text, pts }
 *
 * `w` is the font size (as a fraction of page width, like every other
 * width) and `pts` is the outline of the box. Because it has points and
 * a width, everything that works on strokes — hit testing, the lasso,
 * moving, resizing, undo, saving — works on text without knowing it.
 */

export const LINE_HEIGHT = 1.3;
export const TEXT_FONT = 'Helvetica, Arial, sans-serif'; // Helvetica is what the PDF export uses

/**
 * Break text into lines no wider than maxWidth. `measure(s)` gives a
 * string's width; the screen and the PDF export each pass their own.
 */
export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) { // keeps the runs of spaces
      if (!word) continue;
      if (measure(line + word) <= maxWidth || !line.trim()) {
        line += word;
      } else {
        out.push(line.trimEnd());
        line = word.trim() ? word : '';
      }
      // a single word longer than the box: break it by character
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** The box as { x, y, width } in normalized coordinates. */
export function textBox(item) {
  return { x: item.pts[0].x, y: item.pts[0].y, width: item.pts[1].x - item.pts[0].x };
}

/**
 * A text item at (x, y), `width` wide. Its height comes from how the
 * text wraps, which needs `measure` (for a font size of 1) and the
 * page's aspect (width / height).
 */
export function makeText({ x, y, width, size, color, text }, measure, aspect) {
  const lines = wrapText(text, width / size, measure);
  const height = lines.length * size * LINE_HEIGHT * aspect;
  return {
    k: 'text', shape: 'text', c: color, w: size, text,
    pts: [
      { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y },
    ],
  };
}

/** Paint a text item onto a context sized to w x h CSS pixels. */
export function paintText(ctx, item, w, h, color) {
  const box = textBox(item);
  const px = item.w * w;
  ctx.save();
  ctx.font = `${px}px ${TEXT_FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  const lines = wrapText(item.text, box.width * w, (s) => ctx.measureText(s).width);
  lines.forEach((line, i) => ctx.fillText(line, box.x * w, box.y * h + i * px * LINE_HEIGHT + px * 0.15));
  ctx.restore();
}
