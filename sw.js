/**
 * sw.js — service worker: makes Margin installable and usable offline.
 *
 * Three kinds of request, three policies:
 *
 *   app shell (same origin)   network first, so a new version arrives the
 *                             moment there is a connection; the cached copy
 *                             answers when there is none, or the network stalls
 *   pinned CDN libraries      cache first — the URL carries the version, so
 *                             what is cached can never be stale
 *   fonts                     cache first, fetched lazily; the app has
 *                             system-font fallbacks and works without them
 *
 * Documents and notes are not in here. They live in IndexedDB (store.js).
 *
 * Bump VERSION whenever SHELL changes. tests/pwa.test.mjs fails if a
 * file the app needs is missing from the list.
 */

const VERSION = 'margin-v3';

const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'styles/app.css',
  'src/main.js',
  'src/ink.js',
  'src/cleanup.js',
  'src/store.js',
  'src/export.js',
  'src/library.js',
  'src/history.js',
  'src/gestures.js',
  'src/pages.js',
  'src/search.js',
  'src/backup.js',
  'src/tools/pencil.js',
  'src/tools/shapes.js',
  'src/tools/prefs.js',
  'src/tools/lasso.js',
  'src/tools/scratch.js',
  'src/tools/zoombox.js',
  'src/tools/text.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const PINNED = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const STALL_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Best effort: a CDN hiccup must not stop the app installing. Anything
    // missed here is cached the first time the page asks for it.
    await Promise.all(PINNED.map((url) => cache.add(new Request(url, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== VERSION) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await fetch(request);
  // opaque responses (status 0) are fine to keep: these URLs are fixed
  if (res.ok || res.type === 'opaque') cache.put(request.url, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true })
    ?? (request.mode === 'navigate' ? await cache.match('index.html') : undefined);

  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (!cached) return fresh;

  // with a copy in hand, do not make the user wait on a stalled network
  const stalled = new Promise((resolve) => setTimeout(resolve, STALL_MS, cached));
  return Promise.race([fresh.catch(() => cached), stalled]);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (PINNED.includes(request.url) || FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});
