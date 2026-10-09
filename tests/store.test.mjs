import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import * as Store from '../src/store.js';

const meta = (key, extra = {}) => ({
  key, name: key, title: key, size: 1000, added: 1, opened: 1, pages: 3, ...extra,
});
const pdfBytes = (n = 64) => Uint8Array.from({ length: n }, (_, i) => i % 251).buffer;

beforeEach(async () => {
  Store.close();
  globalThis.indexedDB = new IDBFactory();
  assert.equal(await Store.open(), true);
});

test('a stored document comes back byte-identical after the database is reopened', async () => {
  const bytes = pdfBytes(4096);
  assert.equal(await Store.putDoc(meta('a.pdf:4096'), bytes), true);
  await Store.save('a.pdf:4096', { 1: [{ k: 'pen', pts: [{ x: 0.1, y: 0.2 }] }] });

  Store.close(); // a page reload
  assert.equal(await Store.open(), true);

  const back = await Store.getBytes('a.pdf:4096');
  assert.deepEqual(new Uint8Array(back), new Uint8Array(bytes));
  assert.equal((await Store.getDoc('a.pdf:4096')).pages, 3);
  assert.deepEqual(await Store.load('a.pdf:4096'), { 1: [{ k: 'pen', pts: [{ x: 0.1, y: 0.2 }] }] });
});

test('listDocs returns metadata only, never the bytes', async () => {
  await Store.putDoc(meta('a'), pdfBytes());
  await Store.putDoc(meta('b'), pdfBytes());
  const docs = await Store.listDocs();
  assert.equal(docs.length, 2);
  for (const d of docs) assert.equal('bytes' in d, false);
});

test('updateDoc merges a patch and leaves the bytes alone', async () => {
  const bytes = pdfBytes();
  await Store.putDoc(meta('a'), bytes);
  assert.equal(await Store.updateDoc('a', { title: 'Renamed', opened: 99 }), true);
  const d = await Store.getDoc('a');
  assert.equal(d.title, 'Renamed');
  assert.equal(d.opened, 99);
  assert.equal(d.name, 'a');
  assert.deepEqual(new Uint8Array(await Store.getBytes('a')), new Uint8Array(bytes));
});

test('updateDoc does not create a document that was never stored', async () => {
  assert.equal(await Store.updateDoc('ghost', { opened: 5 }), false);
  assert.equal(await Store.getDoc('ghost'), null);
});

test('removeDoc clears the document, its bytes, its notes and its thumbnail', async () => {
  await Store.putDoc(meta('a'), pdfBytes());
  await Store.putDoc(meta('keep'), pdfBytes());
  await Store.save('a', { 1: [] });
  await Store.save('keep', { 1: [] });
  await Store.putThumb('a', new Uint8Array([1, 2, 3]));
  await Store.putThumb('keep', new Uint8Array([4]));

  assert.equal(await Store.removeDoc('a'), true);

  assert.equal(await Store.getDoc('a'), null);
  assert.equal(await Store.getBytes('a'), null);
  assert.equal(await Store.load('a'), null);
  assert.equal(await Store.getThumb('a'), null);
  assert.deepEqual(await Store.list(), ['keep']);

  // the neighbour is untouched in all four stores
  assert.ok(await Store.getDoc('keep'));
  assert.ok(await Store.getBytes('keep'));
  assert.ok(await Store.load('keep'));
  assert.ok(await Store.getThumb('keep'));
});

test('listThumbs maps each key to its own thumbnail', async () => {
  await Store.putThumb('a', new Uint8Array([1]));
  await Store.putThumb('b', new Uint8Array([2]));
  const thumbs = await Store.listThumbs();
  assert.deepEqual([...thumbs.keys()].sort(), ['a', 'b']);
  assert.equal(thumbs.get('b')[0], 2);
});

test('quotaCheck warns before the write would pass 80% of quota', async () => {
  const est = (usage, quota) => async () => ({ usage, quota });
  assert.equal((await Store.quotaCheck(10, est(70, 100))).ok, true);   // lands on exactly 80%
  assert.equal((await Store.quotaCheck(11, est(70, 100))).ok, false);
  assert.equal((await Store.quotaCheck(50e6, est(0, 0))).ok, true);    // quota unknown
  assert.equal((await Store.quotaCheck(1, async () => { throw new Error('denied'); })).ok, true);
});

test('with storage unavailable every call is a quiet no-op', async () => {
  Store.close();
  globalThis.indexedDB = { open() { throw new Error('SecurityError'); } };
  assert.equal(await Store.open(), false);
  assert.equal(Store.isOpen(), false);

  assert.equal(await Store.putDoc(meta('a'), pdfBytes()), false);
  assert.equal(await Store.getDoc('a'), null);
  assert.equal(await Store.getBytes('a'), null);
  assert.deepEqual(await Store.listDocs(), []);
  assert.equal((await Store.listThumbs()).size, 0);
  assert.equal(await Store.updateDoc('a', {}), false);
  assert.equal(await Store.removeDoc('a'), false);
  assert.equal(await Store.save('a', {}), false);
  assert.equal(await Store.load('a'), null);
});

test('a 50MB document stores and reads back', async () => {
  const big = new Uint8Array(50 * 1024 * 1024);
  big[0] = 7; big[big.length - 1] = 9;
  assert.equal(await Store.putDoc(meta('big', { size: big.length }), big.buffer), true);
  const back = new Uint8Array(await Store.getBytes('big'));
  assert.equal(back.length, big.length);
  assert.equal(back[0], 7);
  assert.equal(back[back.length - 1], 9);
});
