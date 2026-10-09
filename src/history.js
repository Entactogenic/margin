/**
 * history.js — undo and redo for one document.
 *
 * A step is a page number and that page's strokes as they were. Undo
 * swaps the page's current strokes with the step's, and the step moves
 * to the other stack — so redo is undo run the other way.
 */

const copyStrokes = (list) => JSON.parse(JSON.stringify(list ?? []));

export function createHistory(limit = 60) {
  const undos = [];
  const redos = [];
  let shelved = []; // redo steps cleared by the latest record(), in case it is discarded

  function swap(from, to, strokes) {
    const step = from.pop();
    if (!step) return null;
    to.push({ page: step.page, before: copyStrokes(strokes[step.page]) });
    strokes[step.page] = step.before;
    return step.page;
  }

  return {
    get canUndo() { return undos.length > 0; },
    get canRedo() { return redos.length > 0; },

    /** Call before changing a page. Any new edit forgets what could be redone. */
    record(strokes, page) {
      undos.push({ page, before: copyStrokes(strokes[page]) });
      if (undos.length > limit) undos.shift();
      shelved = redos.splice(0);
    },

    /** The edit just recorded came to nothing (a tap that left no ink). */
    discard() {
      undos.pop();
      redos.push(...shelved);
      shelved = [];
    },

    /** Both return the page that changed, or null if there was nothing to do. */
    undo: (strokes) => swap(undos, redos, strokes),
    redo: (strokes) => swap(redos, undos, strokes),
  };
}
