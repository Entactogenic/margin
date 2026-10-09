# Margin — Project Specification

> **For Claude Code:** read this file first in any new session, then `README.md`
> for the architecture. Work one Aim at a time, in order. Do not start an Aim
> until the previous Aim's acceptance criteria pass. When a criterion is
> ambiguous, ask rather than guess.
>
> Parts of this already exist. Each Aim marks what is **done**, **partial**, or
> **not started** — check the code before writing any.

---

## Goal

A browser-based note-taking app in the mould of Notability: open a PDF, write on
it with a stylus, keep a library of documents you can move between, and have
messy handwriting cleaned up automatically.

Runs entirely client-side. No account, no server, no upload. Must work on a
tablet in a browser, with a stylus that may or may not report pressure.

**Success:** the author uses it to read and annotate papers in preference to
Notability, on a tablet, for a full week without losing work.

---

## Non-goals

Do not build these. Do not add dependencies for them.

- Any backend, account system, or cloud sync
- Real-time collaboration
- A native iOS or Android app
- Handwriting-to-text conversion (see Aim 2 — out of scope and why)
- A build step beyond the existing `build.js`; this stays a static site

---

## Constraints

- Vanilla ES modules. No framework, no bundler beyond `build.js`.
- Only two runtime dependencies, both from cdnjs, both pinned:
  `pdf.js@3.11.174` and `pdf-lib@1.17.1`.
- All strokes stored in **normalized page coordinates (0–1)**. This is load-
  bearing: zoom, resize, and export all read the same data. Do not store pixels.
- Point widths are computed once at capture and stored on the point. Recalibration
  must never retroactively change ink already drawn.
- Must degrade without storage (private window, blocked site data) rather than
  throwing into the drawing path.
- Light and dark themes via CSS custom properties, both defined on `:root`.
- Target: 60fps drawing with 500+ strokes on a page.

---

## Aim 1 — Complete the tool set

**Status: done.** Pen, pencil, highlighter, shapes and a two-mode eraser exist; see
`src/main.js`, `src/ink.js` and `src/tools/`.

### 1a. Pencil — *done*

A pencil must look visibly different from the pen: grainy, matte, with the
texture showing through rather than a solid line.

**Build:** a `pencil` tool in the tool enum, rendered in `src/ink.js`.

- Generate a grain tile once on an offscreen canvas (~64×64, random alpha
  noise), cache it, and use `ctx.createPattern(tile, 'repeat')` as
  `strokeStyle`. Do not stamp dabs per point — it is slow and bands visibly.
- Tint the grain to the selected colour by drawing the pattern through a
  `source-atop` fill, or by generating one tile per colour and caching by key.
- Pencil opacity should modulate with speed more aggressively than the pen does:
  a fast pencil stroke is visibly lighter.
- Pencil strokes must still erase, smooth, and export like any other stroke.

**Acceptance criteria**

1. A pencil stroke and a pen stroke of the same colour and width are
   distinguishable in a screenshot at 100% zoom.
2. Drawing 200 pencil strokes on one page holds 60fps on a mid-range tablet.
3. The grain tile is generated at most once per colour per session (assert with
   a counter in a test).
4. Pencil strokes survive save, reload, and export.

### 1b. Shape tool ("box") — *done*

Drag to place a shape instead of freehand drawing. Distinct from the existing
*Snap shapes* toggle, which guesses at freehand strokes.

**Build:** a `shape` tool with a sub-selection: rectangle, ellipse, line, arrow.

- Drag from corner to corner with a live preview on each pointermove.
- Hold Shift to constrain to square / circle / 45° angles.
- Emit a normal stroke object so everything downstream works unchanged —
  reuse `shapeToPoints()` from `src/cleanup.js`.
- Arrow: a line plus two short strokes at the head, sized to the line length.

**Acceptance criteria**

1. Each of the four shapes draws, erases, undoes, saves, and exports.
2. Shift-constrain works for all four.
3. The live preview does not leave artifacts when the drag is cancelled.
4. A shape is a single undo step, not one per preview frame.

### 1c. Tool polish — *done*

- Eraser: add a **stroke/area** mode toggle. Current behaviour is stroke-level
  (removes the whole stroke) — keep it as the default, add an area mode that
  splits a stroke at the erased span.
- Each tool remembers its own colour and width across switches.
- Persist the selected tool and its settings to `localStorage`, wrapped in
  try/catch.

**Acceptance criteria**

1. Switching pen → highlighter → pen restores the pen's own colour and width.
2. Area erase splits a long stroke into two strokes, both still editable.
3. Tool settings survive a page reload.

---

## Aim 2 — Clean up handwriting

**Status: done.** `src/cleanup.js` implements smoothing, shape
recognition, and baseline levelling, all verified against synthetic ink.

### What exists

| Function | Does | Algorithm |
|---|---|---|
| `smooth()` | removes shake, keeps character | simplify → moving average → Chaikin |
| `recognize()` | identifies intended shapes | closure test, residual + straightness scoring |
| `straighten()` | levels sloping lines | group by vertical overlap, least-squares baseline, rotate |
| `tidyPage()` | all of the above over a page | — |

Measured on synthetic jittered ink: strength 0.5 removes 44% of jitter and cuts
201 points to 40; strength 1.0 removes 71%. Letter width is preserved to within
2%.

### 2a. Size normalization — *done*

Levelling fixes slope. It does not fix letters that drift larger or smaller
across a line.

**Build:** `normalizeSize(strokes, opts)` in `src/cleanup.js`.

- Within a line group, compute each stroke's x-height (bounding box height,
  excluding outliers such as descenders).
- Scale each stroke toward the line's median x-height, capped at ±25%.
- Scale about the stroke's own baseline anchor so letters do not drift vertically.

**Acceptance criteria**

1. On synthetic input where letter height ramps 0.7× → 1.3× across a line, the
   standard deviation of x-height drops by more than half.
2. Descenders (g, y, p) are not scaled up to match x-height — test explicitly.
3. No stroke moves more than 25% in any dimension.

### 2b. Spacing normalization — *done*

**Build:** `normalizeSpacing(strokes, opts)` in `src/cleanup.js`.

- Within a line group, measure the horizontal gap between consecutive stroke
  bounding boxes.
- Classify gaps as intra-word or inter-word using a threshold at the midpoint
  between the two clusters (1-D k-means with k=2, or Otsu).
- Shift strokes horizontally to equalize each class. Never reorder.

**Acceptance criteria**

1. Word boundaries are detected correctly on synthetic input with a clear
   bimodal gap distribution.
2. A line with uniform gaps (one long word) is left unchanged.
3. Total line width changes by less than 10%.

### 2c. Cleanup preview — *done*

Currently *Tidy page* applies immediately and relies on undo.

**Build:** a before/after preview.

- Render the cleaned result at 50% opacity over the original.
- Confirm / cancel buttons; a strength slider that re-previews live.
- Escape cancels.

**Acceptance criteria**

1. Cancelling leaves the page byte-identical to before the preview opened.
2. Moving the slider re-renders in under 100ms for a page with 200 strokes.

### Explicitly out of scope

**Handwriting → typed text.** This needs a trained model, not geometry. The
practical routes are MyScript's iink SDK (commercial licence) or posting a
rasterized selection to a vision model — both violate the no-backend constraint
or the no-dependencies constraint. Do not attempt a hand-rolled recognizer.

---

## Aim 3 — Document library

**Status: done** (was the largest gap). Annotations used to save
keyed by filename and size while the PDF itself was not stored. Now the PDF,
its notes and a thumbnail are all kept, and `src/library.js` moves between them.

One deviation from the schema below: `docs` holds metadata only and the PDF
lives in a fourth store, `bytes`. Listing 50 documents must not read 50 PDFs.

### 3a. Store the documents

**Build:** extend `src/store.js` with a `docs` object store.

```
docs:  key -> { key, name, size, bytes: ArrayBuffer, added, opened, pages }
notes: key -> stroke data            // already exists, do not change its shape
thumbs: key -> Blob                  // first-page PNG, ~320px wide
```

- Keep `bytes` in its own store. Notes are read on every save; documents are
  read once on open, and must not be dragged through every transaction.
- Write the thumbnail once, on first open, from the page-1 canvas.
- Before storing, call `navigator.storage.estimate()`. If the file would push
  usage past 80% of quota, warn and let the user proceed or cancel.

**Acceptance criteria**

1. Open a PDF, reload the page, and reopen it from the library without
   re-picking the file. Annotations intact.
2. A 50MB PDF stores and reopens without blocking the UI for more than 500ms.
3. With storage unavailable, the app still opens PDFs normally and says once
   that the library is unavailable.
4. Quota warning fires before the write, not after a failure.

### 3b. Library view

**Build:** `src/library.js` plus markup in `index.html`.

- A grid of thumbnail cards: title, page count, last opened, size.
- Sort by last opened (default), name, or date added.
- Click to open. Shows which document is currently open.
- Rename (the display title, not the stored key).
- Delete, with a confirmation that states annotations will be deleted too.
  **Note:** `confirm()` does not work in sandboxed frames — build the
  confirmation into the page.
- Empty state that explains how to add the first document.
- Opens on launch when the library is non-empty; otherwise the current empty
  state stands.

**Acceptance criteria**

1. Cards render from stored thumbnails, not by re-rendering PDFs.
2. A library of 50 documents opens in under 300ms.
3. Deleting removes the document, its notes, and its thumbnail — verify all
   three stores.
4. Keyboard navigable; visible focus on every card.

### 3c. Switching documents

**Build:** fast switching without losing work.

- Persist pending strokes before switching. Never switch with unsaved ink.
- Restore scroll position and zoom per document.
- `Ctrl/Cmd + [` and `]` cycle to the previous/next document by last-opened.
- Keep the last 3 opened documents' rendered pages in memory; evict beyond that.

**Acceptance criteria**

1. Draw, switch away, switch back — the stroke is there.
2. Scroll position and zoom are restored per document.
3. Switching between two already-opened documents takes under 200ms.
4. Memory does not grow without bound across 20 switches (check
   `performance.memory` where available, or stroke-count accounting).

---

## Aim 4 — Feel like a native app

**Status: Step 1 built, awaiting iPad testing. Steps 2–4 not started.**

Make Margin feel like Notability or GoodNotes on an iPad: the pen draws, fingers
scroll and pinch, and nothing lags or loses work.

Built in four steps. **Stop after each step for testing on the iPad; do not
start the next until the author confirms.** Every feature must survive save,
reload, undo, and export, and every new pure function needs a test asserting
measured behaviour.

An installable web app (4.1d) is not the "native iOS or Android app" ruled out
under Non-goals: it is the same static site, added to the Home Screen.

### Step 1 — Fix what feels broken — *built, awaiting iPad testing*

#### 4.1a Finger scrolling

In stylus-only mode the ink canvas hands fingers back to the browser
(`touch-action: pan-x pan-y pinch-zoom`), and a non-passive `touchstart` /
`touchmove` handler keeps the pen's own touches for ink — without it the
browser would let the pen scroll too. `inkOwnsTouch()` in `src/ink.js` makes
the decision. With stylus-only off, fingers draw as before.

1. Stylus-only on: a one-finger drag over a page scrolls it and leaves no ink.
2. Stylus-only on: a two-finger pinch over a page zooms.
3. Stylus-only on: the pen draws, and the page does not move under it.
4. Stylus-only off: a finger draws, and the page does not scroll under it.
5. A palm landing or lifting while the pen is down neither scrolls the page nor
   cuts the stroke short.

#### 4.1b Drawing performance

Finished strokes are a cached bitmap (a snapshot of the ink canvas taken when
the gesture starts); each move repaints that snapshot plus the one stroke in
progress. A full repaint from stroke data happens only when the hand pauses.

1. 60fps while drawing on a page that already holds 500 strokes.
2. The cost of a pointermove does not depend on how many strokes the page has.
3. After a pause the canvas is pixel-identical to a fresh repaint.

#### 4.1c Automatic palm rejection

1. The first `pointerType: "pen"` contact of a session turns stylus-only on and
   shows a toast saying so. That first stroke still draws.
2. It happens once per session: if the user then turns stylus-only off, further
   pen contacts do not turn it back on.

#### 4.1d Installable app

`manifest.json`, `sw.js`, and `icons/`. The service worker precaches the app
shell and the three pinned CDN files; `tests/pwa.test.mjs` fails if a file the
app loads is missing from the precache list. **Bump `VERSION` in `sw.js`
whenever the list of files changes.** The single-file build (`dist/margin.html`)
carries no manifest or service worker.

1. Installs to the iPad Home Screen and opens full-screen, without browser chrome.
2. With no network: the app starts, a stored PDF opens and renders, and new ink
   is saved.
3. `navigator.storage.persist()` is called on launch, and the library header
   says whether storage is protected. Safari clears a site's storage after
   7 days without a visit unless it is on the Home Screen — the note says so
   when the library is at risk.

### Step 2 — Feel upgrades — *not started*

- **4.2a Gestures.** Two-finger tap = undo, three-finger tap = redo. Needs a
  redo stack; there is none yet. *Accept:* a tap is distinguished from a
  two-finger scroll or pinch; redo is cleared by any new edit; both survive a
  document switch.
- **4.2b Lasso.** Circle strokes, then move, resize, recolor, copy, or delete
  them. Keep "level" available on a selection. *Accept:* each action is one
  undo step and survives reload and export; the lasso selects what it encloses
  and nothing else.
- **4.2c Hold-to-snap.** If the pen rests about 500ms at the end of a stroke,
  run `recognize()` and replace the stroke with the clean shape. Remove the
  *Snap shapes* toggle once this works. *Accept:* never fires on a stroke
  ended without a pause; undo restores the freehand stroke.
- **4.2d Scratch-out.** A fast back-and-forth scribble deletes the strokes
  under it. *Accept:* fires on a deliberate scribble; **does not fire on any
  stroke of a handwriting-like test set**; one undo step restores everything.
- **4.2e Zoom writing box.** A magnified strip at the bottom of the screen;
  ink written large lands small at a chosen spot on the page. *Accept:* ink
  lands within a pixel of where the target box says it will; strokes are
  stored in normalized page coordinates like any other.

### Step 3 — Document handling — *not started*

- **4.3a** Page thumbnail sidebar with tap-to-jump.
- **4.3b** Render only pages near the viewport, so a 200-page PDF opens quickly.
- **4.3c** Blank pages and paper templates (lined, grid, dotted), insertable
  between PDF pages or as standalone notebooks.
- **4.3d** Extra margin space beside PDF pages for notes.
- **4.3e** Text boxes for typed notes.
- **4.3f** Search the PDF's text via the pdf.js text layer; highlighter snaps
  to text lines.
- **4.3g** Backup export and import: one file with all documents and notes.

Acceptance criteria to be written when Step 3 starts. 4.3c–4.3e change what a
page is and what an annotation is, so they need the storage schema settled
first.

### Step 4 — Later — *do not start without asking*

- Audio recording synced to ink: tap a stroke to hear what was being said when
  it was written. Points already store timestamps.
- Predicted ink with `getPredictedEvents()` where the browser supports it.

---

## Build order

Aim 3a → 3b → 3c → 1a → 1b → 1c → 2a → 2b → 2c → 4.1 → 4.2 → 4.3

Aim 3 comes first even though it is listed third: the library is the difference
between a demo and something usable daily, and the storage schema is easier to
get right before more stroke types exist.

Aim 4 stops after each step for testing on the iPad.

---

## Testing

- `tests/cleanup.test.mjs` — pure functions against synthetic ink. Run with
  `node --test`. Every algorithm in `cleanup.js` needs a test asserting a
  **measured property** (jitter reduced by X%, point count bounded, shape
  preserved within Y%), not just that it returns something.
- Storage tests use `fake-indexeddb` as a dev dependency.
- Every bug fixed gets a regression test.
- Manual checklist before each release: stylus on tablet, finger rejection,
  200-stroke page performance, export fidelity, reload persistence.

---

## Repository layout

```
index.html              markup, CDN scripts
manifest.json  sw.js    installable, offline             (Aim 4.1d)
icons/                  Home Screen icons
build.js                bundles to dist/margin.html (no server needed)
styles/app.css          tokens and layout
src/
  main.js               controller: rendering, tools, undo, wiring
  ink.js                stroke capture, width model, hit testing
  cleanup.js            smoothing, shape recognition, levelling
  store.js              IndexedDB: notes, docs, thumbs
  export.js             pdf-lib stamping
  library.js            document library            (Aim 3)
  tools/
    pencil.js           grain rendering             (Aim 1a)
    shapes.js           drag-to-place shapes        (Aim 1b)
tests/
  cleanup.test.mjs
  store.test.mjs
SPEC.md  README.md  package.json  LICENSE  .gitignore
```

---

## Notes carried from the current build

Things already learned the hard way. Do not re-derive them.

- **Stroke width must adapt to hardware.** Many styluses report no usable
  pressure — a constant 0.5 is the spec default for "no sensor". `ink.js`
  detects a real pressure range at runtime and falls back to velocity-based
  width, with the speed curve calibrated from the 85th percentile of the user's
  own strokes.
- **`getCoalescedEvents()` is required.** Browsers deliver pointermove at frame
  rate while the digitizer samples far faster. Without the coalesced points,
  fast strokes render as visible straight segments.
- **Smoothing is three passes, not one.** Simplification alone makes handwriting
  polygonal; Chaikin alone barely touches jitter and quadruples the point count.
  The moving-average pass between them does the actual work.
- **Shape recognition needs two independent tests.** Mean perpendicular
  deviation is not enough — a sine wave averages out straight. The
  chord-to-path-length ratio catches strokes that wander.
- **Do not re-group strokes the user already selected.** Levelling a selection
  uses `asOneLine: true`; automatic grouping is only for whole-page operations.
- Browser ink latency is roughly 30–60ms against about 9ms native. That gap
  cannot be closed in a browser — do not spend time trying.
