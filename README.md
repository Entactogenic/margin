# Margin

A PDF annotation app for reading papers with a stylus. Runs entirely in the
browser — no account, no upload, no backend.

Built because every stylus reports different things, and most annotation
apps assume an Apple Pencil.

## Features

- **A library** — every PDF you open is kept in this browser with its notes
  and a thumbnail; reopen from the grid, sort, rename, delete
- **Switch documents** with `Ctrl/Cmd + [` and `]`; each remembers its own
  zoom and scroll position, and the last three stay rendered in memory
- **Notebooks and blank pages** — start a notebook with no PDF, or slip
  plain, lined, grid or dotted pages between a PDF's own
- **A margin** — extra writing space beside every page, for when the paper's
  own margins are not enough
- **Page thumbnails** — a sidebar of every page; tap one to jump there
- **Search** — find text in the PDF and step through the matches
- **Typed notes** — tap with the Text tool and type; exported as real text
- **Backup** — the whole library, notes and all, as one file you can restore
- **Write on any PDF** with pen, grainy pencil, highlighter, and an eraser that
  removes whole strokes or just the part you rub out; a highlighter sweep
  along a line of text snaps to cover that line exactly
- **Place shapes** — box, ellipse, line, arrow; hold Shift for a square, a
  circle, or 45° steps
- **Adaptive stroke width** — uses pressure if the hardware reports a real
  range, otherwise derives width from pen speed, calibrated to how you write
- **Tidy page** — smooths shaky handwriting without flattening its character,
  shown as a preview over the original before anything changes
- **Level** — rotates sloping lines of handwriting onto a level baseline
- **Even size / even spacing** — pulls drifting letter heights and ragged
  gaps back toward the line's own average
- **Hold to snap** — pause at the end of a circle, box or line and it becomes
  clean geometry
- **Lasso** — circle some ink, then move, resize, recolor, copy, level or
  delete it
- **Scratch out** — scribble quickly over ink to delete it
- **Zoom box** — write large in a strip at the bottom; the ink lands small
  where the frame sits on the page
- **Undo and redo** — buttons, keys, or tap with two fingers to undo and
  three to redo
- **Stylus-only mode** — the pen draws, fingers scroll and pinch, palms are
  ignored; turns itself on the first time a stylus touches the page
- **Installable and offline** — add it to the Home Screen and it opens
  full-screen and works with no connection
- **Export** — stamps your annotations into a real PDF that opens anywhere
- **Automatic save** to IndexedDB, keyed by filename and size; each tool
  remembers its own colour and width

## Specification

See [SPEC.md](SPEC.md) for the goal, aims, and acceptance criteria.

## Running it

ES modules need to be served over HTTP; opening `index.html` from the
filesystem will not work.

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

In VS Code, the **Live Server** extension does the same thing with one click.

Or build one self-contained file that opens without a server:

```bash
node build.js        # -> dist/margin.html
```

## Tests

```bash
npm install          # fake-indexeddb, for the storage tests
npm test             # node --test
```

### Using it on a tablet

Serve it from a machine on the same network and open the LAN address on the
tablet, or deploy to GitHub Pages (below) and open it from anywhere.

**Install it.** In Safari: Share → *Add to Home Screen*. It then opens
full-screen and works offline. This matters for more than convenience: Safari
deletes a website's storage after 7 days without a visit, and a Home Screen
app is exempt. The library header shows whether your storage is protected.

Installing and offline use need HTTPS (GitHub Pages is fine) or `localhost`.
A plain `http://192.168.x.x` LAN address will run the app but cannot install
a service worker.

## Deploying to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/margin.git
git push -u origin main
```

Then in the repository: **Settings → Pages → Source: deploy from branch
`main`, folder `/`**. The app appears at
`https://<you>.github.io/margin/` within a minute or two.

No build step — it is static files and two CDN scripts.

## How cleanup works

All four passes are classical geometry. Nothing is uploaded and no model
runs; everything works offline.

| Pass | What it does | Algorithm |
|---|---|---|
| `smooth` | removes sensor jitter and rounds corners | Ramer–Douglas–Peucker, then Chaikin subdivision |
| `recognize` | identifies intended shapes | closure test, then residual scoring against line / ellipse / rectangle |
| `straighten` | levels sloping handwriting | group strokes into lines by vertical overlap, least-squares baseline fit, rotate |
| `tidyPage` | all of the above over one page | — |

**Smoothing** runs lightly on every stroke as you draw (strength 0.35) and
harder when you press *Tidy page* (strength 0.7). The two-stage design is
deliberate: simplification alone makes handwriting look polygonal, and
smoothing alone leaves the jitter in.

**Shape recognition** is deliberately conservative — it returns `null` for
anything it is not confident about. Replacing handwriting with a shape the
user did not intend is far worse than leaving a scribble alone. It only runs
when asked: rest the pen for half a second at the end of a stroke.

**Levelling** caps its correction at 12°. A larger angle usually means the
line grouping was wrong, and silently rotating someone's notes is worse than
leaving them crooked.

## Architecture

```
index.html          markup and CDN scripts
styles/app.css      tokens and layout
src/
  main.js           controller: rendering, tools, undo, wiring
  ink.js            stroke capture, width model, hit testing
  cleanup.js        smoothing, shape recognition, levelling, size and spacing
  store.js          IndexedDB: notes, docs, bytes, thumbs
  export.js         pdf-lib stamping
  library.js        library grid, sorting, the cache of open documents
  history.js        undo and redo
  gestures.js       multi-finger taps, resting-pen detection
  pages.js          page layout: blank pages, margin, paper rulings
  search.js         text search, snapping the highlighter to text lines
  backup.js         the whole library as one file
  tools/
    pencil.js       grain tile and pencil rendering
    shapes.js       drag-to-place shapes
    prefs.js        per-tool settings in localStorage
    lasso.js        selecting strokes and transforming them
    scratch.js      telling a scratch-out from handwriting
    zoombox.js      zoom writing box geometry
    text.js         typed notes
tests/              node --test; storage tests use fake-indexeddb
```

**Only pages near the viewport are rendered.** Every page has a placeholder
of the right size; canvases come and go as it scrolls, so a 200-page PDF
opens as fast as a 2-page one.

**Strokes are stored in normalized page coordinates (0–1).** Zoom, resize
and export all read the same data without refitting anything. Point widths
are computed once at capture and stored on the point, so recalibrating the
speed curve never retroactively changes ink already drawn.

## Known limitations

- Typed notes export in the PDF's built-in Helvetica, which only covers
  Western European characters. Others show on screen but export as "?".
- A backup is assembled in memory, so it needs about as much free memory as
  the library is large.
- Export draws each stroke segment as a separate line. Faithful, but the
  file is larger than it needs to be; emitting real Bézier paths would fix it.
- Pencil exports as lighter, semi-transparent ink. The grain is a screen
  texture and has no vector equivalent.
- Browser ink latency is roughly 30–60 ms against about 9 ms for a native
  iPad app. That gap cannot be fully closed in a browser.
- No handwriting-to-text conversion. That needs a model, not geometry —
  see below.

## Possible next steps

- **Handwriting → text.** Genuinely hard offline. Practical routes are
  MyScript's iink SDK (commercial, excellent), or sending a rasterized
  selection to a vision model.
- **Text search across notes** once handwriting recognition exists.
- **Per-stroke timestamps for replay** — the data is already captured.

## Licence

MIT
