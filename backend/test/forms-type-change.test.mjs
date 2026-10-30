// Changing a question's type: safe in-place conversions, explained changes, blocked rules, and the
// replacement workflow for published keys. The server refuses to publish an incompatible retype.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { definitionProblems, publishedTypeChangeAllowed } from '../src/shared/forms-logic.mjs';
import { dependentRules, planTypeChange, replacementQuestion, typeChoices } from '../../frontend/js/forms-type-change.mjs';

let counter = 0;
const newKey = prefix => `${prefix}_new${++counter}`;
const definition = fields => ({ title: 'Intake', description: '', presentation: 'classic', submit_label: 'Send', fields });
const fields = () => [
  { id: 'name', type: 'short_text', label: 'Your name', help: 'As you like to be called', required: true },
  { id: 'kind', type: 'single_choice', label: 'What do you need?', required: true, options: [{ id: 'team', label: 'Team' }, { id: 'solo', label: 'Solo' }] },
  { id: 'size', type: 'short_text', label: 'Team size', required: false, show_if: { field: 'kind', op: 'equals', value: 'team' } },
  { id: 'note', type: 'long_text', label: 'Anything else?', required: false, show_if: { field: 'name', op: 'answered' } }
];
const plan = (draft, id, to, extra = {}) => planTypeChange({ field: draft.find(field => field.id === id), to, fields: draft, newKey, ...extra });

test('published keys may only widen: text to wider text, one choice to several', () => {
  for (const [from, to] of [['short_text', 'long_text'], ['email', 'short_text'], ['phone', 'long_text'], ['date', 'short_text'], ['single_choice', 'multiple_choice']]) assert.ok(publishedTypeChangeAllowed(from, to), `${from} → ${to}`);
  for (const [from, to] of [['long_text', 'short_text'], ['short_text', 'email'], ['multiple_choice', 'single_choice'], ['short_text', 'single_choice'], ['single_choice', 'short_text'], ['page_break', 'short_text']]) assert.ok(!publishedTypeChangeAllowed(from, to), `${from} → ${to}`);
  assert.deepEqual(typeChoices({ type: 'page_break' }), []);
});

test('unpublished text conversions keep wording, settings, key and logic; the draft is untouched until applied', () => {
  const draft = fields();
  const before = structuredClone(draft);
  const result = plan(draft, 'name', 'long_text');
  assert.equal(result.kind, 'apply');
  assert.deepEqual(result.next, { ...draft[0], type: 'long_text' });
  assert.deepEqual(draft, before, 'planning changes nothing');
  assert.deepEqual(definitionProblems(definition(draft.map(field => field.id === 'name' ? result.next : field))), []);
  // Text rules on a narrower type are kept and called out.
  const ruled = fields(); ruled[3].show_if = { field: 'name', op: 'equals', value: 'Mia' };
  const narrow = plan(ruled, 'name', 'email');
  assert.equal(narrow.kind, 'confirm');
  assert.match(narrow.effects.join(' '), /stay as they are; check in Preview/);
});

test('choice and text cannot swap while rules compare the answer; otherwise options change only on confirmation', () => {
  const draft = fields();
  const blocked = plan(draft, 'kind', 'short_text');
  assert.equal(blocked.kind, 'blocked');
  assert.deepEqual(blocked.rules, ['The question “Team size”: shown when “What do you need?” is “Team”.']);
  // Routing rules that compare option keys block too.
  const routed = fields(); delete routed[2].show_if;
  const routing = { rules: [{ condition: { field: 'kind', op: 'equals', value: 'solo' }, action: { type: 'message', message: 'Hi' } }], fallback: null };
  assert.match(plan(routed, 'kind', 'long_text', { routing }).rules[0], /^Saved routing rule 1: applies when “What do you need\?” is “Solo”/);
  const free = plan(routed, 'kind', 'short_text');
  assert.equal(free.kind, 'confirm');
  assert.equal(free.next.options, undefined);
  assert.match(free.effects[0], /options are removed from the draft: “Team”, “Solo”/);
  // An "is answered" rule survives any conversion.
  const toChoice = plan(fields(), 'name', 'single_choice');
  assert.equal(toChoice.kind, 'confirm');
  assert.equal(toChoice.next.options.length, 2);
  assert.deepEqual(toChoice.rules, ['The question “Anything else?”: shown when “Your name” is answered.']);
  assert.deepEqual(definitionProblems(definition(fields().map(field => field.id === 'name' ? toChoice.next : field))), []);
  const textRule = fields(); textRule[3].show_if = { field: 'name', op: 'contains', value: 'a' };
  assert.equal(plan(textRule, 'name', 'single_choice').kind, 'blocked');
});

test('single to multiple choice shows how each dependent rule would read afterwards', () => {
  const result = plan(fields(), 'kind', 'multiple_choice');
  assert.equal(result.kind, 'confirm');
  assert.deepEqual(result.next.options, fields()[1].options, 'options and their keys are kept');
  assert.equal(result.effects[0], 'The question “Team size”: shown when “What do you need?” is “Team” — after the change: shown when “Team” is the only choice in “What do you need?”.');
  const single = plan([{ ...fields()[1], type: 'multiple_choice' }], 'kind', 'single_choice');
  assert.equal(single.kind, 'confirm');
  assert.match(single.effects.join(' '), /pick only one/);
});

test('published keys: widening applies in place, anything else offers a replacement unless rules depend on it', () => {
  const locked = new Set(['name', 'kind', 'note']);
  const wide = plan(fields(), 'note', 'long_text', { locked });
  assert.equal(wide.kind, 'none');
  const widened = plan(fields(), 'name', 'long_text', { locked });
  assert.equal(widened.kind, 'apply');
  assert.match(widened.effects.join(' '), /keep their original type/);
  const replace = plan(fields(), 'note', 'short_text', { locked });
  assert.equal(replace.kind, 'replace');
  assert.equal(replace.canReplace, true);
  assert.match(replace.reason, /cannot change type in place.*replace it with a new short text question/i);
  const dependedOn = plan(fields(), 'kind', 'short_text', { locked });
  assert.deepEqual([dependedOn.kind, dependedOn.canReplace], ['replace', false]);
  assert.equal(dependedOn.rules.length, 1);
  assert.equal(dependentRules('name', fields(), null).length, 1);

  const copy = replacementQuestion(fields()[1], 'multiple_choice', newKey);
  assert.notEqual(copy.id, 'kind');
  assert.equal(copy.label, 'What do you need?');
  assert.deepEqual(copy.options.map(option => option.label), ['Team', 'Solo']);
  assert.ok(copy.options.every(option => !['team', 'solo'].includes(option.id)), 'options get new keys');
  const fromText = replacementQuestion(fields()[0], 'single_choice', newKey);
  assert.deepEqual([fromText.help, fromText.required, fromText.options.length], ['As you like to be called', true, 2]);
});

test('server: an incompatible retype of a published key is refused at publish; a replacement keeps earlier answers intact', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Retype');
    const base = `/api/workspaces/${ws.id}/forms`;
    const start = definition([{ id: 'name', type: 'short_text', label: 'Your name', required: true }, { id: 'contact', type: 'email', label: 'Email', required: true }]);
    const form = (await owner.post(base, { definition: start })).body;
    await owner.post(`${base}/${form.id}/publish`, {});
    const accepted = await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Mia', contact: 'mia@example.com' }, version: 1, submission_id: 'retype-submission-0001' });
    assert.equal(accepted.status, 201);

    // Same key, incompatible type: saving the draft is allowed, publishing and the check refuse it.
    const retyped = definition([start.fields[0], { id: 'contact', type: 'single_choice', label: 'Email', required: true, options: [{ id: 'a', label: 'A' }] }]);
    const saved = (await owner.patch(`${base}/${form.id}`, { definition: retyped })).body;
    const check = (await owner.post(`${base}/${form.id}/publish-check`, { base_revision: saved.revision })).body;
    assert.equal(check.can_publish, false);
    assert.match(check.problems[0].message, /published as email and cannot become single choice/);
    const refused = await owner.post(`${base}/${form.id}/publish`, {});
    assert.deepEqual([refused.status, refused.body.error.code], [400, 'validation_failed']);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_versions WHERE form_id = ?', form.id).count, 1, 'nothing new published');
    assert.equal((await env.client().get(`/api/public/forms/${form.slug}`)).body.definition.fields[1].type, 'email', 'the live form is unchanged');

    // Widening in place publishes; a replacement with a new key publishes too.
    await owner.patch(`${base}/${form.id}`, { definition: definition([start.fields[0], { ...start.fields[1], type: 'long_text' }]) });
    assert.equal((await owner.post(`${base}/${form.id}/publish`, {})).status, 200);
    await owner.patch(`${base}/${form.id}`, { definition: definition([start.fields[0], replacementQuestion({ ...start.fields[1], type: 'long_text' }, 'single_choice', newKey)]) });
    assert.equal((await owner.post(`${base}/${form.id}/publish`, {})).status, 200);

    // The first response still reads as an email answer to version 1, in the inbox and the CSV.
    const inbox = (await owner.get(`${base}/${form.id}/responses`)).body;
    assert.equal(inbox.responses.length, 1);
    assert.deepEqual([inbox.responses[0].form_version, inbox.responses[0].answers.contact], [1, 'mia@example.com']);
    assert.equal(inbox.versions[1].fields[1].type, 'email');
    const csv = await owner.get(`${base}/${form.id}/responses.csv`);
    assert.match(typeof csv.body === 'string' ? csv.body : csv.text, /mia@example\.com/);
  } finally { await env.close(); }
});
