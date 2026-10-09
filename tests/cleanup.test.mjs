import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  smooth, simplify, chaikin, movingAverage, recognize, shapeToPoints,
  straighten, groupIntoLines, normalizeSize, normalizeSpacing, classifyGaps, tidyPage,
} from '../src/cleanup.js';
import { rng, gauss, box, stddev, letter, lineOf, gapsOf } from './helpers.mjs';

/* ---------------------------------------------------------------- */
/* smoothing                                                         */
/* ---------------------------------------------------------------- */

// a cursive-like arc: the truth the jitter is added on top of
const truth = (t) => ({ x: 0.2 + 0.3 * t, y: 0.5 + 0.04 * Math.sin(t * Math.PI * 3) });

function jittery(n = 201, sigma = 0.0012, seed = 7) {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = truth(i / (n - 1));
    return { x: p.x + gauss(rand) * sigma, y: p.y + gauss(rand) * sigma, w: 0.003 };
  });
}

/** RMS distance from each point to the true curve (dense nearest-sample search). */
function jitterOf(pts) {
  const dense = Array.from({ length: 4001 }, (_, i) => truth(i / 4000));
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const q of dense) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) best = d;
    }
    sum += best;
  }
  return Math.sqrt(sum / pts.length);
}

test('smooth removes jitter, more of it at higher strength', () => {
  const raw = jittery();
  const before = jitterOf(raw);
  const light = 1 - jitterOf(smooth(raw, 0.5)) / before;
  const hard = 1 - jitterOf(smooth(raw, 1)) / before;
  assert.ok(light > 0.3, `strength 0.5 removed ${(light * 100).toFixed(0)}% of jitter`);
  assert.ok(hard > 0.5, `strength 1.0 removed ${(hard * 100).toFixed(0)}% of jitter`);
  assert.ok(hard > light);
});

test('smooth bounds the point count and keeps the stroke its size', () => {
  const raw = jittery();
  const out = smooth(raw, 0.5);
  assert.ok(out.length < raw.length / 2, `${raw.length} points -> ${out.length}`);
  assert.ok(Math.abs(box(out).w / box(raw).w - 1) < 0.02, 'width within 2%');
  // endpoints are pinned
  assert.deepEqual([out[0].x, out[0].y], [raw[0].x, raw[0].y]);
  assert.deepEqual([out.at(-1).x, out.at(-1).y], [raw.at(-1).x, raw.at(-1).y]);
});

test('smooth leaves short strokes and strength 0 untouched', () => {
  const two = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  assert.equal(smooth(two, 1), two);
  const raw = jittery(50);
  assert.equal(smooth(raw, 0), raw);
});

test('smooth carries width and pencil opacity through to the result', () => {
  const raw = jittery().map((p, i) => ({ ...p, a: 0.4 + 0.5 * (i / 200) }));
  const out = smooth(raw, 1);
  assert.ok(out.every((p) => p.w > 0), 'every point keeps a width');
  assert.ok(out.every((p) => p.a >= 0.4 && p.a <= 0.9), 'every point keeps an opacity in range');
  assert.ok(out.at(-1).a > out[0].a, 'the opacity ramp survives');
});

test('simplify drops collinear points; chaikin and movingAverage pin the ends', () => {
  const straight = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 }));
  assert.equal(simplify(straight).length, 2);

  const zig = [{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 0 }];
  const cut = chaikin(zig, 2);
  assert.deepEqual(cut[0], zig[0]);
  assert.deepEqual(cut.at(-1), zig[2]);
  assert.ok(Math.max(...cut.map((p) => p.y)) < 0.2, 'the corner is cut');

  const avg = movingAverage(zig, 1);
  assert.deepEqual(avg[0], zig[0]);
  assert.deepEqual(avg[2], zig[2]);
  assert.ok(avg[1].y < 0.2);
});

/* ---------------------------------------------------------------- */
/* shape recognition                                                 */
/* ---------------------------------------------------------------- */

function wobble(pts, sigma, seed) {
  const rand = rng(seed);
  return pts.map((p) => ({ x: p.x + gauss(rand) * sigma, y: p.y + gauss(rand) * sigma }));
}

test('recognize finds a line, a circle and a rectangle in shaky ink', () => {
  const line = wobble(Array.from({ length: 40 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.3 + i * 0.004 })), 0.0008, 1);
  assert.equal(recognize(line)?.type, 'line');

  const circle = wobble(shapeToPoints({ type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }), 0.002, 2);
  const c = recognize(circle);
  assert.equal(c?.type, 'ellipse');
  assert.ok(Math.abs(c.cx - 0.5) < 0.01 && Math.abs(c.rx - 0.1) < 0.01);

  const edge = (a, b) => Array.from({ length: 20 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / 20, y: a.y + ((b.y - a.y) * i) / 20,
  }));
  const corners = [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.4 }, { x: 0.2, y: 0.4 }];
  const rect = wobble(corners.flatMap((p, i) => edge(p, corners[(i + 1) % 4])), 0.0015, 3);
  assert.equal(recognize(rect)?.type, 'rect');
});

test('recognize refuses a wave that only averages out straight', () => {
  const wave = Array.from({ length: 80 }, (_, i) => ({
    x: 0.2 + i * 0.005, y: 0.5 + 0.004 * Math.sin(i * 0.9),
  }));
  assert.equal(recognize(wave), null);
});

test('recognize refuses handwriting and anything tiny', () => {
  const scribble = Array.from({ length: 60 }, (_, i) => ({
    x: 0.2 + i * 0.003 + 0.02 * Math.sin(i * 0.5), y: 0.5 + 0.03 * Math.cos(i * 0.31),
  }));
  assert.equal(recognize(scribble), null);
  const dot = Array.from({ length: 10 }, (_, i) => ({ x: 0.5 + i * 0.0005, y: 0.5 }));
  assert.equal(recognize(dot), null);
});

/* ---------------------------------------------------------------- */
/* levelling                                                         */
/* ---------------------------------------------------------------- */

const slopeOf = (strokes) => {
  const a = box(strokes[0].pts), b = box(strokes.at(-1).pts);
  return (b.y1 - a.y1) / (b.x0 - a.x0);
};

function slopedLine(degrees, n = 10) {
  const m = Math.tan((degrees * Math.PI) / 180);
  return Array.from({ length: n }, (_, i) => letter(0.1 + i * 0.03, 0.3 + i * 0.03 * m, 0.02));
}

test('straighten levels a sloping line of handwriting', () => {
  const line = slopedLine(5);
  const out = straighten(line, { asOneLine: true });
  assert.ok(Math.abs(slopeOf(line)) > 0.08);
  assert.ok(Math.abs(slopeOf(out)) < 0.01, `slope after: ${slopeOf(out).toFixed(4)}`);
  // rotation, not distortion: letters keep their size
  assert.ok(Math.abs(box(out[3].pts).h / box(line[3].pts).h - 1) < 0.05);
});

test('straighten will not rotate past its cap', () => {
  const line = slopedLine(20);
  assert.deepEqual(straighten(line, { asOneLine: true }), line);
});

test('groupIntoLines separates two lines of writing', () => {
  const top = lineOf(Array(6).fill({ height: 0.02, gap: 0.006 }), { baseline: 0.3 });
  const bottom = lineOf(Array(4).fill({ height: 0.02, gap: 0.006 }), { baseline: 0.4 });
  const lines = groupIntoLines([...top, ...bottom]);
  assert.deepEqual(lines.map((l) => l.items.length).sort(), [4, 6]);
});

/* ---------------------------------------------------------------- */
/* size normalization                                                */
/* ---------------------------------------------------------------- */

test('normalizeSize more than halves the spread of a 0.7x -> 1.3x ramp', () => {
  const n = 13;
  const line = lineOf(Array.from({ length: n }, (_, i) => ({
    height: 0.02 * (0.7 + (0.6 * i) / (n - 1)), gap: 0.006,
  })));
  const out = normalizeSize(line);
  const before = stddev(line.map((s) => box(s.pts).h));
  const after = stddev(out.map((s) => box(s.pts).h));
  assert.ok(after < before / 2, `x-height stddev ${before.toFixed(5)} -> ${after.toFixed(5)}`);
});

test('normalizeSize keeps every letter on its baseline', () => {
  const line = lineOf(Array.from({ length: 9 }, (_, i) => ({ height: 0.014 + i * 0.0015, gap: 0.006 })));
  for (const s of normalizeSize(line)) {
    assert.ok(Math.abs(box(s.pts).y1 - 0.3) < 1e-9);
  }
});

test('normalizeSize does not treat a descender as extra height', () => {
  const specs = Array(8).fill({ height: 0.02, gap: 0.006 });
  specs[3] = { height: 0.02, gap: 0.006, tail: 0.012 }; // a "g": same body, plus a tail
  const line = lineOf(specs);
  const out = normalizeSize(line);

  // the g is 60% taller than its neighbours overall, and must be left exactly as written
  assert.ok(box(line[3].pts).h > 0.02 * 1.5);
  assert.deepEqual(out[3].pts, line[3].pts);
});

test('normalizeSize measures a descender by its body, not its tail', () => {
  // every letter the same except a g whose BODY is small
  const specs = Array(8).fill({ height: 0.02, gap: 0.006 });
  specs[4] = { height: 0.015, gap: 0.006, tail: 0.012 };
  const line = lineOf(specs);
  const out = normalizeSize(line);

  const bodyBefore = 0.3 - box(line[4].pts).y0;
  const bodyAfter = 0.3 - box(out[4].pts).y0;
  assert.ok(Math.abs(bodyBefore - 0.015) < 1e-9);
  assert.ok(bodyAfter > 0.018, `body grew toward the line's x-height: ${bodyAfter.toFixed(4)}`);
  // and it grew about the baseline, so the body still sits on the line
  const bodyBottom = Math.max(...out[4].pts.slice(0, 25).map((p) => p.y));
  assert.ok(Math.abs(bodyBottom - 0.3) < 1e-9);
});

test('normalizeSize never changes a stroke by more than 25% in either dimension', () => {
  const rand = rng(11);
  const line = lineOf(Array.from({ length: 14 }, () => ({ height: 0.012 + rand() * 0.02, gap: 0.006 })));
  const out = normalizeSize(line);
  line.forEach((s, i) => {
    const a = box(s.pts), b = box(out[i].pts);
    for (const ratio of [b.w / a.w, b.h / a.h]) {
      assert.ok(ratio >= 0.75 - 1e-9 && ratio <= 1.25 + 1e-9, `stroke ${i} scaled by ${ratio.toFixed(3)}`);
    }
  });
});

test('normalizeSize leaves highlighter and placed shapes alone', () => {
  const line = lineOf(Array.from({ length: 8 }, (_, i) => ({ height: 0.014 + i * 0.002, gap: 0.006 })));
  line[0].k = 'hi';
  line[7].shape = 'ellipse';
  const out = normalizeSize(line);
  assert.deepEqual(out[0].pts, line[0].pts);
  assert.deepEqual(out[7].pts, line[7].pts);
});

/* ---------------------------------------------------------------- */
/* spacing normalization                                             */
/* ---------------------------------------------------------------- */

// three words: letter gaps around 0.004, word gaps around 0.02, both ragged
const WORDS = [4, 3, 5];
function raggedWords(seed = 5) {
  const rand = rng(seed);
  const specs = [];
  WORDS.forEach((len, w) => {
    for (let i = 0; i < len; i++) {
      const wordStart = i === 0 && w > 0;
      specs.push({
        height: 0.02,
        gap: wordStart ? 0.016 + rand() * 0.008 : i === 0 ? 0 : 0.0025 + rand() * 0.003,
      });
    }
  });
  return lineOf(specs);
}

test('classifyGaps finds the word boundaries in a clearly bimodal line', () => {
  const cls = classifyGaps(gapsOf(raggedWords()));
  assert.ok(cls);
  const boundaries = cls.isWord.flatMap((isWord, i) => (isWord ? [i] : []));
  assert.deepEqual(boundaries, [3, 6]); // after the 4th and 7th letters
  assert.ok(cls.threshold > 0.006 && cls.threshold < 0.016);
});

test('normalizeSpacing evens each class of gap', () => {
  const line = raggedWords();
  const out = normalizeSpacing(line);
  const before = gapsOf(line), after = gapsOf(out);
  const intra = (g) => g.filter((_, i) => i !== 3 && i !== 6);
  const inter = (g) => [g[3], g[6]];
  assert.ok(stddev(intra(after)) < stddev(intra(before)) / 10);
  assert.ok(stddev(inter(after)) < stddev(inter(before)) / 10);
});

test('normalizeSpacing keeps the line width within 10% and never reorders', () => {
  const line = raggedWords(9);
  const out = normalizeSpacing(line);
  const width = (ss) => box(ss.flatMap((s) => s.pts)).w;
  assert.ok(Math.abs(width(out) / width(line) - 1) < 0.1);
  const lefts = out.map((s) => box(s.pts).x0);
  assert.deepEqual(lefts, [...lefts].sort((a, b) => a - b));
  assert.ok(gapsOf(out).every((g) => g > 0));
});

test('normalizeSpacing leaves one long word unchanged', () => {
  const rand = rng(3);
  const word = lineOf(Array.from({ length: 12 }, () => ({ height: 0.02, gap: 0.004 + rand() * 0.0012 })));
  assert.equal(classifyGaps(gapsOf(word)), null);
  assert.deepEqual(normalizeSpacing(word), word);

  const even = lineOf(Array(12).fill({ height: 0.02, gap: 0.005 }));
  assert.deepEqual(normalizeSpacing(even), even);
});

test('normalizeSpacing moves a letter and its dot together', () => {
  const line = raggedWords();
  const host = box(line[5].pts);
  const dot = { k: 'pen', c: '--pen-1', w: 0.003, pts: [
    { x: host.x0 + 0.006, y: host.y0 - 0.008 }, { x: host.x0 + 0.007, y: host.y0 - 0.007 },
  ] };
  // level with the line, so it groups with it: extend it down into the letters' band
  dot.pts.push({ x: host.x0 + 0.007, y: host.y0 + 0.004 });
  const out = normalizeSpacing([...line, dot], { asOneLine: true });
  const moved = box(out[5].pts).x0 - host.x0;
  assert.ok(Math.abs(moved) > 1e-6, 'the letter moved');
  assert.ok(Math.abs((out.at(-1).pts[0].x - dot.pts[0].x) - moved) < 1e-12, 'its dot moved with it');
});

/* ---------------------------------------------------------------- */
/* whole page                                                        */
/* ---------------------------------------------------------------- */

function busyPage(count = 200) {
  const rand = rng(21);
  const strokes = [];
  for (let row = 0; strokes.length < count; row++) {
    const specs = Array.from({ length: 20 }, (_, i) => ({
      height: 0.012 + rand() * 0.006,
      gap: i % 5 === 0 ? 0.014 + rand() * 0.004 : 0.003 + rand() * 0.002,
    }));
    for (const s of lineOf(specs, { x: 0.05, baseline: 0.08 + row * 0.08 })) {
      // jitter the points so smoothing has real work to do
      s.pts = s.pts.flatMap((p) => [p, { ...p, x: p.x + gauss(rand) * 0.0004, y: p.y + gauss(rand) * 0.0004 }]);
      strokes.push(s);
    }
  }
  return strokes.slice(0, count);
}

const ALL = { smoothStrength: 0.7, level: true, size: true, spacing: true };

test('tidyPage never mutates its input, so a cancelled preview costs nothing', () => {
  const page = busyPage(60);
  page.push({ k: 'hi', c: '--hi-1', w: 0.018, pts: [{ x: 0.1, y: 0.5 }, { x: 0.4, y: 0.5 }] });
  const before = JSON.stringify(page);
  const out = tidyPage(page, ALL);
  assert.equal(JSON.stringify(page), before, 'byte-identical after the preview is computed');
  assert.notEqual(JSON.stringify(out), before, 'and the preview is actually different');
  assert.equal(out.length, page.length);
});

test('tidyPage leaves highlighter and placed shapes exactly as they are', () => {
  const rect = { k: 'pen', shape: 'rect', c: '--pen-2', w: 0.003, pts: shapeToPoints({ type: 'rect', x0: 0.2, y0: 0.6, x1: 0.5, y1: 0.8 }) };
  const hi = { k: 'hi', c: '--hi-1', w: 0.018, pts: [{ x: 0.1, y: 0.5 }, { x: 0.2, y: 0.51 }, { x: 0.4, y: 0.5 }] };
  const out = tidyPage([...busyPage(20), rect, hi], ALL);
  assert.deepEqual(out.at(-2).pts, rect.pts);
  assert.deepEqual(out.at(-1).pts, hi.pts);
});

test('tidyPage re-previews a 200-stroke page well inside 100ms', () => {
  const page = busyPage(200);
  tidyPage(page, ALL); // warm up
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    tidyPage(page, { ...ALL, smoothStrength: 0.3 + i * 0.15 });
    runs.push(performance.now() - t0);
  }
  const worst = Math.max(...runs);
  assert.ok(worst < 50, `slowest of 5 runs: ${worst.toFixed(1)}ms`);
});
