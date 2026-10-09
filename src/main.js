/**
 * main.js — app controller: document views, rendering, tools, undo, wiring.
 *
 * Strokes live in normalized page coordinates (0..1), so zoom, resize
 * and export all work from the same data without re-fitting anything.
 *
 * Each open document is a "view": its PDF, its strokes, its undo stack
 * and its rendered pages. The last few views stay in memory so moving
 * between documents is a DOM swap rather than a re-render.
 */

import * as Ink from './ink.js';
import * as Store from './store.js';
import { tidyPage, straighten, recognize, shapeToPoints, smooth } from './cleanup.js';
import { stampPdf, download } from './export.js';
import { initLibrary, createLru, cycleKey, sortDocs, formatSize, storageNote } from './library.js';
import { createHistory } from './history.js';
import { createTapDetector, heldStill, trimRest } from './gestures.js';
import { strokesInLasso, boundsOf, clampMove, resizeScale, transformStrokes, recolorStrokes } from './tools/lasso.js';
import { scratchOut, scratchTargets } from './tools/scratch.js';
import { stripToPage, pageToStrip, targetFor, magnification, advance } from './tools/zoombox.js';
import { repairLayout, insertBlank, removeBlank, isBlank, paperMarks, MARGIN, BLANK_SIZE } from './pages.js';
import { findMatches, textLines, snapHighlight } from './search.js';
import { makeText, textBox, LINE_HEIGHT, TEXT_FONT } from './tools/text.js';
import { packBackup, readBackup, BACKUP_EXT, BACKUP_TYPE } from './backup.js';
import { pencilAlpha } from './tools/pencil.js';
import { dragShape, dragLength } from './tools/shapes.js';
import { loadPrefs, savePrefs, PALETTES, TOOLS, SHAPES } from './tools/prefs.js';

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const state = {
  view: null,         // the open document, see makeView()
  prefs: loadPrefs(() => localStorage),
  stylusOnly: false,
  penSeen: false,     // has a stylus touched down this session?
  predicting: false,  // has the browser supplied predicted pen positions this session?
  penDown: false,     // is a pen gesture in progress right now?
  lastPointer: '',    // pointerType of the most recent pointerdown
  autoSmooth: true,
  preview: null,      // { rec, list, cleaned } while a tidy preview is open
  textEdit: null,     // { rec, el, item, ... } while a text box is being typed in
  search: { q: '', hits: [], cur: -1, run: 0 }, // hits are { page, rects }
  thumbIo: null,      // IntersectionObserver painting sidebar thumbnails as they appear
  cancelDrag: null,   // set while a shape, lasso or selection drag is in progress
  gesture: false,     // is any pointer gesture in progress, on the page or in the zoom box?
  abortFingerStroke: null, // set while a finger is drawing; a second finger calls it
  selection: null,    // { rec, idx, box } — strokes held by the lasso
  zoomBox: null,      // { rec, target, ... } while the zoom writing box is open
};

const KEEP_VIEWS = 3;
const views = createLru(KEEP_VIEWS, dropView);
let library = null;
let cycle = null;     // last-opened order, frozen while stepping with Ctrl+[ / ]

// stroke width at weight 1, in page widths
// (for text, the font size)
const BASE_WIDTH = { pen: 0.0032, pencil: 0.0038, highlight: 0.018, shape: 0.0032, text: 0.02 };
const SHAPE_LABELS = { rect: 'Box', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' };
const ERASER_LABELS = { stroke: 'Whole stroke', area: 'Area' };

const $ = (id) => document.getElementById(id);

const colorCache = new Map();
function colorOf(token) {
  let c = colorCache.get(token);
  if (!c) {
    c = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    colorCache.set(token, c);
  }
  return c;
}

/* ---------------------------------------------------------------- */
/* undo and redo                                                     */
/* ---------------------------------------------------------------- */

/** Call before changing a page's strokes. */
function pushUndo(v, pageNum) {
  v.history.record(v, pageNum);
  syncHistory();
  refreshThumb(v, pageNum);
}

function syncHistory() {
  const h = state.view?.history;
  $('undo').disabled = !h?.canUndo;
  $('redo').disabled = !h?.canRedo;
}

/** Undo (-1) or redo (+1). Returns whether there was anything to do. */
function stepHistory(dir) {
  const v = state.view;
  if (!v || state.gesture) return false;
  closePreview(false);
  clearSelection(); // it holds stroke positions that are about to change
  closeTextEditor(true);
  const step = dir < 0 ? v.history.undo(v) : v.history.redo(v);
  if (!step) return false;
  persist(v);
  if (step.layout) {
    // pages were added or removed, or the margin changed: lay out again
    layoutChanged(v, step.page);
  } else {
    const rec = v.pages.find((p) => p.num === step.page);
    if (rec) redraw(rec);
    refreshThumb(v, step.page);
    syncHistory();
  }
  return true;
}

/* ---------------------------------------------------------------- */
/* views                                                             */
/* ---------------------------------------------------------------- */

function makeView(key, name, bytes, meta) {
  const el = document.createElement('div');
  el.className = 'doc';
  return {
    key, name, el,
    title: meta?.title ?? name,
    stored: !!meta,         // is it in the library?
    thumbed: !!meta?.thumb,
    srcBytes: bytes,
    doc: null,              // the pdf.js document; null for a notebook, which has no PDF
    layout: null,           // { order, blanks, margin } — see pages.js
    strokes: {},            // page id -> Stroke[]
    history: createHistory(),
    pages: [],              // one record per page, in layout order; see makeRec()
    sizes: {},              // PDF page number -> { w, h } in points, as each is learned
    baseSize: null,         // the size assumed for a page until it is measured
    text: {},               // PDF page number -> { items, lines }, as each is read
    io: null,               // IntersectionObserver deciding which pages are mounted
    scale: meta?.view?.scale ?? 1,
    scroll: meta?.view?.scroll ?? null,  // { page, at }; null = never scrolled, start at the top
    avail: 0, drawnScale: 0,          // what the pages were last laid out at
    gen: 0,                 // bumped to abandon a layout in progress
    ready: false,           // laid out, so its scroll position means something
  };
}

async function loadView(key, name, bytes, meta) {
  const v = makeView(key, name, bytes, meta);
  if (bytes?.byteLength) {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy
    v.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  }
  v.layout = repairLayout(meta?.layout, v.doc?.numPages ?? 0);
  v.strokes = (await Store.load(key)) ?? {};
  return v;
}

/** Release everything a view holds. Its strokes are already persisted. */
function dropView(v) {
  if (state.zoomBox?.rec.view === v) closeZoomBox();
  if (state.selection?.rec.view === v) clearSelection();
  if (state.textEdit?.rec.view === v) closeTextEditor(false);
  v.gen++;
  v.ready = false;
  v.io?.disconnect();
  for (const rec of v.pages) unmountPage(rec, true);
  v.pages = [];
  v.el.remove();
  v.doc?.destroy();
}

const availWidth = () => Math.max(260, $('stage').clientWidth - 32);

/**
 * Scroll position is kept as a page and a fraction of the way down it,
 * never as pixels — like the strokes, it has to mean the same thing at
 * any zoom and any window size.
 */
function captureScroll(v) {
  if (v !== state.view || !v.ready || !v.pages.length) return;
  const top = $('stage').scrollTop;
  const rec = v.pages.find((r) => r.wrap.offsetTop + r.wrap.offsetHeight > top) ?? v.pages[v.pages.length - 1];
  v.scroll = { page: rec.num, at: (top - rec.wrap.offsetTop) / rec.wrap.offsetHeight };
}

function restoreScroll(v) {
  const rec = v.scroll && v.pages.find((r) => r.num === v.scroll.page);
  $('stage').scrollTop = rec ? rec.wrap.offsetTop + v.scroll.at * rec.wrap.offsetHeight : 0;
}

function saveViewState(v) {
  if (v.stored) Store.updateDoc(v.key, { view: { scale: v.scale, scroll: v.scroll } });
}

/** Make `v` the open document. Never leaves the previous one with unsaved ink. */
async function activate(v) {
  const prev = state.view;
  closePreview(false);
  closeTextEditor(true);
  state.cancelDrag?.();
  if (prev === v) { library.hide(); return; }
  clearSelection();
  closeZoomBox();
  clearSearch();
  if (prev) {
    captureScroll(prev);
    saveViewState(prev);
    await persist(prev);
  }

  state.view = v;
  views.touch(v.key, v);
  $('stage').replaceChildren(v.el);
  library.hide();
  syncChrome();

  if (v.stored) Store.updateDoc(v.key, { opened: Date.now() });

  // back where it was left, even if the pages then need laying out again
  // because the window changed size while this document was away
  if (v.pages.length) restoreScroll(v);
  if (!v.pages.length || v.avail !== availWidth() || v.drawnScale !== v.scale) {
    await renderView(v);
  } else {
    buildSidebar();
  }
}

function closeView(key) {
  views.delete(key);
  if (state.view?.key !== key) return;
  state.view = null;
  $('stage').replaceChildren();
  buildSidebar();
  syncChrome();
}

// opening and switching are async; run them one at a time, in order
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(job).catch((err) => {
    console.error(err);
    toast('could not open that document');
  });
  return queue;
}

/* ---------------------------------------------------------------- */
/* rendering                                                         */
/* ---------------------------------------------------------------- */

const PAPER_INK = '#c9d3dc';    // rulings on blank pages
const MOUNT_AHEAD = '150% 0px'; // pages within a screen and a half are kept rendered

/** Paint a page's ink from its stroke data, leaving out any strokes in `skip`. */
function paintPage(rec, skip) {
  if (!rec.mounted) return;
  const { ctx, canvas, dpr, w, h, num } = rec;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of rec.view.strokes[num] ?? []) {
    if (!skip?.has(s)) Ink.paintStroke(ctx, s, w, h, colorOf);
  }
}

/** The page as it should look at rest: its ink, plus whatever is laid over it. */
function redraw(rec) {
  if (!rec.mounted) return;
  paintPage(rec, state.textEdit?.rec === rec && state.textEdit.item ? new Set([state.textEdit.item]) : null);
  if (state.selection?.rec === rec) drawSelectionBox(rec, state.selection.box);
  if (state.zoomBox?.rec === rec) queueStrip();
}

const pointSize = (page) => {
  const vp = page.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
};

/**
 * A page's size in points. A blank page takes the shape of the PDF
 * page before it, so an inserted sheet matches its neighbours.
 */
function sizeOf(v, id) {
  if (!isBlank(id)) return v.sizes[id] ?? v.baseSize;
  const order = v.layout.order;
  for (let i = order.indexOf(id) - 1; i >= 0; i--) {
    if (!isBlank(order[i])) return sizeOf(v, order[i]);
  }
  return v.baseSize;
}

/** Work out a page's on-screen size. `w` and `h` are the page; `cw` adds the margin. */
function measureRec(rec) {
  const v = rec.view;
  const base = sizeOf(v, rec.num);
  const fit = v.avail / (v.baseSize.w * rec.xmax); // the first page, margin and all, fills the width
  const k = fit * v.drawnScale;
  rec.w = base.w * k;
  rec.h = base.h * k;
  rec.cw = rec.w * rec.xmax;
  rec.wrap.style.width = `${Math.floor(rec.cw)}px`;
  rec.wrap.style.height = `${Math.floor(rec.h)}px`;
}

/**
 * A page record. It always has a correctly sized `wrap` in the
 * document; its canvases exist only while it is mounted.
 */
function makeRec(v, id, index, total) {
  const wrap = document.createElement('div');
  wrap.className = 'pagewrap';
  const tag = document.createElement('div');
  tag.className = 'pnum';
  tag.textContent = `${index + 1} / ${total}`;
  const hits = document.createElement('div');
  hits.className = 'hits';
  wrap.append(hits, tag);

  const rec = {
    num: id, index, view: v, wrap, hits,
    blank: isBlank(id) ? v.layout.blanks[id] : null,
    xmax: 1 + v.layout.margin,     // the right edge of the page, margin included
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    w: 0, h: 0, cw: 0,
    mounted: false, mounts: 0, abort: null,
    canvas: null, ctx: null, pdfCanvas: null, pctx: null,
  };
  wrap.rec = rec;
  measureRec(rec);
  return rec;
}

/** Give a page its canvases, its input handling and its picture. */
function mountPage(rec) {
  if (rec.mounted) return;
  const { dpr } = rec;
  const sized = (c) => {
    c.width = Math.floor(rec.cw * dpr);
    c.height = Math.floor(rec.h * dpr);
    c.style.width = `${Math.floor(rec.cw)}px`;
    c.style.height = `${Math.floor(rec.h)}px`;
    return c;
  };
  rec.pdfCanvas = sized(document.createElement('canvas'));
  rec.canvas = sized(document.createElement('canvas'));
  rec.canvas.className = 'ink';
  rec.pctx = rec.pdfCanvas.getContext('2d');
  rec.ctx = rec.canvas.getContext('2d', { desynchronized: true });
  rec.wrap.prepend(rec.pdfCanvas, rec.canvas);

  rec.mounted = true;
  rec.abort = new AbortController();
  attachInput(rec, { signal: rec.abort.signal });
  redraw(rec);
  paintBackground(rec, ++rec.mounts);
}

/** Take a page's canvases away again. Pages in use are left alone unless `force`. */
function unmountPage(rec, force = false) {
  if (!rec.mounted) return;
  const busy = state.gesture || state.selection?.rec === rec || state.zoomBox?.rec === rec
    || state.preview?.rec === rec || state.textEdit?.rec === rec;
  if (busy && !force) return;
  rec.mounted = false;
  rec.mounts++; // abandons a background render in progress
  rec.abort.abort();
  // a canvas keeps its backing store until it is resized or collected
  for (const c of [rec.canvas, rec.pdfCanvas]) { c.width = c.height = 0; c.remove(); }
  rec.canvas = rec.ctx = rec.pdfCanvas = rec.pctx = null;
}

/** The page under the ink: the PDF page, or ruled paper, plus the margin. */
async function paintBackground(rec, mount) {
  const v = rec.view;
  const { pctx, dpr } = rec;
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, rec.cw, rec.h);

  try {
    if (rec.blank) {
      const { lines, dots } = paperMarks(rec.blank.paper, rec.w, rec.h);
      // rulings sit on whole device pixels: a hairline straddling two is a grey smear
      const px = (n) => (Math.round(n * dpr) + 0.5) / dpr;
      pctx.strokeStyle = pctx.fillStyle = PAPER_INK;
      pctx.lineWidth = 1 / dpr;
      pctx.beginPath();
      for (const [x0, y0, x1, y1] of lines) { pctx.moveTo(px(x0), px(y0)); pctx.lineTo(px(x1), px(y1)); }
      pctx.stroke();
      const dot = Math.max(2, Math.round(1.6 * dpr)) / dpr;
      for (const [x, y] of dots) pctx.fillRect(Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr, dot, dot);
    } else {
      const page = await v.doc.getPage(rec.num);
      if (rec.mounts !== mount) return;

      // Pages are laid out before they are measured, on the assumption
      // that they match the first. One that does not is put right here.
      const size = pointSize(page);
      const assumed = sizeOf(v, rec.num);
      v.sizes[rec.num] = size;
      if (Math.abs(size.w - assumed.w) > 0.5 || Math.abs(size.h - assumed.h) > 0.5) {
        captureScroll(v);
        for (const r of v.pages) {
          if (r !== rec && !(isBlank(r.num) && sizeOf(v, r.num) === size)) continue;
          const was = r.mounted;
          unmountPage(r, true);
          measureRec(r);
          if (was) mountPage(r);
        }
        if (v === state.view) restoreScroll(v);
        return; // remounting has started a fresh paint
      }

      await page.render({ canvasContext: pctx, viewport: page.getViewport({ scale: rec.w / size.w }) }).promise;
      if (rec.mounts !== mount) return;
      readText(v, rec.num, page);
    }
  } catch (err) {
    // a page unmounted or a view dropped mid-render rejects; that is not an error
    if (rec.mounts === mount) console.error(err);
    return;
  }

  if (rec.xmax > 1) {
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.fillStyle = PAPER_INK;
    pctx.fillRect(rec.w, 0, 1, rec.h); // where the page ends and the margin begins
  }
  if (rec.index === 0) saveThumb(v, rec);
  if (state.zoomBox?.rec === rec) queueStrip();
  refreshThumb(v, rec.num);
}

/**
 * Lay the document out. Every page gets a correctly sized placeholder
 * at once; only the pages near the viewport are given canvases and
 * rendered, so a 200-page PDF opens as quickly as a 2-page one.
 */
async function renderView(v) {
  const gen = ++v.gen;
  closeTextEditor(true);
  if (!v.baseSize) {
    v.baseSize = v.doc ? pointSize(await v.doc.getPage(1)) : BLANK_SIZE;
    if (v.doc) v.sizes[1] = v.baseSize;
    if (gen !== v.gen) return;
  }

  if (v === state.view) captureScroll(v);
  v.ready = false;
  v.avail = availWidth();
  v.drawnScale = v.scale;

  const { order } = v.layout;
  const recs = order.map((id, i) => makeRec(v, id, i, order.length));

  // a selection points at the old canvases; the zoom box moves to the new ones
  if (state.selection?.rec.view === v) { state.selection = null; $('selbar').hidden = true; }
  v.io?.disconnect();
  const old = v.pages;
  v.pages = recs;
  v.el.replaceChildren(...recs.map((r) => r.wrap));
  old.forEach((r) => unmountPage(r, true));

  v.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) mountPage(e.target.rec); else unmountPage(e.target.rec);
    }
  }, { root: $('stage'), rootMargin: MOUNT_AHEAD });
  recs.forEach((r) => v.io.observe(r.wrap));

  if (v === state.view) { restoreScroll(v); status(); buildSidebar(); paintHits(); }
  v.ready = true;

  const z = state.zoomBox;
  if (z?.rec.view === v) {
    const next = recs.find((r) => r.num === z.rec.num);
    if (next) {
      mountPage(next);
      bindZoomBox(next, { cx: z.target.x + z.target.w / 2, cy: z.target.y + z.target.h / 2 });
    } else {
      closeZoomBox();
    }
  }
}

/** Written once, the first time the first page of a library document is rendered. */
async function saveThumb(v, rec) {
  if (!v.stored || v.thumbed) return;
  v.thumbed = true;
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = Math.round((320 * rec.h) / rec.w);
  const p = rec.pdfCanvas;
  c.getContext('2d').drawImage(p, 0, 0, p.width / rec.xmax, p.height, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  if (blob && await Store.putThumb(v.key, blob)) {
    await Store.updateDoc(v.key, { thumb: true });
    if (library.visible) library.refresh();
  }
}

/** Read a PDF page's text, for search and for snapping the highlighter to lines. */
async function readText(v, n, page) {
  if (v.text[n]) return v.text[n];
  page ??= await v.doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (!it.str) continue;
    const [, , c, d, e, f] = it.transform;
    const size = it.height || Math.hypot(c, d);
    const [x, baseline] = vp.convertToViewportPoint(e, f);
    // the box runs from a little above the ascenders to a little below the baseline
    items.push({ str: it.str, x: x / vp.width, y: (baseline - size * 0.85) / vp.height, w: it.width / vp.width, h: (size * 1.05) / vp.height });
  }
  return (v.text[n] = { items, lines: textLines(items) });
}

/* ---------------------------------------------------------------- */
/* input                                                             */
/* ---------------------------------------------------------------- */

// The page's ink as it stood when the current gesture began. Each move
// repaints this plus the one stroke in progress, so drawing costs the
// same on a page with five strokes as on one with five hundred.
const under = document.createElement('canvas');

const HOLD_CHECK_MS = 120;  // how often a stroke in progress is checked for a resting pen
const REST_PX = 5;          // a resting pen still wanders this far

/**
 * Wire a surface up for ink on `rec`'s page.
 *
 * Normally the surface is the page's own ink canvas. The zoom box
 * passes its strip instead: `toPage` maps a pointer event to page
 * coordinates and `zoom` says how magnified the surface is, and from
 * there on a stroke written in the strip is handled like any other.
 */
function attachInput(rec, surface = {}) {
  const v = rec.view;
  const el = surface.el ?? rec.canvas;
  const zoomOf = surface.zoom ?? (() => 1);
  // the canvas spans the page and its margin, so its right edge is xmax, not 1
  const toPage = surface.toPage ?? ((e) => {
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * rec.xmax, y: (e.clientY - r.top) / r.height };
  });
  const on = (type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: surface.signal });

  let cur = null;       // freehand stroke in progress
  let drag = null;      // shape in progress: { a, b, shift }
  let lasso = null;     // lasso path in progress
  let xf = null;        // selection being moved or resized: { grab, from, box, base, out }
  let erasing = null;   // { undone } while the eraser is down
  let active = null;    // pointerId of the gesture in progress
  let settle = null;    // timer for the repaint that follows a pause in writing
  let holdTimer = null; // checks a stroke in progress for a resting pen
  let finishing = false; // text tool: this tap is closing an open text box

  const local = (e) => ({ ...toPage(e), p: e.pressure, t: performance.now() });
  const allowed = (e) => e.pointerType === 'pen' || !state.stylusOnly;

  // Width and pencil opacity come from pen speed across the page. Writing
  // in the zoom box covers the page slowly for the same hand speed, so
  // speed is measured as the hand moved, not as the ink landed.
  const asWritten = (q) => {
    const k = zoomOf();
    return q && k !== 1 ? { ...q, x: q.x * k, y: q.y * k } : q;
  };

  const snapshot = () => {
    under.width = rec.canvas.width;
    under.height = rec.canvas.height;
    under.getContext('2d').drawImage(rec.canvas, 0, 0);
  };

  /** Repaint the snapshot, then `strokes` on top of it. */
  const paintOver = (...strokes) => {
    const { ctx, dpr, w, h } = rec;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rec.canvas.width, rec.canvas.height);
    ctx.drawImage(under, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of strokes) if (s) Ink.paintStroke(ctx, s, w, h, colorOf);
    stripLive(rec, strokes);
  };

  /**
   * Predicted ink: a short tail drawn beyond the last real point, where
   * the browser expects the pen to be by the time this frame is shown.
   * It is painted and thrown away — the next move repaints without it,
   * and it never enters the stroke. Not for the highlighter, whose one
   * translucent path would show the join as a darker patch.
   */
  const predictedInk = (e) => {
    if (cur.k === 'hi') return null;
    const ahead = e.getPredictedEvents?.() ?? [];
    if (!ahead.length) return null;
    const tail = Ink.predictedTail(cur.pts, ahead.map(toPage));
    if (!tail.length) return null;
    state.predicting = true;
    const last = cur.pts[cur.pts.length - 1];
    const w = last.w ?? cur.w; // the weight the stroke has now; guessing a speed would skew calibration
    return { k: cur.k, c: cur.c, w: cur.w, pts: [last, ...tail.map((p) => ({ ...p, w, a: last.a }))] };
  };

  const release = () => {
    active = null;
    clearInterval(holdTimer);
    state.gesture = false;
    state.penDown = false;
    state.cancelDrag = null;
    state.abortFingerStroke = null;
  };

  const shapeStroke = (d) => {
    const aspect = rec.w / rec.h;
    if (dragLength(d.a, d.b, aspect) * zoomOf() < 0.006) return null; // a tap, not a drag
    const ink = state.prefs.ink.shape;
    const w = BASE_WIDTH.shape * ink.w;
    const kind = state.prefs.shape;
    const pts = dragShape(kind, d.a, d.b, { constrain: d.shift, aspect });
    return { k: 'pen', shape: kind, c: ink.c, w, pts: pts.map((p) => ({ x: p.x, y: p.y, w })) };
  };

  const paintLasso = () => {
    paintOver();
    const { ctx, w, h } = rec;
    ctx.save();
    ctx.strokeStyle = colorOf('--accent');
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    lasso.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
    ctx.stroke();
    ctx.restore();
  };

  const paintXf = () => {
    const shown = xf.out ?? xf.base;
    paintOver(...shown);
    drawSelectionBox(rec, boundsOf(shown));
  };

  /** Lasso tool: grab the selection if the pen lands on it, else start a new loop. */
  const startSelect = (pt) => {
    const sel = state.selection?.rec === rec ? state.selection : null;
    const grab = sel && selectionGrab(sel.box, pt, rec);
    if (grab) {
      const list = v.strokes[rec.num];
      xf = { grab, from: pt, box: sel.box, base: sel.idx.map((i) => list[i]), out: null, xmax: rec.xmax };
      // the snapshot is the page without the selection, so it can be
      // painted wherever it is dragged to
      paintPage(rec, new Set(xf.base));
      snapshot();
      paintXf();
    } else {
      clearSelection();
      snapshot();
      lasso = [pt];
    }
    state.cancelDrag = () => { lasso = null; xf = null; release(); redraw(rec); };
  };

  /**
   * Hold-to-snap: the pen has stopped at the end of a stroke. If what
   * was drawn is recognisably a shape, it becomes one. The freehand
   * stroke is kept as its own undo step, in case the guess is wrong.
   */
  const checkHold = () => {
    if (!cur || cur.shape || cur.held) return;
    const radius = REST_PX / rec.w / zoomOf();
    if (!heldStill(cur.pts, performance.now(), { radius })) return;
    cur.held = true; // one attempt per stroke
    const drawn = trimRest(cur.pts, radius);
    const shape = recognize(drawn, { strict: false });
    const pts = shape && shapeToPoints(shape);
    if (!pts) return;

    cur.pts = drawn;
    pushUndo(v, rec.num);
    cur.shape = shape.type;
    cur.pts = pts.map((p) => ({ x: p.x, y: p.y, w: cur.w }));
    paintOver(cur);
  };

  /** A second finger landed: this was the start of a tap or a pinch, not a stroke. */
  const abortStroke = () => {
    if (!cur) return;
    const list = v.strokes[rec.num];
    list.splice(list.indexOf(cur), 1);
    v.history.discard();
    cur = null;
    release();
    redraw(rec);
    syncHistory();
  };

  // Fingers scroll and pinch natively in stylus-only mode (see the
  // touch-action rule in app.css), but the browser would let the pen
  // scroll too. Claiming the pen's touches here is what keeps it drawing.
  const claimTouch = (e) => {
    // (the text tool acts on click, which a claimed touch would never produce)
    if (!e.cancelable || state.prefs.tool === 'text') return;
    const touchTypes = [...e.changedTouches].map((t) => t.touchType);
    if (Ink.inkOwnsTouch({ ...state, touchTypes })) e.preventDefault();
  };
  on('touchstart', claimTouch, { passive: false });
  on('touchmove', claimTouch, { passive: false });

  on('pointerdown', (e) => {
    // one gesture at a time, across the page and the zoom box alike
    if (!allowed(e) || state.preview || state.gesture) return;
    if (state.prefs.tool === 'text') {
      // a tap outside an open text box finishes it; it does not also start another
      finishing = !!state.textEdit;
      return;
    }
    clearTimeout(settle);
    surface.onStart?.();
    active = e.pointerId;
    state.gesture = true;
    state.penDown = e.pointerType === 'pen';
    el.setPointerCapture(e.pointerId);
    Ink.notePressure(e.pressure);
    const pt = local(e);
    const tool = state.prefs.tool;
    e.preventDefault();

    if (tool === 'erase') {
      erasing = { undone: false };
      eraseAt(rec, pt, erasing);
      return;
    }
    if (tool === 'select') { startSelect(pt); return; }

    snapshot();

    if (tool === 'shape') {
      drag = { a: pt, b: pt, shift: e.shiftKey };
      state.cancelDrag = () => { drag = null; release(); redraw(rec); };
      return;
    }

    pushUndo(v, rec.num);
    const ink = state.prefs.ink[tool];
    cur = {
      k: tool === 'highlight' ? 'hi' : tool,
      c: ink.c,
      w: BASE_WIDTH[tool] * ink.w,
      pts: [pt],
    };
    if (cur.k === 'pencil') pt.a = pencilAlpha(asWritten(pt), null, Ink.speedStats.fast);
    (v.strokes[rec.num] ??= []).push(cur);
    if (e.pointerType === 'touch') state.abortFingerStroke = abortStroke;
    holdTimer = setInterval(checkHold, HOLD_CHECK_MS);
  });

  on('pointermove', (e) => {
    if (e.pointerId !== active) return; // a resting palm, not the gesture
    e.preventDefault();
    if (erasing) {
      const batch = e.getCoalescedEvents?.() ?? [];
      for (const ev of (batch.length ? batch : [e])) eraseAt(rec, local(ev), erasing);
      return;
    }
    if (drag) {
      drag.b = local(e);
      drag.shift = e.shiftKey;
      paintOver(shapeStroke(drag));
      return;
    }
    if (lasso) {
      lasso.push(local(e));
      paintLasso();
      return;
    }
    if (xf) {
      xf.out = transformStrokes(xf.base, selectionTransform(xf, local(e)));
      paintXf();
      return;
    }
    if (!cur || cur.shape) return; // snapped: the shape is final until the pen lifts

    const batch = e.getCoalescedEvents?.() ?? [e];
    for (const ev of (batch.length ? batch : [e])) {
      Ink.notePressure(ev.pressure);
      const pt = local(ev);
      const prev = cur.pts[cur.pts.length - 1];
      pt.w = Ink.widthFor(asWritten(pt), asWritten(prev), cur.w);
      if (cur.k === 'pencil') pt.a = pencilAlpha(asWritten(pt), asWritten(prev), Ink.speedStats.fast);
      cur.pts.push(pt);
    }
    paintOver(cur, predictedInk(e));
  });

  const finish = (e, cancelled) => {
    // only the pointer that started the gesture may end it: a palm
    // lifting off mid-stroke must not cut the stroke short
    if (e.pointerId !== active) return;
    release();
    if (erasing) { erasing = null; return; }

    if (drag) {
      const shape = cancelled ? null : shapeStroke(drag);
      drag = null;
      if (shape) {
        // one undo step for the shape, however long it was dragged about
        pushUndo(v, rec.num);
        (v.strokes[rec.num] ??= []).push(shape);
        persist(v);
      }
      paintOver(shape);
      stripCommit(rec, shape);
      return;
    }

    if (lasso) {
      const path = lasso;
      lasso = null;
      const idx = cancelled ? [] : strokesInLasso(v.strokes[rec.num] ?? [], path);
      if (idx.length) setSelection(rec, idx); else redraw(rec);
      return;
    }

    if (xf) {
      const { out } = xf;
      xf = null;
      const sel = state.selection;
      if (out && !cancelled && sel) {
        pushUndo(v, rec.num);
        const list = v.strokes[rec.num];
        sel.idx.forEach((i, k) => { list[i] = out[k]; });
        sel.box = boundsOf(out);
        persist(v);
      }
      redraw(rec);
      return;
    }

    if (!cur) return;
    const list = v.strokes[rec.num];
    let done = cur;
    cur = null;

    if (done.pts.length < 2) {
      list.splice(list.indexOf(done), 1);
      v.history.discard();
      syncHistory();
      done = null;
    } else if (!done.shape) {
      // Scratch-out: a fast scribble over existing ink deletes it. The
      // undo step taken when the pen went down already holds the page as
      // it was, so one undo brings everything back.
      const k = zoomOf();
      const hit = done.k === 'hi' ? null
        : scratchOut(k === 1 ? done.pts : done.pts.map(asWritten), (rec.w / rec.h));
      const box = hit && (k === 1 ? hit : { x0: hit.x0 / k, x1: hit.x1 / k, y0: hit.y0 / k, y1: hit.y1 / k });
      const targets = box ? scratchTargets(list, box, done) : [];
      if (targets.length) {
        v.strokes[rec.num] = list.filter((s, i) => s !== done && !targets.includes(i));
        toast(`scratched out ${targets.length} stroke${targets.length === 1 ? '' : 's'} — undo brings ${targets.length === 1 ? 'it' : 'them'} back`);
        redraw(rec);
        persist(v);
        return;
      }
      if (state.autoSmooth && done.k !== 'hi') done.pts = smooth(done.pts, 0.35);

      // A highlighter sweep along a line of the PDF's text becomes a clean
      // band over exactly that line. Anywhere else it stays as drawn.
      const band = done.k === 'hi' && snapHighlight(done.pts, v.text[rec.num]?.lines);
      if (band) {
        done.pts = [{ x: band.x0, y: band.y }, { x: band.x1, y: band.y }];
        done.w = (band.h * rec.h) / rec.w; // widths are in page widths; the band's height is in page heights
        done.flat = true;
      }
    }
    delete done?.held;

    // the finished stroke goes on top of the snapshot; the rest of the
    // page was not touched, so it is not repainted
    paintOver(done);
    stripCommit(rec, done);
    // ...until the hand pauses. Then one full repaint from the stroke
    // data, so the canvas is always exactly what a reload would show.
    settle = setTimeout(() => { if (!state.gesture) redraw(rec); }, 300);
    persist(v);
    status();
    if (done) surface.onStroke?.(done);
  };

  // Text is placed on click rather than pointerdown: a tablet only
  // brings up its keyboard for focus that follows a completed tap.
  on('click', (e) => {
    if (state.prefs.tool !== 'text' || state.preview) return;
    if (finishing) { finishing = false; return; }
    if (e.pointerType && !allowed(e)) return;
    openTextEditor(rec, local(e));
  });

  on('pointerup', (e) => finish(e, false));
  on('pointercancel', (e) => finish(e, true));
}

/**
 * Erase under a point. In stroke mode the topmost stroke there goes
 * whole; in area mode every stroke is cut where the eraser passes, and
 * the whole gesture is one undo step.
 */
function eraseAt(rec, pt, gesture) {
  const v = rec.view;
  const list = v.strokes[rec.num];
  if (!list?.length) return;

  if (state.prefs.eraser === 'area') {
    let changed = false;
    const next = list.flatMap((s) => {
      const pieces = Ink.eraseArea(s, pt);
      if (!pieces) return [s];
      changed = true;
      return pieces;
    });
    if (!changed) return;
    if (!gesture.undone) { pushUndo(v, rec.num); gesture.undone = true; }
    v.strokes[rec.num] = next;
  } else {
    const hit = Ink.strokeAt(list, pt);
    if (hit < 0) return;
    pushUndo(v, rec.num);
    list.splice(hit, 1);
  }
  redraw(rec);
  persist(v);
}

/* ---------------------------------------------------------------- */
/* lasso selection                                                   */
/* ---------------------------------------------------------------- */

const GRIP_PX = 18;   // reach of the resize handle
const BOX_PAD = 6;    // breathing room between the ink and its outline

/** What a pen landing at `pt` takes hold of: the resize handle, the selection, or nothing. */
function selectionGrab(box, pt, rec) {
  const px = (pt.x - box.x1) * rec.w, py = (pt.y - box.y1) * rec.h;
  if (Math.hypot(px - BOX_PAD, py - BOX_PAD) <= GRIP_PX) return 'resize';
  const padX = BOX_PAD / rec.w, padY = BOX_PAD / rec.h;
  const inside = pt.x >= box.x0 - padX && pt.x <= box.x1 + padX && pt.y >= box.y0 - padY && pt.y <= box.y1 + padY;
  return inside ? 'move' : null;
}

function selectionTransform(xf, pt) {
  if (xf.grab === 'move') return clampMove(xf.box, pt.x - xf.from.x, pt.y - xf.from.y, xf.xmax);
  return { scale: resizeScale(xf.box, pt, { xmax: xf.xmax }), ox: xf.box.x0, oy: xf.box.y0 };
}

function drawSelectionBox(rec, box) {
  const { ctx, w, h } = rec;
  const x = box.x0 * w - BOX_PAD, y = box.y0 * h - BOX_PAD;
  const bw = (box.x1 - box.x0) * w + BOX_PAD * 2, bh = (box.y1 - box.y0) * h + BOX_PAD * 2;
  ctx.save();
  ctx.strokeStyle = colorOf('--accent');
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x, y, bw, bh);
  ctx.setLineDash([]);
  ctx.fillStyle = colorOf('--accent');
  ctx.fillRect(x + bw - 5, y + bh - 5, 10, 10); // resize handle
  ctx.restore();
}

function setSelection(rec, idx) {
  const list = rec.view.strokes[rec.num];
  state.selection = { rec, idx, box: boundsOf(idx.map((i) => list[i])) };
  showSelectionBar();
  redraw(rec);
}

function clearSelection() {
  const sel = state.selection;
  if (!sel) return;
  state.selection = null;
  $('selbar').hidden = true;
  redraw(sel.rec);
}

function showSelectionBar() {
  const { rec, idx } = state.selection;
  const picked = idx.map((i) => rec.view.strokes[rec.num][i]);
  $('sel-note').textContent = `${idx.length} stroke${idx.length === 1 ? '' : 's'} selected — drag to move, drag the corner to resize`;

  // ink colours if there is ink, highlighter colours if there is highlighter
  const tokens = [
    ...(picked.some((s) => s.k !== 'hi') ? PALETTES.pen : []),
    ...(picked.some((s) => s.k === 'hi') ? PALETTES.highlight : []),
  ];
  const host = $('sel-colors');
  host.innerHTML = '';
  for (const token of tokens) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.type = 'button';
    b.style.background = colorOf(token);
    b.setAttribute('aria-label', `recolor ${token.replace('--', '')}`);
    b.addEventListener('click', () => editSelection((strokes) => recolorStrokes(strokes, token)));
    host.append(b);
  }
  $('selbar').hidden = false;
}

/** Replace the selected strokes with `change(strokes)`, as one undo step. */
function editSelection(change) {
  const sel = state.selection;
  if (!sel) return;
  const { rec, idx } = sel;
  const v = rec.view, list = v.strokes[rec.num];
  pushUndo(v, rec.num);
  const next = change(idx.map((i) => list[i]));
  idx.forEach((i, k) => { list[i] = next[k]; });
  sel.box = boundsOf(next);
  persist(v);
  redraw(rec);
}

function copySelection() {
  const sel = state.selection;
  if (!sel) return;
  const { rec, idx } = sel;
  const v = rec.view, list = v.strokes[rec.num];
  pushUndo(v, rec.num);
  // set a little down and to the right, where there is room for it
  const copies = transformStrokes(idx.map((i) => list[i]), clampMove(sel.box, 0.02, 0.02 * (rec.w / rec.h), rec.xmax));
  const first = list.length;
  list.push(...copies);
  persist(v);
  setSelection(rec, copies.map((_, k) => first + k)); // the copy is what is now held
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  const { rec, idx } = sel;
  const v = rec.view;
  pushUndo(v, rec.num);
  v.strokes[rec.num] = v.strokes[rec.num].filter((_, i) => !idx.includes(i));
  persist(v);
  clearSelection();
}

/* ---------------------------------------------------------------- */
/* zoom writing box                                                  */
/* ---------------------------------------------------------------- */

const ZOOM_BOX = 2.5;      // how much larger the strip shows the page
const ADVANCE_AT = 0.85;   // writing past this much of the strip moves it along
const ADVANCE_MS = 700;    // ...once the pen has been up this long

// the strip without the stroke in progress: the PDF and the finished ink
const stripBase = document.createElement('canvas');
let stripQueued = false;

/** Scale and shift a strip context so page-pixel drawing lands magnified in the strip. */
function stripTransform(g) {
  const { rec, target } = state.zoomBox;
  const k = magnification(target, $('strip-canvas').clientWidth, rec.w) * rec.dpr;
  g.setTransform(k, 0, 0, k, -target.x * rec.w * k, -target.y * rec.h * k);
}

/** Repaint the strip from its base, with the strokes in progress on top. */
function stripLive(rec, strokes = []) {
  const z = state.zoomBox;
  if (z?.rec !== rec) return;
  const c = $('strip-canvas');
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(stripBase, 0, 0);
  stripTransform(g);
  for (const s of strokes) if (s) Ink.paintStroke(g, s, rec.w, rec.h, colorOf);
}

/** Add a finished stroke to the strip's base, so it stays put while the next is written. */
function stripCommit(rec, stroke) {
  if (!stroke || state.zoomBox?.rec !== rec) return;
  const g = stripBase.getContext('2d');
  stripTransform(g);
  Ink.paintStroke(g, stroke, rec.w, rec.h, colorOf);
}

function rebuildStrip() {
  stripQueued = false;
  const z = state.zoomBox;
  if (!z || !z.rec.mounted) return;
  const { rec, target } = z;
  const c = $('strip-canvas');
  stripBase.width = c.width;
  stripBase.height = c.height;
  const g = stripBase.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const p = rec.pdfCanvas;
  g.imageSmoothingQuality = 'high';
  const px = p.width / rec.xmax; // the background canvas spans the margin too
  g.drawImage(p, target.x * px, target.y * p.height, target.w * px, target.h * p.height, 0, 0, c.width, c.height);
  // ink is painted from the stroke data, so it is sharp at any magnification
  stripTransform(g);
  for (const s of rec.view.strokes[rec.num] ?? []) Ink.paintStroke(g, s, rec.w, rec.h, colorOf);
  stripLive(rec);
}

function queueStrip() {
  if (stripQueued) return;
  stripQueued = true;
  requestAnimationFrame(rebuildStrip);
}

function openZoomBox() {
  const rec = visiblePage();
  if (!rec) { toast('open a document first'); return; }
  clearSelection();
  $('strip').hidden = false;
  $('zoombox').setAttribute('aria-pressed', 'true');
  state.zoomBox = { rec: null, target: null, abort: null, frame: null, timer: null };

  // start at the left margin, level with the middle of what is on screen
  const stage = $('stage');
  const cy = (stage.scrollTop + stage.clientHeight / 2 - rec.wrap.offsetTop) / rec.wrap.offsetHeight;
  bindZoomBox(rec, { cx: 0, cy: Math.min(1, Math.max(0, cy)) });
}

/** Attach the strip to a page, showing the part of it centred on (cx, cy). */
function bindZoomBox(rec, { cx, cy }) {
  const z = state.zoomBox;
  z.abort?.abort();
  z.frame?.remove();
  clearTimeout(z.timer);

  const c = $('strip-canvas');
  c.width = Math.round(c.clientWidth * rec.dpr);
  c.height = Math.round(c.clientHeight * rec.dpr);
  z.rec = rec;
  z.target = targetFor({ stripW: c.clientWidth, stripH: c.clientHeight, pageW: rec.w, pageH: rec.h, zoom: ZOOM_BOX, cx, cy, xmax: rec.xmax });
  z.abort = new AbortController();
  const { signal } = z.abort;

  // the outline on the page showing where the ink will land, with a tab to drag it by
  z.frame = document.createElement('div');
  z.frame.className = 'zframe';
  const grip = document.createElement('button');
  grip.className = 'zgrip';
  grip.type = 'button';
  grip.setAttribute('aria-label', 'Move the zoom box');
  z.frame.append(grip);
  rec.wrap.append(z.frame);

  let hold = null; // where in the box the grip was taken, while dragging
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = rec.wrap.getBoundingClientRect();
    hold = { id: e.pointerId, dx: ((e.clientX - r.left) / r.width) * rec.xmax - z.target.x, dy: (e.clientY - r.top) / r.height - z.target.y };
  }, { signal });
  grip.addEventListener('pointermove', (e) => {
    if (e.pointerId !== hold?.id) return;
    const r = rec.wrap.getBoundingClientRect();
    const { w, h } = z.target;
    moveZoomBox({
      w, h,
      x: Math.min(rec.xmax - w, Math.max(0, ((e.clientX - r.left) / r.width) * rec.xmax - hold.dx)),
      y: Math.min(1 - h, Math.max(0, (e.clientY - r.top) / r.height - hold.dy)),
    }, false);
  }, { signal });
  for (const type of ['pointerup', 'pointercancel']) {
    grip.addEventListener(type, () => { hold = null; }, { signal });
  }

  attachInput(rec, {
    el: c,
    signal,
    zoom: () => magnification(z.target, c.clientWidth, rec.w),
    toPage: (e) => {
      const r = c.getBoundingClientRect();
      return stripToPage(z.target, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    },
    onStart: () => clearTimeout(z.timer),
    // writing has reached the end of the strip: move along once the pen has paused
    onStroke: (stroke) => {
      const reach = Math.max(...stroke.pts.map((p) => pageToStrip(z.target, p.x, p.y).fx));
      if (reach < ADVANCE_AT) return;
      z.timer = setTimeout(() => { if (!state.gesture) moveZoomBox(advance(z.target, 'right', { xmax: rec.xmax })); }, ADVANCE_MS);
    },
  });

  moveZoomBox(z.target);
}

function moveZoomBox(target, follow = true) {
  const z = state.zoomBox;
  if (!z) return;
  clearTimeout(z.timer);
  z.target = target;
  const { xmax } = z.rec; // the frame's parent spans the margin too
  Object.assign(z.frame.style, {
    left: `${(target.x / xmax) * 100}%`, top: `${target.y * 100}%`,
    width: `${(target.w / xmax) * 100}%`, height: `${target.h * 100}%`,
  });
  if (follow) z.frame.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  rebuildStrip();
}

function closeZoomBox() {
  const z = state.zoomBox;
  if (!z) return;
  z.abort?.abort();
  z.frame?.remove();
  clearTimeout(z.timer);
  state.zoomBox = null;
  $('strip').hidden = true;
  $('zoombox').setAttribute('aria-pressed', 'false');
}

/* ---------------------------------------------------------------- */
/* pages: blank sheets, the margin, the sidebar                      */
/* ---------------------------------------------------------------- */

const THUMB_W = 96;

function persistLayout(v) {
  if (v.stored) Store.updateDoc(v.key, { layout: v.layout, pages: v.layout.order.length });
}

/** After the layout has changed: save it, lay the document out again, and go to `focus`. */
async function layoutChanged(v, focus) {
  persistLayout(v);
  syncHistory();
  await renderView(v);
  const rec = focus != null && v.pages.find((r) => r.num === focus);
  if (rec) jumpTo(rec);
}

/** Insert a blank page after the one on screen. */
function addPage() {
  const v = state.view;
  if (!v) return;
  const after = visiblePage()?.num ?? v.layout.order[v.layout.order.length - 1];
  v.history.record(v, null, { layout: true });
  let id;
  [v.layout, id] = insertBlank(v.layout, after, $('paper').value);
  layoutChanged(v, id);
}

/** Remove a blank page, and the ink on it, as one undo step. */
function removePage(id) {
  const v = state.view;
  const next = v && removeBlank(v.layout, id);
  if (!v || next === v.layout) { toast('a document needs at least one page'); return; }
  const at = v.layout.order.indexOf(id);
  v.history.record(v, id, { layout: true });
  v.layout = next;
  delete v.strokes[id];
  persist(v);
  layoutChanged(v, next.order[Math.min(at, next.order.length - 1)]);
}

function toggleMargin() {
  const v = state.view;
  if (!v) return;
  const on = !v.layout.margin;
  const inMargin = !on && Object.values(v.strokes).some((list) => list.some((s) => s.pts.some((p) => p.x > 1)));
  v.history.record(v, null, { layout: true });
  v.layout = { ...v.layout, margin: on ? MARGIN : 0 };
  layoutChanged(v, visiblePage()?.num);
  if (inMargin) toast('margin hidden — the notes in it are kept, and come back with it');
}

function jumpTo(rec) {
  $('stage').scrollTop = rec.wrap.offsetTop - 8;
}

/** One small canvas per page, painted only once it scrolls into view in the sidebar. */
function buildSidebar() {
  const list = $('side-list');
  state.thumbIo?.disconnect();
  state.thumbIo = null;
  list.replaceChildren();
  const v = state.view;
  $('side-margin').setAttribute('aria-pressed', String(!!v?.layout.margin));
  if ($('side').hidden || !v) return;

  state.thumbIo = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) paintThumb(e.target.rec);
  }, { root: list, rootMargin: '300px 0px' });

  for (const rec of v.pages) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'pthumb';
    b.type = 'button';
    b.rec = rec;
    b.dataset.page = String(rec.num);
    b.setAttribute('aria-label', `Go to page ${rec.index + 1}`);
    const c = document.createElement('canvas');
    c.style.width = `${THUMB_W}px`;
    c.style.height = `${Math.round((THUMB_W * rec.h) / rec.cw)}px`;
    const n = document.createElement('span');
    n.textContent = String(rec.index + 1);
    b.append(c, n);
    b.addEventListener('click', () => jumpTo(rec));
    li.append(b);

    if (rec.blank) {
      const del = document.createElement('button');
      del.className = 'tb pdel';
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete blank page ${rec.index + 1}`);
      del.addEventListener('click', () => removePage(rec.num));
      li.append(del);
    }
    list.append(li);
    state.thumbIo.observe(b);
  }
  markCurrentThumb();
}

const thumbButton = (id) => $('side-list').querySelector(`.pthumb[data-page="${CSS.escape(String(id))}"]`);

/** A thumbnail's background — the PDF page or the ruled paper — rendered once and kept. */
async function thumbBackground(rec) {
  const v = rec.view;
  const cached = (v.thumbBg ??= new Map()).get(rec.num);
  if (cached) return cached;
  const pending = (async () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = (THUMB_W * dpr) / rec.cw; // thumbnail pixels per page pixel
    const c = document.createElement('canvas');
    c.width = Math.round(rec.cw * k);
    c.height = Math.round(rec.h * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    if (rec.blank) {
      const { lines, dots } = paperMarks(rec.blank.paper, rec.w * k, rec.h * k);
      g.strokeStyle = g.fillStyle = PAPER_INK;
      g.lineWidth = 0.5;
      g.beginPath();
      for (const [x0, y0, x1, y1] of lines) { g.moveTo(x0, y0); g.lineTo(x1, y1); }
      g.stroke();
      for (const [x, y] of dots) g.fillRect(x, y, 0.6, 0.6);
    } else {
      const page = await v.doc.getPage(rec.num);
      const size = pointSize(page);
      await page.render({ canvasContext: g, viewport: page.getViewport({ scale: (rec.w * k) / size.w }) }).promise;
    }
    return c;
  })();
  v.thumbBg.set(rec.num, pending);
  return pending;
}

async function paintThumb(rec) {
  const button = thumbButton(rec.num);
  if (!button || rec.view !== state.view) return;
  let bg;
  try { bg = await thumbBackground(rec); } catch { return; } // the view was dropped meanwhile
  const c = button.querySelector('canvas');
  if (!c.isConnected) return;
  c.width = bg.width;
  c.height = bg.height;
  const g = c.getContext('2d');
  g.drawImage(bg, 0, 0);
  const k = bg.width / rec.cw;
  for (const s of rec.view.strokes[rec.num] ?? []) Ink.paintStroke(g, s, rec.w * k, rec.h * k, colorOf);
}

/** A page's ink changed: repaint its thumbnail once things have settled. */
const thumbTimers = new Map();
function refreshThumb(v, id) {
  if (v !== state.view || $('side').hidden || id == null) return;
  clearTimeout(thumbTimers.get(id));
  thumbTimers.set(id, setTimeout(() => {
    thumbTimers.delete(id);
    const rec = state.view === v && v.pages.find((r) => r.num === id);
    if (rec) paintThumb(rec);
  }, 500));
}

function markCurrentThumb() {
  if ($('side').hidden) return;
  const now = visiblePage();
  for (const b of $('side-list').querySelectorAll('.pthumb')) {
    const current = b.rec === now;
    if (current && !b.hasAttribute('aria-current')) b.scrollIntoView({ block: 'nearest' });
    b.toggleAttribute('aria-current', current);
  }
}

function toggleSidebar() {
  const side = $('side');
  side.hidden = !side.hidden;
  $('pages').setAttribute('aria-pressed', String(!side.hidden));
  // the stage is now a different width, so the pages are a different size
  if (state.view) renderView(state.view); else buildSidebar();
}

/* ---------------------------------------------------------------- */
/* search                                                            */
/* ---------------------------------------------------------------- */

const MAX_HITS = 2000;

function showFindCount(searching = false) {
  const { q, hits, cur } = state.search;
  $('find-count').textContent = !q.trim() ? ''
    : hits.length ? `${cur + 1} / ${hits.length}${hits.length >= MAX_HITS ? '+' : ''}`
    : searching ? '…' : 'none';
  $('find-prev').disabled = $('find-next').disabled = hits.length < 2;
}

/** Draw the search hits over their pages. They are plain elements, so they need no canvas. */
function paintHits(pageId) {
  const v = state.view;
  if (!v) return;
  const { hits, cur } = state.search;
  for (const rec of v.pages) {
    if (pageId != null && rec.num !== pageId) continue;
    const marks = [];
    hits.forEach((hit, i) => {
      if (hit.page !== rec.num) return;
      for (const r of hit.rects) {
        const d = document.createElement('div');
        d.className = i === cur ? 'hit cur' : 'hit';
        Object.assign(d.style, {
          left: `${(r.x / rec.xmax) * 100}%`, top: `${r.y * 100}%`,
          width: `${(r.w / rec.xmax) * 100}%`, height: `${r.h * 100}%`,
        });
        marks.push(d);
      }
    });
    rec.hits.replaceChildren(...marks);
  }
}

/** Search the PDF's text, page by page, showing hits as they are found. */
async function runSearch(q) {
  const s = state.search;
  const run = ++s.run;
  s.q = q;
  s.hits = [];
  s.cur = -1;
  paintHits();
  const v = state.view;
  if (!v?.doc || !q.trim()) { showFindCount(); return; }
  showFindCount(true);

  for (const id of v.layout.order) {
    if (isBlank(id)) continue;
    let text;
    try { text = await readText(v, id); } catch { return; }
    if (run !== s.run || v !== state.view) return; // a newer search, or another document
    const found = findMatches(text.items, q);
    if (!found.length) continue;
    const first = s.hits.length === 0;
    for (const m of found) s.hits.push({ page: id, rects: m.rects });
    if (first) gotoHit(0); else { paintHits(id); showFindCount(true); }
    if (s.hits.length >= MAX_HITS) break;
  }
  showFindCount();
}

function gotoHit(i) {
  const s = state.search;
  const v = state.view;
  if (!v || !s.hits.length) return;
  const before = s.hits[s.cur]?.page;
  s.cur = (i + s.hits.length) % s.hits.length;
  const hit = s.hits[s.cur];
  if (before != null && before !== hit.page) paintHits(before);
  paintHits(hit.page);
  const rec = v.pages.find((r) => r.num === hit.page);
  const stage = $('stage');
  if (rec) stage.scrollTop = rec.wrap.offsetTop + hit.rects[0].y * rec.h - stage.clientHeight / 3;
  showFindCount(true);
}

function clearSearch() {
  const s = state.search;
  s.run++;
  s.q = '';
  s.hits = [];
  s.cur = -1;
  $('find').value = '';
  paintHits();
  showFindCount();
}

/* ---------------------------------------------------------------- */
/* text boxes                                                        */
/* ---------------------------------------------------------------- */

const measureCtx = document.createElement('canvas').getContext('2d');
/** Width of a string in ems, in the font text boxes are drawn in. */
function emWidth(s) {
  measureCtx.font = `100px ${TEXT_FONT}`;
  return measureCtx.measureText(s).width / 100;
}

/** Start typing at `pt` — or, if there is a text box there already, edit it. */
function openTextEditor(rec, pt) {
  closeTextEditor(true);
  const v = rec.view;
  const list = v.strokes[rec.num] ?? [];
  const item = [...list].reverse().find((s) => s.k === 'text'
    && pt.x >= s.pts[0].x && pt.x <= s.pts[1].x && pt.y >= s.pts[0].y && pt.y <= s.pts[2].y) ?? null;

  const ink = state.prefs.ink.text;
  const size = item ? item.w : BASE_WIDTH.text * ink.w;
  const width = item ? textBox(item).width : Math.min(0.5, rec.xmax - 0.04);
  const x = item ? item.pts[0].x : Math.max(0.01, Math.min(pt.x, rec.xmax - width - 0.02));
  // a tap lands in the middle of the first line, not at its top
  const y = item ? item.pts[0].y : pt.y - size * (rec.w / rec.h) * (LINE_HEIGHT / 2);
  const color = item ? item.c : ink.c;

  const el = document.createElement('textarea');
  el.className = 'tedit';
  el.value = item?.text ?? '';
  el.setAttribute('aria-label', 'Text note');
  Object.assign(el.style, {
    left: `${(x / rec.xmax) * 100}%`, top: `${y * 100}%`,
    width: `${width * rec.w}px`, fontSize: `${size * rec.w}px`,
    lineHeight: String(LINE_HEIGHT), fontFamily: TEXT_FONT, color: colorOf(color),
  });
  rec.wrap.append(el);
  state.textEdit = { rec, el, item, x, y, width, size, color };
  if (item) redraw(rec); // the page is repainted without it while it is being edited

  const grow = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  el.addEventListener('input', grow);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must not pick tools or trigger shortcuts
    if (e.key === 'Escape') closeTextEditor(false);
  });
  el.addEventListener('blur', () => closeTextEditor(true));
  grow();
  el.focus();
}

/** Finish typing. Committing is one undo step; emptying a box deletes it. */
function closeTextEditor(commit) {
  const t = state.textEdit;
  if (!t) return;
  state.textEdit = null; // first: removing the element blurs it, which calls back in here
  const { rec, el, item } = t;
  const v = rec.view;
  const text = el.value.replace(/\s+$/, '');
  el.remove();

  if (commit && text !== (item?.text ?? '')) {
    const list = (v.strokes[rec.num] ??= []);
    pushUndo(v, rec.num);
    const next = text
      ? makeText({ x: t.x, y: t.y, width: t.width, size: t.size, color: t.color, text }, emWidth, rec.w / rec.h)
      : null;
    const at = item ? list.indexOf(item) : -1;
    if (at >= 0) list.splice(at, 1, ...(next ? [next] : []));
    else if (next) list.push(next);
    persist(v);
  }
  redraw(rec);
}

/* ---------------------------------------------------------------- */
/* notebooks and backup                                              */
/* ---------------------------------------------------------------- */

/** A document with no PDF behind it: it starts as a single blank page. */
async function newNotebook(paper) {
  cycle = null;
  const now = Date.now();
  const key = `notebook-${now}:0`;
  const meta = {
    key, name: 'Notebook', title: `Notebook — ${new Date(now).toLocaleDateString()}`, size: 0,
    added: now, opened: now, pages: 1,
    layout: { order: ['b1'], blanks: { b1: { paper } }, margin: 0 },
  };
  const bytes = new ArrayBuffer(0);
  const stored = Store.isOpen() && await Store.putDoc(meta, bytes);
  await activate(await loadView(key, meta.name, bytes, stored ? meta : { ...meta, thumb: true }));
  if (!stored) state.view.stored = false;
}

/** Every document, its notes and its thumbnail, in one file. */
async function doBackup() {
  try {
    toast('building backup…');
    await persist(state.view);
    const [docs, thumbs] = await Promise.all([Store.listDocs(), Store.listThumbs()]);
    const entries = [];
    for (const meta of docs) {
      entries.push({
        meta,
        notes: (await Store.load(meta.key)) ?? {},
        bytes: (await Store.getBytes(meta.key)) ?? new ArrayBuffer(0),
        thumb: thumbs.get(meta.key) ?? null,
      });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    download(packBackup(entries), `margin-backup-${stamp}${BACKUP_EXT}`, BACKUP_TYPE);
    toast(`backed up ${entries.length} document${entries.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(err);
    toast('backup failed — see console');
  }
}

async function doRestore(file) {
  if (!file) return;
  let backup;
  try {
    backup = await readBackup(file);
  } catch (err) {
    toast(`could not restore: ${err.message}`);
    return;
  }

  const quota = await Store.quotaCheck(file.size);
  if (!quota.ok && !await ask({
    title: 'Storage is nearly full',
    body: `Restoring this backup (${formatSize(file.size)}) would take this browser's storage past 80%.`,
    confirm: 'Restore anyway',
  })) return;

  const here = new Set((await Store.listDocs()).map((d) => d.key));
  const clash = backup.docs.filter((d) => here.has(d.meta.key)).length;
  const replace = clash > 0 && await ask({
    title: `${clash} of these document${clash === 1 ? ' is' : 's are'} already in the library`,
    body: 'Replace their notes with the ones in the backup, or keep what is here now? '
      + 'Documents that are not here yet are added either way.',
    confirm: 'Replace with the backup',
    cancel: 'Keep what is here',
  });

  await persist(state.view);
  let added = 0, replaced = 0, failed = 0;
  for (const d of backup.docs) {
    const exists = here.has(d.meta.key);
    if (exists && !replace) continue;
    // an open copy would write its own, older strokes straight back
    if (exists) closeView(d.meta.key);
    const ok = await Store.putDoc(d.meta, await d.bytes()) && await Store.save(d.meta.key, d.notes);
    const thumb = ok && d.thumb();
    if (thumb) await Store.putThumb(d.meta.key, thumb);
    if (!ok) failed++; else if (exists) replaced++; else added++;
  }
  cycle = null;
  await library.show();
  toast([
    `${added} added`,
    replaced ? `${replaced} replaced` : '',
    clash && !replace ? `${clash} kept as they were` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(' · '));
}

/* ---------------------------------------------------------------- */
/* cleanup preview                                                   */
/* ---------------------------------------------------------------- */

const ghost = document.createElement('canvas');

function previewOptions() {
  return {
    smoothStrength: +$('pv-strength').value / 100,
    level: $('pv-level').checked,
    size: $('pv-size').checked,
    spacing: $('pv-spacing').checked,
  };
}

/** Show what tidying would do to the visible page, without doing it. */
function openPreview(preset) {
  const rec = visiblePage();
  if (!rec) return;
  const list = rec.view.strokes[rec.num];
  if (!list?.length) { toast('nothing to tidy on this page'); return; }

  closePreview(false);
  clearSelection();
  $('pv-strength').value = Math.round(preset.smoothStrength * 100);
  $('pv-level').checked = !!preset.level;
  $('pv-size').checked = !!preset.size;
  $('pv-spacing').checked = !!preset.spacing;

  // the original is painted once and kept; each re-preview only has to
  // paint the cleaned strokes (nothing can draw while a preview is open,
  // so the gesture snapshot is free to hold it)
  redraw(rec);
  under.width = rec.canvas.width;
  under.height = rec.canvas.height;
  under.getContext('2d').drawImage(rec.canvas, 0, 0);

  state.preview = { rec, list, cleaned: null, focus: document.activeElement };
  $('preview').hidden = false;
  renderPreview();
  $('pv-strength').focus();
}

/** The original at full strength with the cleaned result at 50% over it. */
function renderPreview() {
  const p = state.preview;
  if (!p) return;
  const { rec } = p;
  p.cleaned = tidyPage(p.list, previewOptions());

  ghost.width = rec.canvas.width;
  ghost.height = rec.canvas.height;
  const g = ghost.getContext('2d');
  g.setTransform(rec.dpr, 0, 0, rec.dpr, 0, 0);
  for (const s of p.cleaned) Ink.paintStroke(g, s, rec.w, rec.h, colorOf);

  const { ctx } = rec;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, rec.canvas.width, rec.canvas.height);
  ctx.drawImage(under, 0, 0);
  ctx.globalAlpha = 0.5;
  ctx.drawImage(ghost, 0, 0);
  ctx.restore();
}

/** Cancelling touches nothing: the page's strokes were never replaced. */
function closePreview(apply) {
  const p = state.preview;
  if (!p) return;
  state.preview = null;
  $('preview').hidden = true;
  ghost.width = ghost.height = 0;

  const { rec } = p;
  if (apply && p.cleaned) {
    pushUndo(rec.view, rec.num);
    rec.view.strokes[rec.num] = p.cleaned;
    persist(rec.view);
    toast(`tidied page ${rec.num}`);
  }
  redraw(rec);
  p.focus?.focus?.();
}

function visiblePage() {
  const stage = $('stage');
  const mid = stage.scrollTop + stage.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const rec of state.view?.pages ?? []) {
    const top = rec.wrap.offsetTop;
    const c = top + rec.wrap.offsetHeight / 2;
    const d = Math.abs(c - mid);
    if (d < bestD) { bestD = d; best = rec; }
  }
  return best;
}

/* ---------------------------------------------------------------- */
/* chrome                                                            */
/* ---------------------------------------------------------------- */

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/**
 * An in-page confirmation. `confirm()` does not work in sandboxed
 * frames, and a browser dialog cannot say what will be lost.
 */
function ask({ title, body, confirm = 'OK', cancel = 'Cancel' }) {
  const box = $('dialog');
  const back = document.activeElement;
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body;
  $('dlg-ok').textContent = confirm;
  $('dlg-cancel').textContent = cancel;
  box.hidden = false;
  $('dlg-cancel').focus();

  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      box.removeEventListener('click', onClick);
      box.removeEventListener('keydown', onKey);
      back?.focus?.();
      resolve(answer);
    };
    const onClick = (e) => {
      if (e.target === $('dlg-ok')) done(true);
      else if (e.target === $('dlg-cancel') || e.target === box) done(false);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Tab') {
        // two buttons: keep focus moving between them
        e.preventDefault();
        (document.activeElement === $('dlg-ok') ? $('dlg-cancel') : $('dlg-ok')).focus();
      }
    };
    box.addEventListener('click', onClick);
    box.addEventListener('keydown', onKey);
  });
}

function status() {
  const v = state.view;
  if (!v) { $('stat').textContent = 'no document'; return; }
  $('stat').textContent =
    `${v.title} · ${v.layout.order.length} pp · ${Math.round(v.scale * 100)}% · ${Ink.widthMode()}${state.predicting ? ' · predicted ink' : ''}`;
}

/** Bring everything outside the page in line with the open document. */
function syncChrome() {
  const v = state.view;
  syncHistory();
  $('empty').hidden = !!v || library.visible;
  document.title = v ? `${v.title} — Margin` : 'Margin';
  status();
}

function optionButtons(host, labels, active, onPick) {
  for (const [value, label] of Object.entries(labels)) {
    const b = document.createElement('button');
    b.className = 'tb';
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(value === active));
    b.addEventListener('click', () => onPick(value));
    host.append(b);
  }
}

/** Colours, weight and sub-options for whichever tool is selected. */
function buildToolOptions() {
  const tool = state.prefs.tool;
  const ink = state.prefs.ink[tool]; // undefined for erase and select

  const opts = $('opts');
  opts.innerHTML = '';
  if (tool === 'shape') {
    optionButtons(opts, SHAPE_LABELS, state.prefs.shape, (kind) => {
      state.prefs.shape = kind;
      prefsChanged();
    });
  } else if (tool === 'erase') {
    optionButtons(opts, ERASER_LABELS, state.prefs.eraser, (mode) => {
      state.prefs.eraser = mode;
      prefsChanged();
    });
  }
  opts.hidden = !opts.children.length;

  const colors = $('colors');
  colors.innerHTML = '';
  for (const token of PALETTES[tool] ?? []) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.type = 'button';
    b.style.background = colorOf(token);
    b.setAttribute('aria-pressed', String(token === ink.c));
    b.setAttribute('aria-label', `color ${token.replace('--', '')}`);
    b.addEventListener('click', () => { ink.c = token; prefsChanged(); });
    colors.append(b);
  }
  colors.hidden = !ink;

  $('weight-grp').hidden = !ink;
  if (ink) $('weight').value = Math.round(ink.w * 100);
}

function prefsChanged() {
  savePrefs(() => localStorage, state.prefs);
  buildToolOptions();
}

function setTool(t) {
  state.cancelDrag?.();
  clearSelection();
  closeTextEditor(true);
  state.prefs.tool = t;
  for (const id of TOOLS) {
    $(`t-${id}`).setAttribute('aria-pressed', String(t === id));
  }
  prefsChanged();
}

/** In stylus-only mode fingers are handed back to the browser to scroll with. */
function setStylusOnly(on) {
  state.stylusOnly = on;
  $('stylus').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('stylus-only', on);
}

async function persist(v) {
  if (v?.key) await Store.save(v.key, v.strokes);
}

/* ---------------------------------------------------------------- */
/* opening documents                                                 */
/* ---------------------------------------------------------------- */

/**
 * Add a freshly opened document to the library. The quota check comes
 * before the write: a failed 50MB put is a bad way to find out.
 */
async function addToLibrary(v, size) {
  const q = await Store.quotaCheck(size);
  if (!q.ok) {
    const go = await ask({
      title: 'Storage is nearly full',
      body: `Keeping “${v.name}” (${formatSize(size)}) in the library would take this browser's storage past 80% — ` +
        `${formatSize(q.usage)} of ${formatSize(q.quota)} is already used. ` +
        'You can still open and annotate it without keeping a copy.',
      confirm: 'Keep a copy anyway',
      cancel: 'Open without keeping',
    });
    if (!go) return false;
  }
  const now = Date.now();
  const ok = await Store.putDoc({
    key: v.key, name: v.name, title: v.title, size,
    added: now, opened: now, pages: v.layout.order.length,
  }, v.srcBytes);
  if (!ok) toast('could not add this document to the library');
  return ok;
}

async function openFile(file) {
  if (!file || !pdfjsLib) return;
  cycle = null;
  const key = Store.keyFor(file);
  if (views.has(key)) return activate(views.get(key));

  let v;
  try {
    const bytes = await file.arrayBuffer();
    v = await loadView(key, file.name, bytes, await Store.getDoc(key));
  } catch (err) {
    console.error(err);
    toast('could not open that file');
    return;
  }
  if (!v.stored && Store.isOpen()) v.stored = await addToLibrary(v, file.size);
  await activate(v);
}

/** Open a library document: from memory if it is still there, else from storage. */
async function openStored(key) {
  if (key === state.view?.key) { library.hide(); syncChrome(); return; }
  if (views.has(key)) return activate(views.get(key));

  const [meta, bytes] = await Promise.all([Store.getDoc(key), Store.getBytes(key)]);
  if (!meta || !bytes) { toast('that document is no longer in the library'); return; }
  await activate(await loadView(key, meta.name, bytes, meta));
}

/** Step to the previous or next document by last opened. */
async function cycleDoc(step) {
  // Opening a document moves it to the front of the last-opened order,
  // so stepping against a live order would only ever swap two documents.
  cycle ??= sortDocs(await Store.listDocs(), 'opened').map((d) => d.key);
  const next = cycleKey(cycle, state.view?.key, step);
  if (next && next !== state.view?.key) await openStored(next);
}

async function doExport() {
  const v = state.view;
  if (!v?.srcBytes) return;
  try {
    toast('building PDF…');
    closeTextEditor(true);
    const out = await stampPdf(v.srcBytes.slice(0), v.strokes, colorOf, v.layout);
    download(out, v.title.replace(/\.pdf$/i, '') + ' — annotated.pdf');
    toast('exported');
  } catch (err) {
    console.error(err);
    toast('export failed — see console');
  }
}

function zoom(factor) {
  const v = state.view;
  if (!v) return;
  v.scale = Math.min(4, Math.max(0.4, v.scale * factor));
  closePreview(false);
  saveViewState(v);
  renderView(v);
}

/* ---------------------------------------------------------------- */
/* wiring                                                            */
/* ---------------------------------------------------------------- */

function init() {
  library = initLibrary({
    root: $('library'),
    store: Store,
    ask,
    currentKey: () => state.view?.key ?? null,
    onOpen: (key) => { cycle = null; enqueue(() => openStored(key)); },
    onDeleted: (key) => { cycle = null; closeView(key); },
    onRenamed: (key, title) => {
      const v = views.get(key);
      if (v) v.title = title;
      syncChrome();
    },
    onToggle: (visible) => {
      $('lib').setAttribute('aria-pressed', String(visible));
      $('empty').hidden = !!state.view || visible;
    },
  });

  $('file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still fires
    enqueue(() => openFile(file));
  });
  $('lib').addEventListener('click', () => (library.visible ? library.hide() : library.show()));

  for (const id of TOOLS) {
    $(`t-${id}`).addEventListener('click', () => setTool(id));
  }

  $('undo').addEventListener('click', () => stepHistory(-1));
  $('redo').addEventListener('click', () => stepHistory(1));

  // two fingers tapped together undo, three redo — anywhere over the document
  const tap = createTapDetector({
    onTap: (fingers) => {
      if (library.visible || !$('dialog').hidden) return;
      if (stepHistory(fingers === 2 ? -1 : 1)) toast(fingers === 2 ? 'undo' : 'redo');
    },
  });
  for (const [type, kind] of [['touchstart', 'start'], ['touchmove', 'move'], ['touchend', 'end'], ['touchcancel', 'cancel']]) {
    $('main').addEventListener(type, (e) => {
      // with stylus-only off the first finger has begun a stroke: take it back
      if (kind === 'start' && e.touches.length > 1) state.abortFingerStroke?.();
      tap(kind, [...e.touches].map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY, type: t.touchType })), e.timeStamp);
    }, { passive: true });
  }

  $('sel-level').addEventListener('click', () => editSelection((strokes) => {
    // typed text is level already, and rotating its box would only skew it
    const levelled = straighten(strokes.map((s) => (s.k === 'text' ? { ...s, pts: [] } : s)), { asOneLine: true });
    return strokes.map((s, i) => (s.k === 'text' ? s : levelled[i]));
  }));
  $('sel-copy').addEventListener('click', copySelection);
  $('sel-delete').addEventListener('click', deleteSelection);
  $('sel-done').addEventListener('click', clearSelection);

  $('zoombox').addEventListener('click', () => (state.zoomBox ? closeZoomBox() : openZoomBox()));

  $('pages').addEventListener('click', toggleSidebar);
  $('side-add').addEventListener('click', addPage);
  $('side-margin').addEventListener('click', toggleMargin);

  let ft = null;
  $('find').addEventListener('input', (e) => {
    clearTimeout(ft);
    const q = e.target.value;
    ft = setTimeout(() => runSearch(q), 250);
  });
  $('find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(state.search.cur + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); e.target.blur(); }
  });
  $('find-next').addEventListener('click', () => gotoHit(state.search.cur + 1));
  $('find-prev').addEventListener('click', () => gotoHit(state.search.cur - 1));

  $('lib-new').addEventListener('click', () => enqueue(() => newNotebook($('lib-paper').value)));
  $('lib-backup').addEventListener('click', doBackup);
  $('lib-restore').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    enqueue(() => doRestore(file));
  });
  $('strip-close').addEventListener('click', closeZoomBox);
  for (const step of ['left', 'right', 'line']) {
    $(`strip-${step}`).addEventListener('click', () => {
      const z = state.zoomBox;
      moveZoomBox(advance(z.target, step, { xmax: z.rec.xmax }));
    });
  }
  $('zin').addEventListener('click', () => zoom(1.25));
  $('zout').addEventListener('click', () => zoom(1 / 1.25));

  $('weight').addEventListener('input', (e) => {
    const ink = state.prefs.ink[state.prefs.tool];
    if (!ink) return;
    ink.w = +e.target.value / 100;
    savePrefs(() => localStorage, state.prefs);
  });

  $('stylus').addEventListener('click', () => setStylusOnly(!state.stylusOnly));

  // Automatic palm rejection: the first pen contact of a session proves
  // there is a stylus, so from then on fingers scroll instead of drawing.
  // Once only — after that the toggle is the user's to set.
  document.addEventListener('pointerdown', (e) => {
    state.lastPointer = e.pointerType;
    if (e.pointerType !== 'pen' || state.penSeen) return;
    state.penSeen = true;
    if (state.stylusOnly) return;
    setStylusOnly(true);
    toast('stylus detected — only the pen draws now; fingers scroll and pinch');
  }, true);

  $('tidy').addEventListener('click', () => openPreview({ smoothStrength: 0.7 }));
  $('level').addEventListener('click', () => openPreview({ smoothStrength: 0.45, level: true }));
  for (const id of ['pv-strength', 'pv-level', 'pv-size', 'pv-spacing']) {
    $(id).addEventListener('input', renderPreview);
  }
  $('pv-apply').addEventListener('click', () => closePreview(true));
  $('pv-cancel').addEventListener('click', () => closePreview(false));
  $('export').addEventListener('click', doExport);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.cancelDrag) state.cancelDrag();
      else if (state.preview) closePreview(false);
      else if (state.selection) clearSelection();
      else if (library.visible && state.view) library.hide();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f' && state.view) { e.preventDefault(); $('find').focus(); $('find').select(); return; }
    // typing in a field is typing, not a shortcut (sliders and checkboxes are not typing)
    if (e.target.matches?.('input:not([type="range"]):not([type="checkbox"]), textarea, select')) return;

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory(1); return; }
    if (state.selection && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelection(); return; }
    if (mod && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      enqueue(() => cycleDoc(e.code === 'BracketLeft' ? -1 : 1));
      return;
    }
    if (mod || e.altKey || state.preview) return;
    const tool = TOOLS[Number(e.key) - 1];
    if (tool) setTool(tool);
  });

  // drag and drop
  for (const t of ['dragenter', 'dragover']) {
    document.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  }
  for (const t of ['dragleave', 'drop']) {
    document.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.remove('dragging'); });
  }
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f?.type === 'application/pdf') enqueue(() => openFile(f));
  });

  let rt = null;
  window.addEventListener('resize', () => {
    if (!state.view) return;
    clearTimeout(rt);
    rt = setTimeout(() => {
      const v = state.view;
      if (!v || v.avail === availWidth()) return;
      closePreview(false);
      renderView(v);
    }, 220);
  });

  // remember where each document was left
  let st = null, marking = false;
  $('stage').addEventListener('scroll', () => {
    if (!marking) {
      marking = true;
      requestAnimationFrame(() => { marking = false; markCurrentThumb(); });
    }
    clearTimeout(st);
    st = setTimeout(() => {
      const v = state.view;
      if (!v) return;
      captureScroll(v);
      saveViewState(v);
    }, 400);
  }, { passive: true });
  window.addEventListener('pagehide', () => {
    const v = state.view;
    if (!v) return;
    captureScroll(v);
    saveViewState(v);
  });

  // swatches are painted from the theme's tokens
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    colorCache.clear();
    buildToolOptions();
    state.view?.pages.forEach(redraw);
  });

  setTool(state.prefs.tool);
  syncChrome();

  Store.open().then(async (ok) => {
    if (!ok) {
      // said once; everything else carries on without storage
      $('lib').disabled = true;
      $('lib').title = 'Library unavailable — this browser is blocking storage';
      toast('library unavailable — storage is blocked, so documents and notes will not be kept');
      return;
    }
    if (!state.view && (await Store.listDocs()).length) library.show();
    showStorageNote();
  });

  // installed copies work offline; the single-file build has no manifest and skips this
  if ('serviceWorker' in navigator && document.querySelector('link[rel="manifest"]')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('offline support unavailable', err));
  }
}

/**
 * Ask the browser not to evict our storage, and say where things stand.
 * Safari clears a site's storage after 7 days without a visit unless it
 * has been added to the Home Screen — worth knowing before a week away.
 */
async function showStorageNote() {
  let persisted = null;
  try {
    if (navigator.storage?.persist) persisted = await navigator.storage.persist();
  } catch { /* leave it unknown */ }
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const note = storageNote(persisted, installed);
  const el = $('lib-storage');
  el.textContent = note.label;
  el.title = note.detail;
  el.dataset.state = note.state;
}

init();
