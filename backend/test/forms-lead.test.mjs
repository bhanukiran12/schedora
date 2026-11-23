import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { definitionProblems, leadScore } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition, publicDefinition } from '../src/forms/service.mjs';
import { setup, signUp } from './helpers.mjs';

const definition = () => ({ title: 'Admissions enquiry', presentation: 'classic', mode: 'lead_qualification', lead_scoring: { warm: 25, hot: 50 }, responses: { allow_edit: true }, fields: [
  { id: 'timing', type: 'single_choice', label: 'When would you start?', required: true, options: [{ id: 'now', label: 'This month', lead_points: 50 }, { id: 'later', label: 'Exploring', lead_points: 5 }] },
  { id: 'needs', type: 'multiple_choice', label: 'What do you need?', options: [{ id: 'course', label: 'Course', lead_points: 10 }, { id: 'advice', label: 'Advice', lead_points: 15 }] }
] });

test('lead scoring is deterministic, counts each selected option once and stays private', () => {
  const draft = definition();
  assert.deepEqual(definitionProblems(draft), []);
  const score = leadScore(draft, { timing: 'now', needs: ['course', 'course', 'advice'] });
  assert.equal(score.score, 75);
  assert.equal(score.band, 'Hot');
  assert.equal(score.reasons.length, 3);
  assert.deepEqual(leadScore(draft, { needs: ['advice', 'course'], timing: 'now' }), score);
  assert.equal(leadScore(draft, {}).band, 'Cold');
  assert.equal(leadScore({ ...draft, mode: 'universal' }, {}), null);
});

test('lead thresholds and weights are validated and exported definitions preserve them', () => {
  const draft = definition();
  assert.deepEqual(normalizeDefinition(normalizeDefinition(draft)), normalizeDefinition(draft));
  assert.equal(normalizeDefinition(draft).fields[0].options[0].lead_points, 50);
  assert.equal(definitionProblems({ ...draft, lead_scoring: { warm: 50, hot: 25 } }).length > 0, true);
  draft.fields[0].options[0].lead_points = 101;
  assert.match(definitionProblems(draft).join(' '), /lead points/);
  const shown = JSON.stringify(publicDefinition(definition()));
  assert.ok(!shown.includes('lead_points'));
  assert.ok(!shown.includes('lead_scoring'));
});

test('private lead scores, explanations, CSV and Sheets recalculate on a response edit without another submission', async () => {
  const env = await setup();
  try {
    const owner = env.client(), visitor = env.client();
    const { ws } = await signUp(owner, 'Lead owner');
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = await owner.post(forms, { definition: definition() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const path = `${forms}/${created.body.id}`;
    assert.equal((await owner.post(path + '/publish')).status, 200);
    const publicPath = '/api/public/forms/' + created.body.slug;
    assert.ok(!JSON.stringify((await visitor.get(publicPath)).body).includes('lead_points'));
    const key = randomBytes(32).toString('hex');
    const submitted = await visitor.post(publicPath + '/responses', { answers: { timing: 'now', needs: ['advice'] }, submission_id: 'lead-original', edit_key_hash: createHash('sha256').update(key).digest('hex') });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.ok(!JSON.stringify(submitted.body).includes('lead_score'));
    let rows = (await owner.get(path + '/responses')).body.responses;
    assert.equal(rows[0].lead_score.score, 65);
    assert.equal(rows[0].lead_score.band, 'Hot');
    assert.equal(rows[0].lead_score.reasons[0].answer, 'This month');
    const csv = await owner.get(path + '/responses.csv');
    assert.match(csv.body, /Lead priority/);
    assert.match(csv.body, /Hot/);
    let grid = (await owner.get(path + '/workbook/responses')).body;
    assert.equal(grid.rows[0][3], '65');
    assert.equal(grid.rows[0][grid.header.indexOf('Lead priority')], 'Hot');
    const edited = await visitor.patch(publicPath + '/response-edit', { key, revision: 0, answers: { timing: 'later' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    rows = (await owner.get(path + '/responses')).body.responses;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lead_score.score, 5);
    assert.equal(rows[0].lead_score.band, 'Cold');
    grid = (await owner.get(path + '/workbook/responses')).body;
    assert.equal(grid.rows.length, 1);
    assert.equal(grid.rows[0][3], '5');
    assert.equal(grid.rows[0][grid.header.indexOf('Lead priority')], 'Cold');
    assert.ok(!JSON.stringify((await visitor.post(publicPath + '/response-edit', { key })).body.definition).includes('lead_scoring'));
  } finally { await env.close(); }
});
