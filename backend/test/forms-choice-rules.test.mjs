// Hide-choice rules: one evaluator for preview, the public form and server validation, so a hidden
// choice is never offered, never stored and never triggers anything, whatever a request claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { choiceRuleConflicts, definitionProblems, dropHiddenChoices, formEnding, formScreens, starterDefinition, validateSubmission, visibleFields, visiblePages } from '../src/shared/forms-logic.mjs';
import { chooseAction, normalizeDefinition } from '../src/forms/service.mjs';
import { canHideChoices, choiceRuleSentence, choiceRuleSources, choiceRulesFor, dropChoiceRulesFor, dropOrphanChoiceRules, newChoiceRule, renameInChoiceRules, setChoiceRules } from '../../frontend/js/forms-choice-rules.mjs';
import { contactInfoBlock, dropItem, moveItem } from '../../frontend/js/forms-groups.mjs';
import { logicMapModel } from '../../frontend/js/forms-logicmap.mjs';
import { draftChanges, unreachableFields } from '../../frontend/js/forms-readiness.mjs';
import { dependentRules, planTypeChange } from '../../frontend/js/forms-type-change.mjs';

const is = (field, value) => ({ field, op: 'equals', value });
const options = (...ids) => ids.map(id => ({ id, label: id.toUpperCase() }));
const form = (extra = {}) => ({
  title: 'Support', description: '', presentation: 'conversational', submit_label: 'Send',
  fields: [
    { id: 'plan', type: 'single_choice', label: 'Plan', required: true, options: options('free', 'team', 'closed') },
    { id: 'help', type: 'single_choice', label: 'How can we help?', required: true, options: options('email', 'phone', 'visit') },
    { id: 'extras', type: 'multiple_choice', label: 'Extras', required: false, options: options('sla', 'audit', 'guide') },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false }
  ],
  choice_rules: [
    { field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone', 'visit'] }, { when: is('plan', 'closed'), hide: ['email', 'phone', 'visit'] }] },
    { field: 'extras', rules: [{ when: is('plan', 'free'), hide: ['sla'] }] }
  ],
  logic: [
    { field: 'help', rules: [{ when: is('help', 'phone'), to: { type: 'ending', id: 'callback' } }] },
    { field: 'extras', rules: [{ when: { field: 'extras', op: 'contains', value: 'sla' }, to: { type: 'ending', id: 'callback' } }] }
  ],
  endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'callback', title: 'We will call you' }],
  ...extra
});
const shown = (definition, answers, id) => visibleFields(definition, answers).find(field => field.id === id);
const offered = (definition, answers, id) => shown(definition, answers, id)?.options.map(option => option.id);

test('a form without hide-choice rules behaves and stores exactly as before', () => {
  const starter = starterDefinition();
  const stored = normalizeDefinition(starter);
  assert.equal('choice_rules' in stored, false);
  assert.deepEqual(normalizeDefinition({ ...starter, choice_rules: [] }), stored);
  const walked = visibleFields(starter, { topic: 'other' });
  assert.ok(walked.every(field => starter.fields.includes(field)), 'the very same question objects, not copies');
  // Text is compared as typed, as published forms always did; only forms with these rules tidy it first.
  assert.deepEqual(visibleFields(starter, { topic: 'other ' }).map(field => field.id), ['name', 'email', 'topic']);
  const before = { name: 'A', topic: 'support', email: 'a@example.com' };
  dropHiddenChoices(starter, before);
  assert.deepEqual(before, { name: 'A', topic: 'support', email: 'a@example.com' });
  assert.deepEqual(validateSubmission(starter, { name: ' A ', email: 'A@Example.com', topic: 'support', details: 'dropped' }), { answers: { name: 'A', email: 'a@example.com', topic: 'support' }, errors: {} });
});

test('partial hiding offers only the remaining choices, in order, without touching the definition', () => {
  const definition = form();
  assert.deepEqual(definitionProblems(definition), []);
  assert.deepEqual(choiceRuleConflicts(definition), []);
  assert.deepEqual(offered(definition, {}, 'help'), ['email', 'phone', 'visit']);
  assert.deepEqual(offered(definition, { plan: 'team' }, 'help'), ['email', 'phone', 'visit']);
  assert.deepEqual(offered(definition, { plan: 'free' }, 'help'), ['email']);
  assert.equal(definition.fields[1].options.length, 3);
  assert.deepEqual(formScreens(definition, { plan: 'free' }, 'conversational')[1][0].options.map(option => option.id), ['email']);
  assert.deepEqual(visiblePages(definition, { plan: 'free' }, 'classic').flat()[1].options.map(option => option.id), ['email']);
});

test('every rule that holds adds to what is hidden', () => {
  const definition = form({ logic: [], endings: [], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }, { when: { field: 'plan', op: 'answered' }, hide: ['visit'] }] }] });
  assert.deepEqual(offered(definition, { plan: 'free' }, 'help'), ['email']);
  assert.deepEqual(offered(definition, { plan: 'team' }, 'help'), ['email', 'phone']);
});

test('a selected choice that becomes hidden leaves the answer: required asks again, optional stores nothing', () => {
  const required = validateSubmission(form(), { plan: 'free', help: 'phone' });
  assert.deepEqual(Object.keys(required.errors), ['help'], 'required, and the hidden choice does not count');
  assert.equal(required.answers.help, undefined);

  const optional = form({ fields: form().fields.map(field => field.id === 'help' ? { ...field, required: false } : field) });
  assert.deepEqual(validateSubmission(optional, { plan: 'free', help: 'phone' }), { answers: { plan: 'free' }, errors: {}, ending: optional.endings[0] });
});

test('all choices hidden: the question is skipped even when required, stays blank and runs no jump', () => {
  const definition = form();
  const answers = { plan: 'closed', help: 'phone', notes: 'still here' };
  assert.deepEqual(visibleFields(definition, answers).map(field => field.id), ['plan', 'extras', 'notes']);
  const result = validateSubmission(definition, answers);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.answers, { plan: 'closed', notes: 'still here' });
  assert.equal(result.ending.id, 'thanks', 'the crafted answer did not use its jump to the callback ending');
  assert.equal(formEnding(definition, answers).id, 'thanks');
});

test('a later rule reading a skipped question treats it as empty', () => {
  const fields = [...form().fields.slice(0, 2), { id: 'why', type: 'short_text', label: 'Why not?', required: false, show_if: { field: 'help', op: 'not_answered' } }];
  const definition = form({ fields, logic: [], endings: [], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'closed'), hide: ['email', 'phone', 'visit'] }] }] });
  assert.deepEqual(visibleFields(definition, { plan: 'closed', help: 'email' }).map(field => field.id), ['plan', 'why']);
  assert.deepEqual(visibleFields(definition, { plan: 'team', help: 'email' }).map(field => field.id), ['plan', 'help']);
});

test('Back with a changed answer recalculates, and a removed selection does not come back by itself', () => {
  const definition = form();
  const answers = { plan: 'team', help: 'phone', extras: ['sla', 'guide'] };
  dropHiddenChoices(definition, answers);
  assert.deepEqual(answers, { plan: 'team', help: 'phone', extras: ['sla', 'guide'] }, 'nothing hidden yet');

  answers.plan = 'free'; // went Back and changed the first answer
  dropHiddenChoices(definition, answers);
  assert.deepEqual(answers, { plan: 'free', extras: ['guide'] });
  assert.deepEqual(offered(definition, answers, 'help'), ['email']);

  answers.plan = 'team'; // and changed it back
  dropHiddenChoices(definition, answers);
  assert.deepEqual(offered(definition, answers, 'help'), ['email', 'phone', 'visit'], 'the choices return');
  assert.deepEqual(answers, { plan: 'team', extras: ['guide'] }, 'the selection does not');

  answers.help = 'visit';
  answers.plan = 'closed';
  dropHiddenChoices(definition, answers);
  assert.equal('help' in answers, false, 'a question that was skipped loses its answer too');
});

test('multi-select keeps the visible choices and drops only the hidden one, including from its jump', () => {
  const definition = form();
  const kept = validateSubmission(definition, { plan: 'free', help: 'email', extras: ['sla', 'audit'] });
  assert.deepEqual(kept.errors, {});
  assert.deepEqual(kept.answers, { plan: 'free', help: 'email', extras: ['audit'] });
  assert.equal(kept.ending.id, 'thanks', 'the hidden choice does not trigger its jump');
  assert.deepEqual(visibleFields(definition, { plan: 'free', help: 'email', extras: ['sla'] }).map(field => field.id), ['plan', 'help', 'extras', 'notes']);

  const allowed = validateSubmission(definition, { plan: 'team', help: 'email', extras: ['sla'] });
  assert.equal(allowed.ending.id, 'callback', 'the same answer does jump when the choice is not hidden');
  assert.deepEqual(visibleFields(definition, { plan: 'team', help: 'email', extras: ['sla'] }).map(field => field.id), ['plan', 'help', 'extras']);

  const required = form({ fields: form().fields.map(field => field.id === 'extras' ? { ...field, required: true } : field) });
  assert.equal(validateSubmission(required, { plan: 'free', help: 'email', extras: ['sla'] }).errors.extras, 'That choice is not available. Choose another.');
  assert.deepEqual(Object.keys(validateSubmission(form(), { plan: 'free', help: 'email', extras: 'audit' }).errors), ['extras'], 'a malformed answer is still refused');
  assert.deepEqual(Object.keys(validateSubmission(form(), { plan: 'free', help: ['email'] }).errors), ['help']);
});

test('a hidden answer cannot feed a later rule, a display condition or a chain of hide rules', () => {
  const fields = [
    ...form().fields.slice(0, 2),
    { id: 'phone_no', type: 'phone', label: 'Number', required: true, show_if: is('help', 'phone') },
    { id: 'hours', type: 'single_choice', label: 'Hours', required: true, options: options('am', 'pm') },
    { id: 'pref', type: 'single_choice', label: 'Prefer', required: true, options: options('x', 'y') }
  ];
  const definition = form({ fields, logic: [], endings: [], choice_rules: [
    { field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] },
    { field: 'hours', rules: [{ when: is('help', 'phone'), hide: ['am'] }] },
    { field: 'pref', rules: [{ when: is('hours', 'am'), hide: ['x', 'y'] }] }
  ] });
  const crafted = validateSubmission(definition, { plan: 'free', help: 'phone', hours: 'am' });
  assert.deepEqual(crafted.errors.help, 'That choice is not available. Choose another.');
  assert.equal(crafted.errors.phone_no, undefined, 'the display rule did not see the hidden answer');
  assert.deepEqual(offered(definition, { plan: 'free', help: 'phone' }, 'hours'), ['am', 'pm'], 'nor did the next hide rule');
  assert.deepEqual(validateSubmission(definition, { plan: 'team', help: 'email', hours: 'am', pref: 'x' }), { answers: { plan: 'team', help: 'email', hours: 'am' }, errors: {} }, 'a fully hidden question at the end of a chain');
});

test('post-submit routing reads only the accepted answers, so a hidden choice cannot steer it either', () => {
  const routing = { rules: [{ condition: is('help', 'phone'), action: { type: 'message', message: 'Calling you' } }], fallback: { type: 'message', message: 'Thanks' } };
  const definition = form();
  assert.equal(chooseAction(routing, validateSubmission(definition, { plan: 'closed', help: 'phone' }).answers).message, 'Thanks');
  assert.equal(chooseAction(routing, validateSubmission(definition, { plan: 'team', help: 'phone' }).answers).message, 'Calling you');
});

test('text is compared as it would be stored, so spacing and case cannot slip past a rule', () => {
  const definition = {
    title: 'T', presentation: 'classic', fields: [
      { id: 'code', type: 'short_text', label: 'Code', required: false },
      { id: 'mail', type: 'email', label: 'Email', required: false },
      { id: 'pick', type: 'single_choice', label: 'Pick', required: false, options: options('a', 'b', 'c') }
    ],
    choice_rules: [{ field: 'pick', rules: [{ when: is('code', 'VIP pass'), hide: ['a'] }, { when: is('mail', 'boss@example.com'), hide: ['b'] }] }]
  };
  for (const code of ['VIP pass', '  VIP   pass ', 'VIP\tpass']) assert.deepEqual(validateSubmission(definition, { code, pick: 'a' }).answers, { code: 'VIP pass' }, JSON.stringify(code));
  assert.deepEqual(validateSubmission(definition, { mail: 'BOSS@Example.com', pick: 'b' }).answers, { mail: 'boss@example.com' });
  assert.deepEqual(validateSubmission(definition, { code: 'other', pick: 'a' }).answers, { code: 'other', pick: 'a' });
  assert.deepEqual(offered(definition, { code: ' VIP pass ' }, 'pick'), ['b', 'c'], 'the browser sees what the server sees');
});

test('a rule holding on a question the respondent never reached does nothing', () => {
  const definition = form({ logic: [{ field: 'plan', rules: [{ when: is('plan', 'team'), to: { type: 'field', id: 'help' } }] }], endings: [] });
  const fields = [definition.fields[0], { id: 'seat', type: 'single_choice', label: 'Seat', required: false, options: options('one'), show_if: is('plan', 'free') }, ...definition.fields.slice(1)];
  const withSkip = { ...definition, fields, choice_rules: [{ field: 'help', rules: [{ when: is('seat', 'one'), hide: ['email'] }] }] };
  assert.deepEqual(offered(withSkip, { plan: 'team', seat: 'one' }, 'help'), ['email', 'phone', 'visit'], 'the skipped answer is ignored');
  assert.deepEqual(offered(withSkip, { plan: 'free', seat: 'one' }, 'help'), ['phone', 'visit']);
});

test('conflicts name what is wrong, and a conflicting rule does nothing, in preview and on the server', () => {
  const base = () => form({ logic: [], endings: [] });
  const conflictsOf = definition => choiceRuleConflicts(definition).map(conflict => conflict.message);

  const removedHidden = base();
  removedHidden.fields[1].options = options('email', 'visit');
  assert.match(conflictsOf(removedHidden)[0], /hides a choice that is no longer in this question/);
  assert.deepEqual(offered(removedHidden, { plan: 'free' }, 'help'), ['email', 'visit'], 'inert until repaired');

  const removedSource = base();
  removedSource.fields[0].options = options('team', 'closed');
  assert.match(conflictsOf(removedSource)[0], /depends on an option that is no longer in “Plan”/);

  const sourceAfter = base();
  sourceAfter.fields.reverse();
  assert.ok(conflictsOf(sourceAfter).some(message => /earlier question/.test(message)));

  const sourceGone = base();
  sourceGone.fields.shift();
  assert.ok(conflictsOf(sourceGone).every(message => /earlier question/.test(message)));

  const targetGone = base();
  targetGone.fields.splice(1, 1);
  assert.deepEqual(choiceRuleConflicts(targetGone)[0].rule, null);
  assert.match(conflictsOf(targetGone)[0], /no longer in the form/);

  const notChoice = base();
  notChoice.fields[1] = { id: 'help', type: 'short_text', label: 'How can we help?' };
  assert.match(conflictsOf(notChoice)[0], /only a single or multiple choice question/);

  const empty = base();
  empty.choice_rules[0].rules[0].hide = [];
  assert.match(conflictsOf(empty)[0], /at least one choice/);

  const blank = base();
  blank.fields.unshift({ id: 'code', type: 'short_text', label: 'Code' });
  blank.choice_rules = [{ field: 'help', rules: [{ when: is('code', '  '), hide: ['phone'] }] }];
  assert.match(conflictsOf(blank)[0], /needs a value/);

  const scored = base();
  scored.choice_rules = [{ field: 'help', rules: [{ when: { field: 'score', op: 'equals', value: '1' }, hide: ['phone'] }] }];
  assert.match(conflictsOf(scored)[0], /earlier question/, 'a variable, score or URL parameter is not a rule input');

  const self = base();
  self.choice_rules = [{ field: 'help', rules: [{ when: is('help', 'email'), hide: ['phone'] }] }];
  assert.match(conflictsOf(self)[0], /earlier question/, 'a question cannot read its own answer');
});

test('the stored shape is checked on every save; junk is refused while a repairable conflict is kept', () => {
  const bad = choice_rules => definitionProblems(form({ choice_rules }));
  assert.ok(bad('rules').length);
  assert.ok(bad([{ rules: [] }]).length);
  assert.ok(bad([{ field: 'help', rules: [] }]).length);
  assert.ok(bad([{ field: 'help', rules: [{ hide: ['phone'] }] }]).length);
  assert.ok(bad([{ field: 'help', rules: [{ when: is('plan', 'free'), hide: 'phone' }] }]).length);
  assert.ok(bad([{ field: 'help', rules: [{ when: is('plan', 'free'), hide: [1] }] }]).length);
  assert.ok(bad([{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }, { field: 'help', rules: [{ when: is('plan', 'team'), hide: ['phone'] }] }]).length);
  assert.throws(() => normalizeDefinition(form({ choice_rules: [{ field: 'help', rules: [{ when: 'always', hide: ['phone'] }] }] })));

  const kept = normalizeDefinition(form({ choice_rules: [{ field: 'help', extra: 1, rules: [{ when: { ...is('plan', 'free'), extra: 1 }, hide: ['gone'], extra: 1 }] }] }));
  assert.deepEqual(kept.choice_rules, [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['gone'] }] }], 'only known keys, and the conflict is kept to repair');
  assert.deepEqual(normalizeDefinition(kept), kept, 'normalizing twice gives identical JSON');
});

test('moving a rule-bearing question onto a multi-question page keeps the rule and raises a conflict; moving off clears it', () => {
  const page = contactInfoBlock([]).slice(0, 3);
  const plan = form().fields[0];
  const help = form().fields[1];
  const definition = { title: 'T', presentation: 'classic', fields: [plan, help, ...page], choice_rules: [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }] };
  assert.deepEqual(choiceRuleConflicts(definition), []);
  assert.equal(canHideChoices(help), true);

  // Dragged between the page's questions.
  const moved = dropItem(definition.fields, 1, 4);
  assert.equal(definition.fields[moved.to].group, page[0].id);
  assert.equal(canHideChoices(definition.fields[moved.to]), false);
  assert.equal(definition.choice_rules.length, 1, 'the rule is not silently removed');
  const [conflict] = choiceRuleConflicts(definition);
  assert.equal(conflict.field, 'help');
  assert.match(conflict.message, /inside the page “Contact Info”/);
  assert.deepEqual(offered(definition, { plan: 'free' }, 'help'), ['email', 'phone', 'visit'], 'unsupported there, so it does nothing');
  assert.deepEqual(validateSubmission(definition, { plan: 'free', help: 'phone', first_name: 'A', last_name: 'B' }).answers.help, 'phone');

  // The ↑ control steps it back off the page; the conflict clears and the rule works again.
  while (definition.fields.find(field => field.id === 'help').group != null) moveItem(definition.fields, definition.fields.findIndex(field => field.id === 'help'), -1);
  assert.deepEqual(choiceRuleConflicts(definition), []);
  assert.deepEqual(offered(definition, { plan: 'free' }, 'help'), ['email', 'visit']);

  // A source on a page is fine: only the question that hides choices must stay off the page.
  const sourceOnPage = { title: 'T', presentation: 'classic', fields: [...page, help], choice_rules: [{ field: 'help', rules: [{ when: { field: page[1].id, op: 'answered' }, hide: ['phone'] }] }] };
  assert.deepEqual(choiceRuleConflicts(sourceOnPage), []);
  assert.deepEqual(offered(sourceOnPage, { [page[1].id]: 'A' }, 'help'), ['email', 'visit']);
});

test('builder helpers: words, keys, removal, reachability and type changes', () => {
  const definition = form();
  const help = definition.fields[1];
  assert.equal(choiceRuleSentence(choiceRulesFor(definition, 'help')[0], help, definition.fields), 'When “Plan” is “FREE”, hide “PHONE” and “VISIT”.');
  assert.equal(choiceRuleSentence(choiceRulesFor(definition, 'help')[1], help, definition.fields), 'When “Plan” is “CLOSED”, hide every choice, so this question is skipped.');
  assert.match(choiceRuleSentence({ when: is('plan', 'free'), hide: ['gone'] }, help, definition.fields), /hide a choice that was removed/);

  assert.deepEqual(choiceRuleSources(definition, 1).map(field => field.id), ['plan']);
  assert.deepEqual(newChoiceRule(definition, 1), { when: is('plan', 'free'), hide: ['email'] });

  renameInChoiceRules(definition, 'plan', 'tier');
  assert.equal(definition.choice_rules[0].rules[0].when.field, 'tier');
  renameInChoiceRules(definition, 'help', 'support');
  assert.equal(definition.choice_rules[0].field, 'support');

  setChoiceRules(definition, 'support', []);
  assert.deepEqual(definition.choice_rules.map(entry => entry.field), ['extras']);
  setChoiceRules(definition, 'help', [{ when: is('plan', 'team'), hide: ['visit'] }]);
  assert.equal(dropChoiceRulesFor(definition, ['extras', 'help', 'none']), 2);
  assert.equal('choice_rules' in definition, false);
  definition.choice_rules = [{ field: 'gone', rules: [{ when: is('plan', 'team'), hide: ['visit'] }] }];
  assert.equal(dropOrphanChoiceRules(definition), 1);
  assert.equal('choice_rules' in definition, false);

  const plain = form({ logic: [], endings: [] });
  assert.equal(unreachableFields(plain, visibleFields).reason, 'choice_rules', 'readiness says it did not check, rather than guessing');
  assert.deepEqual(draftChanges(plain, { ...plain, choice_rules: [] }), ['hide-choice rules changed']);

  const map = logicMapModel(form());
  assert.deepEqual(map.choices.filter(rule => rule.field === 'extras').map(rule => rule.sentence), ['When “Plan” is “FREE”, hide “SLA”.']);
  assert.deepEqual(map.conflicts, []);
  assert.deepEqual(map.jumps.map(jump => jump.from), ['help', 'extras'], 'hiding a choice is not a jump');

  const source = form().fields[0];
  assert.equal(dependentRules('plan', form().fields, null, form().choice_rules).length, 3);
  const plan = planTypeChange({ field: source, to: 'short_text', fields: form().fields, choiceRules: form().choice_rules, newKey: () => 'k' });
  assert.equal(plan.kind, 'blocked', 'a rule compares its options, so they cannot silently disappear');
  assert.equal(plan.rules.length, 3);
});

test('server: an invalid rule is saved for repair, reported by the publish check and refused by publish', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(base, { definition: form() })).body;
    const broken = form({ logic: [], endings: [] });
    broken.fields[1].options = options('email', 'visit');
    const saved = await owner.patch(`${base}/${created.id}`, { definition: broken, base_revision: created.revision });
    assert.equal(saved.status, 200, 'the draft keeps the conflict');
    assert.deepEqual(saved.body.draft.choice_rules[0].rules[0].hide, ['phone', 'visit']);

    const check = await owner.post(`${base}/${created.id}/publish-check`, { base_revision: saved.body.revision });
    assert.equal(check.body.can_publish, false);
    assert.equal(check.body.problems[0].field, 'choice_rules');
    assert.match(check.body.problems[0].message, /no longer in this question/);

    const refused = await owner.post(`${base}/${created.id}/publish`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /no longer in this question/);
    assert.equal((await owner.get(`${base}/${created.id}`)).body.published_version, null);
    assert.equal((await env.client().get(`/api/public/forms/${created.slug}`)).status, 404, 'nothing went live');

    const grouped = form({ logic: [], endings: [] });
    grouped.fields.splice(1, 0, { id: 'page', type: 'page_break', label: 'Details', grouped: true });
    grouped.fields[2].group = 'page';
    grouped.choice_rules = [{ field: 'help', rules: [{ when: is('plan', 'free'), hide: ['phone'] }] }];
    const current = (await owner.get(`${base}/${created.id}`)).body;
    await owner.patch(`${base}/${created.id}`, { definition: grouped, base_revision: current.revision });
    const onPage = await owner.post(`${base}/${created.id}/publish`);
    assert.equal(onPage.status, 400);
    assert.match(onPage.body.error.message, /multi-question page/);

    const latest = (await owner.get(`${base}/${created.id}`)).body;
    await owner.patch(`${base}/${created.id}`, { definition: form(), base_revision: latest.revision });
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 1, 'repaired, it publishes');
  } finally { await env.close(); }
});

test('server: publish to inbox and CSV; crafted requests store no hidden choice and trigger no jump', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(base, { definition: form() })).body;
    await owner.post(`${base}/${created.id}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const inbox = async () => (await owner.get(`${base}/${created.id}/responses`)).body.responses;
    const stored = async response => (await inbox()).find(item => item.id === response.body.id)?.answers;
    const live = (await env.client().get(`/api/public/forms/${created.slug}`)).body;
    assert.deepEqual(live.definition.choice_rules, form().choice_rules, 'respondents receive the rules the browser evaluates');

    // Partial hiding, honest answer.
    const partial = await submit({ answers: { plan: 'free', help: 'email', extras: ['audit'] } });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.ending.id, 'thanks');
    assert.deepEqual(await stored(partial), { plan: 'free', help: 'email', extras: ['audit'] });

    // A required question answered only with a hidden choice is refused, and nothing is stored or counted.
    const before = (await inbox()).length;
    const refused = await submit({ answers: { plan: 'free', help: 'phone' } });
    assert.equal(refused.status, 400);
    assert.deepEqual(Object.keys(refused.body.error.errors), ['help']);
    assert.equal((await inbox()).length, before);

    // Hidden choice next to a visible one on a multi-select, aiming at that choice's jump.
    const crafted = await submit({ answers: { plan: 'free', help: 'email', extras: ['sla', 'audit'] } });
    assert.equal(crafted.status, 201);
    assert.equal(crafted.body.ending.id, 'thanks');
    assert.deepEqual(await stored(crafted), { plan: 'free', help: 'email', extras: ['audit'] });

    // Fully hidden required question: skipped, blank, and its crafted answer cannot jump.
    const skipped = await submit({ answers: { plan: 'closed', help: 'phone', notes: 'closed account' } });
    assert.equal(skipped.status, 201);
    assert.equal(skipped.body.ending.id, 'thanks');
    assert.deepEqual(await stored(skipped), { plan: 'closed', notes: 'closed account' });

    // The same answers where nothing is hidden still jump, so the rules above are what stopped them.
    const allowed = await submit({ answers: { plan: 'team', help: 'phone' } });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.ending.id, 'callback');
    assert.deepEqual(await stored(allowed), { plan: 'team', help: 'phone' });

    const responses = await inbox();
    assert.ok(responses.filter(item => item.answers.plan !== 'team').every(item => item.answers.help !== 'phone' && !item.answers.extras?.includes('sla')), 'no stored response holds a hidden choice');

    const csv = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(rows.length, 5);
    const cell = (row, index) => row.split('","')[index].replace(/^"|"$/g, '');
    const header = rows[0].split('","').map(text => text.replace(/^"|"$/g, ''));
    const at = header.indexOf('How can we help?');
    const inCsv = rows.slice(1).map(row => [cell(row, header.indexOf('Plan')), cell(row, at), cell(row, header.indexOf('Extras'))].join('|')).sort();
    assert.deepEqual(inCsv, ['CLOSED||', 'FREE|EMAIL|AUDIT', 'FREE|EMAIL|AUDIT', 'TEAM|PHONE|'], 'the skipped question is blank, and a hidden choice has no label anywhere');
  } finally { await env.close(); }
});

test('server: each response follows the rules of the version it answered, and older forms keep working', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const plain = form({ choice_rules: [], logic: [], endings: [] });
    const created = (await owner.post(base, { definition: plain })).body;
    await owner.post(`${base}/${created.id}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const inbox = async () => (await owner.get(`${base}/${created.id}/responses`)).body.responses;
    const stored = async response => (await inbox()).find(item => item.id === response.body.id);

    const old = await submit({ answers: { plan: 'free', help: 'phone' }, version: 1 });
    assert.equal(old.status, 201);
    assert.deepEqual((await stored(old)).answers, { plan: 'free', help: 'phone' }, 'version 1 has no rule, and nothing changes for it');

    const current = (await owner.get(`${base}/${created.id}`)).body;
    await owner.patch(`${base}/${created.id}`, { definition: form({ logic: [], endings: [] }), base_revision: current.revision });
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 2);

    assert.equal((await submit({ answers: { plan: 'free', help: 'phone' }, version: 2 })).status, 400, 'version 2 applies its rule');
    const pinned = await submit({ answers: { plan: 'free', help: 'phone' }, version: 1 });
    assert.equal(pinned.status, 201, 'someone still on version 1 is judged by version 1');
    assert.equal(pinned.body.version, 1);
    const skipped = await submit({ answers: { plan: 'closed' }, version: 2 });
    assert.equal(skipped.status, 201, 'version 2 skips the required question');
    assert.deepEqual((await stored(skipped)).answers, { plan: 'closed' });
    assert.equal((await stored(skipped)).form_version, 2);

    // A retry replays the first accepted response; its changed answers can neither add a hidden choice nor store anything.
    const first = await submit({ answers: { plan: 'free', help: 'email' }, version: 2, submission_id: 'choice-rules-retry-001' });
    const retry = await submit({ answers: { plan: 'free', help: 'phone' }, version: 2, submission_id: 'choice-rules-retry-001' });
    assert.equal(first.status, 201);
    assert.equal(retry.body.replay, true);
    assert.equal(retry.body.answers_changed, true);
    assert.deepEqual((await stored(first)).answers, { plan: 'free', help: 'email' });
  } finally { await env.close(); }
});
