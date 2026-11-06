// The evaluation policy: each published version records how its rules read typed answers. A version
// without it keeps the behaviour it was published with, and nothing rewrites a version or a response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { answerConditionHolds, comparesTypedText, conditionHolds, dropHiddenChoices, EVALUATION_POLICY, formEnding, formScreens, starterDefinition, validateSubmission, visibleFields, withEvaluationPolicy } from '../src/shared/forms-logic.mjs';
import { chooseAction, normalizeDefinition } from '../src/forms/service.mjs';
import { assessFormReadiness, unreachableFields } from '../../frontend/js/forms-readiness.mjs';
import { definitionProblems } from '../../frontend/shared/forms-logic.mjs';

const is = (field, value) => ({ field, op: 'equals', value });
const options = (...ids) => ids.map(id => ({ id, label: id.toUpperCase() }));
const base = (extra = {}) => ({
  title: 'T', description: '', presentation: 'classic', submit_label: 'Send',
  fields: [
    { id: 'code', type: 'short_text', label: 'Code', required: false },
    { id: 'more', type: 'short_text', label: 'More', required: true, show_if: is('code', 'yes') },
    { id: 'pick', type: 'single_choice', label: 'Pick', required: false, options: options('a', 'b', 'c') },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false }
  ],
  logic: [{ field: 'code', rules: [{ when: is('code', 'skip'), to: { type: 'ending', id: 'skipped' } }] }],
  endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'skipped', title: 'Skipped' }],
  ...extra
});
const hideRules = { choice_rules: [{ field: 'pick', rules: [{ when: is('code', 'yes'), hide: ['b'] }] }] };
const urlParams = { url_params: [{ key: 'ref', record: true }] };
const paramRule = { choice_rules: [{ field: 'pick', rules: [{ when: { param: 'ref', op: 'equals', value: 'partner' }, hide: ['c'] }] }] };
const VARIANTS = {
  'no hide rules or URL parameters': {},
  'URL parameters declared': urlParams,
  'hide rules': hideRules,
  'hide rules and URL parameters': { ...urlParams, choice_rules: [{ field: 'pick', rules: [...hideRules.choice_rules[0].rules, ...paramRule.choice_rules[0].rules] }] }
};
const ids = (definition, answers, params) => visibleFields(definition, answers, params).map(field => field.id);
const offered = (definition, answers, params) => visibleFields(definition, answers, params).find(field => field.id === 'pick')?.options.map(option => option.id);

for (const [name, extra] of Object.entries(VARIANTS)) {
  test(`"yes " against a rule for yes, with the policy: ${name}`, () => {
    const definition = withEvaluationPolicy(base(extra));
    assert.deepEqual(definitionProblems(definition), []);
    for (const typed of ['yes', 'yes ', '  yes', ' yes  ']) {
      assert.deepEqual(ids(definition, { code: typed }), ['code', 'more', 'pick', 'notes'], JSON.stringify(typed));
      assert.deepEqual(Object.keys(validateSubmission(definition, { code: typed }).errors), ['more'], 'the server asks for what the browser showed');
      assert.deepEqual(validateSubmission(definition, { code: typed, more: 'x' }).errors, {});
    }
    assert.deepEqual(ids(definition, { code: 'Yes ' }), ['code', 'pick', 'notes'], 'capitals still count for is');
    assert.deepEqual(formScreens(definition, { code: 'yes ' }, 'conversational').flat().map(field => field.id), ['code', 'more', 'pick', 'notes']);
    assert.deepEqual(ids(definition, { code: 'skip ' }), ['code'], 'a jump');
    assert.equal(formEnding(definition, { code: 'skip ' }).id, 'skipped', 'an ending');
    const jumped = validateSubmission(definition, { code: ' skip ', more: 'dropped' });
    assert.deepEqual(jumped.answers, { code: 'skip' });
    assert.equal(jumped.ending.id, 'skipped');
  });
}

test('without the policy, a form without hide rules keeps comparing as typed, whatever else it declares', () => {
  for (const extra of [VARIANTS['no hide rules or URL parameters'], VARIANTS['URL parameters declared']]) {
    const old = base(extra);
    assert.deepEqual(ids(old, { code: 'yes ' }, { ref: 'x' }), ['code', 'pick', 'notes'], 'the follow-up stays hidden');
    assert.deepEqual(ids(old, { code: 'yes' }, { ref: 'x' }), ['code', 'more', 'pick', 'notes']);
    assert.deepEqual(validateSubmission(old, { code: 'yes ' }).errors, {}, 'and the server does not ask for it');
    assert.deepEqual(validateSubmission(old, { code: 'yes ' }).answers, { code: 'yes' }, 'the answer is stored tidied');
    assert.deepEqual(ids(old, { code: 'skip ' }), ['code', 'pick', 'notes'], 'the jump does not run');
    // The historical mismatch itself: the walk read it as typed, the ending reads it tidied.
    assert.equal(validateSubmission(old, { code: 'skip ' }).ending.id, 'skipped');
    assert.equal(formEnding(old, { code: 'skip ' }).id, 'thanks');
  }
});

test('without the policy, a form with hide rules keeps what it had: tidied answers, rule values as written', () => {
  const old = base(hideRules);
  assert.deepEqual(ids(old, { code: 'yes ' }), ['code', 'more', 'pick', 'notes']);
  assert.deepEqual(offered(old, { code: 'yes ' }), ['a', 'c']);
  const spaced = base({ choice_rules: [{ field: 'pick', rules: [{ when: is('code', 'yes '), hide: ['b'] }] }] });
  assert.deepEqual(offered(spaced, { code: 'yes' }), ['a', 'b', 'c'], 'a rule value with a space never matched');
  assert.deepEqual(offered(withEvaluationPolicy(spaced), { code: 'yes' }), ['a', 'c'], 'and does with the policy');
});

test('an unknown policy reads as no policy, so a later value cannot change an old release silently', () => {
  assert.deepEqual(ids({ ...base(), evaluation_policy: 'something_else' }, { code: 'yes ' }), ['code', 'pick', 'notes']);
  assert.equal(EVALUATION_POLICY, 'normalized_v1');
  const definition = base();
  const stamped = withEvaluationPolicy(definition);
  assert.equal('evaluation_policy' in definition, false, 'stamping a copy leaves the draft as it is');
  assert.equal(stamped.evaluation_policy, EVALUATION_POLICY);
});

test('type-specific clean-up comes from the question type, for answers and rule values', () => {
  const form = fields => withEvaluationPolicy({ title: 'T', presentation: 'classic', fields });
  const after = (type, value, op = 'equals') => form([{ id: 'q', type, label: 'Q', required: false }, { id: 'n', type: 'short_text', label: 'N', required: false, show_if: { field: 'q', op, value } }]);
  const shows = (definition, answer) => ids(definition, { q: answer }).includes('n');

  assert.equal(shows(after('email', 'boss@example.com'), ' BOSS@Example.com '), true);
  assert.equal(shows(after('email', 'Boss@Example.com'), 'boss@example.com'), true, 'a rule value is cleaned the same way');
  assert.equal(shows(after('email', '@EXAMPLE.com ', 'contains'), 'boss@example.com'), true, 'part of an email is only tidied');
  assert.equal(shows(after('email', 'boss@example.com'), 'not an email'), false);
  assert.equal(validateSubmission(after('email', 'boss@example.com'), { q: 'not an email' }).errors.q.startsWith('Enter a valid email'), true);
  assert.equal(shows(after('short_text', 'a b'), ' a   b '), true);
  assert.equal(shows(after('long_text', 'line one\nline two'), ' line one\r\nline two \n'), true, 'long text keeps its line breaks');
  assert.equal(shows(after('long_text', 'a b'), 'a   b'), false, 'and its inner spacing');
  assert.equal(shows(after('phone', '+91 98765 43210'), ' +91  98765 43210 '), true);
  assert.equal(shows(after('date', '2026-11-06'), ' 2026-11-06 '), true);
  assert.equal(shows(after('short_text', 'yes', 'not_equals'), 'yes '), false, 'is not');
  assert.equal(shows(after('short_text', 'YES', 'contains'), 'oh yes  please'), true, 'includes ignores capitals, as it did');
  assert.equal(shows(after('short_text', undefined, 'answered'), '   '), false, 'only spaces is not an answer');
  assert.equal(shows(after('short_text', undefined, 'not_answered'), '   '), true);

  const choice = form([{ id: 'q', type: 'single_choice', label: 'Q', required: false, options: options('a', 'b') }, { id: 'n', type: 'short_text', label: 'N', required: false, show_if: is('q', 'a') }]);
  assert.deepEqual(ids(choice, { q: 'a' }), ['q', 'n']);
  assert.deepEqual(ids(choice, { q: 'b' }), ['q'], 'option keys are compared as they are');
  const multiple = form([{ id: 'q', type: 'multiple_choice', label: 'Q', required: false, options: options('a', 'b') }, { id: 'n', type: 'short_text', label: 'N', required: false, show_if: { field: 'q', op: 'contains', value: 'a' } }]);
  assert.deepEqual(ids(multiple, { q: ['a', 'b'] }), ['q', 'n']);
  assert.deepEqual(validateSubmission(multiple, { q: ['a', 'a'], n: 'x' }).answers, { q: ['a'], n: 'x' });
});

test('the jump can read its own question, hidden choices still leave, and a bad answer is still refused', () => {
  const definition = withEvaluationPolicy(base(hideRules));
  const answers = { code: 'yes ', more: 'x', pick: 'b' };
  dropHiddenChoices(definition, answers);
  assert.deepEqual(answers, { code: 'yes ', more: 'x' }, 'the browser keeps what was typed, and drops the hidden choice');
  assert.deepEqual(validateSubmission(definition, { code: 'yes', more: 'x', pick: 'b' }).answers, { code: 'yes', more: 'x' });
  assert.deepEqual(Object.keys(validateSubmission(definition, { code: 5 }).errors), ['code']);
  assert.deepEqual(Object.keys(validateSubmission(definition, { code: 'x'.repeat(301) }).errors), ['code']);
});

test('URL parameters keep their own clean-up and limits under the policy', () => {
  for (const definition of [base(VARIANTS['hide rules and URL parameters']), withEvaluationPolicy(base(VARIANTS['hide rules and URL parameters']))]) {
    assert.deepEqual(offered(definition, {}, { ref: ' partner  ' }), ['a', 'b'], 'tidied');
    assert.deepEqual(offered(definition, {}, { ref: 'Partner' }), ['a', 'b', 'c'], 'capitals count');
    assert.deepEqual(offered(definition, {}, { ref: 'partner'.repeat(40) }), ['a', 'b', 'c'], 'oversized is missing');
    assert.deepEqual(offered(definition, {}, {}), ['a', 'b', 'c']);
    assert.deepEqual(offered(definition, { ref: 'partner' }, {}), ['a', 'b', 'c'], 'an answer is never a parameter');
  }
  const typedSameName = withEvaluationPolicy({ title: 'T', presentation: 'classic', url_params: [{ key: 'q' }], fields: [{ id: 'q', type: 'email', label: 'Q', required: false }, { id: 'pick', type: 'single_choice', label: 'P', required: false, options: options('a', 'b') }], choice_rules: [{ field: 'pick', rules: [{ when: { param: 'q', op: 'equals', value: 'Boss@Example.com' }, hide: ['a'] }] }] });
  assert.deepEqual(offered(typedSameName, {}, { q: 'Boss@Example.com' }), ['b'], 'a parameter is not cleaned as the question of the same name');
  assert.deepEqual(offered(typedSameName, {}, { q: 'boss@example.com' }), ['a', 'b']);
});

test('routing reads the same way, and only for versions with the policy', () => {
  const definition = base();
  const routing = rules => ({ rules: rules.map(condition => ({ condition, action: { type: 'message', message: 'Matched' } })), fallback: { type: 'message', message: 'Other' } });
  const message = (rules, answers, version) => chooseAction(routing(rules), answers, version).message;
  const stored = validateSubmission(withEvaluationPolicy(definition), { code: ' yes ', more: 'x' }).answers;
  assert.equal(message([is('code', 'yes')], stored, withEvaluationPolicy(definition)), 'Matched');
  assert.equal(message([is('code', 'yes ')], stored, withEvaluationPolicy(definition)), 'Matched', 'a rule value is cleaned too');
  assert.equal(message([is('code', 'yes ')], stored, definition), 'Other', 'an old version keeps the value as written');
  assert.equal(message([is('code', 'yes')], stored, definition), 'Matched');
  assert.equal(message([is('code', 'yes ')], stored), 'Other', 'no version given behaves as before');
  assert.equal(answerConditionHolds(null, is('code', 'yes'), { code: 'yes' }), true);
  assert.equal(conditionHolds(is('code', 'yes'), { code: 'yes ' }), false, 'the plain comparison is unchanged for bookings and workflows');
  assert.deepEqual(validateSubmission({ fields: [{ id: 'a', type: 'short_text', label: 'A', required: false }] }, { a: ' x ' }).answers, { a: 'x' }, 'booking questions have no policy');
});

test('comparesTypedText finds the only rules the policy can change', () => {
  const choiceOnly = { fields: [{ id: 'q', type: 'single_choice', label: 'Q', options: options('a') }, { id: 'n', type: 'short_text', label: 'N', show_if: is('q', 'a') }] };
  assert.equal(comparesTypedText(choiceOnly), false);
  assert.equal(comparesTypedText({ fields: [{ id: 'q', type: 'short_text', label: 'Q' }, { id: 'n', type: 'short_text', label: 'N', show_if: { field: 'q', op: 'answered' } }] }), false, 'answered ignores spacing anyway');
  assert.equal(comparesTypedText(starterDefinition()), false);
  assert.equal(comparesTypedText(base()), true, 'display rule');
  const typed = { fields: [{ id: 'q', type: 'short_text', label: 'Q' }, { id: 'p', type: 'single_choice', label: 'P', options: options('a') }] };
  assert.equal(comparesTypedText({ ...typed, logic: [{ field: 'q', rules: [{ when: { any: [is('q', 'x')] }, to: { type: 'field', id: 'p' } }] }] }), true, 'jump');
  assert.equal(comparesTypedText({ ...typed, choice_rules: [{ field: 'p', rules: [{ when: is('q', 'x'), hide: ['a'] }] }] }), true, 'hide rule');
  assert.equal(comparesTypedText(typed, { rules: [{ condition: is('q', 'x') }] }), true, 'routing');
  assert.equal(comparesTypedText({ ...typed, url_params: [{ key: 'q' }], choice_rules: [{ field: 'p', rules: [{ when: { param: 'q', op: 'equals', value: 'x' }, hide: ['a'] }] }] }), false, 'a parameter is not a typed answer');
});

test('readiness checks reachability the way the next publish will, and explains an older live version', () => {
  const definition = { ...base({ logic: undefined, endings: undefined }), fields: [{ id: 'mail', type: 'email', label: 'Mail', required: false }, { id: 'n', type: 'short_text', label: 'N', required: false, show_if: is('mail', 'Boss@Example.com') }] };
  delete definition.logic; delete definition.endings;
  assert.deepEqual(unreachableFields(definition, visibleFields).unreachable, [], 'as typed, this rule value can be typed');
  assert.deepEqual(unreachableFields(withEvaluationPolicy(definition), visibleFields).unreachable, [], 'and with the policy the rule value is cleaned the same way');
  const form = { id: 'f', slug: 's', draft: base(), published_version: 1, has_unpublished_changes: false, locked_ids: [], legacy_text_comparison: true, updated_at: 1, created_at: 1, revision: 1, routing: null, published_routing: null };
  const input = { form, live: { ok: true, value: { definition: base(), availability: 'open', accepting: true } }, eventTypes: { ok: true, value: [] }, viewer: { admin: true }, flags: { formsActive: true, meetActive: true }, baseUrl: 'https://x.test', logic: { definitionProblems, visibleFields } };
  const says = result => JSON.stringify(result).includes('compares typed answers exactly as typed');
  assert.equal(says(assessFormReadiness(input)), true);
  assert.equal(assessFormReadiness(input).shareable, true, 'a recommendation, not a blocker');
  assert.equal(says(assessFormReadiness({ ...input, form: { ...form, legacy_text_comparison: undefined } })), false);
});

// Removes the stamp from a stored row, which is exactly what a version published before the policy looks like.
const makeHistorical = (env, formId, version) => {
  const stored = JSON.parse(env.app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = ?', formId, version).definition);
  delete stored.evaluation_policy;
  const text = JSON.stringify(stored);
  env.app.db.run('UPDATE form_versions SET definition = ? WHERE form_id = ? AND version = ?', text, formId, version);
  return text;
};

for (const [name, extra] of Object.entries(VARIANTS)) {
  test(`server: old version, republish and in-flight responses: ${name}`, async () => {
    const env = await setup();
    try {
      const owner = env.client();
      const { ws } = await signUp(owner, 'Owner');
      const forms = `/api/workspaces/${ws.id}/forms`;
      const created = (await owner.post(forms, { definition: base(extra) })).body;
      const published = (await owner.post(`${forms}/${created.id}/publish`)).body;
      assert.equal(published.has_unpublished_changes, false, 'the stamp alone is not an unpublished change');
      const row = version => env.app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = ?', created.id, version).definition;
      assert.equal(JSON.parse(row(1)).evaluation_policy, EVALUATION_POLICY, 'a new publish is stamped');
      assert.equal('evaluation_policy' in published.draft, false, 'the draft is not');
      assert.equal((await env.client().get(`/api/public/forms/${created.slug}`)).body.definition.evaluation_policy, EVALUATION_POLICY, 'the browser reads the same policy');

      const oldText = makeHistorical(env, created.id, 1);
      // As a current browser: older ones are covered by forms-rollout-compat.test.mjs.
      const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, { evaluator: 2, ...body });
      const stored = id => env.app.db.get('SELECT form_version, answers FROM responses WHERE id = ?', id);
      const flagged = (await owner.get(`${forms}/${created.id}`)).body;
      assert.equal(flagged.legacy_text_comparison, true, 'this form has a rule the policy would change');
      assert.equal(flagged.has_unpublished_changes, false, 'still no unpublished change');

      // The old version, live.
      const old = await submit({ answers: { code: 'yes ' } });
      const hasHide = Boolean(extra.choice_rules);
      if (hasHide) assert.equal(old.status, 400, 'a form with hide rules already compared tidied answers');
      else assert.equal(old.status, 201, 'the old version does not ask the follow-up');
      const historical = hasHide ? await submit({ answers: { code: 'yes ', more: 'x' } }) : old;
      assert.equal(historical.status, 201);
      const historicalAnswers = stored(historical.body.id).answers;

      // Republish with no edits.
      const again = (await owner.post(`${forms}/${created.id}/publish`)).body;
      assert.equal(again.published_version, 2);
      assert.equal(again.has_unpublished_changes, false);
      assert.equal(again.legacy_text_comparison, undefined);
      assert.equal(JSON.parse(row(2)).evaluation_policy, EVALUATION_POLICY);
      assert.equal(row(1), oldText, 'the old version is byte for byte as it was');
      assert.equal(stored(historical.body.id).answers, historicalAnswers, 'the historical response too');

      // The new version: consistent, with or without the space.
      for (const code of ['yes', 'yes ']) {
        const refused = await submit({ answers: { code } });
        assert.equal(refused.status, 400, JSON.stringify(code));
        assert.deepEqual(Object.keys(refused.body.error.errors), ['more']);
      }
      const accepted = await submit({ answers: { code: 'yes ', more: 'x' } });
      assert.equal(accepted.status, 201);
      assert.equal(stored(accepted.body.id).form_version, 2);
      assert.deepEqual(JSON.parse(stored(accepted.body.id).answers), { code: 'yes', more: 'x' });
      const jumped = await submit({ answers: { code: 'skip ' } });
      assert.equal(jumped.body.ending.id, 'skipped');
      assert.deepEqual(JSON.parse(stored(jumped.body.id).answers), { code: 'skip' });

      // A response started on the old version follows it after the republish.
      const inFlight = await submit({ answers: hasHide ? { code: 'yes ', more: 'x' } : { code: 'yes ' }, version: 1 });
      assert.equal(inFlight.status, 201);
      assert.equal(inFlight.body.version, 1);
      assert.equal(stored(inFlight.body.id).form_version, 1);

      // The replay of an old response keeps its version's reading.
      const first = await submit({ answers: { code: 'skip ' }, version: 1, submission_id: 'policy-replay-0000001' });
      const replay = await submit({ answers: { code: 'skip ' }, version: 2, submission_id: 'policy-replay-0000001' });
      assert.equal(replay.body.replay, true);
      assert.equal(replay.body.version, 1);
      assert.equal(replay.body.id, first.body.id);
    } finally { await env.close(); }
  });
}

test('server: routing and editing: the policy cannot be set by a request, and an edit after publish is still an unpublished change', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(forms, { definition: { ...base(), evaluation_policy: 'made_up' } })).body;
    assert.equal('evaluation_policy' in created.draft, false, 'not settable on a draft');
    const routed = await owner.raw('PUT', `${forms}/${created.id}/routing`, { routing: { rules: [{ condition: is('code', 'yes '), action: { type: 'message', message: 'Matched' } }], fallback: { type: 'message', message: 'Other' } }, base_revision: created.revision });
    assert.equal(routed.status, 200);
    await owner.post(`${forms}/${created.id}/publish`);
    const stamped = JSON.parse(env.app.db.get('SELECT definition FROM form_versions WHERE form_id = ?', created.id).definition);
    assert.equal(stamped.evaluation_policy, EVALUATION_POLICY, 'and what a request said is not what is stored');

    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const matched = await submit({ answers: { code: 'yes ', more: 'x' } });
    assert.equal(matched.body.next.message, 'Matched', 'routing agrees with the rules before it');
    assert.equal((await submit({ answers: { code: 'other' } })).body.next.message, 'Other');
    const replayed = await submit({ answers: { code: 'yes ', more: 'x' }, submission_id: 'policy-routing-00001' });
    const again = await submit({ answers: { code: 'yes ', more: 'x' }, submission_id: 'policy-routing-00001' });
    assert.equal(replayed.body.next.message, 'Matched');
    assert.equal(again.body.next.message, 'Matched');

    // The same routing on a version from before the policy keeps the rule value as written, on a first submission and a retry.
    const unstamped = makeHistorical(env, created.id, 1);
    const oldRoute = await submit({ answers: { code: 'yes', more: 'x' }, submission_id: 'policy-routing-00002' });
    assert.equal(oldRoute.body.next.message, 'Other');
    assert.equal((await submit({ answers: { code: 'yes', more: 'x' }, submission_id: 'policy-routing-00002' })).body.next.message, 'Other');
    env.app.db.run('UPDATE form_versions SET definition = ? WHERE form_id = ? AND version = 1', JSON.stringify(withEvaluationPolicy(JSON.parse(unstamped))), created.id);

    const current = (await owner.get(`${forms}/${created.id}`)).body;
    assert.equal(current.has_unpublished_changes, false);
    assert.equal(current.legacy_text_comparison, undefined);
    const edited = await owner.patch(`${forms}/${created.id}`, { definition: { ...base(), title: 'Changed' }, base_revision: current.revision });
    assert.equal(edited.body.has_unpublished_changes, true);
    const reverted = await owner.patch(`${forms}/${created.id}`, { definition: base(), base_revision: edited.body.revision });
    assert.equal(reverted.body.has_unpublished_changes, false, 'back to what is live');

    // A form with no typed-text rule is not flagged, even from before the policy.
    const plain = (await owner.post(forms, { definition: { title: 'Choice', description: '', presentation: 'classic', submit_label: 'Send', fields: [{ id: 'q', type: 'single_choice', label: 'Q', required: true, options: options('a') }] } })).body;
    await owner.post(`${forms}/${plain.id}/publish`);
    makeHistorical(env, plain.id, 1);
    const unflagged = (await owner.get(`${forms}/${plain.id}`)).body;
    assert.equal(unflagged.legacy_text_comparison, undefined);
    assert.equal(unflagged.has_unpublished_changes, false);
    assert.deepEqual(normalizeDefinition(unflagged.draft), unflagged.draft);
  } finally { await env.close(); }
});
