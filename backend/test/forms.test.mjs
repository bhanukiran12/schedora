// Sprints 6–7: versioned forms, shared logic, server validation, responses, authorized CSV export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { definitionProblems, pipe, starterDefinition, validateSubmission, visiblePages } from '../src/shared/forms-logic.mjs';
import { csvCell } from '../src/forms/service.mjs';

const branching = {
  title: 'Intake', description: '', presentation: 'conversational', submit_label: 'Send',
  fields: [
    { id: 'name', type: 'short_text', label: 'Name?', required: true },
    { id: 'kind', type: 'single_choice', label: 'Hi {{name}}, what kind?', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }] },
    { id: 'p2', type: 'page_break', label: '', show_if: { field: 'kind', op: 'equals', value: 'office' } },
    { id: 'staff', type: 'short_text', label: 'Team size?', required: true },
    { id: 'p3', type: 'page_break', label: '' },
    { id: 'when', type: 'date', label: 'Start date', required: false },
    { id: 'extras', type: 'multiple_choice', label: 'Extras', required: false, options: [{ id: 'a', label: 'Plants' }, { id: 'b', label: '=Lights' }] },
    { id: 'contact', type: 'email', label: 'Email', required: true }
  ]
};

test('shared logic: pages, branching, piping and validation', () => {
  assert.deepEqual(definitionProblems(branching), []);
  assert.deepEqual(definitionProblems(starterDefinition()), []);
  assert.match(definitionProblems({ ...branching, fields: [{ id: 'a', type: 'short_text', label: 'A', show_if: { field: 'later', op: 'answered' } }] })[0], /earlier question/);
  assert.equal(visiblePages(branching, { kind: 'home' }).length, 2, 'office page hidden');
  assert.equal(visiblePages(branching, { kind: 'office' }).length, 3);
  assert.equal(pipe(branching.fields[1].label, branching, { name: 'Mia' }), 'Hi Mia, what kind?');

  const home = validateSubmission(branching, { name: 'Mia', kind: 'home', staff: 'should be dropped', contact: 'MIA@example.com', extras: ['a'] });
  assert.deepEqual(home.errors, {});
  assert.deepEqual(home.answers, { name: 'Mia', kind: 'home', extras: ['a'], contact: 'mia@example.com' });
  const office = validateSubmission(branching, { name: 'Mia', kind: 'office', contact: 'bad', when: '2026-02-30', extras: ['zzz'] });
  assert.deepEqual(Object.keys(office.errors).sort(), ['contact', 'extras', 'staff', 'when']);
});

test('draft, publish versions, public submission and authorized CSV export', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const created = (await owner.post(`/api/workspaces/${ws.id}/forms`, { definition: branching })).body;
    assert.equal(created.published_version, null);
    assert.equal((await env.client().get(`/api/public/forms/${created.slug}`)).status, 404, 'drafts are not public');
    assert.equal((await owner.patch(`/api/workspaces/${ws.id}/forms/${created.id}`, { definition: { ...branching, presentation: 'slides' } })).status, 400);

    const v1 = (await owner.post(`/api/workspaces/${ws.id}/forms/${created.id}/publish`)).body;
    assert.equal(v1.published_version, 1);
    const publicForm = (await env.client().get(`/api/public/forms/${created.slug}`)).body;
    assert.equal(publicForm.definition.presentation, 'conversational');

    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const invalid = await submit({ answers: { name: 'Mia', kind: 'office', contact: 'mia@example.com' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.body.error.errors), ['staff'], 'field-specific error for the branched question');
    assert.equal((await submit({ answers: { name: 'X', kind: 'home', contact: 'x@example.com' }, website: 'bot' })).status, 400);

    const ok = await submit({ answers: { name: 'Mia', kind: 'office', staff: '12', contact: 'mia@example.com', extras: ['b'] }, submission_id: 'submission-000000001' });
    assert.equal(ok.status, 201);
    assert.equal((await submit({ answers: { name: 'Mia', kind: 'office', staff: '12', contact: 'mia@example.com' }, submission_id: 'submission-000000001' })).status, 200, 'retried submission is not stored twice');
    await submit({ answers: { name: '=HYPERLINK("http://evil")', kind: 'home', contact: 'x@example.com' } });

    // Draft edits do not change the live form until republished.
    await owner.patch(`/api/workspaces/${ws.id}/forms/${created.id}`, { definition: { ...branching, title: 'Intake v2' } });
    assert.equal((await env.client().get(`/api/public/forms/${created.slug}`)).body.definition.title, 'Intake');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/forms/${created.id}/publish`)).body.published_version, 2);

    const inbox = (await owner.get(`/api/workspaces/${ws.id}/forms/${created.id}/responses`)).body;
    assert.equal(inbox.responses.length, 2);
    assert.ok(inbox.versions[1] && inbox.versions[2]);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM outbox WHERE type = 'forms.response.created'").count, 2);
    assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM outbox')).includes('mia@example.com'), 'events carry no personal data');

    const csv = await owner.get(`/api/workspaces/${ws.id}/forms/${created.id}/responses.csv`);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename=".*-responses\.csv"/);
    assert.match(csv.body, /"Name\?","Hi \{\{name\}\}, what kind\?"/);
    assert.match(csv.body, /"'=Lights"/, 'option label formulas neutralized');
    assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/evil""\)"/, 'answer formulas neutralized and quotes escaped');
    assert.equal(csvCell('+1'), `"'+1"`);

    const stranger = env.client();
    await signUp(stranger, 'Stranger');
    assert.equal((await stranger.get(`/api/workspaces/${ws.id}/forms/${created.id}/responses.csv`)).status, 404);
    assert.equal((await env.client().get(`/api/workspaces/${ws.id}/forms/${created.id}/responses.csv`)).status, 401);

    await owner.post(`/api/workspaces/${ws.id}/forms/${created.id}/unpublish`);
    const late = await submit({ answers: { name: 'Late', kind: 'home', contact: 'l@example.com' } });
    assert.deepEqual([late.status, late.body.error.code], [410, 'form_closed'], 'a closed form says so; a never-published draft stays 404');
  } finally { await env.close(); }
});
