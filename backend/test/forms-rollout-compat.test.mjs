// Older browsers during a rollout. A tab opened before this logic can load new versions and cannot be
// updated, so the server must never demand a question that browser did not display. A real old build is
// driven by scripts/release-rehearsal.mjs; these tests pin the contract and what it does not relax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { CLIENT_EVALUATOR, olderClientFieldIds, validateSubmission, withEvaluationPolicy } from '../src/shared/forms-logic.mjs';

const is = (field, value) => ({ field, op: 'equals', value });
const options = (...ids) => ids.map(id => ({ id, label: id }));
const shell = extra => ({ title: 'T', description: '', presentation: 'classic', submit_label: 'Send', ...extra });
const typed = () => shell({ fields: [
  { id: 'code', type: 'short_text', label: 'Code', required: false },
  { id: 'more', type: 'short_text', label: 'More', required: true, show_if: is('code', 'yes') }
] });
const older = { olderClient: true };

test('olderClientFieldIds is the old walk: answers as typed, display rules and plain pages only', () => {
  const definition = withEvaluationPolicy(typed());
  assert.deepEqual([...olderClientFieldIds(definition, { code: 'yes ' })], ['code']);
  assert.deepEqual([...olderClientFieldIds(definition, { code: 'yes' })], ['code', 'more']);
  const page = shell({ fields: [
    { id: 'plan', type: 'single_choice', label: 'Plan', options: options('free', 'team') },
    { id: 'details', type: 'page_break', label: 'Details', grouped: true, show_if: is('plan', 'team') },
    { id: 'seats', type: 'short_text', label: 'Seats', group: 'details' },
    { id: 'after', type: 'short_text', label: 'After' }
  ] });
  assert.deepEqual([...olderClientFieldIds(page, { plan: 'free' })], ['plan'], 'an old browser hides everything up to the next page break');
  const jump = shell({ fields: [{ id: 'a', type: 'short_text', label: 'A' }, { id: 'b', type: 'short_text', label: 'B' }], logic: [{ field: 'a', rules: [{ to: { type: 'field', id: 'b' } }] }] });
  assert.deepEqual([...olderClientFieldIds(jump, { a: 'x' })], ['a', 'b'], 'and knows no jumps');
});

test('an older client is never asked for a question it did not display', () => {
  const definition = withEvaluationPolicy(typed());
  assert.deepEqual(Object.keys(validateSubmission(definition, { code: 'yes ' }).errors), ['more'], 'a current client is');
  const result = validateSubmission(definition, { code: 'yes ' }, undefined, older);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.answers, { code: 'yes' });
  const leftover = validateSubmission(definition, { code: 'yes ', more: 'x'.repeat(301) }, undefined, older);
  assert.deepEqual(leftover.errors, {}, 'an abandoned answer on a question it stopped displaying cannot block it either');
  assert.deepEqual(leftover.answers, { code: 'yes' }, 'and an invalid one is not stored');
});

test('everything else stays enforced for a request without the marker', () => {
  const definition = withEvaluationPolicy(typed());
  assert.deepEqual(Object.keys(validateSubmission(definition, { code: 'yes' }, undefined, older).errors), ['more'], 'a question it does display');
  assert.deepEqual(Object.keys(validateSubmission(definition, { code: 'x'.repeat(301) }, undefined, older).errors), ['code'], 'a displayed answer');
  assert.deepEqual(validateSubmission(definition, { code: 'yes ', more: 'typed' }, undefined, older).answers, { code: 'yes', more: 'typed' }, 'a valid answer is kept');

  const hide = withEvaluationPolicy(shell({ fields: [
    { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
    { id: 'help', type: 'single_choice', label: 'Help', required: true, options: options('email', 'phone') }
  ], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }] }));
  const refused = validateSubmission(hide, { plan: 'free', help: 'phone' }, undefined, older);
  assert.equal(refused.errors.help, 'That choice is not available. Choose another.', 'and it says why');

  const followUp = withEvaluationPolicy(shell({ fields: [
    { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team') },
    { id: 'help', type: 'single_choice', label: 'Help', required: false, options: options('email', 'phone') },
    { id: 'why', type: 'short_text', label: 'Why', required: true, show_if: { field: 'help', op: 'not_equals', value: 'phone' } }
  ], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }] }));
  const waived = validateSubmission(followUp, { plan: 'free', help: 'phone' }, undefined, older);
  assert.deepEqual(waived.errors, {}, 'the question the browser hid is waived');
  assert.deepEqual(waived.answers, { plan: 'free' }, 'and the hidden choice is still not stored');
  assert.deepEqual(Object.keys(validateSubmission(followUp, { plan: 'free', help: 'phone' }).errors), ['why'], 'a current client gets the question');
});

test('server: a submission carries the marker or is treated as an older browser, on every path', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(forms, { definition: typed() })).body;
    await owner.post(`${forms}/${created.id}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const answers = id => JSON.parse(env.app.db.get('SELECT answers FROM responses WHERE id = ?', id).answers);

    const current = await submit({ answers: { code: 'yes ' }, evaluator: CLIENT_EVALUATOR });
    assert.equal(current.status, 400);
    assert.deepEqual(Object.keys(current.body.error.errors), ['more']);

    const old = await submit({ answers: { code: 'yes ' } });
    assert.equal(old.status, 201);
    assert.deepEqual(answers(old.body.id), { code: 'yes' });

    assert.equal((await submit({ answers: { code: 'yes' } })).status, 400, 'an older browser displays this one, so it is required');

    const accepted = await submit({ answers: { code: 'yes ', more: 'x' }, evaluator: CLIENT_EVALUATOR, submission_id: 'rollout-marker-000001' });
    assert.equal(accepted.status, 201);
    const replay = await submit({ answers: { code: 'yes ' }, submission_id: 'rollout-marker-000001' });
    assert.equal(replay.body.replay, true, 'a retry still replays');
    assert.equal(replay.body.answers_changed, true);

    const live = (await env.client().get(`/api/public/forms/${created.slug}`)).body;
    assert.equal(live.definition.evaluation_policy, 'normalized_v1');
  } finally { await env.close(); }
});
