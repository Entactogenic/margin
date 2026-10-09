/**
 * export.js — stamp annotations back into a real PDF.
 *
 * Uses pdf-lib to draw the strokes as vector paths into the original
 * document, so the output opens anywhere and stays searchable. Runs
 * entirely in the browser; nothing is uploaded.
 *
 * Note: file downloads are blocked inside sandboxed preview frames.
 * This works when the app is served normally (localhost or a host).
 */

const { PDFDocument, rgb } = window.PDFLib ?? {};

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * @param {ArrayBuffer} srcBytes  the original PDF
 * @param {Object} strokes        { [pageNumber]: Stroke[] }  1-indexed
 * @param {Function} colorOf      token -> "#rrggbb"
 * @returns {Promise<Uint8Array>} the annotated PDF
 */
export async function stampPdf(srcBytes, strokes, colorOf) {
  if (!PDFDocument) throw new Error('pdf-lib is not loaded');

  const doc = await PDFDocument.load(srcBytes);
  const pages = doc.getPages();

  for (const [numStr, list] of Object.entries(strokes)) {
    const page = pages[Number(numStr) - 1];
    if (!page || !list?.length) continue;

    const { width: pw, height: ph } = page.getSize();

    for (const s of list) {
      if (!s.pts || s.pts.length < 2) continue;
      const color = hexToRgb(colorOf(s.c));
      const isHi = s.k === 'hi';
      const isPencil = s.k === 'pencil';

      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1], b = s.pts[i];
        page.drawLine({
          // normalized -> PDF points; PDF origin is bottom-left, ours is top-left
          start: { x: a.x * pw, y: ph - a.y * ph },
          end:   { x: b.x * pw, y: ph - b.y * ph },
          thickness: (isHi ? s.w : (b.w ?? s.w)) * pw,
          color,
          // pencil grain has no vector equivalent; its lightness carries over
          opacity: isHi ? 0.34 : isPencil ? (b.a ?? 0.8) * 0.8 : 1,
          lineCap: 1, // round
        });
      }
    }
  }
  return doc.save();
}

/** Trigger a browser download of the annotated file. */
export function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
