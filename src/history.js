/**
 * history.js — undo and redo for one document.
 *
 * A step is a page id and that page's strokes as they were, and
 * sometimes the document's layout as it was (a blank page added or
 * removed, the margin turned on). Undo swaps the current state with
 * the step's, and the step moves to the other stack — so redo is undo
 * run the other way.
 *
 * `doc` is anything with { strokes, layout }: in practice, a view.
 */

const copyOf = (value) => JSON.parse(JSON.stringify(value));

export function createHistory(limit = 60) {
  const undos = [];
  const redos = [];
  let shelved = []; // redo steps cleared by the latest record(), in case it is discarded

  const capture = (doc, page, withLayout) => {
    const step = {};
    if (page != null) { step.page = page; step.before = copyOf(doc.strokes[page] ?? []); }
    if (withLayout) step.layout = copyOf(doc.layout);
    return step;
  };

  function swap(from, to, doc) {
    const step = from.pop();
    if (!step) return null;
    to.push(capture(doc, step.page, 'layout' in step));
    if ('page' in step) doc.strokes[step.page] = step.before;
    if ('layout' in step) doc.layout = step.layout;
    return { page: step.page ?? null, layout: 'layout' in step };
  }

  return {
    get canUndo() { return undos.length > 0; },
    get canRedo() { return redos.length > 0; },

    /**
     * Call before changing a page's strokes, the layout, or both.
     * Any new edit forgets what could be redone.
     */
    record(doc, page, { layout = false } = {}) {
      undos.push(capture(doc, page, layout));
      if (undos.length > limit) undos.shift();
      shelved = redos.splice(0);
    },

    /** The edit just recorded came to nothing (a tap that left no ink). */
    discard() {
      undos.pop();
      redos.push(...shelved);
      shelved = [];
    },

    /** Both return { page, layout } saying what changed, or null if there was nothing to do. */
    undo: (doc) => swap(undos, redos, doc),
    redo: (doc) => swap(redos, undos, doc),
  };
}
