import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inkOwnsTouch } from '../src/ink.js';
import { storageNote } from '../src/library.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/* ---------------------------------------------------------------- */
/* touch arbitration                                                 */
/* ---------------------------------------------------------------- */

test('outside stylus-only mode every touch draws, fingers included', () => {
  for (const touchTypes of [['direct'], ['stylus'], [undefined], []]) {
    for (const lastPointer of ['touch', 'pen', 'mouse', '']) {
      assert.equal(inkOwnsTouch({ stylusOnly: false, penDown: false, touchTypes, lastPointer }), true);
    }
  }
});

test('in stylus-only mode a finger is left to the browser to scroll with', () => {
  const on = { stylusOnly: true, penDown: false };
  assert.equal(inkOwnsTouch({ ...on, touchTypes: ['direct'], lastPointer: 'touch' }), false);
  assert.equal(inkOwnsTouch({ ...on, touchTypes: ['direct', 'direct'], lastPointer: 'touch' }), false); // a pinch
  // Safari's label wins over a stale pointer type from an earlier pen stroke
  assert.equal(inkOwnsTouch({ ...on, touchTypes: ['direct'], lastPointer: 'pen' }), false);
});

test('in stylus-only mode the pen is always kept for ink', () => {
  const on = { stylusOnly: true, penDown: false };
  assert.equal(inkOwnsTouch({ ...on, touchTypes: ['stylus'], lastPointer: 'pen' }), true);
  assert.equal(inkOwnsTouch({ ...on, touchTypes: ['stylus'], lastPointer: '' }), true);
  // browsers that do not label touches: go by the pointerdown just before
  assert.equal(inkOwnsTouch({ ...on, touchTypes: [undefined], lastPointer: 'pen' }), true);
  assert.equal(inkOwnsTouch({ ...on, touchTypes: [undefined], lastPointer: 'touch' }), false);
});

test('a palm landing while the pen is down does not scroll the page', () => {
  assert.equal(inkOwnsTouch({ stylusOnly: true, penDown: true, touchTypes: ['direct'], lastPointer: 'touch' }), true);
});

/* ---------------------------------------------------------------- */
/* storage protection                                                */
/* ---------------------------------------------------------------- */

test('storageNote only warns when the library really is at risk', () => {
  assert.equal(storageNote(true, false).state, 'safe');
  assert.equal(storageNote(true, true).state, 'safe');
  assert.equal(storageNote(false, true).state, 'safe');   // installed: exempt from the 7-day rule
  assert.equal(storageNote(null, true).state, 'safe');
  assert.equal(storageNote(null, false).state, 'unknown');

  const risk = storageNote(false, false);
  assert.equal(risk.state, 'risk');
  assert.match(risk.label, /Home Screen/);
  assert.match(risk.detail, /7 days/);
});

/* ---------------------------------------------------------------- */
/* offline completeness                                              */
/* ---------------------------------------------------------------- */

const sw = read('sw.js');
const listOf = (name) => JSON.parse(sw.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
const SHELL = listOf('SHELL');
const PINNED = listOf('PINNED');

function walk(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}

test('the service worker precaches every file the app loads', () => {
  const needed = ['index.html', 'manifest.json', ...walk('src'), ...walk('styles')];
  const missing = needed.filter((f) => !SHELL.includes(f));
  assert.deepEqual(missing, [], 'these would 404 offline');
});

test('every precached path exists, so install cannot fail on a typo', () => {
  const gone = SHELL.filter((f) => f !== './' && !existsSync(join(root, f)));
  assert.deepEqual(gone, []);
});

test('every module import resolves to a precached file', () => {
  for (const file of walk('src')) {
    for (const m of read(file).matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join(dirname(file), m[1]).replace(/\\/g, '/');
      assert.ok(SHELL.includes(target), `${file} imports ${target}`);
    }
  }
});

test('every CDN script the app uses is pinned in the service worker', () => {
  const used = [
    ...read('index.html').matchAll(/<script src="(https:[^"]+)"/g),
    ...read('src/main.js').matchAll(/'(https:\/\/cdnjs[^']+)'/g),
  ].map((m) => m[1]);
  assert.equal(used.length, 3);
  assert.deepEqual(used.filter((u) => !PINNED.includes(u)), []);
});

test('the manifest is installable: standalone, relative scope, icons that exist', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './'); // relative, so it works under /margin/ on GitHub Pages
  assert.equal(m.scope, './');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons) {
    const png = readFileSync(join(root, icon.src));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
    assert.ok(SHELL.includes(icon.src));
  }
  // iOS ignores manifest icons and wants its own link
  const touch = read('index.html').match(/rel="apple-touch-icon" href="([^"]+)"/)[1];
  assert.equal(readFileSync(join(root, touch)).readUInt32BE(16), 180);
});
