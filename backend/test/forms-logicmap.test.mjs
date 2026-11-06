// The Workflow map draws the rules the shared logic walks, so what it says leads somewhere must agree
// with where respondents actually go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formEnding, visibleFields } from '../src/shared/forms-logic.mjs';
import { contactInfoBlock } from '../../frontend/js/forms-groups.mjs';
import { logicMapModel } from '../../frontend/js/forms-logicmap.mjs';

const q = (id, label = id) => ({ id, type: 'short_text', label });
const form = (fields, extra = {}) => ({ title: 'T', presentation: 'classic', fields, ...extra });
const keysOf = list => list.map(node => node.key);

test('with no rules the map is the form in order, ending at the receipt', () => {
  const map = logicMapModel(form([q('a'), q('b')]));
  assert.deepEqual(keysOf(map.nodes), ['a', 'b', 'end']);
  assert.deepEqual(map.steps, [{ from: 'a', to: 'b' }, { from: 'b', to: 'end' }]);
  assert.deepEqual(map.jumps, []);
  assert.deepEqual(map.unreached, []);
  assert.deepEqual(keysOf(logicMapModel(form([])).nodes), ['end']);
});

test('jumps appear in rule order, with the sentence and whether a condition guards them', () => {
  const definition = form([q('a', 'First'), q('b'), q('c', 'Third')], {
    logic: [{ field: 'a', rules: [{ when: { field: 'a', op: 'answered' }, to: { type: 'field', id: 'c' } }, { to: { type: 'ending', id: 'e2' } }] }],
    endings: [{ id: 'e1', title: 'One' }, { id: 'e2', title: 'Two' }]
  });
  const map = logicMapModel(definition);
  assert.deepEqual(map.jumps.map(({ from, to, conditional }) => [from, to, conditional]), [['a', 'c', true], ['a', 'ending:e2', false]]);
  assert.equal(map.jumps[0].sentence, 'When “First” is answered, go to “Third”.');
  assert.equal(map.jumps[1].sentence, 'Otherwise go to the ending “Two”.');
  assert.equal(map.steps.some(edge => edge.from === 'a'), false, 'a rule that always matches leaves no next-question step');
});

test('anything no path leads to is reported, and agrees with what respondents can reach', () => {
  const definition = form([q('a'), q('b'), q('c')], { logic: [{ field: 'a', rules: [{ to: { type: 'field', id: 'c' } }] }], endings: [{ id: 'e1', title: 'One' }, { id: 'e2', title: 'Never' }] });
  const map = logicMapModel(definition);
  assert.deepEqual(keysOf(map.unreached), ['b', 'ending:e2']);
  assert.deepEqual(visibleFields(definition, {}).map(field => field.id), ['a', 'c']);
  assert.equal(formEnding(definition, {}).id, 'e1');
  const conditional = form([q('a'), q('b'), q('c')], { logic: [{ field: 'a', rules: [{ when: { field: 'a', op: 'answered' }, to: { type: 'field', id: 'c' } }] }] });
  assert.deepEqual(logicMapModel(conditional).unreached, [], 'an unanswered path still reaches b');
});

test('a page shows as a page with its questions under it, and is a jump target', () => {
  const fields = [q('intro'), ...contactInfoBlock([]), q('after')];
  const map = logicMapModel(form(fields, { logic: [{ field: 'intro', rules: [{ when: { field: 'intro', op: 'answered' }, to: { type: 'group', id: 'contact_info' } }] }, { field: 'email', rules: [{ to: { type: 'field', id: 'after' } }] }] }));
  const page = map.nodes.find(node => node.key === 'contact_info');
  assert.equal(page.kind, 'page');
  assert.equal(page.mark, '2');
  assert.equal(map.nodes.find(node => node.key === 'first_name').member, true);
  assert.equal(map.nodes.find(node => node.key === 'first_name').mark, 'A');
  assert.equal(map.jumps[0].sentence, 'When “intro” is answered, go to the page “Contact Info”.');
  assert.deepEqual(keysOf(map.unreached), ['company'], 'a jump past the last question of a page leaves it unreached');
});
