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
  penDown: false,     // is a pen gesture in progress right now?
  lastPointer: '',    // pointerType of the most recent pointerdown
  autoShapes: false,
  autoSmooth: true,
  preview: null,      // { rec, list, cleaned } while a tidy preview is open
  cancelDrag: null,   // set while a shape or selection drag is in progress
};

const KEEP_VIEWS = 3;
const views = createLru(KEEP_VIEWS, dropView);
let library = null;
let cycle = null;     // last-opened order, frozen while stepping with Ctrl+[ / ]

// stroke width at weight 1, in page widths
const BASE_WIDTH = { pen: 0.0032, pencil: 0.0038, highlight: 0.018, shape: 0.0032 };
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
/* undo                                                              */
/* ---------------------------------------------------------------- */

function pushUndo(v, pageNum) {
  v.undo.push({
    page: pageNum,
    before: JSON.parse(JSON.stringify(v.strokes[pageNum] ?? [])),
  });
  if (v.undo.length > 60) v.undo.shift();
  $('undo').disabled = false;
}

function doUndo() {
  const v = state.view;
  const step = v?.undo.pop();
  if (!step) return;
  closePreview(false);
  v.strokes[step.page] = step.before;
  const rec = v.pages.find((p) => p.num === step.page);
  if (rec) redraw(rec);
  $('undo').disabled = v.undo.length === 0;
  persist(v);
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
    doc: null,
    strokes: {},            // pageNum -> Stroke[]
    undo: [],               // { page, before: Stroke[] }
    pages: [],              // render records
    scale: meta?.view?.scale ?? 1,
    scroll: meta?.view?.scroll ?? null,  // { page, at }; null = never scrolled, start at the top
    avail: 0, drawnScale: 0,          // what the pages were last rendered at
    gen: 0,                 // bumped to abandon a render in progress
    ready: false,           // laid out, so its scroll position means something
  };
}

async function loadView(key, name, bytes, meta) {
  const v = makeView(key, name, bytes, meta);
  // pdf.js takes ownership of the buffer it is given, so hand it a copy
  v.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  v.strokes = (await Store.load(key)) ?? {};
  return v;
}

/** Release everything a view holds. Its strokes are already persisted. */
function dropView(v) {
  v.gen++;
  v.ready = false;
  for (const rec of v.pages) freePage(rec);
  v.pages = [];
  v.el.remove();
  v.doc?.destroy();
}

function freePage(rec) {
  // a canvas keeps its backing store until it is resized or collected
  rec.canvas.width = rec.canvas.height = 0;
  rec.pdfCanvas.width = rec.pdfCanvas.height = 0;
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
  state.cancelDrag?.();
  if (prev === v) { library.hide(); return; }
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

  // back where it was left, even if the pages then need re-rendering
  // because the window changed size while this document was away
  if (v.pages.length) restoreScroll(v);
  if (!v.pages.length || v.avail !== availWidth() || v.drawnScale !== v.scale) {
    renderView(v); // not awaited: pages paint in as they are ready
  }
}

function closeView(key) {
  views.delete(key);
  if (state.view?.key !== key) return;
  state.view = null;
  $('stage').replaceChildren();
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

function redraw(rec) {
  const { ctx, canvas, dpr, w, h, num } = rec;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of rec.view.strokes[num] ?? []) {
    Ink.paintStroke(ctx, s, w, h, colorOf);
  }
}

async function renderView(v) {
  const gen = ++v.gen;
  const avail = availWidth();
  const scale = v.scale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const total = v.doc.numPages;
  const recs = [];

  try {
    // Lay every page out before painting any, off the document. The
    // stage then goes from the old layout to the new one in a single
    // step, and the scroll position can be restored straight away.
    for (let n = 1; n <= total; n++) {
      const page = await v.doc.getPage(n);
      if (gen !== v.gen) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (avail / base.width) * scale });

      const wrap = document.createElement('div');
      wrap.className = 'pagewrap';
      wrap.style.width = `${Math.floor(vp.width)}px`;
      wrap.style.height = `${Math.floor(vp.height)}px`;

      const pdfCanvas = document.createElement('canvas');
      pdfCanvas.width = Math.floor(vp.width * dpr);
      pdfCanvas.height = Math.floor(vp.height * dpr);
      pdfCanvas.style.width = `${Math.floor(vp.width)}px`;
      pdfCanvas.style.height = `${Math.floor(vp.height)}px`;

      const inkCanvas = document.createElement('canvas');
      inkCanvas.className = 'ink';
      inkCanvas.width = pdfCanvas.width;
      inkCanvas.height = pdfCanvas.height;
      inkCanvas.style.width = pdfCanvas.style.width;
      inkCanvas.style.height = pdfCanvas.style.height;

      const tag = document.createElement('div');
      tag.className = 'pnum';
      tag.textContent = `${n} / ${total}`;

      wrap.append(pdfCanvas, inkCanvas, tag);

      const pctx = pdfCanvas.getContext('2d');
      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const rec = {
        num: n, view: v, wrap, page, vp, pdfCanvas, pctx, canvas: inkCanvas,
        ctx: inkCanvas.getContext('2d', { desynchronized: true }),
        w: vp.width, h: vp.height, dpr,
      };
      recs.push(rec);
      attachInput(rec);
    }

    if (v === state.view) captureScroll(v);
    v.ready = false;
    const old = v.pages;
    v.pages = recs;
    v.avail = avail;
    v.drawnScale = scale;
    v.el.replaceChildren(...recs.map((r) => r.wrap));
    old.forEach(freePage);
    recs.forEach(redraw);
    if (v === state.view) { restoreScroll(v); status(); }
    v.ready = true;

    for (const rec of recs) {
      await rec.page.render({ canvasContext: rec.pctx, viewport: rec.vp }).promise;
      if (gen !== v.gen) return;
      if (rec.num === 1) saveThumb(v, rec);
    }
  } catch (err) {
    // a view dropped mid-render rejects its pending pages; that is not an error
    if (gen === v.gen) { console.error(err); toast('could not render that document'); }
  }
}

/** Written once, the first time page 1 of a library document is rendered. */
async function saveThumb(v, rec) {
  if (!v.stored || v.thumbed) return;
  v.thumbed = true;
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = Math.round((320 * rec.h) / rec.w);
  c.getContext('2d').drawImage(rec.pdfCanvas, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  if (blob && await Store.putThumb(v.key, blob)) {
    await Store.updateDoc(v.key, { thumb: true });
    if (library.visible) library.refresh();
  }
}

/* ---------------------------------------------------------------- */
/* input                                                             */
/* ---------------------------------------------------------------- */

// The page's ink as it stood when the current gesture began. Each move
// repaints this plus the one stroke in progress, so drawing costs the
// same on a page with five strokes as on one with five hundred.
const under = document.createElement('canvas');

function attachInput(rec) {
  const el = rec.canvas;
  const v = rec.view;
  let cur = null;       // freehand stroke in progress
  let drag = null;      // shape or selection in progress: { tool, a, b, shift }
  let erasing = null;   // { undone } while the eraser is down
  let active = null;    // pointerId of the gesture in progress
  let settle = null;    // timer for the repaint that follows a pause in writing

  const local = (e) => {
    const r = el.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      p: e.pressure,
      t: performance.now(),
    };
  };

  const allowed = (e) => e.pointerType === 'pen' || !state.stylusOnly;

  const snapshot = () => {
    under.width = el.width;
    under.height = el.height;
    under.getContext('2d').drawImage(el, 0, 0);
  };

  /** Repaint the snapshot, then `stroke` on top of it if there is one. */
  const paintOver = (stroke) => {
    const { ctx, dpr, w, h } = rec;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(under, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (stroke) Ink.paintStroke(ctx, stroke, w, h, colorOf);
  };

  const shapeStroke = (d) => {
    const aspect = rec.w / rec.h;
    if (dragLength(d.a, d.b, aspect) < 0.006) return null; // a tap, not a drag
    const ink = state.prefs.ink.shape;
    const w = BASE_WIDTH.shape * ink.w;
    const kind = state.prefs.shape;
    const pts = dragShape(kind, d.a, d.b, { constrain: d.shift, aspect });
    return { k: 'pen', shape: kind, c: ink.c, w, pts: pts.map((p) => ({ x: p.x, y: p.y, w })) };
  };

  const paintDrag = () => {
    if (drag.tool === 'shape') { paintOver(shapeStroke(drag)); return; }
    paintOver(null);
    const { ctx, w, h } = rec;
    ctx.save();
    ctx.strokeStyle = colorOf('--accent');
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(
      Math.min(drag.a.x, drag.b.x) * w, Math.min(drag.a.y, drag.b.y) * h,
      Math.abs(drag.b.x - drag.a.x) * w, Math.abs(drag.b.y - drag.a.y) * h
    );
    ctx.restore();
  };

  // Fingers scroll and pinch natively in stylus-only mode (see the
  // touch-action rule in app.css), but the browser would let the pen
  // scroll too. Claiming the pen's touches here is what keeps it drawing.
  const claimTouch = (e) => {
    if (!e.cancelable) return;
    const touchTypes = [...e.changedTouches].map((t) => t.touchType);
    if (Ink.inkOwnsTouch({ ...state, touchTypes })) e.preventDefault();
  };
  el.addEventListener('touchstart', claimTouch, { passive: false });
  el.addEventListener('touchmove', claimTouch, { passive: false });

  el.addEventListener('pointerdown', (e) => {
    if (!allowed(e) || state.preview || active !== null) return;
    clearTimeout(settle);
    active = e.pointerId;
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

    snapshot();

    if (tool === 'select' || tool === 'shape') {
      drag = { tool, a: pt, b: pt, shift: e.shiftKey };
      state.cancelDrag = () => { drag = null; active = null; state.penDown = false; state.cancelDrag = null; redraw(rec); };
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
    if (cur.k === 'pencil') pt.a = pencilAlpha(pt, null, Ink.speedStats.fast);
    (v.strokes[rec.num] ??= []).push(cur);
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return; // a resting palm, not the gesture
    if (erasing) {
      const batch = e.getCoalescedEvents?.() ?? [];
      for (const ev of (batch.length ? batch : [e])) eraseAt(rec, local(ev), erasing);
      e.preventDefault();
      return;
    }
    if (drag) {
      drag.b = local(e);
      drag.shift = e.shiftKey;
      paintDrag();
      e.preventDefault();
      return;
    }
    if (!cur) return;

    const batch = e.getCoalescedEvents?.() ?? [e];
    for (const ev of (batch.length ? batch : [e])) {
      Ink.notePressure(ev.pressure);
      const pt = local(ev);
      const prev = cur.pts[cur.pts.length - 1];
      pt.w = Ink.widthFor(pt, prev, cur.w);
      if (cur.k === 'pencil') pt.a = pencilAlpha(pt, prev, Ink.speedStats.fast);
      cur.pts.push(pt);
    }
    paintOver(cur);
    e.preventDefault();
  });

  const finish = (e, cancelled) => {
    // only the pointer that started the gesture may end it: a palm
    // lifting off mid-stroke must not cut the stroke short
    if (e.pointerId !== active) return;
    active = null;
    state.penDown = false;
    if (erasing) { erasing = null; return; }

    if (drag) {
      const d = drag;
      drag = null;
      state.cancelDrag = null;
      if (!cancelled && d.tool === 'select') {
        levelSelection(rec, {
          x0: Math.min(d.a.x, d.b.x), x1: Math.max(d.a.x, d.b.x),
          y0: Math.min(d.a.y, d.b.y), y1: Math.max(d.a.y, d.b.y),
        });
      }
      const shape = !cancelled && d.tool === 'shape' ? shapeStroke(d) : null;
      if (shape) {
        // one undo step for the shape, however long it was dragged about
        pushUndo(v, rec.num);
        (v.strokes[rec.num] ??= []).push(shape);
        persist(v);
      }
      // a levelled selection moved existing strokes; anything else only added one
      if (d.tool === 'select') redraw(rec); else paintOver(shape);
      return;
    }

    if (!cur) return;
    const list = v.strokes[rec.num];
    let done = cur;
    if (cur.pts.length < 2) {
      list.splice(list.indexOf(cur), 1);
      v.undo.pop();
      $('undo').disabled = v.undo.length === 0;
      done = null;
    } else {
      // post-processing on stroke end
      if (state.autoShapes) {
        const shape = recognize(cur.pts);
        const pts = shape && shapeToPoints(shape);
        if (pts) {
          cur.shape = shape.type;
          cur.pts = pts.map((p) => ({ ...p, w: cur.w }));
        }
      } else if (state.autoSmooth && cur.k !== 'hi') {
        cur.pts = smooth(cur.pts, 0.35);
      }
    }
    cur = null;
    // the finished stroke goes on top of the snapshot; the rest of the
    // page was not touched, so it is not repainted
    paintOver(done);
    // ...until the hand pauses. Then one full repaint from the stroke
    // data, so the canvas is always exactly what a reload would show.
    settle = setTimeout(() => { if (active === null && rec.canvas.width) redraw(rec); }, 300);
    persist(v);
    status();
  };

  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
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

function levelSelection(rec, rect) {
  const v = rec.view;
  const list = v.strokes[rec.num];
  if (!list?.length) return;
  const idx = Ink.strokesInRect(list, rect);
  if (idx.length < 2) return;

  pushUndo(v, rec.num);
  const subset = idx.map((i) => list[i]);
  const levelled = straighten(subset, { asOneLine: true });
  idx.forEach((i, k) => { list[i] = levelled[k]; });
  persist(v);
  toast(`levelled ${idx.length} strokes`);
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
  if (rec.canvas.width) redraw(rec);
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
    `${v.title} · ${v.doc.numPages} pp · ${Math.round(v.scale * 100)}% · ${Ink.widthMode()}`;
}

/** Bring everything outside the page in line with the open document. */
function syncChrome() {
  const v = state.view;
  $('undo').disabled = !v?.undo.length;
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
    added: now, opened: now, pages: v.doc.numPages,
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
    const out = await stampPdf(v.srcBytes.slice(0), v.strokes, colorOf);
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

  $('undo').addEventListener('click', doUndo);
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

  $('shapes').addEventListener('click', (e) => {
    state.autoShapes = !state.autoShapes;
    e.currentTarget.setAttribute('aria-pressed', String(state.autoShapes));
    toast(state.autoShapes ? 'shapes snap on release' : 'shapes off');
  });

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
      else if (library.visible && state.view) library.hide();
      return;
    }
    if (e.target.matches?.('input[type="text"], textarea, select')) return;

    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
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
  let st = null;
  $('stage').addEventListener('scroll', () => {
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
