/**
 * export.js — stamp annotations back into a real PDF.
 *
 * Uses pdf-lib to draw the strokes as vector paths into the original
 * document, so the output opens anywhere and stays searchable. Blank
 * pages are inserted where the layout has them, ruled as on screen;
 * pages are widened where there is a margin; typed notes become real
 * text. Runs entirely in the browser; nothing is uploaded.
 *
 * Note: file downloads are blocked inside sandboxed preview frames.
 * This works when the app is served normally (localhost or a host).
 */

import { isBlank, paperMarks, BLANK_SIZE } from './pages.js';
import { wrapText, textBox, LINE_HEIGHT } from './tools/text.js';

const { PDFDocument, StandardFonts, rgb } = window.PDFLib ?? {};

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * @param {ArrayBuffer} srcBytes  the original PDF; empty for a notebook
 * @param {Object} strokes        { [pageId]: Stroke[] }
 * @param {Function} colorOf      token -> "#rrggbb"
 * @param {Object} layout         { order, blanks, margin } — see pages.js
 * @returns {Promise<Uint8Array>} the annotated PDF
 */
export async function stampPdf(srcBytes, strokes, colorOf, layout) {
  if (!PDFDocument) throw new Error('pdf-lib is not loaded');

  const doc = srcBytes?.byteLength ? await PDFDocument.load(srcBytes) : await PDFDocument.create();

  // Blank pages go in where the layout has them. PDF pages are never
  // reordered, so after this the document's pages are in layout order.
  let size = doc.getPageCount() ? doc.getPage(0).getSize() : { width: BLANK_SIZE.w, height: BLANK_SIZE.h };
  layout.order.forEach((id, i) => {
    if (!isBlank(id)) { size = doc.getPage(i).getSize(); return; }
    const page = doc.insertPage(i, [size.width, size.height]);
    const { lines, dots } = paperMarks(layout.blanks[id].paper, size.width, size.height);
    const ruling = rgb(0.79, 0.83, 0.86);
    for (const [x0, y0, x1, y1] of lines) {
      page.drawLine({ start: { x: x0, y: size.height - y0 }, end: { x: x1, y: size.height - y1 }, thickness: 0.5, color: ruling });
    }
    for (const [x, y] of dots) page.drawCircle({ x, y: size.height - y, size: 0.7, color: ruling });
  });

  let font = null; // embedded only if there is text to set
  let encodable = null;
  // the built-in PDF fonts cover Western European text only; anything else becomes "?"
  const safe = (s) => [...s].map((ch) => (encodable.has(ch.codePointAt(0)) ? ch : '?')).join('');

  const pages = doc.getPages();
  for (const [i, id] of layout.order.entries()) {
    const page = pages[i];
    const list = strokes[id];
    if (!page) continue;

    // widths and positions are measured against the page itself; the margin is extra, to the right
    const { width: pw, height: ph } = page.getSize();
    if (layout.margin) page.setSize(pw * (1 + layout.margin), ph);
    if (!list?.length) continue;

    for (const s of list) {
      if (!s.pts || s.pts.length < 2) continue;
      const color = hexToRgb(colorOf(s.c));

      if (s.k === 'text') {
        if (!font) {
          font = await doc.embedFont(StandardFonts.Helvetica);
          encodable = new Set(font.getCharacterSet());
        }
        const box = textBox(s);
        const fontSize = s.w * pw;
        const text = safe(s.text.replace(/\t/g, '    '));
        const lines = wrapText(text, box.width * pw, (t) => font.widthOfTextAtSize(t, fontSize));
        lines.forEach((line, n) => {
          if (!line) return;
          // the screen draws from the top of each line; a PDF draws from the baseline
          const top = box.y * ph + n * fontSize * LINE_HEIGHT + fontSize * 0.15;
          page.drawText(line, { x: box.x * pw, y: ph - top - fontSize * 0.76, size: fontSize, font, color });
        });
        continue;
      }

      const isHi = s.k === 'hi';
      const isPencil = s.k === 'pencil';
      for (let k = 1; k < s.pts.length; k++) {
        const a = s.pts[k - 1], b = s.pts[k];
        page.drawLine({
          // normalized -> PDF points; PDF origin is bottom-left, ours is top-left
          start: { x: a.x * pw, y: ph - a.y * ph },
          end:   { x: b.x * pw, y: ph - b.y * ph },
          thickness: (isHi ? s.w : (b.w ?? s.w)) * pw,
          color,
          // pencil grain has no vector equivalent; its lightness carries over
          opacity: isHi ? 0.34 : isPencil ? (b.a ?? 0.8) * 0.8 : 1,
          lineCap: s.flat ? 0 : 1, // butt for a highlight snapped to text, else round
        });
      }
    }
  }
  return doc.save();
}

/** Trigger a browser download. `data` is bytes or a Blob. */
export function download(data, filename, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
