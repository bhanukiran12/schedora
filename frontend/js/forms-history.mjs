// Undo and redo for the form builder, and its keyboard shortcuts. Plain data and functions, so the
// rules are tested without a browser (backend/test/forms-history.test.mjs).
//
// History holds whole-draft snapshots as JSON strings. Every change to the draft (questions, pages,
// options, logic, endings, settings kept in the draft, theme) is one step, so undoing a change also
// restores the branching rules that went with it. Consecutive typing in the same control within
// `coalesceMs` is one step, like a word processor. Saving does not clear history; publishing and
// loading someone else's version do (the builder calls reset()), so undo never brings back a state
// that a published version has since locked.

export function createHistory({ limit = 100, coalesceMs = 1000 } = {}) {
  let current = null; // { json } — the draft as last recorded
  let undo = [];      // [{ json: before, selection }]
  let redo = [];      // [{ json: after, selection }]
  let last = null;    // { kind, target, time } of the last recorded change, for coalescing
  return {
    reset(json) { current = { json }; undo = []; redo = []; last = null; },
    /** Records the draft after a change. Returns false when nothing changed. */
    record(json, selection, { kind = 'change', target = null, now = Date.now() } = {}) {
      if (!current) { current = { json }; return false; }
      if (json === current.json) return false;
      const merge = undo.length && !redo.length && last && kind !== 'change' && last.kind === kind
        && last.target === target && now - last.time < coalesceMs;
      if (merge) undo.at(-1).selection = selection;
      else {
        undo.push({ json: current.json, selection });
        if (undo.length > limit) undo.shift();
      }
      redo = [];
      current = { json };
      last = { kind, target, time: now };
      return true;
    },
    /** Steps back. Returns { json, selection } to apply, or null when there is nothing to undo. */
    undo() {
      const entry = undo.pop();
      if (!entry) return null;
      redo.push({ json: current.json, selection: entry.selection });
      current = { json: entry.json };
      last = null;
      return entry;
    },
    redo() {
      const entry = redo.pop();
      if (!entry) return null;
      undo.push({ json: current.json, selection: entry.selection });
      current = { json: entry.json };
      last = null;
      return entry;
    },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; }
  };
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image', 'hidden']);

/** True when the element edits text, so the browser's own undo and typed characters belong to it. */
export function isTextEntry(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has(String(element.type || 'text').toLowerCase());
}

/**
 * The builder action for a key press, or null to leave it to the browser.
 * `mac` selects ⌘ as the modifier (Control keeps its text-editing meaning there, e.g. Control+D
 * deletes forward); elsewhere Control is the modifier. Inside a text field, undo and redo stay with
 * the field and `?` is typed; duplicate and add have no text-editing meaning, so they still work.
 */
export function shortcutAction(event, { mac = false, textEntry = false, dialogOpen = false } = {}) {
  if (!event || event.isComposing || dialogOpen) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = String(event.key || '');
  if (mod && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === 'z') return textEntry ? null : event.shiftKey ? 'redo' : 'undo';
    if (lower === 'y' && !mac && !event.shiftKey) return textEntry ? null : 'redo';
    if (lower === 'd' && !event.shiftKey) return event.repeat ? 'swallow' : 'duplicate';
    if (key === 'Enter' && !event.shiftKey) return event.repeat ? 'swallow' : 'add';
    return null;
  }
  if (key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !textEntry) return 'help';
  return null;
}

export const isMacPlatform = (nav = globalThis.navigator) => /Mac|iPhone|iPad|iPod/i.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '');

/** The shortcut list shown in the builder, with the platform's modifier names. */
export function shortcutList(mac) {
  const mod = mac ? '⌘' : 'Ctrl';
  const shift = mac ? '⇧' : 'Shift';
  return [
    { keys: [mod, 'Z'], label: 'Undo the last change to the form' },
    { keys: [mod, shift, 'Z'], label: 'Redo', also: mac ? null : ['Ctrl', 'Y'] },
    { keys: [mod, 'D'], label: 'Duplicate the selected question or page' },
    { keys: [mod, 'Enter'], label: 'Add a question after the selected one' },
    { keys: ['?'], label: 'Show these shortcuts' }
  ];
}
