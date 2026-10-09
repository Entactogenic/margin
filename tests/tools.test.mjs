import { test } from 'node:test';
import assert from 'node:assert/strict';

import { strokeAt, eraseArea, strokesInRect, predictedTail, ERASE_RADIUS } from '../src/ink.js';
import { grainTile, grainStats, pencilAlpha } from '../src/tools/pencil.js';
import { dragShape, constrainEnd, dragLength } from '../src/tools/shapes.js';
import { defaultPrefs, loadPrefs, savePrefs, SHAPES } from '../src/tools/prefs.js';
import { tidyPage } from '../src/cleanup.js';
import { box } from './helpers.mjs';

/* ---------------------------------------------------------------- */
/* pencil                                                            */
/* ---------------------------------------------------------------- */

function fakeCanvas(size) {
  const canvas = { width: size, height: size, pixels: null };
  canvas.getContext = () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { canvas.pixels = img.data; },
  });
  return canvas;
}

test('the grain tile is generated at most once per colour', () => {
  const start = grainStats.generated;
  const first = grainTile('#1b2a4a', fakeCanvas);
  for (let i = 0; i < 200; i++) assert.equal(grainTile('#1b2a4a', fakeCanvas), first);
  assert.equal(grainStats.generated, start + 1);

  grainTile('#a63a2e', fakeCanvas);
  grainTile('#a63a2e', fakeCanvas);
  assert.equal(grainStats.generated, start + 2);
});

test('the grain is the selected colour with uneven coverage', () => {
  const { pixels } = grainTile('#336699', fakeCanvas);
  const alphas = new Set();
  let bare = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2]], [0x33, 0x66, 0x99]);
    alphas.add(pixels[i + 3]);
    if (pixels[i + 3] === 0) bare++;
  }
  const share = bare / (pixels.length / 4);
  assert.ok(alphas.size > 50, 'many densities, not a flat tint');
  assert.ok(share > 0.1 && share < 0.3, `${(share * 100).toFixed(0)}% of the tile is bare paper`);
});

test('a fast pencil stroke is lighter than a slow one', () => {
  const fast = 0.002;
  const at = (dist) => pencilAlpha({ x: dist, y: 0, t: 10 }, { x: 0, y: 0, t: 0 }, fast);
  const slow = at(0.0005), mid = at(0.012), quick = at(0.03);
  assert.ok(slow > 0.9);
  assert.ok(mid < slow - 0.2, 'already visibly lighter at moderate speed');
  assert.ok(quick <= 0.36 && quick >= 0.3, 'but never invisible');
});

test('pencil strokes go through cleanup like any other stroke', () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({
    x: 0.2 + i * 0.004, y: 0.5 + 0.01 * Math.sin(i / 4) + (i % 2 ? 0.0006 : -0.0006), w: 0.003, a: 0.7,
  }));
  const [out] = tidyPage([{ k: 'pencil', c: '--pen-4', w: 0.003, pts }]);
  assert.equal(out.k, 'pencil');
  assert.ok(out.pts.length < pts.length);
  assert.ok(out.pts.every((p) => Math.abs(p.a - 0.7) < 1e-9));
});

/* ---------------------------------------------------------------- */
/* shapes                                                            */
/* ---------------------------------------------------------------- */

const A = { x: 0.2, y: 0.3 }, B = { x: 0.5, y: 0.4 };
const ASPECT = 0.75; // a portrait page

test('every shape is a point list spanning the drag', () => {
  for (const kind of SHAPES) {
    const pts = dragShape(kind, A, B, { aspect: ASPECT });
    assert.ok(pts.length >= 2, kind);
    assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), kind);
  }
  const rect = dragShape('rect', A, B);
  assert.equal(rect.length, 5);
  assert.deepEqual(rect[0], rect[4]); // closed
  assert.deepEqual(box(rect), { x0: 0.2, x1: 0.5, y0: 0.3, y1: 0.4, w: box(rect).w, h: box(rect).h });

  const ell = box(dragShape('ellipse', A, B));
  assert.ok(Math.abs(ell.x0 - 0.2) < 1e-9 && Math.abs(ell.x1 - 0.5) < 1e-9);
  assert.ok(Math.abs(ell.y0 - 0.3) < 1e-9 && Math.abs(ell.y1 - 0.4) < 1e-9);

  assert.deepEqual(dragShape('line', A, B), [A, B]);
});

test('shapes drag the same in any direction', () => {
  assert.deepEqual(box(dragShape('rect', B, A)), box(dragShape('rect', A, B)));
  assert.deepEqual(dragShape('line', B, A), [B, A]); // a line keeps its direction
});

test('an arrow is a line plus a head sized to it', () => {
  const short = dragShape('arrow', A, { x: 0.24, y: 0.3 }, { aspect: 1 });
  const long = dragShape('arrow', A, { x: 0.3, y: 0.3 }, { aspect: 1 });
  const barb = (pts) => Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);

  assert.equal(short.length, 5);
  assert.deepEqual(short.slice(0, 2), [A, { x: 0.24, y: 0.3 }]);
  assert.deepEqual(short[3], short[1]); // the path returns to the tip between barbs
  assert.ok(Math.abs(barb(short) - 0.04 * 0.22) < 1e-9);
  assert.ok(Math.abs(barb(long) / barb(short) - 2.5) < 1e-6, 'head scales with the line');
  // barbs trail behind the tip, one either side
  assert.ok(short[2].x < short[1].x && short[4].x < short[1].x);
  assert.ok((short[2].y - 0.3) * (short[4].y - 0.3) < 0);

  const huge = dragShape('arrow', { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { aspect: 1 });
  assert.ok(barb(huge) <= 0.05 + 1e-9, 'and is capped on a very long line');
});

test('Shift makes a square and a circle on screen, not in page units', () => {
  for (const kind of ['rect', 'ellipse']) {
    const b = box(dragShape(kind, A, B, { constrain: true, aspect: ASPECT }));
    assert.ok(Math.abs(b.w * ASPECT - b.h) < 1e-9, `${kind}: ${b.w * ASPECT} x ${b.h} on screen`);
  }
  // dragging up and to the left still grows from the starting corner
  const b = box(dragShape('rect', B, A, { constrain: true, aspect: ASPECT }));
  assert.ok(Math.abs(b.x1 - B.x) < 1e-9 && Math.abs(b.y1 - B.y) < 1e-9);
});

test('Shift snaps a line and an arrow to 45 degree steps', () => {
  for (const kind of ['line', 'arrow']) {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const end = { x: A.x + (Math.cos(rad) * 0.2) / ASPECT, y: A.y + Math.sin(rad) * 0.2 };
      const [from, to] = dragShape(kind, A, end, { constrain: true, aspect: ASPECT });
      const angle = (Math.atan2(to.y - from.y, (to.x - from.x) * ASPECT) * 180) / Math.PI;
      const off = Math.abs(angle / 45 - Math.round(angle / 45));
      assert.ok(off < 1e-6, `${kind} at ${deg} deg snapped to ${angle.toFixed(2)}`);
      assert.ok(Math.abs(dragLength(from, to, ASPECT) - 0.2) < 1e-9, 'length is kept');
    }
  }
  assert.deepEqual(constrainEnd('line', A, { x: 0.4, y: 0.301 }, 1).y.toFixed(9), (0.3).toFixed(9));
});

/* ---------------------------------------------------------------- */
/* erasing                                                           */
/* ---------------------------------------------------------------- */

const pen = (pts, extra = {}) => ({ k: 'pen', c: '--pen-1', w: 0.003, pts, ...extra });
const longStroke = () => pen(Array.from({ length: 101 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5, w: 0.003 })));

test('strokeAt hits the middle of a two-point line and every edge of a rectangle', () => {
  const line = pen(dragShape('line', { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }));
  assert.equal(strokeAt([line], { x: 0.5, y: 0.105 }), 0);
  assert.equal(strokeAt([line], { x: 0.5, y: 0.2 }), -1);

  const rect = pen(dragShape('rect', { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }));
  for (const p of [{ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.4 }, { x: 0.4, y: 0.6 }, { x: 0.2, y: 0.4 }]) {
    assert.equal(strokeAt([rect], p), 0);
  }
  assert.equal(strokeAt([rect], { x: 0.4, y: 0.4 }), -1, 'the inside of a shape is empty');
});

test('strokeAt returns the topmost stroke', () => {
  const a = longStroke(), b = longStroke();
  assert.equal(strokeAt([a, b], { x: 0.5, y: 0.5 }), 1);
});

test('area erase splits a long stroke into two that are both still strokes', () => {
  const s = longStroke();
  const pieces = eraseArea(s, { x: 0.5, y: 0.5 });
  assert.equal(pieces.length, 2);

  const [left, right] = pieces.map((p) => box(p.pts));
  assert.ok(Math.abs(left.x0 - 0.1) < 1e-9 && Math.abs(right.x1 - 0.9) < 1e-9, 'the far ends are untouched');
  assert.ok(left.x1 <= 0.5 - ERASE_RADIUS && right.x0 >= 0.5 + ERASE_RADIUS, 'the erased span is gone');
  assert.ok(right.x0 - left.x1 < ERASE_RADIUS * 3, 'and nothing more than that');

  for (const p of pieces) {
    assert.equal(p.k, 'pen');
    assert.equal(p.c, '--pen-1');
    assert.ok(p.pts.length >= 2 && p.pts.every((q) => q.w === 0.003));
    // each half can be erased again, and selected
    assert.equal(eraseArea(p, p.pts[Math.floor(p.pts.length / 2)]).length, 2);
    assert.deepEqual(strokesInRect([p], { x0: 0, y0: 0, x1: 1, y1: 1 }), [0]);
  }
  assert.equal(s.pts.length, 101, 'the original is not mutated');
});

test('area erase trims an end, removes a small stroke, and ignores a miss', () => {
  const s = longStroke();
  const trimmed = eraseArea(s, { x: 0.1, y: 0.5 });
  assert.equal(trimmed.length, 1);
  assert.ok(box(trimmed[0].pts).x0 >= 0.1 + ERASE_RADIUS);

  const dot = pen([{ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.501 }]);
  assert.deepEqual(eraseArea(dot, { x: 0.501, y: 0.5 }), []);

  assert.equal(eraseArea(s, { x: 0.5, y: 0.6 }), null);
});

test('area erase cuts a gap in a sparse shape', () => {
  const line = pen(dragShape('line', { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }), { shape: 'line' });
  const pieces = eraseArea(line, { x: 0.5, y: 0.1 });
  assert.equal(pieces.length, 2);
  assert.ok(box(pieces[0].pts).x1 < 0.5 && box(pieces[1].pts).x0 > 0.5);
  assert.ok(pieces.every((p) => p.shape === 'line'));
});

/* ---------------------------------------------------------------- */
/* predicted ink                                                     */
/* ---------------------------------------------------------------- */

// a pen moving right at a steady 0.001 page widths per 4ms sample (a 240Hz digitizer)
const steady = (n = 12) => Array.from({ length: n }, (_, i) => ({ x: 0.3 + i * 0.001, y: 0.5, t: i * 4 }));
const beyond = (pts, steps, dx = 0.001, dy = 0) => {
  const last = pts.at(-1);
  return Array.from({ length: steps }, (_, i) => ({ x: last.x + dx * (i + 1), y: last.y + dy * (i + 1) }));
};

test('a prediction that continues the stroke is drawn, about a frame ahead', () => {
  const pts = steady();
  const tail = predictedTail(pts, beyond(pts, 4));
  assert.equal(tail.length, 4);
  assert.ok(tail.every((p, i) => Math.abs(p.x - (pts.at(-1).x + 0.001 * (i + 1))) < 1e-12 && p.y === 0.5));
  // one frame at this speed is 0.004; the tail covers that and no more than half as much again
  const reach = tail.at(-1).x - pts.at(-1).x;
  assert.ok(reach >= 0.004 - 1e-12 && reach <= 0.006 + 1e-12, `reaches ${reach.toFixed(4)}`);
});

test('a prediction is cut where it runs further than the pen could have gone', () => {
  const pts = steady();
  const wild = beyond(pts, 6, 0.004); // six guesses, each four times the pen's real step
  const tail = predictedTail(pts, wild);
  assert.ok(tail.length <= 1, `kept ${tail.length} of 6`);
  const reach = tail.length ? tail.at(-1).x - pts.at(-1).x : 0;
  assert.ok(reach <= 0.006 + 1e-12);
  assert.ok(predictedTail(pts, beyond(pts, 30)).length <= 6, 'and never more than a few points');
});

test('a prediction that doubles back on the stroke is not drawn', () => {
  const pts = steady();
  assert.deepEqual(predictedTail(pts, beyond(pts, 3, -0.001)), []);
  // good for two points, then it turns round: keep the two
  const last = pts.at(-1);
  const turns = [{ x: last.x + 0.001, y: 0.5 }, { x: last.x + 0.002, y: 0.5 }, { x: last.x + 0.001, y: 0.5 }];
  assert.equal(predictedTail(pts, turns).length, 2);
});

test('a prediction is not drawn from a pen that is not moving, or a stroke just begun', () => {
  const still = Array.from({ length: 10 }, (_, i) => ({ x: 0.3, y: 0.5, t: i * 4 }));
  assert.deepEqual(predictedTail(still, [{ x: 0.31, y: 0.5 }]), []);
  assert.deepEqual(predictedTail([{ x: 0.3, y: 0.5, t: 0 }], [{ x: 0.31, y: 0.5 }]), []);
  assert.deepEqual(predictedTail(steady(), []), []);
});

test('the tail follows a curve, and reaches further when the pen is faster', () => {
  const arc = Array.from({ length: 12 }, (_, i) => ({ x: 0.3 + 0.05 * Math.sin(i * 0.1), y: 0.5 - 0.05 * Math.cos(i * 0.1), t: i * 4 }));
  const next = [12, 13, 14].map((i) => ({ x: 0.3 + 0.05 * Math.sin(i * 0.1), y: 0.5 - 0.05 * Math.cos(i * 0.1) }));
  assert.equal(predictedTail(arc, next).length, 3);

  const slow = steady(), fast = steady().map((p) => ({ ...p, x: 0.3 + (p.x - 0.3) * 5 }));
  const far = (pts) => { const t = predictedTail(pts, beyond(pts, 6, 0.004)); return t.length ? t.at(-1).x - pts.at(-1).x : 0; };
  assert.ok(far(fast) > far(slow));
});

test('predicting leaves the stroke itself untouched', () => {
  const pts = steady();
  const before = JSON.stringify(pts);
  predictedTail(pts, beyond(pts, 4));
  assert.equal(JSON.stringify(pts), before);
});

/* ---------------------------------------------------------------- */
/* tool settings                                                     */
/* ---------------------------------------------------------------- */

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); } };
}

test('each tool keeps its own colour and width through save and reload', () => {
  const storage = memoryStorage();
  const prefs = defaultPrefs();
  prefs.tool = 'highlight';
  prefs.shape = 'arrow';
  prefs.eraser = 'area';
  prefs.ink.pen = { c: '--pen-3', w: 1.6 };
  prefs.ink.highlight = { c: '--hi-2', w: 0.7 };
  assert.equal(savePrefs(() => storage, prefs), true);

  const back = loadPrefs(() => storage);
  assert.deepEqual(back, prefs);
  // the pen's settings are its own, not the highlighter's
  assert.notDeepEqual(back.ink.pen, back.ink.highlight);
  assert.deepEqual(back.ink.pencil, defaultPrefs().ink.pencil);
});

test('prefs fall back to defaults when storage throws or holds rubbish', () => {
  const blocked = () => { throw new Error('SecurityError'); };
  assert.deepEqual(loadPrefs(blocked), defaultPrefs());
  assert.equal(savePrefs(blocked, defaultPrefs()), false);

  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(savePrefs(() => full, defaultPrefs()), false);

  const junk = memoryStorage();
  junk.setItem('margin.tools.v1', '{not json');
  assert.deepEqual(loadPrefs(() => junk), defaultPrefs());

  junk.setItem('margin.tools.v1', JSON.stringify({
    tool: 'laser', shape: 'star', eraser: 'bomb',
    ink: { pen: { c: '--hi-1', w: 99 }, highlight: { c: 'red', w: 'thick' } },
  }));
  const p = loadPrefs(() => junk);
  assert.equal(p.tool, 'pen');
  assert.equal(p.shape, 'rect');
  assert.equal(p.eraser, 'stroke');
  assert.deepEqual(p.ink.pen, { c: '--pen-1', w: 1.9 }); // a highlighter colour is not a pen colour
  assert.deepEqual(p.ink.highlight, { c: '--hi-1', w: 1 });
});
