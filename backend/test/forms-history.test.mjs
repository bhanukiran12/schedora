// Form builder undo/redo and keyboard shortcuts (frontend/js/forms-history.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, isTextEntry, shortcutAction, shortcutList } from '../../frontend/js/forms-history.mjs';

const draft = fields => JSON.stringify({ title: 'T', fields, logic: [] });
const q = (id, label = id) => ({ id, type: 'short_text', label });

test('history: undo and redo step through whole-draft snapshots and keep where each change happened', () => {
  const history = createHistory();
  const a = draft([q('a')]);
  const b = draft([q('a'), q('b')]);
  const c = draft([q('a'), q('b'), q('c')]);
  history.reset(a);
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null, 'nothing to undo at the start');
  assert.equal(history.record(b, { question: 1 }), true);
  assert.equal(history.record(c, { question: 2 }), true);
  assert.equal(history.record(c, { question: 2 }), false, 'an unchanged draft is not a step');
  assert.deepEqual(history.undo(), { json: b, selection: { question: 2 } });
  assert.deepEqual(history.undo(), { json: a, selection: { question: 1 } });
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), { json: b, selection: { question: 1 } });
  assert.deepEqual(history.redo(), { json: c, selection: { question: 2 } });
  assert.equal(history.redo(), null);
});

test('history: a new change after undo discards the redo branch', () => {
  const history = createHistory();
  history.reset(draft([]));
  history.record(draft([q('a')]), {});
  history.undo();
  assert.equal(history.canRedo, true);
  history.record(draft([q('x')]), {});
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
});

test('history: typing in one field within the window is one step; another field, a pause or a structural change starts a new one', () => {
  const history = createHistory({ coalesceMs: 1000 });
  const title = { id: 'title' };
  const other = { id: 'other' };
  history.reset(draft([q('a', '')]));
  history.record(draft([q('a', 'H')]), {}, { kind: 'text', target: title, now: 0 });
  history.record(draft([q('a', 'He')]), {}, { kind: 'text', target: title, now: 300 });
  history.record(draft([q('a', 'Hey')]), {}, { kind: 'text', target: title, now: 900 });
  assert.equal(JSON.parse(history.undo().json).fields[0].label, '', 'one undo removes the whole burst');
  history.redo();
  history.record(draft([q('a', 'Hey!')]), {}, { kind: 'text', target: title, now: 5000 });
  history.record(draft([q('a', 'Hey!'), q('b')]), {}, { kind: 'change', now: 5100 });
  history.record(draft([q('a', 'Hey!'), q('b', 'x')]), {}, { kind: 'text', target: other, now: 5200 });
  assert.equal(JSON.parse(history.undo().json).fields[1].label, 'b');
  assert.equal(JSON.parse(history.undo().json).fields.length, 1, 'the structural change was its own step');
  assert.equal(JSON.parse(history.undo().json).fields[0].label, 'Hey', 'the pause started a new step');
});

test('history: undo restores branching rules together with the questions they point to', () => {
  const history = createHistory();
  const withJump = JSON.stringify({ fields: [q('a'), q('b')], logic: [{ field: 'a', rules: [{ to: { type: 'field', id: 'b' } }] }] });
  // Removing the target question prunes the jump in the same change.
  const pruned = JSON.stringify({ fields: [q('a')], logic: [] });
  history.reset(withJump);
  history.record(pruned, { question: 1 });
  const restored = JSON.parse(history.undo().json);
  assert.deepEqual(restored.logic, [{ field: 'a', rules: [{ to: { type: 'field', id: 'b' } }] }]);
  assert.deepEqual(restored.fields.map(field => field.id), ['a', 'b']);
});

test('history: reset (after publishing or loading another version) forgets every step', () => {
  const history = createHistory();
  history.reset(draft([]));
  history.record(draft([q('a')]), {});
  history.record(draft([q('a'), q('b')]), {});
  history.undo();
  history.reset(draft([q('a')]));
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test('history: the oldest steps fall off past the limit', () => {
  const history = createHistory({ limit: 3 });
  history.reset(draft([]));
  for (let index = 1; index <= 5; index++) history.record(draft(Array.from({ length: index }, (_, n) => q('q' + n))), {});
  let steps = 0;
  while (history.undo()) steps++;
  assert.equal(steps, 3);
});

test('shortcuts: Control on Windows and Linux, Command on Mac', () => {
  const key = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(shortcutAction(key('z', { ctrlKey: true })), 'undo');
  assert.equal(shortcutAction(key('Z', { ctrlKey: true, shiftKey: true })), 'redo');
  assert.equal(shortcutAction(key('y', { ctrlKey: true })), 'redo');
  assert.equal(shortcutAction(key('d', { ctrlKey: true })), 'duplicate');
  assert.equal(shortcutAction(key('Enter', { ctrlKey: true })), 'add');
  assert.equal(shortcutAction(key('?', { shiftKey: true })), 'help');
  assert.equal(shortcutAction(key('z', { metaKey: true }), { mac: true }), 'undo');
  assert.equal(shortcutAction(key('z', { metaKey: true, shiftKey: true }), { mac: true }), 'redo');
  assert.equal(shortcutAction(key('d', { metaKey: true }), { mac: true }), 'duplicate');
  assert.equal(shortcutAction(key('y', { metaKey: true }), { mac: true }), null, '⌘Y is not redo on Mac');
  assert.equal(shortcutAction(key('d', { ctrlKey: true }), { mac: true }), null, 'Control+D keeps its text meaning on Mac');
  assert.equal(shortcutAction(key('z', { metaKey: true })), null, 'the Windows key is not a modifier here');
  assert.equal(shortcutAction(key('z', { ctrlKey: true, altKey: true })), null, 'AltGr combinations are left alone');
  assert.equal(shortcutAction(key('s', { ctrlKey: true })), null, 'unrelated shortcuts stay with the browser');
});

test('shortcuts: text fields keep their own undo and typed characters; dialogs and IME composition are left alone', () => {
  const key = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  const typing = { textEntry: true };
  assert.equal(shortcutAction(key('z', { ctrlKey: true }), typing), null);
  assert.equal(shortcutAction(key('z', { ctrlKey: true, shiftKey: true }), typing), null);
  assert.equal(shortcutAction(key('y', { ctrlKey: true }), typing), null);
  assert.equal(shortcutAction(key('?', { shiftKey: true }), typing), null);
  assert.equal(shortcutAction(key('d', { ctrlKey: true }), typing), 'duplicate', 'Ctrl+D has no text-editing meaning');
  assert.equal(shortcutAction(key('Enter', { ctrlKey: true }), typing), 'add');
  assert.equal(shortcutAction(key('z', { ctrlKey: true }), { dialogOpen: true }), null);
  assert.equal(shortcutAction(key('z', { ctrlKey: true, isComposing: true })), null);
  assert.equal(shortcutAction(key('d', { ctrlKey: true, repeat: true })), 'swallow', 'holding the key does not duplicate repeatedly or open the bookmark dialog');
});

test('text entry: text-like inputs, text areas and editable regions; not buttons, checkboxes or selects', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'email' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), false);
  assert.equal(isTextEntry(null), false);
});

test('shortcut list names the platform modifier', () => {
  assert.deepEqual(shortcutList(true)[0].keys, ['⌘', 'Z']);
  assert.deepEqual(shortcutList(false)[1].also, ['Ctrl', 'Y']);
  assert.equal(shortcutList(true)[1].also, null);
});
