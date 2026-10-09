/**
 * prefs.js — the selected tool and each tool's own colour and width.
 *
 * Kept in localStorage as a convenience, never as something the app
 * depends on: reading or writing can throw (private window, blocked
 * site data), so both are wrapped and fall back to the defaults.
 */

const PREFS_KEY = 'margin.tools.v1';

export const PEN_COLORS = ['--pen-1', '--pen-2', '--pen-3', '--pen-4'];
export const HI_COLORS = ['--hi-1', '--hi-2', '--hi-3'];

/** Which swatches each ink tool offers. Tools not listed here have no ink. */
export const PALETTES = {
  pen: PEN_COLORS,
  pencil: PEN_COLORS,
  highlight: HI_COLORS,
  shape: PEN_COLORS,
};

export const TOOLS = ['pen', 'pencil', 'highlight', 'shape', 'erase', 'select'];
export const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
const ERASERS = ['stroke', 'area'];
export const WEIGHT_MIN = 0.55, WEIGHT_MAX = 1.9;

export function defaultPrefs() {
  return {
    tool: 'pen',
    shape: 'rect',
    eraser: 'stroke',
    ink: {
      pen: { c: '--pen-1', w: 1 },
      pencil: { c: '--pen-4', w: 1 },
      highlight: { c: '--hi-1', w: 1 },
      shape: { c: '--pen-2', w: 1 },
    },
  };
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** Defaults overlaid with whatever valid settings were saved. */
export function loadPrefs(getStorage) {
  const prefs = defaultPrefs();
  try {
    const saved = JSON.parse(getStorage().getItem(PREFS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return prefs;

    prefs.tool = pick(saved.tool, TOOLS, prefs.tool);
    prefs.shape = pick(saved.shape, SHAPES, prefs.shape);
    prefs.eraser = pick(saved.eraser, ERASERS, prefs.eraser);
    for (const [tool, ink] of Object.entries(prefs.ink)) {
      const s = saved.ink?.[tool];
      if (!s) continue;
      ink.c = pick(s.c, PALETTES[tool], ink.c);
      if (Number.isFinite(s.w)) ink.w = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, s.w));
    }
  } catch {
    return defaultPrefs();
  }
  return prefs;
}

export function savePrefs(getStorage, prefs) {
  try {
    getStorage().setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
