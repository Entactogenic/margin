/**
 * pages.js — what pages a document has, and in what order.
 *
 * A document's layout is { order, blanks, margin }:
 *
 *   order   page ids, top to bottom. A PDF page's id is its page number
 *           (1, 2, 3…); a blank page's id is a string ('b1', 'b2'…).
 *   blanks  id -> { paper } for each blank page
 *   margin  extra writing space to the right of every page, as a
 *           fraction of the page's width (0 for none)
 *
 * Strokes are stored per page id, so a PDF page's notes stay keyed by
 * its page number exactly as they always were, and inserting a blank
 * page between two PDF pages renumbers nothing.
 *
 * Coordinates stay normalized to the page itself. With a margin, x
 * simply runs past 1 — ink in the margin is ink at x = 1.2.
 */

export const PAPERS = ['plain', 'lined', 'grid', 'dotted'];
export const MARGIN = 0.4;

// a blank page's shape when there is no PDF page to copy: US Letter
export const BLANK_SIZE = { w: 612, h: 792 };

export const isBlank = (id) => typeof id === 'string';

export function defaultLayout(pdfPages) {
  return {
    order: Array.from({ length: pdfPages }, (_, i) => i + 1),
    blanks: {},
    margin: 0,
  };
}

/**
 * A layout that is safe to render, whatever was stored: every PDF page
 * present exactly once, nothing that does not exist, at least one page.
 */
export function repairLayout(layout, pdfPages) {
  const blanks = {};
  const order = [];
  const seen = new Set();
  for (const id of layout?.order ?? []) {
    if (seen.has(id)) continue;
    if (isBlank(id)) {
      const b = layout.blanks?.[id];
      if (!b) continue;
      blanks[id] = { paper: PAPERS.includes(b.paper) ? b.paper : 'plain' };
    } else if (!(Number.isInteger(id) && id >= 1 && id <= pdfPages)) {
      continue;
    }
    seen.add(id);
    order.push(id);
  }
  // PDF pages the layout forgot go back in page order, each after its predecessor
  for (let n = 1; n <= pdfPages; n++) {
    if (seen.has(n)) continue;
    const prev = order.indexOf(n - 1);
    order.splice(prev < 0 ? (n === 1 ? 0 : order.length) : prev + 1, 0, n);
    seen.add(n);
  }
  if (!order.length) {
    blanks.b1 = { paper: 'plain' };
    order.push('b1');
  }
  const margin = Number.isFinite(layout?.margin) ? Math.min(1, Math.max(0, layout.margin)) : 0;
  return { order, blanks, margin };
}

/** A new layout with a blank page after `afterId` (or first, if null). Returns [layout, id]. */
export function insertBlank(layout, afterId, paper = 'plain') {
  const used = Object.keys(layout.blanks).map((id) => Number(id.slice(1)) || 0);
  const id = `b${Math.max(0, ...used) + 1}`;
  const at = afterId == null ? 0 : layout.order.indexOf(afterId) + 1;
  const order = layout.order.slice();
  order.splice(at, 0, id);
  return [{ ...layout, order, blanks: { ...layout.blanks, [id]: { paper } } }, id];
}

/** A new layout without blank page `id`. PDF pages cannot be removed; nor can the last page. */
export function removeBlank(layout, id) {
  if (!isBlank(id) || !layout.blanks[id] || layout.order.length < 2) return layout;
  const blanks = { ...layout.blanks };
  delete blanks[id];
  return { ...layout, order: layout.order.filter((p) => p !== id), blanks };
}

/**
 * The ruling for a sheet of paper w x h (any unit): line segments
 * [x0, y0, x1, y1] and dot centres [x, y], measured from the top left.
 * The screen and the exported PDF both draw from this, so they agree.
 */
export function paperMarks(paper, w, h) {
  const lines = [], dots = [];
  const gap = w / 27; // about 8mm on a Letter page

  if (paper === 'lined') {
    for (let y = gap * 3; y < h - gap; y += gap) lines.push([gap, y, w - gap, y]);
  } else if (paper === 'grid') {
    const cols = Math.floor(w / gap), rows = Math.floor(h / gap);
    const ox = (w - cols * gap) / 2, oy = (h - rows * gap) / 2; // centred, so the edges match
    for (let i = 0; i <= cols; i++) lines.push([ox + i * gap, oy, ox + i * gap, oy + rows * gap]);
    for (let j = 0; j <= rows; j++) lines.push([ox, oy + j * gap, ox + cols * gap, oy + j * gap]);
  } else if (paper === 'dotted') {
    const cols = Math.floor(w / gap), rows = Math.floor(h / gap);
    const ox = (w - cols * gap) / 2, oy = (h - rows * gap) / 2;
    for (let j = 1; j < rows; j++) for (let i = 1; i < cols; i++) dots.push([ox + i * gap, oy + j * gap]);
  }
  return { lines, dots };
}
