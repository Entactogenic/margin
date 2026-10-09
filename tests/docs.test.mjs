import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../src/history.js';
import { defaultLayout, repairLayout, insertBlank, removeBlank, isBlank, paperMarks, PAPERS } from '../src/pages.js';
import { findMatches, textLines, snapHighlight } from '../src/search.js';
import { wrapText, makeText, textBox, LINE_HEIGHT } from '../src/tools/text.js';
import { packBackup, readBackup } from '../src/backup.js';
import { strokeAt, eraseArea } from '../src/ink.js';
import { strokesInLasso, transformStrokes, boundsOf, clampMove, resizeScale } from '../src/tools/lasso.js';
import { targetFor, advance } from '../src/tools/zoombox.js';
import { tidyPage } from '../src/cleanup.js';

/* ---------------------------------------------------------------- */
/* layout                                                            */
/* ---------------------------------------------------------------- */

test('inserting a blank page renumbers nothing: PDF pages keep their ids', () => {
  let layout = defaultLayout(3), id;
  [layout, id] = insertBlank(layout, 1, 'lined');
  assert.deepEqual(layout.order, [1, 'b1', 2, 3]);
  assert.deepEqual(layout.blanks, { b1: { paper: 'lined' } });
  assert.equal(isBlank(id), true);
  assert.equal(isBlank(2), false);

  [layout, id] = insertBlank(layout, null, 'grid');     // before everything
  [layout] = insertBlank(layout, 3, 'dotted');          // after the last page
  assert.deepEqual(layout.order, ['b2', 1, 'b1', 2, 3, 'b3']);
});

test('insertBlank never reuses an id, even after pages are removed', () => {
  let layout = defaultLayout(1), a, b;
  [layout, a] = insertBlank(layout, 1);
  [layout, b] = insertBlank(layout, 1);
  layout = removeBlank(layout, a);
  const [, c] = insertBlank(layout, 1);
  assert.notEqual(c, b);
  assert.equal(new Set([a, b, c]).size >= 2, true);
  assert.equal(layout.order.includes(c), false, 'the original is not mutated');
});

test('removeBlank removes blank pages only, and never the last page', () => {
  let [layout, id] = insertBlank(defaultLayout(2), 1);
  assert.deepEqual(removeBlank(layout, 1), layout, 'a PDF page cannot be removed');
  layout = removeBlank(layout, id);
  assert.deepEqual(layout, defaultLayout(2));

  const notebook = repairLayout(null, 0);
  assert.deepEqual(notebook.order, ['b1']);
  assert.deepEqual(removeBlank(notebook, 'b1'), notebook);
});

test('repairLayout makes any stored layout safe to render', () => {
  const messy = {
    order: [3, 'b1', 3, 'ghost', 9, 0, 1.5, 'b2', 1],
    blanks: { b1: { paper: 'grid' }, b2: { paper: 'papyrus' } },
    margin: 7,
  };
  const fixed = repairLayout(messy, 3);
  assert.deepEqual(fixed.order, [3, 'b1', 'b2', 1, 2]); // 2 was missing: back after 1
  assert.deepEqual(fixed.blanks, { b1: { paper: 'grid' }, b2: { paper: 'plain' } });
  assert.equal(fixed.margin, 1);

  assert.deepEqual(repairLayout(undefined, 4), defaultLayout(4));
  assert.deepEqual(repairLayout({ order: [] }, 2).order, [1, 2]);
  // every PDF page appears exactly once whatever went in
  for (const order of [[2, 2, 2], ['b1'], [5, 4, 3, 2, 1], [1, 3, 5]]) {
    const out = repairLayout({ order, blanks: {} }, 5).order.filter((id) => !isBlank(id));
    assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  }
});

test('layout changes undo and redo, together with the strokes they took with them', () => {
  const h = createHistory();
  const doc = { strokes: { 1: [{ id: 'a' }] }, layout: defaultLayout(2) };

  h.record(doc, null, { layout: true });
  let id;
  [doc.layout, id] = insertBlank(doc.layout, 1, 'lined');
  h.record(doc, id);
  doc.strokes[id] = [{ id: 'on-blank' }];

  // delete the blank page, ink and all, as one step
  h.record(doc, id, { layout: true });
  doc.layout = removeBlank(doc.layout, id);
  delete doc.strokes[id];
  assert.deepEqual(doc.layout.order, [1, 2]);

  assert.deepEqual(h.undo(doc), { page: id, layout: true });
  assert.deepEqual(doc.layout.order, [1, 'b1', 2]);
  assert.deepEqual(doc.strokes[id], [{ id: 'on-blank' }]);

  h.undo(doc); h.undo(doc);
  assert.deepEqual(doc.layout, defaultLayout(2));
  assert.deepEqual(doc.strokes[1], [{ id: 'a' }]);

  h.redo(doc); h.redo(doc); h.redo(doc);
  assert.deepEqual(doc.layout.order, [1, 2]);
  assert.equal(doc.strokes[id].length, 0);
});

test('paper rulings stay on the page and are evenly spaced', () => {
  const W = 612, H = 792;
  assert.deepEqual(paperMarks('plain', W, H), { lines: [], dots: [] });

  const lined = paperMarks('lined', W, H).lines;
  assert.ok(lined.length > 25 && lined.length < 40, `${lined.length} lines`);
  const gaps = lined.slice(1).map((l, i) => l[1] - lined[i][1]);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9));
  assert.ok(lined.every(([x0, y, x1, y1]) => y === y1 && x0 > 0 && x1 < W && y > 0 && y < H));

  const grid = paperMarks('grid', W, H).lines;
  const vertical = grid.filter((l) => l[0] === l[2]), horizontal = grid.filter((l) => l[1] === l[3]);
  const cell = vertical[1][0] - vertical[0][0];
  assert.ok(Math.abs(cell - (horizontal[1][1] - horizontal[0][1])) < 1e-9, 'cells are square');
  // centred: the leftover is the same on both sides
  assert.ok(Math.abs(vertical[0][0] - (W - vertical.at(-1)[0])) < 1e-9);
  assert.ok(Math.abs(horizontal[0][1] - (H - horizontal.at(-1)[1])) < 1e-9);

  const dots = paperMarks('dotted', W, H).dots;
  assert.ok(dots.length > 500);
  assert.ok(dots.every(([x, y]) => x > 0 && x < W && y > 0 && y < H));

  // the same paper at twice the size is the same ruling, scaled
  const big = paperMarks('lined', W * 2, H * 2).lines;
  assert.equal(big.length, lined.length);
  assert.ok(Math.abs(big[3][1] - lined[3][1] * 2) < 1e-9);
  assert.deepEqual(PAPERS, ['plain', 'lined', 'grid', 'dotted']);
});

/* ---------------------------------------------------------------- */
/* search                                                            */
/* ---------------------------------------------------------------- */

// a line of text as PDFs really deliver it: split into arbitrary runs
const run = (str, x, y, w, h = 0.015) => ({ str, x, y, w, h });
const PAGE = [
  run('Attention Is All', 0.1, 0.1, 0.32),
  run(' You Need', 0.42, 0.1, 0.18),
  run('The dominant sequence transduc', 0.1, 0.2, 0.6),
  run('tion models are based on', 0.1, 0.22, 0.48),   // a word broken across lines
  run('attention', 0.1, 0.3, 0.18),
  run('mechanisms.', 0.29, 0.3, 0.22),                // next word, no space in either item
  run('', 0.5, 0.5, 0, 0),
];

test('findMatches ignores case and finds every occurrence', () => {
  const hits = findMatches(PAGE, 'ATTENTION');
  assert.equal(hits.length, 2);
  const [first] = hits[0].rects;
  assert.ok(Math.abs(first.x - 0.1) < 1e-9 && Math.abs(first.y - 0.1) < 1e-9);
  assert.ok(Math.abs(first.w - (0.32 * 9) / 16) < 1e-9, 'covers 9 of the item\'s 16 characters');
  assert.deepEqual(findMatches(PAGE, 'zebra'), []);
  assert.deepEqual(findMatches(PAGE, '   '), []);
});

test('findMatches follows a phrase across items, missing spaces and line breaks', () => {
  const across = findMatches(PAGE, 'all you need');
  assert.equal(across.length, 1);
  assert.equal(across[0].rects.length, 2, 'one rectangle per item it runs through');
  assert.ok(across[0].rects[0].x > 0.3 && across[0].rects[1].x >= 0.42);

  const broken = findMatches(PAGE, 'transduction');
  assert.equal(broken.length, 1);
  assert.deepEqual(broken[0].rects.map((r) => r.y), [0.2, 0.22], 'wraps onto the next line');

  assert.equal(findMatches(PAGE, 'attention mechanisms').length, 1);
});

test('a match rectangle sits where its characters are within the item', () => {
  const [hit] = findMatches([run('abcdefghij', 0.2, 0.5, 0.5)], 'efg');
  const [r] = hit.rects;
  assert.ok(Math.abs(r.x - (0.2 + 0.5 * 0.4)) < 1e-9);
  assert.ok(Math.abs(r.w - 0.5 * 0.3) < 1e-9);
});

test('textLines merges runs on a line but keeps two columns apart', () => {
  const lines = textLines(PAGE);
  assert.equal(lines.length, 4);
  assert.ok(Math.abs(lines[0].x0 - 0.1) < 1e-9 && Math.abs(lines[0].x1 - 0.6) < 1e-9);

  const columns = textLines([run('left column text', 0.05, 0.4, 0.4), run('right column text', 0.55, 0.4, 0.4)]);
  assert.equal(columns.length, 2);
});

const sweep = (x0, x1, y, wobble = 0.002) => Array.from({ length: 30 }, (_, i) => ({
  x: x0 + ((x1 - x0) * i) / 29, y: y + wobble * Math.sin(i),
}));

test('a highlighter sweep along a line snaps to cover exactly that line', () => {
  const lines = textLines(PAGE);
  const snap = snapHighlight(sweep(0.15, 0.5, 0.111), lines); // a little low, a little wobbly
  assert.ok(snap);
  assert.ok(Math.abs(snap.y - 0.1075) < 1e-9, 'centred on the line, not on the stroke');
  assert.ok(Math.abs(snap.h - 0.015 * 1.15) < 1e-9);
  assert.ok(Math.abs(snap.x0 - 0.15) < 1e-9 && Math.abs(snap.x1 - 0.5) < 1e-9, 'keeps the swept extent');

  const over = snapHighlight(sweep(0.02, 0.9, 0.108), lines);
  assert.ok(Math.abs(over.x0 - 0.1) < 1e-9 && Math.abs(over.x1 - 0.6) < 1e-9, 'but not past the text');
});

test('highlighting between lines picks the nearer one', () => {
  const lines = textLines(PAGE);
  assert.ok(Math.abs(snapHighlight(sweep(0.2, 0.5, 0.214), lines).y - 0.2075) < 1e-9);
  assert.ok(Math.abs(snapHighlight(sweep(0.2, 0.5, 0.222), lines).y - 0.2275) < 1e-9);
});

test('highlighting that is not along a line of text is left as drawn', () => {
  const lines = textLines(PAGE);
  assert.equal(snapHighlight(sweep(0.2, 0.5, 0.6), lines), null, 'over a figure');
  assert.equal(snapHighlight(sweep(0.7, 0.9, 0.3), lines), null, 'beside the line');
  const bar = Array.from({ length: 30 }, (_, i) => ({ x: 0.2, y: 0.1 + i * 0.008 }));
  assert.equal(snapHighlight(bar, lines), null, 'a vertical bar down the page');
  assert.equal(snapHighlight(sweep(0.3, 0.303, 0.108), lines), null, 'a dab');
  assert.equal(snapHighlight(sweep(0.2, 0.5, 0.108), []), null, 'a page with no text');
});

/* ---------------------------------------------------------------- */
/* text boxes                                                        */
/* ---------------------------------------------------------------- */

const mono = (s) => s.length * 0.5; // every character half an em wide

test('wrapText keeps every line inside the box and loses no words', () => {
  const text = 'The quick brown fox jumps over the lazy dog and keeps on running';
  const lines = wrapText(text, 10, mono);
  assert.ok(lines.length > 2);
  assert.ok(lines.every((l) => mono(l) <= 10), lines.join(' | '));
  assert.equal(lines.join(' '), text);
});

test('wrapText honours line breaks and breaks a word too long for the box', () => {
  assert.deepEqual(wrapText('one\n\ntwo', 100, mono), ['one', '', 'two']);
  const long = wrapText('a supercalifragilistic word', 5, mono);
  assert.ok(long.every((l) => mono(l) <= 5), long.join(' | '));
  assert.equal(long.join('').replace(/\s/g, ''), 'asupercalifragilisticword');
  assert.deepEqual(wrapText('', 10, mono), ['']);
});

const note = () => makeText({ x: 0.2, y: 0.3, width: 0.3, size: 0.02, color: '--pen-4', text: 'a note that is long enough to wrap onto several lines of the box' }, mono, 0.75);

test('a text box is as tall as its wrapped text', () => {
  const t = note();
  const lines = wrapText(t.text, 0.3 / 0.02, mono).length;
  const b = boundsOf([t]);
  assert.ok(lines >= 3);
  assert.ok(Math.abs((b.y1 - b.y0) - lines * 0.02 * LINE_HEIGHT * 0.75) < 1e-12);
  assert.deepEqual(textBox(t), { x: 0.2, y: 0.3, width: t.pts[1].x - 0.2 });
});

test('text behaves as a stroke: it can be hit, lassoed, moved and resized', () => {
  const t = note();
  const b = boundsOf([t]);
  assert.equal(strokeAt([t], { x: 0.35, y: b.y0 }), 0, 'the eraser finds its edge');

  const loop = [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }, { x: 0.1, y: 0.6 }];
  assert.deepEqual(strokesInLasso([t], loop), [0]);

  const [moved] = transformStrokes([t], { dx: 0.1, dy: 0.05 });
  assert.ok(Math.abs(textBox(moved).x - 0.3) < 1e-12 && moved.text === t.text && moved.w === t.w);

  const [big] = transformStrokes([t], { scale: 2, ox: 0.2, oy: 0.3 });
  assert.equal(big.w, 0.04, 'the font grows with the box');
  assert.ok(Math.abs(textBox(big).width - 0.6) < 1e-12);
  // same wrapping at twice the size, so it still fits its box
  assert.equal(wrapText(big.text, textBox(big).width / big.w, mono).length, wrapText(t.text, 0.3 / 0.02, mono).length);
});

test('erasing part of a text box removes it whole, and tidying leaves it alone', () => {
  const t = note();
  const b = boundsOf([t]);
  assert.deepEqual(eraseArea(t, { x: 0.35, y: b.y0 }), []);
  assert.equal(eraseArea(t, { x: 0.9, y: 0.9 }), null);
  const [same] = tidyPage([t], { smoothStrength: 1, level: true, size: true, spacing: true });
  assert.deepEqual(same.pts, t.pts);
  assert.equal(same.text, t.text);
});

/* ---------------------------------------------------------------- */
/* margins                                                           */
/* ---------------------------------------------------------------- */

test('with a margin the page runs past 1, and selections may go there but no further', () => {
  const box = { x0: 0.8, y0: 0.1, x1: 0.95, y1: 0.2 };
  assert.ok(Math.abs(clampMove(box, 0.5, 0).dx - 0.05) < 1e-12, 'no margin: stops at the page edge');
  assert.ok(Math.abs(clampMove(box, 0.5, 0, 1.4).dx - 0.45) < 1e-12, 'margin: stops at the margin edge');
  assert.ok(Math.abs(resizeScale(box, { x: 9, y: 0.1 }, { xmax: 1.4 }) - 4) < 1e-9); // (1.4 - 0.8) / 0.15
});

test('the zoom box can reach into the margin', () => {
  const o = { stripW: 1024, stripH: 260, pageW: 700, pageH: 906, zoom: 2.5 };
  const inside = targetFor({ ...o, cx: 1.3, cy: 0.5 });
  assert.ok(inside.x + inside.w <= 1 + 1e-12, 'without a margin it stays on the page');
  const out = targetFor({ ...o, cx: 1.3, cy: 0.5, xmax: 1.4 });
  assert.ok(out.x + out.w > 1.2 && out.x + out.w <= 1.4 + 1e-12);

  let t = targetFor({ ...o, cx: 0.2, cy: 0.5, xmax: 1.4 }), steps = 0;
  const y = t.y;
  while (t.y === y && steps++ < 20) t = advance(t, 'right', { xmax: 1.4 });
  assert.ok(steps > 2 && steps < 20, 'walks through the margin before starting a new line');
});

/* ---------------------------------------------------------------- */
/* backup                                                            */
/* ---------------------------------------------------------------- */

const pdf = (n, fill) => Uint8Array.from({ length: n }, (_, i) => (i * fill) % 251).buffer;
const LIBRARY = [
  {
    meta: { key: 'a.pdf:5000', name: 'a.pdf', title: 'Paper A — “quoted” ünïcödé', size: 5000, pages: 3, layout: { order: [1, 'b1', 2, 3], blanks: { b1: { paper: 'grid' } }, margin: 0.4 } },
    notes: { 1: [{ k: 'pen', c: '--pen-1', w: 0.003, pts: [{ x: 0.1, y: 0.2, w: 0.003 }, { x: 1.2, y: 0.3, w: 0.002 }] }], b1: [{ k: 'text', text: 'héllo\nworld', pts: [] }] },
    bytes: pdf(5000, 7),
    thumb: new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }),
  },
  { meta: { key: 'notebook-1:0', name: 'Notebook', size: 0, pages: 0 }, notes: {}, bytes: new ArrayBuffer(0), thumb: null },
  { meta: { key: 'c.pdf:70000', name: 'c.pdf', size: 70000, pages: 40 }, notes: { 7: [] }, bytes: pdf(70000, 3), thumb: null },
];

test('a backup restores every document, note and thumbnail byte for byte', async () => {
  const file = packBackup(LIBRARY, 1234);
  const back = await readBackup(file);
  assert.equal(back.created, 1234);
  assert.equal(back.docs.length, 3);
  for (const [i, d] of back.docs.entries()) {
    assert.deepEqual(d.meta, LIBRARY[i].meta);
    assert.deepEqual(d.notes, LIBRARY[i].notes);
    assert.deepEqual(new Uint8Array(await d.bytes()), new Uint8Array(LIBRARY[i].bytes));
  }
  const thumb = back.docs[0].thumb();
  assert.equal(thumb.type, 'image/png');
  assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  assert.equal(back.docs[1].thumb(), null);
  assert.equal((await back.docs[1].bytes()).byteLength, 0);
});

test('a backup is barely larger than what it holds', () => {
  const file = packBackup(LIBRARY);
  const payload = 5000 + 70000 + 7;
  assert.ok(file.size - payload < 1500, `${file.size - payload} bytes of overhead`);
});

test('an empty library backs up and restores', async () => {
  assert.deepEqual((await readBackup(packBackup([]))).docs, []);
});

test('files that are not backups, or are cut short, are refused', async () => {
  await assert.rejects(readBackup(new Blob(['%PDF-1.7 not a backup at all'])), /not a Margin backup/);
  await assert.rejects(readBackup(new Blob([])), /not a Margin backup/);
  const file = packBackup(LIBRARY);
  await assert.rejects(readBackup(file.slice(0, file.size - 10)), /cut short/);
  await assert.rejects(readBackup(file.slice(0, 40)), /cut short/);
});
