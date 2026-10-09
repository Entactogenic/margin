/**
 * pencil.js — grain rendering for the pencil tool.
 *
 * A pencil is a pen whose ink is a texture: the stroke is painted with
 * a repeating tile of random-alpha noise, so paper shows through it.
 * The tile is generated once per colour and reused for every stroke —
 * stamping dabs per point is slow and bands visibly.
 */

const GRAIN_SIZE = 64;
const ALPHA_LEVELS = 6;
const grainTiles = new Map();        // colour -> tile canvas
const grainPatterns = new WeakMap(); // context -> Map(colour -> CanvasPattern)

/** How many tiles have been generated this session. Tests assert on it. */
export const grainStats = { generated: 0 };

function domCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function grainRgb(color) {
  const h = String(color).replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return [60, 60, 60];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The noise tile for a colour, generated at most once per session. */
export function grainTile(color, makeCanvas = domCanvas) {
  let tile = grainTiles.get(color);
  if (tile) return tile;

  tile = makeCanvas(GRAIN_SIZE);
  const g = tile.getContext('2d');
  const img = g.createImageData(GRAIN_SIZE, GRAIN_SIZE);
  const [r, gr, b] = grainRgb(color);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = gr;
    img.data[i + 2] = b;
    // about one pixel in five is bare paper; the rest vary in density
    img.data[i + 3] = Math.random() < 0.2 ? 0 : Math.round(255 * (0.3 + 0.7 * Math.random()));
  }
  g.putImageData(img, 0, 0);

  grainStats.generated++;
  grainTiles.set(color, tile);
  return tile;
}

function grainPattern(ctx, color) {
  let byColor = grainPatterns.get(ctx);
  if (!byColor) grainPatterns.set(ctx, (byColor = new Map()));
  let pattern = byColor.get(color);
  if (!pattern) byColor.set(color, (pattern = ctx.createPattern(grainTile(color), 'repeat')));
  return pattern;
}

/**
 * Opacity for one pencil point, baked in at capture like width is.
 * Linear in speed, where the pen's width curve is a smoothstep: a
 * pencil lightens as soon as the hand speeds up, not only when it races.
 */
export function pencilAlpha(pt, prev, fastSpeed) {
  if (!prev) return 0.9;
  const dt = Math.max(pt.t - prev.t, 1);
  const v = Math.hypot(pt.x - prev.x, pt.y - prev.y) / dt;
  const k = Math.min(1, Math.max(0, v / (fastSpeed * 1.2)));
  return 0.95 - 0.6 * k;
}

const alphaLevel = (p) => Math.max(1, Math.round((p.a ?? 0.8) * ALPHA_LEVELS));

/**
 * Paint one pencil stroke onto a context sized to w x h CSS pixels.
 *
 * Runs of similar opacity are drawn as one path. Drawing each segment
 * separately, as the pen does, would overlap the round caps at every
 * joint — invisible in opaque ink, a string of dark beads in pencil.
 */
export function paintPencil(ctx, stroke, w, h, color) {
  const pts = stroke.pts;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = grainPattern(ctx, color);

  let i = 1;
  while (i < pts.length) {
    const level = alphaLevel(pts[i]);
    let j = i, widths = 0;
    while (j < pts.length && alphaLevel(pts[j]) === level) {
      widths += pts[j].w ?? stroke.w;
      j++;
    }

    ctx.globalAlpha = level / ALPHA_LEVELS;
    ctx.lineWidth = (widths / (j - i)) * w;
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x * w, pts[i - 1].y * h);
    for (let k = i; k < j; k++) {
      const a = pts[k - 1], b = pts[k];
      ctx.quadraticCurveTo(a.x * w, a.y * h, ((a.x + b.x) / 2) * w, ((a.y + b.y) / 2) * h);
    }
    ctx.lineTo(pts[j - 1].x * w, pts[j - 1].y * h);
    ctx.stroke();
    i = j;
  }
  ctx.restore();
}
