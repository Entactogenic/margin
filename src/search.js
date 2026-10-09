/**
 * search.js — finding text in a PDF page, and snapping the highlighter
 * to its lines.
 *
 * Works on text items as { str, x, y, w, h }: the string, and its box
 * in normalized page coordinates with (x, y) the top-left corner. main.js
 * makes these from the pdf.js text layer; nothing here touches pdf.js.
 */

/**
 * Every occurrence of `query` on a page, each as a list of rectangles
 * (a match can run across several text items, or wrap onto a new line).
 *
 * Matching ignores case and all whitespace. PDFs split text into items
 * wherever they please — mid-word, between words with no space, at
 * every line end — so the spaces in the items mean very little.
 */
export function findMatches(items, query) {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return [];

  // the page's text with whitespace removed, and where each character came from
  let hay = '';
  const from = []; // from[k] = [item index, character index]
  items.forEach((it, i) => {
    for (let c = 0; c < it.str.length; c++) {
      if (/\s/.test(it.str[c])) continue;
      hay += it.str[c].toLowerCase();
      from.push([i, c]);
    }
  });
  if (hay.length !== from.length) return []; // a character that changes length when lowercased

  const out = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    const rects = [];
    let k = at;
    while (k < at + needle.length) {
      const [i, c0] = from[k];
      let c1 = c0;
      while (k < at + needle.length && from[k][0] === i) { c1 = from[k][1]; k++; }
      // items do not say where each letter sits; assume even spacing within one
      const it = items[i], n = it.str.length;
      rects.push({ x: it.x + (it.w * c0) / n, y: it.y, w: (it.w * (c1 + 1 - c0)) / n, h: it.h });
    }
    out.push({ rects });
  }
  return out;
}

/**
 * The lines of text on a page: items that sit at the same height,
 * merged. Each is { x0, x1, y0, y1 }.
 */
export function textLines(items) {
  const lines = [];
  for (const it of [...items].filter((i) => i.str.trim() && i.h > 0).sort((a, b) => a.y - b.y)) {
    const mid = it.y + it.h / 2;
    // only lines that overlap this item horizontally-adjacent text: two
    // columns at the same height are still two lines
    const line = lines.find((l) => mid > l.y0 && mid < l.y1 && it.x < l.x1 + it.h * 2 && it.x + it.w > l.x0 - it.h * 2);
    if (line) {
      line.x0 = Math.min(line.x0, it.x);
      line.x1 = Math.max(line.x1, it.x + it.w);
      line.y0 = Math.min(line.y0, it.y);
      line.y1 = Math.max(line.y1, it.y + it.h);
    } else {
      lines.push({ x0: it.x, x1: it.x + it.w, y0: it.y, y1: it.y + it.h });
    }
  }
  return lines;
}

/**
 * If a highlighter stroke was drawn along a line of text, the band
 * that covers that line exactly: { x0, x1, y, h }, with y the centre.
 * Null if the stroke is not on a line — highlighting a figure, or
 * drawing a vertical bar down the margin, is left as drawn.
 */
export function snapHighlight(pts, lines) {
  if (!pts?.length || !lines?.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const cy = (y0 + y1) / 2;

  let best = null, bestD = Infinity;
  for (const l of lines) {
    const lh = l.y1 - l.y0, mid = (l.y0 + l.y1) / 2;
    if (y1 - y0 > lh * 2.5) continue;               // too tall to be along one line
    if (x1 < l.x0 || x0 > l.x1) continue;           // beside the line, not on it
    const d = Math.abs(cy - mid);
    if (d < lh * 0.75 && d < bestD) { best = l; bestD = d; }
  }
  if (!best) return null;

  const lh = best.y1 - best.y0;
  const from = Math.max(x0, best.x0), to = Math.min(x1, best.x1);
  if (to - from < lh * 0.5) return null;            // a dab, not a sweep
  return { x0: from, x1: to, y: (best.y0 + best.y1) / 2, h: lh * 1.15 };
}
