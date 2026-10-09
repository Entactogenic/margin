/**
 * library.js — the document library.
 *
 * A grid of cards drawn from stored metadata and thumbnails; it never
 * opens a PDF to render itself. The helpers at the top are pure and are
 * what the tests exercise; the view at the bottom is the only part that
 * touches the DOM.
 */

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

const titleOf = (d) => d.title || d.name || '';

/** A sorted copy. Modes: 'opened' (default), 'name', 'added'. */
export function sortDocs(docs, mode = 'opened') {
  const out = docs.slice();
  if (mode === 'name') {
    out.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base', numeric: true }));
  } else {
    const field = mode === 'added' ? 'added' : 'opened';
    out.sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0));
  }
  return out;
}

export function formatSize(bytes) {
  if (!(bytes > 0)) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatWhen(ts, now = Date.now()) {
  if (!ts) return 'never';
  const mins = Math.floor((now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** The key `step` places along `order` from `current`, wrapping around. */
export function cycleKey(order, current, step) {
  if (!order.length) return null;
  const at = order.indexOf(current);
  if (at < 0) return step > 0 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

/**
 * What to tell the user about whether the browser will keep their
 * library. `persisted` is the answer from navigator.storage.persist(),
 * or null where the browser cannot say.
 */
export function storageNote(persisted, installed) {
  if (persisted === true) {
    return { state: 'safe', label: 'storage protected', detail: 'This browser has agreed not to clear your documents and notes.' };
  }
  if (installed) {
    return {
      state: 'safe', label: 'installed',
      detail: 'Installed to the Home Screen, so documents and notes are not cleared for being unused.',
    };
  }
  if (persisted === false) {
    return {
      state: 'risk', label: 'storage not protected — add to Home Screen',
      detail: 'The browser may clear documents and notes; Safari does after 7 days without a visit. ' +
        'Add Margin to the Home Screen (Share, then Add to Home Screen) to keep them.',
    };
  }
  return {
    state: 'unknown', label: 'storage protection unknown',
    detail: 'This browser does not report whether it may clear stored documents. Export anything you cannot lose.',
  };
}

/**
 * A small least-recently-used cache. `touch` marks an entry as the most
 * recent and evicts whatever falls off the end, calling `onEvict` so
 * the owner can release what the entry holds.
 */
export function createLru(limit, onEvict) {
  const map = new Map(); // insertion order = least recent first
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    get size() { return map.size; },
    touch(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const [oldKey, oldValue] = map.entries().next().value;
        map.delete(oldKey);
        onEvict?.(oldValue, oldKey);
      }
    },
    delete(key) {
      if (!map.has(key)) return false;
      const value = map.get(key);
      map.delete(key);
      onEvict?.(value, key);
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* view                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} o
 * @param {HTMLElement} o.root     the library panel
 * @param {Object} o.store         store.js
 * @param {Function} o.ask         ({title, body, confirm}) -> Promise<boolean>
 * @param {Function} o.onOpen      (key) => void
 * @param {Function} o.onDeleted   (key) => void
 * @param {Function} o.onRenamed   (key, title) => void
 * @param {Function} o.currentKey  () => key of the open document, or null
 * @param {Function} o.onToggle    (visible) => void
 */
export function initLibrary({ root, store, ask, onOpen, onDeleted, onRenamed, currentKey, onToggle }) {
  const grid = root.querySelector('.lib-grid');
  const none = root.querySelector('.lib-none');
  const sort = root.querySelector('.lib-sort');
  const count = root.querySelector('.lib-count');
  let urls = [];
  let mode = 'opened';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function card(doc, thumb) {
    const li = el('li', 'card');
    li.dataset.key = doc.key;
    const title = titleOf(doc);

    const open = el('button', 'card-open');
    open.type = 'button';
    if (doc.key === currentKey()) open.setAttribute('aria-current', 'true');

    const frame = el('span', 'thumb');
    if (thumb) {
      const url = URL.createObjectURL(thumb);
      urls.push(url);
      const img = el('img');
      img.src = url;
      img.alt = '';
      img.decoding = 'async';
      frame.append(img);
    }
    if (doc.key === currentKey()) frame.append(el('span', 'badge', 'open'));

    open.append(
      frame,
      el('span', 'card-title', title),
      el('span', 'card-meta', `${doc.pages} pp · ${formatSize(doc.size)} · ${formatWhen(doc.opened)}`)
    );
    open.addEventListener('click', () => onOpen(doc.key));

    const acts = el('span', 'card-acts');
    const rename = el('button', 'tb', 'Rename');
    rename.type = 'button';
    rename.setAttribute('aria-label', `Rename ${title}`);
    rename.addEventListener('click', () => startRename(li, doc));
    const del = el('button', 'tb', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${title}`);
    del.addEventListener('click', () => confirmDelete(doc));
    acts.append(rename, del);

    li.append(open, acts);
    return li;
  }

  function startRename(li, doc) {
    const acts = li.querySelector('.card-acts');
    const form = el('form', 'card-rename');
    const input = el('input');
    input.type = 'text';
    input.value = titleOf(doc);
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Document title');
    const ok = el('button', 'tb', 'Save');
    ok.type = 'submit';
    form.append(input, ok);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (title && title !== titleOf(doc)) {
        await store.updateDoc(doc.key, { title });
        onRenamed(doc.key, title);
      }
      await refresh();
      focusCard(doc.key);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      form.replaceWith(acts);
      acts.querySelector('button').focus();
    });

    acts.replaceWith(form);
    input.focus();
    input.select();
  }

  async function confirmDelete(doc) {
    const yes = await ask({
      title: `Delete “${titleOf(doc)}”?`,
      body: 'The document and every annotation on it will be deleted from this browser. This cannot be undone.',
      confirm: 'Delete',
    });
    if (!yes) { focusCard(doc.key); return; }
    await store.removeDoc(doc.key);
    onDeleted(doc.key);
    await refresh();
    (grid.querySelector('.card-open') ?? sort).focus();
  }

  function focusCard(key) {
    for (const li of grid.children) {
      if (li.dataset.key === key) { li.querySelector('.card-open').focus(); return; }
    }
  }

  async function refresh() {
    const [docs, thumbs] = await Promise.all([store.listDocs(), store.listThumbs()]);
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    grid.replaceChildren(...sortDocs(docs, mode).map((d) => card(d, thumbs.get(d.key))));
    none.hidden = docs.length > 0;
    grid.hidden = docs.length === 0;
    count.textContent = docs.length === 1 ? '1 document' : `${docs.length} documents`;
    return docs.length;
  }

  sort.addEventListener('change', () => { mode = sort.value; refresh(); });

  const api = {
    refresh,
    get visible() { return !root.hidden; },
    async show() {
      await refresh();
      root.hidden = false;
      onToggle?.(true);
    },
    hide() {
      if (root.hidden) return;
      root.hidden = true;
      onToggle?.(false);
    },
  };
  return api;
}
