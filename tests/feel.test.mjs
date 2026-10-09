import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../src/history.js';
import { createTapDetector, heldStill, trimRest } from '../src/gestures.js';
import { strokesInLasso, boundsOf, clampMove, resizeScale, transformStrokes, recolorStrokes } from '../src/tools/lasso.js';
import { scratchOut, scratchTargets } from '../src/tools/scratch.js';
import { stripToPage, pageToStrip, targetFor, magnification, advance } from '../src/tools/zoombox.js';
import { recognize } from '../src/cleanup.js';
import { rng, gauss, box, letter, lineOf } from './helpers.mjs';

/* ---------------------------------------------------------------- */
/* undo / redo                                                       */
/* ---------------------------------------------------------------- */

const ink = (id) => ({ k: 'pen', id, pts: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });
const ids = (doc, page = 1) => (doc.strokes[page] ?? []).map((s) => s.id).join('');
const newDoc = () => ({ strokes: {}, layout: { order: [1, 2, 3], blanks: {}, margin: 0 } });

function draw(h, doc, id, page = 1) {
  h.record(doc, page);
  (doc.strokes[page] ??= []).push(ink(id));
}

test('undo then redo returns the page to exactly where it was', () => {
  const h = createHistory(), doc = newDoc();
  draw(h, doc, 'a'); draw(h, doc, 'b'); draw(h, doc, 'c');
  const full = JSON.stringify(doc);

  assert.deepEqual(h.undo(doc), { page: 1, layout: false });
  h.undo(doc);
  assert.equal(ids(doc), 'a');
  assert.deepEqual(h.redo(doc), { page: 1, layout: false });
  assert.equal(ids(doc), 'ab');
  h.redo(doc);
  assert.equal(JSON.stringify(doc), full);
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(doc), null);
});

test('a new edit forgets what could have been redone', () => {
  const h = createHistory(), doc = newDoc();
  draw(h, doc, 'a'); draw(h, doc, 'b');
  h.undo(doc);
  assert.equal(h.canRedo, true);
  draw(h, doc, 'x');
  assert.equal(h.canRedo, false);
  assert.equal(ids(doc), 'ax');
});

test('a tap that leaves no ink does not cost the redo stack', () => {
  const h = createHistory(), doc = newDoc();
  draw(h, doc, 'a'); draw(h, doc, 'b');
  h.undo(doc);
  h.record(doc, 1); // pen touches down...
  h.discard();      // ...and lifts without drawing
  assert.equal(h.canRedo, true);
  h.redo(doc);
  assert.equal(ids(doc), 'ab');
  h.undo(doc); h.undo(doc);
  assert.equal(h.canUndo, false);
});

test('history works across pages and is bounded', () => {
  const h = createHistory(5), doc = newDoc();
  draw(h, doc, 'a', 1); draw(h, doc, 'b', 2);
  assert.equal(h.undo(doc).page, 2);
  assert.equal(ids(doc, 1), 'a');
  assert.equal(ids(doc, 2), '');
  assert.equal(h.redo(doc).page, 2);

  for (let i = 0; i < 20; i++) draw(h, doc, 'z', 3);
  let steps = 0;
  while (h.undo(doc) !== null) steps++;
  assert.equal(steps, 5);
});

test('undo steps are snapshots: later edits to the page do not leak into them', () => {
  const h = createHistory(), doc = newDoc();
  draw(h, doc, 'a');
  h.record(doc, 1);
  doc.strokes[1][0].pts[0].x = 0.9; // a move, done in place
  h.undo(doc);
  assert.equal(doc.strokes[1][0].pts[0].x, 0.1);
});

/* ---------------------------------------------------------------- */
/* multi-finger taps                                                 */
/* ---------------------------------------------------------------- */

function taps() {
  const seen = [];
  return { seen, feed: createTapDetector({ onTap: (n) => seen.push(n) }) };
}
const T = (id, x, y, type = 'direct') => ({ id, x, y, type });

test('a two-finger tap and a three-finger tap are told apart', () => {
  const { seen, feed } = taps();
  feed('start', [T(1, 100, 100)], 0);
  feed('start', [T(1, 100, 100), T(2, 180, 110)], 20);
  feed('move', [T(1, 102, 101), T(2, 181, 108)], 60); // fingers are never perfectly still
  feed('end', [T(2, 181, 108)], 110);
  feed('end', [], 130);
  assert.deepEqual(seen, [2]);

  feed('start', [T(1, 100, 100), T(2, 180, 110), T(3, 260, 105)], 1000);
  feed('end', [], 1100);
  assert.deepEqual(seen, [2, 3]);
});

test('a two-finger scroll is not a tap', () => {
  const { seen, feed } = taps();
  feed('start', [T(1, 100, 300), T(2, 180, 300)], 0);
  for (let i = 1; i <= 6; i++) feed('move', [T(1, 100, 300 - i * 12), T(2, 180, 300 - i * 12)], i * 16);
  feed('end', [], 120);
  assert.deepEqual(seen, []);
});

test('a pinch is not a tap, even a quick one', () => {
  const { seen, feed } = taps();
  feed('start', [T(1, 200, 300), T(2, 260, 300)], 0);
  feed('move', [T(1, 180, 300), T(2, 280, 300)], 40);
  feed('end', [], 90);
  assert.deepEqual(seen, []);
});

test('holding, one finger, four fingers, late fingers and the browser taking over are not taps', () => {
  const cases = {
    'held too long': (f) => { f('start', [T(1, 0, 0), T(2, 50, 0)], 0); f('end', [], 600); },
    'one finger': (f) => { f('start', [T(1, 0, 0)], 0); f('end', [], 80); },
    'four fingers': (f) => { f('start', [T(1, 0, 0), T(2, 50, 0), T(3, 100, 0), T(4, 150, 0)], 0); f('end', [], 80); },
    'second finger arrives late': (f) => { f('start', [T(1, 0, 0)], 0); f('start', [T(1, 0, 0), T(2, 50, 0)], 250); f('end', [], 300); },
    'scroll took over': (f) => { f('start', [T(1, 0, 0), T(2, 50, 0)], 0); f('cancel', [], 60); },
    'a stylus is one of them': (f) => { f('start', [T(1, 0, 0, 'stylus'), T(2, 50, 0)], 0); f('end', [], 80); },
  };
  for (const [name, run] of Object.entries(cases)) {
    const { seen, feed } = taps();
    run(feed);
    assert.deepEqual(seen, [], name);
  }
});

test('the detector recovers when a scroll is taken over and its fingers are never reported lifting', () => {
  const { seen, feed } = taps();
  feed('start', [T(1, 0, 0), T(2, 50, 0)], 0);
  feed('move', [T(1, 0, 30), T(2, 50, 30)], 30);
  feed('cancel', [T(1, 0, 30), T(2, 50, 30)], 40); // the browser starts scrolling; no touchend follows
  feed('start', [T(3, 0, 0), T(4, 50, 0)], 3000);
  feed('end', [], 3080);
  assert.deepEqual(seen, [2]);

  // the same, where the browser reuses touch ids and never said the scroll ended
  const reused = taps();
  reused.feed('start', [T(1, 0, 0)], 0);
  reused.feed('start', [T(1, 0, 0), T(2, 50, 0)], 10);
  reused.feed('move', [T(1, 0, 80), T(2, 50, 80)], 60);
  reused.feed('start', [T(1, 0, 0)], 4000);
  reused.feed('start', [T(1, 0, 0), T(2, 50, 0)], 4010);
  reused.feed('end', [T(2, 50, 0)], 4070);
  reused.feed('end', [], 4080);
  assert.deepEqual(reused.seen, [2]);

  // and likewise if the stale gesture was never cancelled at all
  const again = taps();
  again.feed('start', [T(1, 0, 0), T(2, 50, 0)], 0);
  again.feed('start', [T(7, 0, 0), T(8, 50, 0)], 5000);
  again.feed('end', [], 5070);
  assert.deepEqual(again.seen, [2]);
});

test('the detector recovers: a tap straight after a scroll still counts', () => {
  const { seen, feed } = taps();
  feed('start', [T(1, 0, 0), T(2, 50, 0)], 0);
  feed('move', [T(1, 0, 90), T(2, 50, 90)], 50);
  feed('end', [], 100);
  feed('start', [T(3, 0, 0), T(4, 50, 0)], 400);
  feed('end', [], 480);
  assert.deepEqual(seen, [2]);
});

/* ---------------------------------------------------------------- */
/* hold to snap                                                      */
/* ---------------------------------------------------------------- */

// a stroke drawn over `ms`, then the pen rests (with sensor jitter) for `rest` ms
function strokeThenRest(ms, rest, seed = 1) {
  const rand = rng(seed), pts = [];
  for (let t = 0; t <= ms; t += 8) pts.push({ x: 0.2 + 0.3 * (t / ms), y: 0.4, t });
  for (let t = ms + 8; t <= ms + rest; t += 8) {
    pts.push({ x: 0.5 + gauss(rand) * 0.0006, y: 0.4 + gauss(rand) * 0.0006, t });
  }
  return pts;
}

test('heldStill fires only after the pen has rested about 500ms', () => {
  assert.equal(heldStill(strokeThenRest(400, 300), 700), false);
  assert.equal(heldStill(strokeThenRest(400, 480), 880), false);
  assert.equal(heldStill(strokeThenRest(400, 520), 920), true);
  // the digitizer goes quiet while the pen is still: the clock keeps running
  assert.equal(heldStill(strokeThenRest(400, 100), 400 + 560), true);
});

test('heldStill never fires on a stroke that ends without a pause, or on a dot', () => {
  const moving = strokeThenRest(600, 0);
  assert.equal(heldStill(moving, 600), false);
  assert.equal(heldStill(moving, 640), false); // lifted a moment later
  const slow = Array.from({ length: 200 }, (_, i) => ({ x: 0.2 + i * 0.0012, y: 0.4, t: i * 8 }));
  assert.equal(heldStill(slow, 1600), false, 'slow but still moving');
  const dot = Array.from({ length: 100 }, (_, i) => ({ x: 0.5, y: 0.5, t: i * 8 }));
  assert.equal(heldStill(dot, 800), false);
});

test('a held freehand shape, resting points and all, is still recognised', () => {
  const rand = rng(4);
  const circle = Array.from({ length: 80 }, (_, i) => {
    const a = (i / 79) * Math.PI * 2;
    return { x: 0.5 + 0.1 * Math.cos(a) + gauss(rand) * 0.002, y: 0.5 + 0.1 * Math.sin(a) + gauss(rand) * 0.002, t: i * 8 };
  });
  const end = circle.at(-1);
  for (let i = 1; i <= 60; i++) circle.push({ x: end.x + gauss(rand) * 0.0005, y: end.y + gauss(rand) * 0.0005, t: 640 + i * 8 });
  assert.equal(heldStill(circle, 640 + 60 * 8 + 30), true);
  const drawn = trimRest(circle);
  assert.ok(drawn.length >= 78 && drawn.length <= 84, `${circle.length} points -> ${drawn.length} once the rest is trimmed`);
  assert.equal(recognize(drawn, { strict: false })?.type, 'ellipse');
});

/* ---------------------------------------------------------------- */
/* lasso                                                             */
/* ---------------------------------------------------------------- */

const loop = (cx, cy, r, n = 40) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return { x: cx + r * Math.cos(a) * (1 + 0.08 * Math.sin(a * 5)), y: cy + r * Math.sin(a) * (1 + 0.08 * Math.cos(a * 3)) };
});

test('the lasso selects what it encloses and nothing else', () => {
  const inside = [letter(0.28, 0.31, 0.02), letter(0.31, 0.31, 0.02), letter(0.29, 0.34, 0.015)];
  const outside = [letter(0.6, 0.31, 0.02), letter(0.3, 0.6, 0.02)];
  const crossing = { k: 'pen', w: 0.003, pts: Array.from({ length: 50 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.31 })) };
  const strokes = [outside[0], ...inside, crossing, outside[1]];
  assert.deepEqual(strokesInLasso(strokes, loop(0.3, 0.31, 0.06)), [1, 2, 3]);
});

test('a stroke only half inside the loop is not taken, a loop of two points takes nothing', () => {
  const half = { k: 'pen', pts: Array.from({ length: 20 }, (_, i) => ({ x: 0.3 + i * 0.006, y: 0.3 })) };
  assert.deepEqual(strokesInLasso([half], loop(0.3, 0.3, 0.06)), []);
  assert.deepEqual(strokesInLasso([letter(0.3, 0.3, 0.02)], [{ x: 0, y: 0 }, { x: 1, y: 1 }]), []);
});

test('moving keeps shape and weight; the original is untouched', () => {
  const sel = [letter(0.3, 0.3, 0.02), letter(0.34, 0.3, 0.02)];
  const before = JSON.stringify(sel);
  const moved = transformStrokes(sel, { dx: 0.1, dy: -0.05 });
  assert.equal(JSON.stringify(sel), before);
  const a = boundsOf(sel), b = boundsOf(moved);
  assert.ok(Math.abs(b.x0 - a.x0 - 0.1) < 1e-12 && Math.abs(b.y0 - a.y0 + 0.05) < 1e-12);
  assert.ok(Math.abs((b.x1 - b.x0) - (a.x1 - a.x0)) < 1e-12);
  assert.equal(moved[0].pts[3].w, sel[0].pts[3].w);
  assert.equal(moved[0].c, sel[0].c);
});

test('resizing scales about the anchor and scales ink weight with it', () => {
  const sel = [letter(0.3, 0.3, 0.02), letter(0.34, 0.3, 0.02)];
  const a = boundsOf(sel);
  const big = transformStrokes(sel, { scale: 2, ox: a.x0, oy: a.y0 });
  const b = boundsOf(big);
  assert.ok(Math.abs(b.x0 - a.x0) < 1e-12 && Math.abs(b.y0 - a.y0) < 1e-12, 'the anchored corner stays put');
  assert.ok(Math.abs((b.x1 - b.x0) / (a.x1 - a.x0) - 2) < 1e-9);
  assert.ok(Math.abs((b.y1 - b.y0) / (a.y1 - a.y0) - 2) < 1e-9);
  assert.equal(big[0].w, sel[0].w * 2);
  assert.equal(big[0].pts[5].w, sel[0].pts[5].w * 2);
  // there and back again
  const back = boundsOf(transformStrokes(big, { scale: 0.5, ox: a.x0, oy: a.y0 }));
  assert.ok(Math.abs(back.x1 - a.x1) < 1e-12);
});

test('clampMove never lets a selection leave the page', () => {
  const b = { x0: 0.7, y0: 0.1, x1: 0.9, y1: 0.2 };
  const far = clampMove(b, 0.5, -0.5);
  assert.ok(Math.abs(far.dx - 0.1) < 1e-12 && Math.abs(far.dy + 0.1) < 1e-12);
  assert.deepEqual(clampMove(b, 0.05, 0.05), { dx: 0.05, dy: 0.05 });
});

test('resizeScale follows the pen, keeps proportions, and stays on the page', () => {
  const b = { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.3 };
  assert.ok(Math.abs(resizeScale(b, { x: 0.6, y: 0.4 }) - 2) < 1e-12);
  assert.ok(Math.abs(resizeScale(b, { x: 0.3, y: 0.25 }) - 0.5) < 1e-12);
  assert.ok(Math.abs(resizeScale(b, { x: 0.3, y: 0.5 }) - 3) < 1e-12, 'the further axis decides');
  assert.equal(resizeScale(b, { x: 0.1, y: 0.1 }), 0.2, 'dragged past the anchor: smallest, not inverted');
  const s = resizeScale(b, { x: 5, y: 5 });
  assert.ok(Math.abs(s - 4) < 1e-9, 'stops at the page edge'); // (1 - 0.2) / 0.2
  const flat = { x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.5 }; // a horizontal line has no height
  assert.ok(Number.isFinite(resizeScale(flat, { x: 0.8, y: 0.5 })));
});

test('recolouring keeps highlighter and ink apart', () => {
  const sel = [{ k: 'pen', c: '--pen-1', pts: [] }, { k: 'hi', c: '--hi-1', pts: [] }, { k: 'pencil', c: '--pen-4', pts: [] }];
  assert.deepEqual(recolorStrokes(sel, '--pen-2').map((s) => s.c), ['--pen-2', '--hi-1', '--pen-2']);
  assert.deepEqual(recolorStrokes(sel, '--hi-3').map((s) => s.c), ['--pen-1', '--hi-3', '--pen-4']);
  assert.equal(sel[0].c, '--pen-1');
});

/* ---------------------------------------------------------------- */
/* scratch-out                                                       */
/* ---------------------------------------------------------------- */

const ASPECT = 0.75;
// sample a parametric curve over `ms`, with sensor noise
function trace(fn, ms, seed = 1, noise = 0.0006) {
  const rand = rng(seed), n = Math.max(12, Math.round(ms / 8));
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = fn(i / n);
    return { x: p.x + gauss(rand) * noise, y: p.y + gauss(rand) * noise, t: (i / n) * ms };
  });
}
// triangle wave: 0 -> 1 -> 0 ..., `passes` straight runs
const tri = (u, passes) => { const k = u * passes, f = k - Math.floor(k); return Math.floor(k) % 2 ? 1 - f : f; };

// a back-and-forth scribble across a w x h patch, at `angle`
function scribble({ passes = 7, w = 0.12, h = 0.02, ms = 900, angle = 0, seed = 1, cx = 0.4, cy = 0.4 } = {}) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return trace((u) => {
    const a = (tri(u, passes) - 0.5) * w, b = (u - 0.5) * h;
    return { x: cx + (a * c - b * s) / ASPECT, y: cy + a * s + b * c };
  }, ms, seed);
}

test('a deliberate scribble is a scratch-out, at any angle', () => {
  for (const [name, opts] of Object.entries({
    'horizontal': {},
    'vertical': { angle: Math.PI / 2 },
    'diagonal': { angle: 0.7 },
    'five passes': { passes: 5, ms: 700 },
    'long and frantic': { passes: 12, ms: 1100, w: 0.2 },
    'on one spot, no drift': { h: 0.001 },
    'tall patch': { h: 0.06, passes: 9, ms: 1100 },
  })) {
    for (const seed of [1, 2, 3]) {
      assert.ok(scratchOut(scribble({ ...opts, seed }), ASPECT), `${name} (seed ${seed})`);
    }
  }
});

test('a scribble made of thin loops, the way a hand really does it, counts too', () => {
  const coil = trace((u) => {
    const a = u * Math.PI * 2 * 4; // four turns
    return { x: 0.4 + (0.06 * Math.cos(a)) / ASPECT, y: 0.4 + 0.006 * Math.sin(a) + (u - 0.5) * 0.02 };
  }, 900, 2);
  assert.ok(scratchOut(coil, ASPECT));
});

// Handwriting-like strokes. None of these may ever be taken for a scratch-out,
// however fast they are written: every one is traced at a scribble's pace.
const HANDWRITING = {
  'cursive loops (elle)': (u) => ({ x: 0.2 + 0.3 * u - 0.012 * Math.sin(u * 12 * Math.PI), y: 0.4 - 0.02 * (1 - Math.cos(u * 12 * Math.PI)) / 2 }),
  'cursive humps (mmmm)': (u) => ({ x: 0.2 + 0.25 * u, y: 0.4 - 0.015 * Math.abs(Math.sin(u * 8 * Math.PI)) }),
  'wide zigzag (wwww)': (u) => ({ x: 0.2 + 0.25 * u, y: 0.4 - 0.02 * tri(u, 12) }),
  'a tall W': (u) => ({ x: 0.3 + 0.03 * u, y: 0.36 + 0.06 * tri(u, 4) }),
  'a tall M': (u) => ({ x: 0.3 + 0.03 * u, y: 0.42 - 0.06 * tri(u, 4) }),
  'a big N': (u) => ({ x: 0.3 + 0.04 * u, y: 0.42 - 0.07 * tri(u, 3) }),
  'a big Z': (u) => ({ x: 0.3 + 0.06 * tri(u, 3), y: 0.36 + 0.06 * u }),
  'a figure 8': (u) => ({ x: 0.4 + 0.02 * Math.sin(u * 4 * Math.PI), y: 0.4 + 0.04 * Math.sin(u * 2 * Math.PI) }),
  'an underline': (u) => ({ x: 0.2 + 0.4 * u, y: 0.4 + 0.002 * Math.sin(u * 9) }),
  'a double underline in one stroke': (u) => ({ x: 0.2 + 0.3 * tri(u, 2), y: 0.4 + 0.008 * u }),
  'a wavy underline': (u) => ({ x: 0.2 + 0.4 * u, y: 0.4 + 0.006 * Math.sin(u * 30) }),
  'a word circled once': (u) => ({ x: 0.4 + 0.08 * Math.cos(u * 2.2 * Math.PI), y: 0.4 + 0.03 * Math.sin(u * 2.2 * Math.PI) }),
  'a word circled three times': (u) => ({ x: 0.4 + 0.08 * Math.cos(u * 6 * Math.PI), y: 0.4 + 0.03 * Math.sin(u * 6 * Math.PI) }),
  'a word circled five times, messily': (u) => ({ x: 0.4 + (0.08 + 0.006 * Math.sin(u * 23)) * Math.cos(u * 10 * Math.PI), y: 0.4 + (0.03 + 0.004 * Math.cos(u * 17)) * Math.sin(u * 10 * Math.PI) }),
  'a coiled spring along a line': (u) => ({ x: 0.2 + 0.3 * u + 0.012 * Math.cos(u * 20 * Math.PI), y: 0.4 + 0.02 * Math.sin(u * 20 * Math.PI) }),
  'a bracket': (u) => ({ x: 0.3 + 0.02 * Math.sin(u * Math.PI), y: 0.3 + 0.2 * u }),
  'a square root sign': (u) => ({ x: 0.3 + 0.2 * u, y: u < 0.1 ? 0.4 + 0.3 * u : u < 0.2 ? 0.43 - 0.8 * (u - 0.1) : 0.35 }),
  'a small scribbled dot': (u) => ({ x: 0.4 + 0.004 * tri(u, 9), y: 0.4 + 0.004 * u }),
};

test('handwriting is never mistaken for a scratch-out, however fast', () => {
  for (const [name, fn] of Object.entries(HANDWRITING)) {
    for (const ms of [250, 500, 900, 1500]) {
      for (const seed of [1, 2, 3]) {
        assert.equal(scratchOut(trace(fn, ms, seed), ASPECT), null, `${name}, written in ${ms}ms (seed ${seed})`);
      }
    }
  }
});

test('a slow, careful zigzag is drawing, not scratching', () => {
  assert.equal(scratchOut(scribble({ passes: 7, ms: 4000 }), ASPECT), null); // a resistor, hatching
  assert.ok(scratchOut(scribble({ passes: 7, ms: 1000 }), ASPECT));
});

test('too few points or no real stroke is not a scratch-out', () => {
  assert.equal(scratchOut([], ASPECT), null);
  assert.equal(scratchOut(scribble().slice(0, 8), ASPECT), null);
});

test('scratch-out takes what it covers and leaves what merely passes through', () => {
  const word = lineOf(Array(5).fill({ height: 0.012, gap: 0.004 }), { x: 0.36, baseline: 0.406 });
  const farAway = letter(0.7, 0.4, 0.02);
  const underline = { k: 'pen', pts: Array.from({ length: 60 }, (_, i) => ({ x: 0.1 + i * 0.012, y: 0.405 })) };
  const frame = { k: 'pen', shape: 'rect', pts: [{ x: 0.3, y: 0.37 }, { x: 0.52, y: 0.37 }, { x: 0.52, y: 0.43 }, { x: 0.3, y: 0.43 }, { x: 0.3, y: 0.37 }] };
  const scratch = { k: 'pen', pts: scribble({ w: 0.11, h: 0.03, passes: 8 }) };
  const strokes = [farAway, ...word, underline, frame, scratch];

  const hit = scratchOut(scratch.pts, ASPECT);
  assert.ok(hit);
  assert.deepEqual(scratchTargets(strokes, hit, scratch), [1, 2, 3, 4, 5]);
});

test('a scribble over empty paper covers nothing, so it stays as ink', () => {
  const scratch = { k: 'pen', pts: scribble() };
  const hit = scratchOut(scratch.pts, ASPECT);
  assert.deepEqual(scratchTargets([letter(0.7, 0.7, 0.02), scratch], hit, scratch), []);
});

/* ---------------------------------------------------------------- */
/* zoom writing box                                                  */
/* ---------------------------------------------------------------- */

const IPAD = { stripW: 1024, stripH: 260, pageW: 992, pageH: 1284, zoom: 2.5 };

test('the target has the strip\'s shape and shows the page at the chosen zoom', () => {
  const t = targetFor({ ...IPAD, cx: 0.5, cy: 0.5 });
  assert.ok(Math.abs(magnification(t, IPAD.stripW, IPAD.pageW) - 2.5) < 1e-9);
  const onScreen = (t.w * IPAD.pageW) / (t.h * IPAD.pageH);
  assert.ok(Math.abs(onScreen - IPAD.stripW / IPAD.stripH) < 1e-9, 'no stretching');
  assert.ok(Math.abs(t.x + t.w / 2 - 0.5) < 1e-9 && Math.abs(t.y + t.h / 2 - 0.5) < 1e-9);
});

test('ink lands within a pixel of where the target box says it will', () => {
  const t = targetFor({ ...IPAD, cx: 0.3, cy: 0.62 });
  const k = magnification(t, IPAD.stripW, IPAD.pageW);
  let worst = 0;
  for (let sx = 0; sx <= IPAD.stripW; sx += 37) {
    for (let sy = 0; sy <= IPAD.stripH; sy += 29) {
      const p = stripToPage(t, sx / IPAD.stripW, sy / IPAD.stripH);
      // where the box, as drawn on the page, says this strip pixel is
      const wantX = t.x * IPAD.pageW + sx / k, wantY = t.y * IPAD.pageH + sy / k;
      worst = Math.max(worst, Math.abs(p.x * IPAD.pageW - wantX), Math.abs(p.y * IPAD.pageH - wantY));
      const back = pageToStrip(t, p.x, p.y);
      assert.ok(Math.abs(back.fx * IPAD.stripW - sx) < 1e-6 && Math.abs(back.fy * IPAD.stripH - sy) < 1e-6);
    }
  }
  assert.ok(worst < 0.001, `worst error ${worst.toExponential(2)} page pixels`);
});

test('the target stays on the page, and magnifies more rather than overflow a narrow page', () => {
  const corner = targetFor({ ...IPAD, cx: 0.99, cy: 0.01 });
  assert.ok(corner.x + corner.w <= 1 + 1e-12 && corner.y >= 0);
  const narrow = targetFor({ ...IPAD, pageW: 300, pageH: 400, cx: 0.5, cy: 0.5 });
  assert.ok(narrow.w <= 1 + 1e-12);
  assert.ok(magnification(narrow, IPAD.stripW, 300) >= 2.5);
});

test('advancing steps along the line with overlap, then wraps to the next line', () => {
  let t = targetFor({ ...IPAD, cx: 0.2, cy: 0.3 });
  const start = t;
  const next = advance(t, 'right');
  assert.ok(next.x > t.x && next.x < t.x + t.w, 'the last of what was written stays in view');
  assert.equal(next.y, t.y);
  assert.ok(Math.abs(advance(next, 'left').x - t.x) < 1e-12);

  let steps = 0;
  while (t.y === start.y && steps++ < 20) t = advance(t, 'right');
  assert.ok(steps < 20, 'reaches the right edge');
  assert.ok(t.y > start.y && t.y < start.y + start.h, 'next line overlaps the last a little');
  assert.ok(t.x < 0.1, 'and starts back at the left margin');
  assert.ok(advance(start, 'line').y > start.y);
});
