// Forms "Ready to share?" (frontend/js/forms-readiness.mjs): draft vs live, the shared validator,
// unreachable questions, routing destinations by role, and no state invented from the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessFormReadiness, conditionSentence, draftChanges, placeholderIssues, unreachableFields } from '../../frontend/js/forms-readiness.mjs';
import { conditionHolds, definitionProblems, visibleFields } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { setup, signUp, publishedEventType, START } from './helpers.mjs';

const logic = { definitionProblems, visibleFields };
const ok = value => ({ ok: true, value });
const definition = (fields, extra = {}) => ({ title: 'Enquiry', description: '', presentation: 'classic', submit_label: 'Send', fields, ...extra });
const basic = definition([
  { id: 'name', type: 'short_text', label: 'Your name', required: true },
  { id: 'kind', type: 'single_choice', label: 'What do you need?', required: true, options: [{ id: 'team', label: 'Team' }, { id: 'solo', label: 'Solo' }] }
]);
const savedForm = (overrides = {}) => ({ id: 'f1', slug: 'enquiry', draft: basic, published_version: 1, has_unpublished_changes: false, routing: null, locked_ids: ['name', 'kind'], updated_at: START, ...overrides });
const input = (overrides = {}) => ({
  form: savedForm(), live: ok({ definition: basic, availability: 'open', accepting: true }), eventTypes: ok([]), viewer: { admin: true },
  flags: { formsActive: true, meetActive: true }, baseUrl: 'https://schedora.example', logic, now: START, ...overrides
});
const area = (result, key) => result.areas.find(item => item.key === key);
const texts = (result, kind) => result.areas.flatMap(item => item.items).filter(item => item.kind === kind).map(item => item.text);

test('a live form matching its saved draft, with no routing, has no blockers', () => {
  const result = assessFormReadiness(input());
  assert.deepEqual(result.areas.map(item => [item.key, item.status]), [['versions', 'ready'], ['questions', 'ready'], ['preview', 'ready'], ['after', 'not_required'], ['sharing', 'ready']]);
  assert.equal(result.counts.blocker, 0);
  assert.match(area(result, 'versions').items[0].text, /^Respondents see version 1, which matches your saved draft\./);
  assert.match(area(result, 'after').items[0].text, /The receipt means the response was received, nothing more\./);
  assert.equal(result.link, 'https://schedora.example/f/enquiry');
});

test('draft, closed and changed-but-unpublished states are distinct; nothing publishes', () => {
  const draft = assessFormReadiness(input({ form: savedForm({ published_version: null, locked_ids: [] }), live: null }));
  assert.match(texts(draft, 'blocker')[0], /^Not published\. Nobody can open the link yet\. Publishing happens only when you select Publish\./);
  assert.deepEqual(area(draft, 'versions').items[0].action, { label: 'Go to Publish', section: 'publish' });
  const closed = assessFormReadiness(input({ form: savedForm({ published_version: null }), live: null }));
  assert.match(texts(closed, 'blocker')[0], /^Closed: the link tells people the form is not accepting responses/);
  const changedDraft = definition([...basic.fields, { id: 'phone', type: 'phone', label: 'Phone', required: false }]);
  const changed = assessFormReadiness(input({ form: savedForm({ draft: changedDraft, has_unpublished_changes: true }) }));
  assert.match(texts(changed, 'recommendation')[0], /differs from live version 1: 1 question added\. Respondents keep seeing version 1 until you publish\./);
  assert.deepEqual(draftChanges(basic, definition(basic.fields, { presentation: 'conversational' })), ['presentation changed']);
});

test('the shared validator reports invalid fields and broken conditions as blockers', () => {
  const broken = definition([{ id: 'name', type: 'short_text', label: '', required: true }, { id: 'more', type: 'short_text', label: 'More', show_if: { field: 'missing', op: 'answered' } }]);
  const result = assessFormReadiness(input({ form: savedForm({ draft: broken, has_unpublished_changes: true }) }));
  assert.deepEqual(texts(result, 'blocker'), ['Item 1 needs a question of up to 300 characters.', 'Item 2 logic must refer to an earlier question.']);
});

test('unreachable required questions are found with the shared visibility rules; too many paths are "Not verified"', () => {
  const tricky = definition([
    ...basic.fields,
    { id: 'p2', type: 'page_break', label: '', show_if: { field: 'kind', op: 'equals', value: 'team' } },
    { id: 'size', type: 'short_text', label: 'Team size', required: true, show_if: { field: 'kind', op: 'equals', value: 'solo' } },
    { id: 'goal', type: 'short_text', label: 'Team goal', required: false }
  ]);
  assert.deepEqual(unreachableFields(tricky, visibleFields).unreachable.map(field => field.id), ['size']);
  const result = assessFormReadiness(input({ form: savedForm({ draft: tricky }) }));
  assert.ok(texts(result, 'recommendation').includes('“Team size” can never be shown with these display rules, so it is never asked even though it is required. Respondents can still submit.'));
  assert.equal(texts(result, 'blocker').length, 0, 'respondents can still submit');
  const many = definition(Array.from({ length: 14 }, (_, index) => ({ id: 'q' + index, type: 'short_text', label: 'Q' + index, ...(index ? { show_if: { field: 'q' + (index - 1), op: 'answered' } } : {}) })));
  assert.equal(unreachableFields(many, visibleFields).complete, false);
  assert.ok(texts(assessFormReadiness(input({ form: savedForm({ draft: many }) })), 'unknown').some(text => /too many answer combinations/.test(text)));
});

test('combined text-includes answers are never falsely labelled unreachable', () => {
  const draft = definition([
    { id: 'topic', type: 'short_text', label: 'Topic' },
    { id: 'p2', type: 'page_break', show_if: { field: 'topic', op: 'contains', value: 'red' } },
    { id: 'detail', type: 'short_text', label: 'Detail', required: true, show_if: { field: 'topic', op: 'contains', value: 'blue' } }
  ]);
  assert.deepEqual(definitionProblems(draft), []);
  assert.ok(visibleFields(draft, { topic: 'red blue' }).some(field => field.id === 'detail'), 'the real renderer has a reachable answer path');
  const reach = unreachableFields(draft, visibleFields);
  assert.deepEqual(reach.unreachable, []);
  assert.equal(reach.complete, false);
  const result = assessFormReadiness(input({ form: savedForm({ draft }) }));
  assert.ok(texts(result, 'unknown').some(text => /Text-includes rules/.test(text)));
  assert.ok(!texts(result, 'recommendation').some(text => /can never be shown/.test(text)));
});

test('a sample answer never hides a reachable not-equals question', () => {
  const draft = definition([
    { id: 'topic', type: 'short_text', label: 'Topic' },
    { id: 'p2', type: 'page_break', show_if: { field: 'topic', op: 'answered' } },
    { id: 'detail', type: 'short_text', label: 'Detail', required: true, show_if: { field: 'topic', op: 'not_equals', value: 'any answer' } }
  ]);
  assert.ok(visibleFields(draft, { topic: 'another answer' }).some(field => field.id === 'detail'));
  assert.deepEqual(unreachableFields(draft, visibleFields).unreachable, []);
});

test('server publish results are tied to the saved revision and never replace live-routing evidence', () => {
  const form = savedForm({ revision: 4, published_routing: null, routing: { rules: [], fallback: { type: 'message', message: 'Draft thanks' } } });
  const passed = assessFormReadiness(input({ form, publishCheck: ok({ revision: 4, can_publish: true, problems: [] }) }));
  assert.ok(area(passed, 'questions').items.some(item => /Server publish checks passed for saved revision 4/.test(item.text)));
  assert.ok(area(passed, 'after').items.some(item => /Live version 1: receipt only, with no booking offer/.test(item.text)));
  for (const publishCheck of [{ ok: false }, ok({ revision: 3, can_publish: true, problems: [] })]) {
    const result = assessFormReadiness(input({ form, publishCheck }));
    assert.ok(texts(result, 'unknown').some(text => /could not verify this saved revision/.test(text)));
    assert.ok(!area(result, 'questions').items.some(item => /Server publish checks passed/.test(item.text)));
  }
  const blocked = assessFormReadiness(input({ form, publishCheck: ok({ revision: 4, can_publish: false, problems: [{ field: 'routing', message: 'Destination no longer published.' }] }) }));
  assert.ok(texts(blocked, 'blocker').includes('Server publish check: Destination no longer published.'));
});

test('answer insertions that can only show blank or "…" are flagged', () => {
  const draft = definition([{ id: 'name', type: 'short_text', label: 'Hi {{name}}, and {{budget}}', required: true }, { id: 'budget', type: 'short_text', label: 'Budget' }]);
  assert.deepEqual(placeholderIssues(draft).map(issue => [issue.key, issue.problem]), [['name', 'self'], ['budget', 'later']]);
  assert.deepEqual(placeholderIssues(definition([{ id: 'a', type: 'short_text', label: 'x {{zzz}}' }])).map(issue => issue.problem), ['unknown']);
});

test('booking destinations: published, unpublished, deleted (admin) and invisible (member); a booking offer is not an appointment', () => {
  const routing = event => ({ rules: [{ condition: { field: 'kind', op: 'equals', value: 'solo' }, action: { type: 'event', event_type_id: event } }], fallback: { type: 'message', message: 'Thanks' } });
  const types = ok([{ id: 'e1', title: 'Discovery call', published: true }, { id: 'e2', title: 'Draft call', published: false }]);
  const live = assessFormReadiness(input({ form: savedForm({ routing: routing('e1') }), eventTypes: types }));
  const offer = area(live, 'after').items.find(item => item.status === 'ready');
  assert.match(offer.text, /Rule 1 offers “Discovery call”\. The receipt says “Response received — choose a time”\. Nothing is booked until the respondent picks a time, and only Meet's confirmation means an appointment exists\./);
  assert.equal(offer.action.href, '/meet/event-types/e1', 'links to the event type\'s own readiness summary');
  assert.ok(texts(assessFormReadiness(input({ form: savedForm({ routing: routing('e2') }), eventTypes: types })), 'blocker').some(text => /“Draft call”, which is not published, so publishing is refused/.test(text)));
  assert.ok(texts(assessFormReadiness(input({ form: savedForm({ routing: routing('gone') }), eventTypes: types })), 'blocker').some(text => /was deleted/.test(text)));
  const member = assessFormReadiness(input({ form: savedForm({ routing: routing('gone') }), eventTypes: types, viewer: { admin: false } }));
  assert.equal(texts(member, 'blocker').length, 0);
  assert.ok(texts(member, 'unknown').some(text => /a booking page you cannot see \(another host's\)/.test(text)));
  assert.ok(texts(assessFormReadiness(input({ form: savedForm({ routing: routing('e1') }), eventTypes: types, flags: { formsActive: true, meetActive: false } })), 'blocker').some(text => /need an active Meet or Suite plan/.test(text)));
  const failed = assessFormReadiness(input({ form: savedForm({ routing: routing('e1') }), eventTypes: { ok: false, error: new Error('Offline') } }));
  assert.ok(texts(failed, 'unknown').some(text => /could not be checked \(Offline\)/.test(text)));
});

test('the live form\'s own state: failed check, used-up allowance, inactive plan', () => {
  const failed = assessFormReadiness(input({ live: { ok: false, error: new Error('Timed out') } }));
  assert.equal(area(failed, 'versions').status, 'unverified');
  assert.equal(area(failed, 'sharing').status, 'unverified');
  const full = assessFormReadiness(input({ live: ok({ definition: basic, availability: 'capacity_reached', accepting: false }) }));
  assert.ok(texts(full, 'blocker').some(text => /monthly response allowance is used up/.test(text)));
  const member = assessFormReadiness(input({ viewer: { admin: false }, live: ok({ definition: basic, availability: 'not_accepting', accepting: false }) }));
  assert.ok(member.areas.flatMap(item => item.items).some(item => item.action?.note === 'Ask a workspace owner about the plan.'));
});

test('regression: normalizing a conditional page break twice gives identical JSON', () => {
  const once = normalizeDefinition(definition([...basic.fields, { id: 'p2', type: 'page_break', show_if: { field: 'kind', op: 'equals', value: 'team' } }, { id: 'more', type: 'short_text', label: 'More' }]));
  assert.equal(JSON.stringify(normalizeDefinition(once)), JSON.stringify(once));
});

test('real local API: a form with a conditional page break is not "changed" after publishing; members see only their own event types', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const event = await publishedEventType(owner, ws);
    const created = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition: definition([...basic.fields, { id: 'p2', type: 'page_break', show_if: { field: 'kind', op: 'equals', value: 'team' } }, { id: 'more', type: 'short_text', label: 'More' }]) })).body;
    const routed = (await owner.raw('PUT', `/api/workspaces/${ws.id}/forms/${created.id}/routing`, { routing: { rules: [{ condition: { field: 'kind', op: 'equals', value: 'solo' }, action: { type: 'event', event_type_id: event.id } }], fallback: null }, base_revision: created.revision })).body;
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms/${created.id}/publish`, { base_revision: routed.revision })).body;
    assert.equal(form.has_unpublished_changes, false);
    const live = (await env.client().get(`/api/public/forms/${form.slug}`)).body;
    const assess = async (http, admin) => assessFormReadiness({ form: (await http.get(`/api/workspaces/${ws.id}/forms/${form.id}`)).body, live: ok(live), eventTypes: ok((await http.get(`/api/workspaces/${ws.id}/event-types`)).body),
      viewer: { admin }, flags: { formsActive: true, meetActive: true }, baseUrl: 'http://localhost', logic, now: env.clock.now });
    const asOwner = await assess(owner, true);
    assert.equal(area(asOwner, 'versions').status, 'ready');
    assert.equal(asOwner.counts.blocker, 0);
    const memberHttp = env.client();
    const member = await signUp(memberHttp, 'Member');
    await owner.post(`/api/workspaces/${ws.id}/members`, { email: member.email, role: 'member' });
    const asMember = await assess(memberHttp, false);
    assert.equal(asMember.counts.blocker, 0, 'a member is not told a colleague\'s booking page was deleted');
    assert.ok(texts(asMember, 'unknown').some(text => /cannot see/.test(text)));
    assert.equal((await env.client().get(`/api/public/forms/${form.slug}`)).status, 200);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 0, 'checking readiness creates no response');
  } finally { await env.close(); }
});

test('plain-language conditions say exactly what the shared evaluator does', () => {
  const fields = [
    { id: 'site', type: 'single_choice', label: 'Do you have a website?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    { id: 'kind', type: 'single_choice', label: 'Kind', options: [{ id: 'other', label: 'Other' }, { id: 'another', label: 'Another' }, { id: 'team', label: 'Team' }] },
    { id: 'tools', type: 'multiple_choice', label: 'Tools', options: [{ id: 'a', label: 'Calendar' }, { id: 'b', label: 'Email' }] },
    { id: 'note', type: 'short_text', label: 'Note' }
  ];
  const cases = [
    [{ field: 'site', op: 'equals', value: 'yes' }, 'when “Do you have a website?” is “Yes”', [[{ site: 'yes' }, true], [{ site: 'no' }, false], [{}, false]]],
    [{ field: 'site', op: 'not_equals', value: 'yes' }, 'when “Do you have a website?” is anything other than “Yes”, including unanswered', [[{}, true], [{ site: 'no' }, true], [{ site: 'yes' }, false]]],
    [{ field: 'kind', op: 'contains', value: 'other' }, 'when “Kind” is “Other” or “Another”', [[{ kind: 'other' }, true], [{ kind: 'another' }, true], [{ kind: 'team' }, false]]],
    [{ field: 'tools', op: 'equals', value: 'a' }, 'when “Calendar” is the only choice in “Tools”', [[{ tools: ['a'] }, true], [{ tools: ['a', 'b'] }, false]]],
    [{ field: 'tools', op: 'contains', value: 'a' }, 'when “Calendar” is one of the choices in “Tools”', [[{ tools: ['a', 'b'] }, true], [{ tools: ['b'] }, false]]],
    [{ field: 'tools', op: 'not_equals', value: 'a' }, 'unless “Calendar” is the only choice in “Tools”', [[{ tools: ['a'] }, false], [{ tools: [] }, true], [{ tools: ['a', 'b'] }, true]]],
    [{ field: 'note', op: 'contains', value: 'Urgent' }, 'when the answer to “Note” includes “Urgent” (any capitalisation)', [[{ note: 'very urgent' }, true], [{ note: 'later' }, false]]],
    [{ field: 'note', op: 'not_answered' }, 'when “Note” is left unanswered', [[{ note: ' ' }, true], [{ note: 'x' }, false]]]
  ];
  for (const [condition, sentence, examples] of cases) {
    assert.equal(conditionSentence(condition, fields), sentence);
    for (const [answers, holds] of examples) assert.equal(conditionHolds(condition, answers), holds, `${sentence} with ${JSON.stringify(answers)}`);
  }
  assert.match(conditionSentence({ field: 'gone', op: 'answered' }, fields), /no longer in the form.*cannot match/);
  assert.equal(conditionSentence({ field: 'note', op: 'equals', value: '' }, fields), 'when “Note” is an empty value (no value entered yet: enter one so the rule means what you intend)');
  assert.match(conditionSentence({ field: 'site', op: 'equals', value: 'maybe' }, fields), /no longer exists.*cannot match/);
});
