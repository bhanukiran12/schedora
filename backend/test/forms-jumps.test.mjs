// In-form branching: jumps to questions, groups and endings, evaluated by the shared logic so the
// preview, the public form and the server walk the same path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { definitionProblems, formEnding, pruneLogic, starterDefinition, validateSubmission, visibleFields, visiblePages } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { defaultCondition, jumpSentence, jumpTargets, parseTarget, renameInLogic, rulesFor, setRules, targetValue } from '../../frontend/js/forms-jumps.mjs';

const is = (field, value) => ({ field, op: 'equals', value });
const form = (extra = {}) => ({
  title: 'Enquiry', description: '', presentation: 'conversational', submit_label: 'Send',
  fields: [
    { id: 'kind', type: 'single_choice', label: 'Who is this for?', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }, { id: 'press', label: 'Press' }] },
    { id: 'size', type: 'short_text', label: 'Team size?', required: true },
    { id: 'desk', type: 'short_text', label: 'Desks?', required: true },
    { id: 'contact_page', type: 'page_break', label: '' },
    { id: 'email', type: 'email', label: 'Email', required: true },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false }
  ],
  logic: [{ field: 'kind', rules: [
    { when: is('kind', 'home'), to: { type: 'field', id: 'email' } },
    { when: is('kind', 'press'), to: { type: 'ending', id: 'press_end' } }
  ] }],
  endings: [{ id: 'thanks', title: 'Thanks', message: 'We will reply soon.' }, { id: 'press_end', title: 'Press enquiries', message: 'Our press team handles these.' }],
  ...extra
});
const ids = (definition, answers) => visibleFields(definition, answers).map(field => field.id);

test('a form without logic walks exactly as before and stores no new keys', () => {
  const starter = starterDefinition();
  assert.deepEqual(ids(starter, { topic: 'other' }), ['name', 'email', 'topic', 'details']);
  assert.deepEqual(ids(starter, { topic: 'support' }), ['name', 'email', 'topic']);
  assert.equal(formEnding(starter, {}), null);
  assert.deepEqual(Object.keys(validateSubmission(starter, { name: 'A', email: 'a@example.com', topic: 'support' })).sort(), ['answers', 'errors']);
  const stored = normalizeDefinition(starter);
  assert.equal('logic' in stored, false);
  assert.equal('endings' in stored, false);
  assert.deepEqual(normalizeDefinition({ ...starter, logic: [], endings: [] }), stored);
});

test('a jump skips the questions between, and they are not required', () => {
  assert.deepEqual(definitionProblems(form()), []);
  assert.deepEqual(ids(form(), { kind: 'home' }), ['kind', 'email', 'notes']);
  assert.deepEqual(ids(form(), { kind: 'office' }), ['kind', 'size', 'desk', 'email', 'notes']);
  assert.deepEqual(ids(form(), {}), ['kind', 'size', 'desk', 'email', 'notes'], 'no jump until the answer exists');
  assert.deepEqual(validateSubmission(form(), { kind: 'home', email: 'A@example.com' }).errors, {});
  assert.deepEqual(Object.keys(validateSubmission(form(), { kind: 'office', email: 'a@example.com' }).errors).sort(), ['desk', 'size']);
});

test('changing an earlier answer discards answers the new path no longer reaches', () => {
  // Answered as Office, then went back and chose Home: the old answers are not stored.
  const changed = validateSubmission(form(), { kind: 'home', size: '12', desk: '4', email: 'a@example.com' });
  assert.deepEqual(changed.answers, { kind: 'home', email: 'a@example.com' });
  // A rule on a skipped question treats its answer as empty.
  const definition = form();
  definition.fields.push({ id: 'seats', type: 'short_text', label: 'Seats?', required: true, show_if: { field: 'size', op: 'answered' } });
  assert.deepEqual(ids(definition, { kind: 'home', size: '12' }), ['kind', 'email', 'notes']);
  assert.deepEqual(ids(definition, { kind: 'office', size: '12' }), ['kind', 'size', 'desk', 'email', 'notes', 'seats']);
});

test('a jump to a group lands on that page and honours its display rule', () => {
  const definition = form({ logic: [{ field: 'kind', rules: [{ when: is('kind', 'home'), to: { type: 'group', id: 'contact_page' } }] }] });
  assert.deepEqual(definitionProblems(definition), []);
  assert.deepEqual(visiblePages(definition, { kind: 'home' }).map(page => page.map(field => field.id)), [['kind'], ['email', 'notes']]);
  definition.fields[3].show_if = is('kind', 'office');
  assert.deepEqual(ids(definition, { kind: 'home' }), ['kind']);
});

test('a jump past a page break starts a new page, even onto a later question of that page', () => {
  const definition = form({ logic: [{ field: 'kind', rules: [{ when: is('kind', 'home'), to: { type: 'field', id: 'notes' } }] }] });
  assert.deepEqual(visiblePages(definition, { kind: 'home' }).map(page => page.map(field => field.id)), [['kind'], ['notes']]);
});

test('a jump to an ending stops the form there; otherwise the first ending is the default', () => {
  assert.deepEqual(ids(form(), { kind: 'press' }), ['kind']);
  assert.equal(formEnding(form(), { kind: 'press' }).id, 'press_end');
  assert.equal(formEnding(form(), { kind: 'office' }).id, 'thanks');
  const accepted = validateSubmission(form(), { kind: 'press', size: 'ignored' });
  assert.deepEqual(accepted.errors, {});
  assert.deepEqual(accepted.answers, { kind: 'press' });
  assert.equal(accepted.ending.id, 'press_end');
});

test('the first matching rule decides, and a rule with no condition catches the rest', () => {
  const definition = form({ logic: [{ field: 'kind', rules: [
    { when: is('kind', 'home'), to: { type: 'field', id: 'desk' } },
    { when: { field: 'kind', op: 'answered' }, to: { type: 'field', id: 'email' } }
  ] }] });
  assert.deepEqual(ids(definition, { kind: 'home' }).slice(0, 2), ['kind', 'desk']);
  assert.deepEqual(ids(definition, { kind: 'office' }).slice(0, 2), ['kind', 'email']);
  const always = form({ logic: [{ field: 'kind', rules: [{ when: is('kind', 'home'), to: { type: 'field', id: 'desk' } }, { to: { type: 'field', id: 'notes' } }] }] });
  assert.deepEqual(definitionProblems(always), []);
  assert.deepEqual(ids(always, { kind: 'press' }), ['kind', 'notes']);
});

test('all-of and any-of conditions combine rules', () => {
  const combined = when => form({ logic: [{ field: 'size', rules: [{ when, to: { type: 'field', id: 'email' } }] }] });
  const both = combined({ all: [is('kind', 'office'), is('size', '1')] });
  const either = combined({ any: [is('kind', 'home'), is('size', '1')] });
  assert.deepEqual(definitionProblems(both), []);
  assert.deepEqual(definitionProblems(either), []);
  assert.ok(!ids(both, { kind: 'office', size: '1' }).includes('desk'));
  assert.ok(ids(both, { kind: 'office', size: '2' }).includes('desk'));
  assert.ok(!ids(either, { kind: 'office', size: '1' }).includes('desk'));
  assert.ok(ids(either, { kind: 'office', size: '2' }).includes('desk'));
});

test('definitions that could not walk correctly are refused with a named reason', () => {
  const problem = (logic, endings = form().endings) => definitionProblems(form({ logic, endings })).join(' ');
  const rule = (to, when = is('kind', 'home')) => [{ field: 'kind', rules: [{ when, to }] }];
  assert.match(problem([{ field: 'desk', rules: [{ to: { type: 'field', id: 'size' } }] }]), /later question/);
  assert.match(problem([{ field: 'desk', rules: [{ to: { type: 'field', id: 'desk' } }] }]), /later question/);
  assert.match(problem(rule({ type: 'field', id: 'gone' })), /later question/);
  assert.match(problem(rule({ type: 'field', id: 'contact_page' })), /later question/);
  assert.match(problem(rule({ type: 'group', id: 'email' })), /later page/);
  assert.match(problem(rule({ type: 'ending', id: 'gone' })), /ending that does not exist/);
  assert.match(problem(rule({ type: 'url', id: 'x' })), /jump to a question, a page or an ending/);
  assert.match(problem([{ field: 'gone', rules: [{ to: { type: 'field', id: 'email' } }] }]), /question that is not in the form/);
  assert.match(problem([{ field: 'contact_page', rules: [{ to: { type: 'field', id: 'email' } }] }]), /question that is not in the form/);
  assert.match(problem([...rule({ type: 'field', id: 'email' }), ...rule({ type: 'field', id: 'notes' })]), /only one set of rules/);
  assert.match(problem(rule({ type: 'field', id: 'email' }, is('kind', 'nope'))), /one of the options/);
  assert.match(problem(rule({ type: 'field', id: 'email' }, is('email', 'x'))), /this question or an earlier one/);
  assert.match(problem(rule({ type: 'field', id: 'email' }, { field: 'kind', op: 'matches', value: 'x' })), /unsupported rule/);
  assert.match(problem(rule({ type: 'field', id: 'email' }, { all: [] })), /at least one condition/);
  assert.match(problem([{ field: 'kind', rules: [{ to: { type: 'field', id: 'email' } }, { when: is('kind', 'home'), to: { type: 'field', id: 'notes' } }] }]), /can never be reached/);
  assert.match(problem([{ field: 'kind', rules: [] }]), /1–20 rules/);
  assert.match(problem('nope'), /Logic must be a list/);
  assert.match(definitionProblems(form({ endings: 'nope' })).join(' '), /Endings must be a list/);
  assert.match(definitionProblems(form({ endings: [form().endings[0], form().endings[0]], logic: [] })).join(' '), /reuses the id/);
  assert.match(definitionProblems(form({ endings: [{ id: 'a', title: '' }], logic: [] })).join(' '), /title of up to 150/);
  assert.match(definitionProblems(form({ endings: [{ id: 'a', title: 'A', message: 'x'.repeat(2001) }], logic: [] })).join(' '), /2000 characters/);
});

test('normalizing keeps only known logic keys and gives identical JSON twice', () => {
  const messy = form();
  messy.logic[0].extra = 'x';
  messy.logic[0].rules[0].extra = 'x';
  messy.logic[0].rules[0].when.extra = 'x';
  messy.logic[0].rules[0].to.extra = 'x';
  messy.endings[0] = { ...messy.endings[0], title: '  Thanks  ', extra: 'x' };
  const once = normalizeDefinition(messy);
  assert.deepEqual(once.logic, form().logic);
  assert.deepEqual(once.endings, form().endings);
  assert.equal(JSON.stringify(normalizeDefinition(once)), JSON.stringify(once));
});

test('builder edits that invalidate a jump remove only that rule and report how many', () => {
  const definition = form({ logic: [{ field: 'kind', rules: [{ when: is('kind', 'home'), to: { type: 'field', id: 'email' } }, { when: is('kind', 'press'), to: { type: 'ending', id: 'press_end' } }] }] });
  assert.equal(pruneLogic(definition), 0);
  definition.endings = definition.endings.filter(ending => ending.id !== 'press_end');
  assert.equal(pruneLogic(definition), 1);
  assert.equal(definition.logic[0].rules.length, 1);
  assert.deepEqual(definitionProblems(definition), []);
  // The target moved above the question: nothing valid is left, so no empty list stays behind.
  const email = definition.fields.splice(4, 1)[0];
  definition.fields.unshift(email);
  assert.equal(pruneLogic(definition), 1);
  assert.equal('logic' in definition, false);
  assert.deepEqual(definitionProblems(definition), []);
});

test('the jump editor offers only later targets, reads in plain words and follows key changes', () => {
  const definition = form();
  assert.deepEqual(jumpTargets(definition, 0).map(group => [group.label, group.items.map(item => item.value)]), [
    ['Questions', ['field:size', 'field:desk', 'field:email', 'field:notes']], ['Pages', ['group:contact_page']], ['Endings', ['ending:thanks', 'ending:press_end']]
  ]);
  assert.deepEqual(jumpTargets({ ...definition, endings: [] }, 5), []);
  assert.deepEqual(parseTarget(targetValue({ type: 'ending', id: 'press_end' })), { type: 'ending', id: 'press_end' });
  assert.equal(jumpSentence(definition.logic[0].rules[0], definition), 'When “Who is this for?” is “Home”, go to “Email”.');
  assert.equal(jumpSentence(definition.logic[0].rules[1], definition), 'When “Who is this for?” is “Press”, go to the ending “Press enquiries”.');
  assert.equal(jumpSentence({ to: { type: 'group', id: 'contact_page' } }, definition), 'Always go to page 2.');
  assert.equal(jumpSentence({ to: { type: 'field', id: 'notes' } }, definition, false), 'Otherwise go to “Notes”.');
  assert.deepEqual(defaultCondition(definition.fields[0]), { field: 'kind', op: 'equals', value: 'home' });
  assert.deepEqual(defaultCondition(definition.fields[1]), { field: 'size', op: 'answered' });

  renameInLogic(definition, 'email', 'reply_to');
  assert.equal(definition.logic[0].rules[0].to.id, 'reply_to');
  renameInLogic(definition, 'kind', 'audience');
  assert.equal(definition.logic[0].field, 'audience');
  assert.equal(definition.logic[0].rules[0].when.field, 'audience');

  setRules(definition, 'audience', []);
  assert.equal('logic' in definition, false);
  setRules(definition, 'size', [{ to: { type: 'field', id: 'desk' } }]);
  assert.equal(rulesFor(definition, 'size').length, 1);
});

test('server: a published path is enforced, the ending comes back with the receipt, and retries keep it', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(base, { definition: form() })).body;
    assert.equal((await owner.patch(`${base}/${created.id}`, { definition: form({ logic: [{ field: 'desk', rules: [{ to: { type: 'field', id: 'size' } }] }] }), base_revision: created.revision })).status, 400, 'a backward jump is refused on save');
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 1);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);

    const wrongPath = await submit({ answers: { kind: 'office', email: 'a@example.com' } });
    assert.equal(wrongPath.status, 400);
    assert.deepEqual(Object.keys(wrongPath.body.error.errors).sort(), ['desk', 'size']);

    const press = await submit({ answers: { kind: 'press', size: 'dropped' }, submission_id: 'jump-submission-0001' });
    assert.equal(press.status, 201);
    assert.deepEqual(press.body.ending, { id: 'press_end', title: 'Press enquiries', message: 'Our press team handles these.' });
    const stored = (await owner.get(`${base}/${created.id}/responses`)).body.responses;
    assert.deepEqual(stored[0].answers, { kind: 'press' });

    // Republishing with different endings changes neither the retry nor the version answered.
    const current = (await owner.get(`${base}/${created.id}`)).body;
    await owner.patch(`${base}/${created.id}`, { definition: form({ endings: [{ id: 'thanks', title: 'New thanks' }], logic: [] }), base_revision: current.revision });
    await owner.post(`${base}/${created.id}/publish`);
    const retry = await submit({ answers: { kind: 'press' }, submission_id: 'jump-submission-0001' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replay, true);
    assert.equal(retry.body.ending.title, 'Press enquiries');

    const live = await submit({ answers: { kind: 'press', size: '1', desk: '1', email: 'a@example.com' } });
    assert.equal(live.status, 201);
    assert.equal(live.body.ending.title, 'New thanks');

    const plain = (await owner.post(base, { definition: starterDefinition('Plain') })).body;
    await owner.post(`${base}/${plain.id}/publish`);
    const noEnding = await env.client().post(`/api/public/forms/${plain.slug}/responses`, { answers: { name: 'A', email: 'a@example.com', topic: 'support' } });
    assert.equal(noEnding.status, 201);
    assert.equal('ending' in noEnding.body, false);
  } finally { await env.close(); }
});
