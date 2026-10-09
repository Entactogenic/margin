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
- Audio recording of any kind, including audio synced to ink (tap a stroke to
  hear what was said as it was written). Considered for Aim 4 and dropped; do
  not propose it again. The per-point timestamps in stroke data stay — they
  are not there for audio, and other features may use them.
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

**Status: Steps 1 and 2 done and confirmed on the iPad. Step 3 built, awaiting
iPad testing. Step 4 not started — ask first.**

Make Margin feel like Notability or GoodNotes on an iPad: the pen draws, fingers
scroll and pinch, and nothing lags or loses work.

Built in four steps. **Stop after each step for testing on the iPad; do not
start the next until the author confirms.** Every feature must survive save,
reload, undo, and export, and every new pure function needs a test asserting
measured behaviour.

An installable web app (4.1d) is not the "native iOS or Android app" ruled out
under Non-goals: it is the same static site, added to the Home Screen.

### Step 1 — Fix what feels broken — *done, confirmed on the iPad*

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

### Step 2 — Feel upgrades — *done, confirmed on the iPad*

#### 4.2a Undo and redo gestures

`src/history.js` holds each document's undo and redo stacks.
`createTapDetector()` in `src/gestures.js` recognises the taps.

1. Two fingers tapped together undo; three redo. A toast says which.
2. A two-finger scroll, a pinch, fingers held down, and fingers that land one
   after another are not taps.
3. With stylus-only off, the finger that lands first has started a stroke; when
   the second lands that stroke is taken back, so the tap leaves no ink.
4. Any new edit clears redo. A pen tap that leaves no ink does not.
5. Redo is also on a toolbar button, `Ctrl/Cmd+Shift+Z`, and `Ctrl/Cmd+Y`.

#### 4.2b Lasso

Replaces the old rectangle *Select* tool. Geometry is in `src/tools/lasso.js`.

1. A loop selects the strokes that are at least three-quarters inside it; a
   stroke the loop merely cuts across is not taken.
2. Drag the selection to move it; drag the corner handle to resize it about the
   opposite corner. Resizing keeps proportions and scales ink weight with it.
3. The bar offers recolor, level, copy and delete. Highlighter colours apply
   only to highlighter strokes, ink colours only to ink.
4. Every action is exactly one undo step, and survives reload and export.
5. A selection never leaves the page. `Esc` or *Done* drops it; `Del` deletes.

#### 4.2c Hold-to-snap

The *Snap shapes* toggle is gone. `heldStill()` in `src/gestures.js` decides.

1. Resting the pen about 500ms at the end of a stroke replaces it with the
   shape `recognize()` finds, if it finds one.
2. A stroke that ends without a pause is never snapped; nor is one that
   `recognize()` does not recognise, however long the pen rests.
3. The freehand stroke is its own undo step: one undo gives it back, a second
   removes it.

#### 4.2d Scratch-out

`src/tools/scratch.js`. A stroke is a scratch-out when, projected onto its own
long axis, it reverses at least four times, quickly, and is not a ring (a word
circled several times). It then deletes the strokes lying mostly under it.

1. Fires on a deliberate scribble at any angle, including one made of thin loops.
2. **Never fires on any stroke in the handwriting-like set in
   `tests/feel.test.mjs`**, at any writing speed. Add to that set whenever a
   false positive is found on a real device.
3. A scribble over empty paper, or a slow careful zigzag, stays as ink.
4. Strokes that only pass through the scribbled area — a long underline, the
   border of a shaded box — are left alone.
5. One undo restores everything, and the toast says so.

#### 4.2e Zoom writing box

`src/tools/zoombox.js` for the geometry. The strip is a second input surface
for the same page: `attachInput()` takes a mapping from strip to page, and
everything after that is the ordinary stroke path.

1. Ink written in the strip lands within a pixel of where the frame on the
   page says it will, and is stored as an ordinary stroke.
2. The strip magnifies 2.5x without stretching, and ink in it is drawn from
   stroke data, so it stays sharp.
3. Ink weight is judged by how fast the hand moved, not how fast the ink
   crossed the page — writing large does not produce fat strokes.
4. The frame can be dragged by its tab. Arrows step it left and right, with
   overlap; writing up to the right edge and pausing steps it along; stepping
   off the right edge, or the return arrow, starts the next line.
5. Undo, the eraser, shapes and scratch-out all work in the strip. The box
   survives a zoom or rotation and closes when the document changes.

### Step 3 — Document handling — *built, awaiting iPad testing*

#### The page model

Step 3 changes what a page is, so the model comes first. It is in
`src/pages.js`, and nothing already stored had to change shape.

- A document has a **layout**, `{ order, blanks, margin }`, kept in its `docs`
  record. `order` lists page ids top to bottom.
- A PDF page's id is its page number; a blank page's id is a string (`'b1'`).
  Strokes are stored per page id, so a PDF page's notes stay under its page
  number exactly as before, and **inserting a blank page renumbers nothing**.
- Coordinates stay normalized to the page itself. With a margin, x runs past 1:
  ink in the margin is ink at x = 1.2. Nothing is rescaled when the margin is
  turned on or off.
- A typed note is an item in the page's stroke list, `{ k: 'text', w, text,
  pts }`, where `w` is the font size and `pts` the outline of its box. Having
  points and a width, it is erased, lassoed, moved, resized, undone and saved
  by the code that already does those things for ink.
- A notebook is a document with no PDF: zero bytes, and a layout of blank pages.
- `repairLayout()` makes any stored layout safe to render. Call it on load.

#### 4.3a Page thumbnail sidebar

1. Lists every page, in order, and marks the one on screen.
2. Tapping a thumbnail jumps to that page.
3. Paints only the thumbnails in view; a page's thumbnail picks up new ink.

#### 4.3b Render only pages near the viewport

Every page gets a correctly sized placeholder at once; an
`IntersectionObserver` gives canvases to the pages within a screen and a half
of the viewport and takes them away again. Pages are assumed to match the
first until each is measured.

1. A 200-page PDF shows its first page in well under two seconds.
2. Paging through the whole document never holds more than a handful of
   canvases.
3. Ink on a page that was released is there when it comes back.
4. Scroll position, search hits and the thumbnail sidebar do not depend on a
   page being mounted.

#### 4.3c Blank pages, paper templates, notebooks

1. *+ Page* inserts a blank page after the one on screen: plain, lined, grid
   or dotted. PDF pages keep their numbers and their notes.
2. Rulings are crisp on screen and are drawn into the exported PDF from the
   same geometry (`paperMarks()`).
3. Only blank pages can be deleted; a document always keeps one page.
   Deleting takes the page's ink with it, and one undo restores both.
4. Inserting and deleting pages undo and redo like any other edit.
5. *New notebook* in the library makes a document of blank pages with no PDF.
   It saves, reopens, gets a thumbnail, and exports as a PDF.

#### 4.3d Margin

1. *Margin* adds 40% of the page's width as writing space to the right of
   every page in the document.
2. Ink there is stored past x = 1; ink on the page keeps its coordinates.
3. The lasso and the zoom box can reach into the margin, and no further.
4. Export widens every page by the margin.
5. Turning the margin off hides the notes in it without deleting them, and
   says so. It is an undoable edit.

#### 4.3e Text boxes

1. With the *Text* tool, a tap opens a box to type in; tapping away commits
   it; `Esc` abandons it. Tapping an existing note edits it.
2. Committing is one undo step. Emptying a note deletes it.
3. A note wraps to its box, and the box is as tall as the wrapped text.
4. It can be erased, lassoed, moved, resized (the font scales) and recoloured.
5. Export sets it as real, selectable text. **Limit:** the exported PDF uses
   the built-in Helvetica, which covers Western European characters only;
   anything else is exported as "?". On screen all characters display.

#### 4.3f Search, and the highlighter on text

`src/search.js`. Text comes from the pdf.js text layer.

1. Search finds every match in the document, page by page, showing hits as
   they are found; `Enter` and the arrows step through them and scroll to
   each. `Ctrl/Cmd+F` focuses the box; `Esc` clears it.
2. Matching ignores case and all whitespace, so a phrase is found even where
   the PDF split it across text runs, dropped its spaces, or broke a word at
   a line end.
3. A highlighter stroke drawn along a line of PDF text becomes a flat band
   over exactly that line, keeping the extent that was swept.
4. A highlighter stroke anywhere else — over a figure, down the page, on a
   blank page — is left as drawn.

#### 4.3g Backup and restore

`src/backup.js`. One file, a small binary container (not JSON: the PDFs are
most of it).

1. *Back up* in the library saves every document, its layout, notes and
   thumbnail as one file. *Restore* reads it back, byte for byte.
2. Restoring never overwrites silently: documents not yet in the library are
   added; if some are already there, it asks whether to replace them or keep
   what is here.
3. A file that is not a backup, or is cut short, is refused and nothing
   changes.
4. **Limit:** a backup is built in memory, so it needs roughly the library's
   size in free memory. Fine for hundreds of megabytes; not tested beyond.

### Step 4 — Later — *do not start without asking*

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
  pages.js              page layout: blank pages, margin, paper    (Aim 4.3)
  search.js             text search, highlighter snapping          (Aim 4.3f)
  backup.js             whole-library backup file                  (Aim 4.3g)
  history.js            undo and redo                              (Aim 4.2a)
  gestures.js           taps, resting pen                          (Aim 4.2)
  tools/
    pencil.js           grain rendering             (Aim 1a)
    shapes.js           drag-to-place shapes        (Aim 1b)
    lasso.js  scratch.js  zoombox.js                (Aim 4.2)
    text.js             typed notes                 (Aim 4.3e)
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
