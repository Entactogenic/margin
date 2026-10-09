import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortDocs, formatSize, formatWhen, cycleKey, createLru } from '../src/library.js';

const docs = [
  { key: 'b', name: 'beta.pdf', title: 'Zebra notes', added: 3, opened: 10 },
  { key: 'a', name: 'alpha.pdf', title: 'apple paper', added: 1, opened: 30 },
  { key: 'c', name: 'gamma.pdf', title: 'Mango 10', added: 2, opened: 20 },
  { key: 'd', name: 'delta.pdf', title: 'Mango 9', added: 4, opened: 5 },
];

test('sortDocs orders by last opened, name, or date added without mutating', () => {
  const before = docs.map((d) => d.key).join('');
  assert.deepEqual(sortDocs(docs).map((d) => d.key), ['a', 'c', 'b', 'd']);
  assert.deepEqual(sortDocs(docs, 'added').map((d) => d.key), ['d', 'b', 'c', 'a']);
  // case-insensitive, and "Mango 9" before "Mango 10"
  assert.deepEqual(sortDocs(docs, 'name').map((d) => d.key), ['a', 'd', 'c', 'b']);
  assert.equal(docs.map((d) => d.key).join(''), before);
});

test('sortDocs falls back to the filename when there is no title', () => {
  const out = sortDocs([{ key: 1, name: 'b.pdf' }, { key: 2, name: 'a.pdf' }], 'name');
  assert.deepEqual(out.map((d) => d.key), [2, 1]);
});

test('formatSize and formatWhen', () => {
  assert.equal(formatSize(0), '0 KB');
  assert.equal(formatSize(300), '1 KB');
  assert.equal(formatSize(2.34 * 1024 * 1024), '2.3 MB');
  assert.equal(formatSize(50 * 1024 * 1024), '50 MB');

  const now = 1_000_000_000_000;
  assert.equal(formatWhen(0, now), 'never');
  assert.equal(formatWhen(now - 20_000, now), 'just now');
  assert.equal(formatWhen(now - 5 * 60_000, now), '5 min ago');
  assert.equal(formatWhen(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(formatWhen(now - 4 * 86_400_000, now), '4 d ago');
});

test('cycleKey steps through the order and wraps', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(cycleKey(order, 'a', 1), 'b');
  assert.equal(cycleKey(order, 'c', 1), 'a');
  assert.equal(cycleKey(order, 'a', -1), 'c');
  assert.equal(cycleKey(order, 'missing', 1), 'a');
  assert.equal(cycleKey(order, 'missing', -1), 'c');
  assert.equal(cycleKey([], 'a', 1), null);
});

test('the view cache never holds more than its limit across 20 switches', () => {
  const evicted = [];
  const live = new Set();
  const lru = createLru(3, (view) => { evicted.push(view.key); live.delete(view.key); });

  const keys = ['a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < 20; i++) {
    const key = keys[(i * 3) % keys.length];
    const view = lru.get(key) ?? { key };
    live.add(key);
    lru.touch(key, view);
    assert.ok(lru.size <= 3, `switch ${i}: ${lru.size} views cached`);
    assert.equal(live.size, lru.size); // everything dropped was released
    assert.equal(lru.keys().at(-1), key); // the open document is never the one evicted
  }
  assert.equal(evicted.length, 20 - 3);
});

test('touching a cached view keeps it and reuses the same object', () => {
  const lru = createLru(3, () => assert.fail('nothing should be evicted'));
  const a = { key: 'a' }, b = { key: 'b' };
  lru.touch('a', a);
  lru.touch('b', b);
  lru.touch('a', a);
  assert.equal(lru.get('a'), a);
  assert.deepEqual(lru.keys(), ['b', 'a']);
});

test('delete releases the entry through onEvict', () => {
  const gone = [];
  const lru = createLru(3, (v, k) => gone.push(k));
  lru.touch('a', {});
  assert.equal(lru.delete('a'), true);
  assert.equal(lru.delete('a'), false);
  assert.deepEqual(gone, ['a']);
  assert.equal(lru.size, 0);
});
