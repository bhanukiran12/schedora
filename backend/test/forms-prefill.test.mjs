// Prefilled links (docs/FORMS.md, "Prefilled links"): answer.<key>=value fills editable starting answers,
// checked by the same rule as typed answers, and never meets URL parameters, identity or attribution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionValues, prefillAnswers, prefilledLink, prefillProblem, prefillQuery, urlParamValues, validateSubmission, visibleFields } from '../src/shared/forms-logic.mjs';
import { setup, signUp } from './helpers.mjs';

const definition = {
  title: 'Batch check-in', presentation: 'classic',
  url_params: [{ key: 'batch', record: true }],
  fields: [
    { id: 'full_name', type: 'short_text', label: 'Your name', required: true },
    { id: 'student_id', type: 'short_text', label: 'Student ID', required: true },
    { id: 'email', type: 'email', label: 'Email', required: true },
    { id: 'mobile', type: 'phone', label: 'Mobile' },
    { id: 'about', type: 'long_text', label: 'About you' },
    { id: 'batch', type: 'single_choice', label: 'Batch', required: true, options: [{ id: 'jan', label: 'January' }, { id: 'jul', label: 'July' }] },
    { id: 'skills', type: 'multiple_choice', label: 'Skills', options: [{ id: 'js', label: 'JavaScript' }, { id: 'py', label: 'Python' }] },
    { id: 'other_tech', type: 'short_text', label: 'Other technology' },
    { id: 'other_level', type: 'single_choice', label: 'Level', required: true, options: [{ id: 'beg', label: 'Beginner' }, { id: 'adv', label: 'Advanced' }], show_if: { field: 'other_tech', op: 'answered' } },
    { id: 'contact_page', type: 'page_break', label: 'Where you are', grouped: true },
    { id: 'city', type: 'short_text', label: 'City', group: 'contact_page' },
    { id: 'start', type: 'date', label: 'Start date', group: 'contact_page' },
    { id: 'dob', type: 'date', label: 'Date of birth', group: 'contact_page' }
  ]
};

test('only questions safe to put in a link can be prefilled', () => {
  const allowed = definition.fields.filter(field => field.type !== 'page_break' && !prefillProblem(field)).map(field => field.id);
  assert.deepEqual(allowed, ['full_name', 'batch', 'skills', 'other_tech', 'other_level', 'city', 'start']);
  assert.match(prefillProblem(definition.fields[1]), /personal identifier/);
  assert.match(prefillProblem(definition.fields[2]), /Contact details/);
  assert.match(prefillProblem(definition.fields[4]), /Long answers/);
  assert.match(prefillProblem(definition.fields.find(field => field.id === 'dob')), /personal identifier/);
  for (const label of ['Roll No.', 'Hall ticket number', 'Employee code', 'Aadhaar', 'PAN card', 'Passport number', 'Registration number']) assert.ok(prefillProblem({ id: 'x', type: 'short_text', label }), label);
  for (const label of ['Number of projects', 'Company name', 'Pin code', 'GitHub profile link', 'City']) assert.equal(prefillProblem({ id: 'x', type: 'short_text', label }), null, label);
  assert.ok(prefillProblem({ id: 'student_id', type: 'short_text', label: 'Your identifier' }), 'the key counts too');
});

test('a link fills valid values and ignores invalid, unknown and sensitive ones', () => {
  const link = new URLSearchParams('answer.full_name=%20Asha%20%20Rao%20&answer.student_id=S123&answer.email=a%40b.co&answer.mobile=%2B919876543210&answer.batch=jul&answer.batch=jan&answer.skills=js&answer.skills=py&answer.skills=rust&answer.start=2026-02-30&answer.city=Pune&answer.ghost=1&answer.about=hi');
  const { answers, ignored } = prefillAnswers(definition, link);
  assert.deepEqual(answers, { full_name: 'Asha Rao', batch: 'jul', city: 'Pune' }, 'tidied like a typed answer; first value of a single choice');
  assert.deepEqual(ignored.map(item => item.id), ['student_id', 'email', 'mobile', 'about', 'skills', 'start']);
  assert.deepEqual(prefillAnswers(definition, new URLSearchParams('answer.skills=js&answer.skills=py')).answers, { skills: ['js', 'py'] });
  assert.deepEqual(prefillAnswers(definition, new URLSearchParams('answer.batch=')).answers, {}, 'empty is ignored');
  assert.deepEqual(prefillAnswers(definition, { 'answer.city': 'Delhi', 'answer.skills': ['py'] }).answers, { city: 'Delhi', skills: ['py'] });
  assert.deepEqual(prefillAnswers(definition, null).answers, {});
});

test('prefill and URL parameters stay separate, and a prefilled value is never attribution', () => {
  const link = new URLSearchParams('batch=partner&answer.batch=jan');
  assert.deepEqual({ ...urlParamValues(definition, link) }, { batch: 'partner' });
  assert.deepEqual(attributionValues(definition, link), { batch: 'partner' });
  assert.deepEqual(prefillAnswers(definition, link).answers, { batch: 'jan' });
  assert.deepEqual(prefillAnswers(definition, new URLSearchParams('batch=jan')).answers, {}, 'a bare question key does not prefill');
});

test('the builder link round-trips, keeps keys when labels change and drops questions a later version removed', () => {
  const values = { full_name: 'Asha', batch: 'jan', skills: ['js', 'py'], student_id: 'S1', other_tech: '', city: 'Pune' };
  const query = prefillQuery(definition, values);
  assert.equal(query, 'answer.full_name=Asha&answer.batch=jan&answer.skills=js&answer.skills=py&answer.city=Pune');
  assert.equal(prefilledLink('https://forms.schedora.in/f/x', definition, values), 'https://forms.schedora.in/f/x?' + query);
  assert.equal(prefilledLink('https://forms.schedora.in/f/x?mode=conversational', definition, { city: 'Pune' }), 'https://forms.schedora.in/f/x?mode=conversational&answer.city=Pune');
  assert.equal(prefilledLink('https://forms.schedora.in/f/x', definition, {}), 'https://forms.schedora.in/f/x');
  const renamed = structuredClone(definition);
  renamed.fields.find(field => field.id === 'batch').label = 'Which intake?';
  renamed.fields.find(field => field.id === 'batch').options[0].label = 'Jan intake';
  assert.deepEqual(prefillAnswers(renamed, new URLSearchParams(query)).answers, { full_name: 'Asha', batch: 'jan', skills: ['js', 'py'], city: 'Pune' });
  const republished = structuredClone(definition);
  republished.fields = republished.fields.filter(field => field.id !== 'city');
  republished.fields.find(field => field.id === 'batch').options = [{ id: 'jul', label: 'July' }];
  assert.deepEqual(prefillAnswers(republished, new URLSearchParams(query)).answers, { full_name: 'Asha', skills: ['js', 'py'] }, 'a removed question or option is ignored');
});

test('prefill feeds conditional logic, and the server still judges the submitted answers', () => {
  const { answers } = prefillAnswers(definition, new URLSearchParams('answer.other_tech=Go&answer.other_level=adv'));
  assert.ok(visibleFields(definition, answers).some(field => field.id === 'other_level'), 'the conditional question appears');
  const hidden = prefillAnswers(definition, new URLSearchParams('answer.other_level=adv')).answers;
  assert.ok(!visibleFields(definition, hidden).some(field => field.id === 'other_level'));
  assert.equal(validateSubmission(definition, { ...hidden, full_name: 'A', student_id: 'S', email: 'a@b.co', batch: 'jan' }).answers.other_level, undefined, 'a prefilled answer to a hidden question is discarded');
  // The respondent changed the prefilled batch: what they submit is what counts.
  const submitted = validateSubmission(definition, { full_name: 'A', student_id: 'S', email: 'a@b.co', batch: 'jul' });
  assert.equal(submitted.answers.batch, 'jul');
});

test('the public API needs nothing new: prefill never reaches the server unless submitted as an answer', async () => {
  const env = await setup();
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Prefill');
    const form = (await http.post(`/api/workspaces/${ws.id}/forms`, { definition })).body;
    assert.equal((await http.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`, {})).status, 200);
    const result = await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { full_name: 'Asha', student_id: 'S1', email: 'a@b.co', batch: 'jan' }, url_params: { batch: 'partner', 'answer.batch': 'jul' }, version: 1, evaluator: 2 });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const row = env.app.db.get('SELECT answers, attribution FROM responses WHERE id = ?', result.body.id);
    assert.deepEqual(JSON.parse(row.attribution), { batch: 'partner' }, 'an answer.* key is not attribution');
    assert.equal(JSON.parse(row.answers).batch, 'jan');
  } finally { await env.close(); }
});
