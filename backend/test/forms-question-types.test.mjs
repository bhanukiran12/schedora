import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { checkAnswer, definitionProblems, quizFeedback, responseWindow } from '../src/shared/forms-logic.mjs';

const base = { title: 'Types', presentation: 'classic' };

test('grid answers and anonymous edits keep the same response, CSV and Sheets row', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const visitor = env.client();
    const { ws } = await signUp(owner, 'Grid Owner');
    const grid = {
      rows: [{ id: 'morning', label: 'Morning' }, { id: 'evening', label: 'Evening' }],
      columns: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
    };
    const single = { id: 'schedule', type: 'single_grid', label: 'Schedule', required: true, grid };
    const multiple = { id: 'availability', type: 'multiple_grid', label: 'Availability', grid };
    const definition = { ...base, responses: { allow_edit: true, limit: 1 }, fields: [single, multiple] };
    assert.deepEqual(definitionProblems(definition), []);
    assert.match(checkAnswer(single, { morning: 'yes' }).error, /Evening/);
    assert.match(checkAnswer(single, { other: 'yes' }).error, /rows/);
    assert.match(checkAnswer(multiple, { morning: ['unknown'] }).error, /listed options/);
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = await owner.post(forms, { definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const form = `${forms}/${created.body.id}`;
    assert.equal((await owner.post(form + '/publish')).status, 200);
    const publicPath = '/api/public/forms/' + created.body.slug;
    const key = randomBytes(32).toString('hex');
    const edit_key_hash = createHash('sha256').update(key).digest('hex');
    const answers = { schedule: { morning: 'yes', evening: 'no' }, availability: { evening: ['no', 'yes'] } };
    const submitted = await visitor.post(publicPath + '/responses', { answers, edit_key_hash, submission_id: 'distinct-valid-key' });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.can_edit, true);
    assert.ok(!JSON.stringify(submitted.body).includes(edit_key_hash));
    assert.equal((await visitor.post(publicPath + '/responses', { answers, edit_key_hash, submission_id: 'distinct-valid-key' })).body.can_edit, true);
    const editPath = publicPath + '/response-edit';
    assert.equal((await visitor.post(editPath, { key: '0'.repeat(64) })).status, 404);
    const loaded = await visitor.post(editPath, { key });
    assert.equal(loaded.body.revision, 0);
    assert.deepEqual(loaded.body.answers.availability.evening, ['yes', 'no']);
    const before = (await owner.get(form + '/workbook/responses')).body;
    assert.deepEqual(before.header.slice(6), ['Schedule · Morning', 'Schedule · Evening', 'Availability · Morning', 'Availability · Evening']);
    assert.deepEqual(before.rows[0].slice(6), ['Yes', 'No', '', 'Yes, No']);
    const updated = { ...answers, schedule: { morning: 'no', evening: 'no' } };
    const invalid = await visitor.patch(editPath, { key, revision: 0, answers: { schedule: { morning: 'no' } } });
    assert.equal(invalid.status, 400);
    const request = { key, revision: 0, answers: updated };
    const saved = await visitor.patch(editPath, request);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.id, submitted.body.id);
    assert.equal(saved.body.created_at, submitted.body.created_at);
    assert.equal((await visitor.patch(editPath, request)).body.revision, 1);
    assert.equal((await visitor.patch(editPath, { key, revision: 0, answers })).status, 409);
    const after = (await owner.get(form + '/workbook/responses')).body;
    assert.notEqual(after.signature, before.signature);
    assert.equal(after.total, 1);
    assert.deepEqual(after.rows[0].slice(6), ['No', 'No', '', 'Yes, No']);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM outbox WHERE type = 'forms.response.created' AND subject_id = ?", submitted.body.id).count, 1);
    assert.equal(JSON.parse(env.app.db.get('SELECT original_answers FROM form_response_edits WHERE response_id = ?', submitted.body.id).original_answers).schedule.morning, 'yes');
    const csv = await owner.get(form + '/responses.csv');
    assert.match(csv.body, /Schedule · Morning/);
    assert.match(csv.body, /,"No","No","","Yes, No"/);
    await owner.post(form + '/unpublish');
    assert.equal((await visitor.post(editPath, { key })).status, 404);
  } finally { await env.close(); }
});


test('number, linear scale and time answers are checked and normalized', () => {
  const number = { id: 'n', type: 'number', label: 'How many?', required: true, number: { min: 1, max: 100, integer: true } };
  assert.deepEqual(checkAnswer(number, ' 42 '), { value: '42' });
  assert.deepEqual(checkAnswer(number, '1,000').error, 'Enter 100 or less.');
  assert.equal(checkAnswer(number, '2.5').error, 'Enter a whole number.');
  assert.equal(checkAnswer(number, 'ten').error, 'Enter a number, like 42 or 3.5.');
  assert.equal(checkAnswer(number, '=1+1').error, 'Enter a number, like 42 or 3.5.', 'formula-like text is not a number');
  assert.deepEqual(checkAnswer({ ...number, number: undefined }, '-3.50'), { value: '-3.5' });
  const scale = { id: 's', type: 'scale', label: 'Rate it', scale: { min: 0, max: 10, min_label: 'Poor', max_label: 'Great' } };
  assert.deepEqual(checkAnswer(scale, '7'), { value: '7' });
  assert.equal(checkAnswer(scale, '11').error, 'Choose a number from 0 to 10.');
  assert.deepEqual(checkAnswer({ id: 's', type: 'scale', label: 'Default' }, '5'), { value: '5' }, 'defaults to 1–5');
  const time = { id: 't', type: 'time', label: 'When?' };
  assert.deepEqual(checkAnswer(time, '09:30'), { value: '09:30' });
  assert.equal(checkAnswer(time, '24:00').error, 'Enter a time as HH:MM, like 14:30.');

  assert.deepEqual(definitionProblems({ ...base, fields: [number, scale, time] }), []);
  assert.match(definitionProblems({ ...base, fields: [{ ...scale, scale: { min: 2, max: 5 } }] })[0], /scale from 0 or 1/);
  assert.match(definitionProblems({ ...base, fields: [{ ...number, number: { min: 5, max: 1 } }] })[0], /number limits/);
  assert.match(definitionProblems({ ...base, fields: [{ id: 'm', type: 'multiple_choice', label: 'M', display: 'dropdown', options: [{ id: 'a', label: 'A' }] }] })[0], /dropdown only/);
  assert.match(definitionProblems({ ...base, responses: { limit: 0 }, fields: [time] })[0], /Response limits/);
});

test('quiz feedback and the response window', () => {
  const quiz = { ...base, mode: 'knowledge_quiz', fields: [
    { id: 'capital', type: 'single_choice', label: 'Capital of France', feedback: { correct: 'Yes, Paris.', incorrect: 'It is Paris.' }, options: [{ id: 'paris', label: 'Paris', correct: true }, { id: 'rome', label: 'Rome' }] },
    { id: 'free', type: 'short_text', label: 'Anything else?' }
  ] };
  assert.deepEqual(definitionProblems(quiz), []);
  assert.deepEqual(quizFeedback(quiz, { capital: 'rome' }), [{ id: 'capital', label: 'Capital of France', correct: false, feedback: 'It is Paris.' }]);
  assert.deepEqual(quizFeedback({ ...quiz, mode: undefined }, { capital: 'rome' }), []);
  assert.deepEqual(responseWindow({ responses: { limit: 2 } }, { now: 0, count: 1 }), { closed: false });
  assert.equal(responseWindow({ responses: { limit: 2 } }, { now: 0, count: 2 }).reason, 'limit');
  assert.equal(responseWindow({ responses: { close_at: 100, closed_message: 'See you next year.' } }, { now: 100, count: 0 }).message, 'See you next year.');
});

test('scheduled collection and date bounds are enforced before responses reach Sheets', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Scheduled Forms Owner');
    const start = env.clock.now + 60000;
    const field = { id: 'day', type: 'date', label: 'Choose a day', answer_rule: { min: '2026-10-25', max: '2026-10-31', message: 'Choose a day this week.' } };
    const definition = { ...base, responses: { open_at: start, close_at: start + 60000 }, fields: [field] };
    assert.match(definitionProblems({ ...definition, fields: [{ ...field, answer_rule: { min: '2026-02-30' } }] }).join(' '), /valid minimum/);
    assert.match(definitionProblems({ ...definition, responses: { open_at: start, close_at: start } }).join(' '), /closing time after/);
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = await owner.post(forms, { definition });
    assert.equal(created.status, 201);
    const form = forms + '/' + created.body.id;
    assert.equal((await owner.post(form + '/publish')).status, 200);
    const respondent = env.client();
    const publicPath = '/api/public/forms/' + created.body.slug;
    assert.equal((await respondent.get(publicPath)).body.error.reason, 'not_open_yet');
    assert.equal((await respondent.post(publicPath + '/responses', { answers: { day: '2026-10-27' } })).status, 410);
    env.clock.now = start;
    assert.equal((await respondent.get(publicPath)).status, 200);
    const tooEarly = await respondent.post(publicPath + '/responses', { answers: { day: '2026-10-24' } });
    assert.equal(tooEarly.status, 400);
    assert.match(JSON.stringify(tooEarly.body), /Choose a day this week/);
    assert.equal((await respondent.post(publicPath + '/responses', { answers: { day: '2026-10-25' } })).status, 201);
    assert.equal((await owner.get(form + '/workbook/responses')).body.rows[0][6], '2026-10-25');
    env.clock.now = start + 60000;
    assert.equal((await respondent.get(publicPath)).body.error.reason, 'closed_at');
  } finally { await env.close(); }
});

test('published forms enforce new types, keep feedback private until submitting, and close on their limits', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Types Owner');
    const definition = {
      title: 'Workshop quiz', presentation: 'classic', mode: 'knowledge_quiz',
      responses: { limit: 2, closed_message: 'Thanks, we have enough answers.' },
      fields: [
        { id: 'attendees', type: 'number', label: 'How many attended?', required: true, number: { min: 1, max: 500, integer: true } },
        { id: 'rating', type: 'scale', label: 'Rate the session', required: true, scale: { min: 1, max: 5, min_label: 'Poor', max_label: 'Great' } },
        { id: 'start', type: 'time', label: 'Start time' },
        { id: 'room', type: 'single_choice', label: 'Room', display: 'dropdown', feedback: { correct: 'Right room.', incorrect: 'It was Hall A.' }, options: [{ id: 'hall_a', label: 'Hall A', correct: true }, { id: 'hall_b', label: 'Hall B' }] }
      ]
    };
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = await owner.post(forms, { definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.draft.fields[3].feedback, definition.fields[3].feedback, 'feedback is kept in the draft');
    assert.equal(created.body.draft.fields[3].display, 'dropdown');
    assert.equal((await owner.post(`${forms}/${created.body.id}/publish`)).status, 200);
    const route = `/api/public/forms/${created.body.slug}`;
    const published = (await env.client().get(route)).body.definition;
    assert.equal(published.fields[3].feedback, undefined, 'feedback stays private until submitting');
    assert.deepEqual(published.fields[3].options[0], { id: 'hall_a', label: 'Hall A' });
    const submit = answers => env.client().post(route + '/responses', { answers });
    const bad = await submit({ attendees: '0', rating: '9', start: '25:00', room: 'hall_b' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.body.error.errors).sort(), ['attendees', 'rating', 'start']);
    const first = await submit({ attendees: '120', rating: '4', start: '09:30', room: 'hall_b' });
    assert.equal(first.status, 201);
    assert.deepEqual(first.body.quiz_results, [{ id: 'room', label: 'Room', correct: false, feedback: 'It was Hall A.' }]);
    assert.equal((await submit({ attendees: '80', rating: '5', room: 'hall_a' })).status, 201);
    // The limit is reached: the form closes with the author's message, for loading and for submitting.
    const closedLoad = await env.client().get(route);
    assert.deepEqual([closedLoad.status, closedLoad.body.error.message, closedLoad.body.error.reason], [410, 'Thanks, we have enough answers.', 'limit']);
    assert.equal((await submit({ attendees: '10', rating: '3' })).status, 410);
    const csv = (await owner.get(`${forms}/${created.body.id}/responses.csv`)).body;
    assert.match(csv, /"120","4","09:30","Hall B"/);
  } finally { await env.close(); }
});

test('a closing time stops new responses', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Closing Owner');
    const forms = `/api/workspaces/${ws.id}/forms`;
    const definition = { ...base, responses: { close_at: env.clock.now + 60000 }, fields: [{ id: 'name', type: 'short_text', label: 'Name' }] };
    const created = (await owner.post(forms, { definition })).body;
    await owner.post(`${forms}/${created.id}/publish`);
    const route = `/api/public/forms/${created.slug}`;
    assert.equal((await env.client().post(route + '/responses', { answers: { name: 'Early' } })).status, 201);
    env.clock.now += 60000;
    const late = await env.client().post(route + '/responses', { answers: { name: 'Late' } });
    assert.deepEqual([late.status, late.body.error.code], [410, 'form_closed']);
  } finally { await env.close(); }
});
