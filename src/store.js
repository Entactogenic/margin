/**
 * store.js — IndexedDB persistence.
 *
 * Four object stores, all keyed by filename + byte size:
 *
 *   notes   stroke data, written on every stroke
 *   docs    document metadata: { key, name, title, size, added, opened, pages, view }
 *   bytes   the PDF itself, as an ArrayBuffer
 *   thumbs  first-page PNG Blob, ~320px wide
 *
 * The PDF bytes sit in their own store so that listing the library or
 * touching `opened` never drags a 50MB buffer through a transaction.
 *
 * Every call degrades to a no-op if storage is unavailable (private
 * window, blocked site data) rather than throwing into the drawing path.
 */

const DB_NAME = 'margin';
const STORE = 'notes';
const DOCS = 'docs';
const BYTES = 'bytes';
const THUMBS = 'thumbs';
const QUOTA_LIMIT = 0.8;
let db = null;

export async function open() {
  if (db) return true;
  return new Promise((resolve) => {
    try {
      const rq = indexedDB.open(DB_NAME, 2);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        for (const name of [STORE, DOCS, BYTES, THUMBS]) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
        }
      };
      rq.onsuccess = () => {
        db = rq.result;
        // another tab upgrading must not be blocked by this one
        db.onversionchange = () => close();
        resolve(true);
      };
      rq.onerror = () => resolve(false);
      rq.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function close() {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
}

export function isOpen() {
  return db !== null;
}

export function keyFor(file) {
  return `${file.name}:${file.size}`;
}

/* ------------------------------------------------------------------ */
/* notes                                                               */
/* ------------------------------------------------------------------ */

export async function save(key, data) {
  if (!db || !key) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(JSON.stringify(data), key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function load(key) {
  if (!db || !key) return null;
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => {
        try { resolve(rq.result ? JSON.parse(rq.result) : null); }
        catch { resolve(null); }
      };
      rq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function list() {
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function remove(key) {
  if (!db || !key) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* documents                                                           */
/* ------------------------------------------------------------------ */

/**
 * One transaction over `names`. `work` receives the object stores and
 * returns a function producing the value to resolve with on commit.
 * Resolves to `fallback` if storage is missing or the transaction fails.
 */
function transact(names, mode, fallback, work) {
  if (!db) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(names, mode);
      const result = work(...names.map((n) => tx.objectStore(n)));
      tx.oncomplete = () => resolve(result());
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

/** Store a document's metadata and its bytes together. */
export async function putDoc(meta, bytes) {
  if (!meta?.key) return false;
  return transact([DOCS, BYTES], 'readwrite', false, (docs, blobs) => {
    docs.put(meta, meta.key);
    blobs.put(bytes, meta.key);
    return () => true;
  });
}

export async function getDoc(key) {
  if (!key) return null;
  return transact([DOCS], 'readonly', null, (docs) => {
    const rq = docs.get(key);
    return () => rq.result ?? null;
  });
}

export async function getBytes(key) {
  if (!key) return null;
  return transact([BYTES], 'readonly', null, (blobs) => {
    const rq = blobs.get(key);
    return () => rq.result ?? null;
  });
}

/** Metadata for every stored document. Never touches the bytes. */
export async function listDocs() {
  return transact([DOCS], 'readonly', [], (docs) => {
    const rq = docs.getAll();
    return () => rq.result ?? [];
  });
}

/** Merge `patch` into a document's metadata. No-op if it is not stored. */
export async function updateDoc(key, patch) {
  if (!key) return false;
  return transact([DOCS], 'readwrite', false, (docs) => {
    let found = false;
    const rq = docs.get(key);
    rq.onsuccess = () => {
      if (!rq.result) return;
      found = true;
      docs.put({ ...rq.result, ...patch }, key);
    };
    return () => found;
  });
}

export async function putThumb(key, blob) {
  if (!key || !blob) return false;
  return transact([THUMBS], 'readwrite', false, (thumbs) => {
    thumbs.put(blob, key);
    return () => true;
  });
}

export async function getThumb(key) {
  if (!key) return null;
  return transact([THUMBS], 'readonly', null, (thumbs) => {
    const rq = thumbs.get(key);
    return () => rq.result ?? null;
  });
}

/** Every thumbnail, as a Map of key -> Blob. */
export async function listThumbs() {
  return transact([THUMBS], 'readonly', new Map(), (thumbs) => {
    const keys = thumbs.getAllKeys();
    const vals = thumbs.getAll();
    return () => new Map((keys.result ?? []).map((k, i) => [k, vals.result[i]]));
  });
}

/** Delete a document with its bytes, notes and thumbnail — all or nothing. */
export async function removeDoc(key) {
  if (!key) return false;
  return transact([DOCS, BYTES, STORE, THUMBS], 'readwrite', false, (...stores) => {
    for (const s of stores) s.delete(key);
    return () => true;
  });
}

/**
 * Would storing `size` more bytes push usage past 80% of quota?
 * Unknown quota counts as fine: there is nothing to warn about.
 */
export async function quotaCheck(size, estimate = () => navigator.storage.estimate()) {
  try {
    const { usage = 0, quota = 0 } = await estimate();
    if (!quota) return { ok: true, usage, quota };
    return { ok: (usage + size) / quota <= QUOTA_LIMIT, usage, quota };
  } catch {
    return { ok: true, usage: 0, quota: 0 };
  }
}
