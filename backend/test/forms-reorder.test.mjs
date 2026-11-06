// Moving questions in the Forms builder: the same result from the ↑/↓ buttons and from drag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitionProblems } from '../src/shared/forms-logic.mjs';
import { dropSlot, moveField, moveMessage, slotToIndex } from '../../frontend/js/forms-reorder.mjs';

const fields = () => [
  { id: 'name', type: 'short_text', label: 'Your name', required: true },
  { id: 'topic', type: 'single_choice', label: 'Topic', required: false, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { id: 'details', type: 'long_text', label: 'Details', required: false, show_if: { field: 'topic', op: 'equals', value: 'b' } },
  { id: 'phone', type: 'phone', label: 'Phone', required: false }
];
const order = list => list.map(field => field.id);
const definition = list => ({ title: 'Intake', description: '', presentation: 'classic', submit_label: 'Send', fields: list });

test('a move keeps every question and shifts the ones between', () => {
  const list = fields();
  assert.deepEqual(moveField(list, 0, 3), []);
  assert.deepEqual(order(list), ['topic', 'details', 'phone', 'name']);
  assert.deepEqual(moveField(list, 3, 1), []);
  assert.deepEqual(order(list), ['topic', 'name', 'details', 'phone']);
  assert.equal(list.find(field => field.id === 'details').show_if.field, 'topic');
});

test('a rule that would point at a later question is removed and reported; the question stays', () => {
  const list = fields();
  const dropped = moveField(list, 2, 0);
  assert.deepEqual(order(dropped), ['details']);
  assert.deepEqual(order(list), ['details', 'name', 'topic', 'phone']);
  assert.equal(list[0].show_if, undefined);
  assert.deepEqual(definitionProblems(definition(list)), []);

  const other = fields();
  assert.deepEqual(order(moveField(other, 1, 3)), ['details']);
  assert.deepEqual(order(other), ['name', 'details', 'phone', 'topic']);
  assert.deepEqual(definitionProblems(definition(other)), []);
});

test('a rule still pointing at an earlier question survives, including across a page break', () => {
  const list = [...fields().slice(0, 2), { id: 'page', type: 'page_break' }, ...fields().slice(2)];
  assert.deepEqual(moveField(list, 3, 4), []);
  assert.deepEqual(order(list), ['name', 'topic', 'page', 'phone', 'details']);
  assert.equal(list[4].show_if.field, 'topic');
});

test('adjacent moves match the swap the ↑/↓ buttons have always made', () => {
  const list = fields();
  moveField(list, 0, 1);
  assert.deepEqual(order(list), ['topic', 'name', 'details', 'phone']);
  moveField(list, 1, 0);
  assert.deepEqual(order(list), ['name', 'topic', 'details', 'phone']);
});

test('the drop gap follows the middle of each row', () => {
  const middles = [10, 30, 50];
  assert.equal(dropSlot(middles, 0), 0);
  assert.equal(dropSlot(middles, 10), 0);
  assert.equal(dropSlot(middles, 11), 1);
  assert.equal(dropSlot(middles, 45), 2);
  assert.equal(dropSlot(middles, 99), 3);
  assert.equal(dropSlot([], 5), 0);
});

test('gaps either side of the dragged row mean it stays put; others land in the gap', () => {
  assert.equal(slotToIndex(1, 1), 1);
  assert.equal(slotToIndex(1, 2), 1);
  assert.equal(slotToIndex(1, 0), 0);
  assert.equal(slotToIndex(1, 3), 2);
  assert.equal(slotToIndex(1, 4), 3);
  assert.equal(slotToIndex(0, 4), 3);
  assert.equal(slotToIndex(3, 0), 0);
});

test('the announcement states the position and any rules removed', () => {
  assert.equal(moveMessage(1, 4, 0), 'Moved to position 2 of 4. Save the draft to keep this change.');
  assert.equal(moveMessage(0, 4, 1), 'Moved to position 1 of 4. 1 display rule was removed because it referred to a later question. Save the draft to keep this change.');
  assert.equal(moveMessage(3, 4, 2), 'Moved to position 4 of 4. 2 display rules were removed because they referred to a later question. Save the draft to keep this change.');
});
