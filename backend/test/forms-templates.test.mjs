// Goal-based Forms templates use only the supported schema, validate on the server and are created
// as unpublished drafts. The browser and the server import the same template data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { definitionProblems, validateSubmission, visibleFields } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { FORM_TEMPLATES, questionCount } from '../../frontend/js/forms-templates.mjs';

const visibleIds = (definition, answers) => visibleFields(definition, answers).map(field => field.id);

test('every template is a valid supported definition and survives server normalisation unchanged in shape', () => {
  assert.equal(FORM_TEMPLATES.length, 4);
  assert.equal(new Set(FORM_TEMPLATES.map(template => template.id)).size, 4);
  for (const template of FORM_TEMPLATES) {
    assert.deepEqual(definitionProblems(template.definition), [], template.id);
    const normalized = normalizeDefinition(template.definition);
    assert.deepEqual(normalized.fields.map(field => field.id), template.definition.fields.map(field => field.id), template.id);
    assert.ok(questionCount(template.definition) >= 4 && questionCount(template.definition) <= 9, `${template.id} stays short`);
    assert.ok(template.purpose && template.audience && template.logic, `${template.id} explains itself`);
  }
});

test('template logic behaves as each card describes', () => {
  const byId = Object.fromEntries(FORM_TEMPLATES.map(template => [template.id, template.definition]));
  // Consultation: the free-text topic appears only for "Something else".
  assert.ok(!visibleIds(byId.consultation, { topic: 'strategy' }).includes('topic_other'));
  assert.ok(visibleIds(byId.consultation, { topic: 'other' }).includes('topic_other'));
  const consult = validateSubmission(byId.consultation, { name: 'Mia', email: 'mia@example.com', topic: 'strategy', topic_other: 'ignored' });
  assert.deepEqual(consult.errors, {});
  assert.equal(consult.answers.topic_other, undefined, 'hidden answers are discarded');
  assert.deepEqual(Object.keys(validateSubmission(byId.consultation, { name: 'Mia', email: 'mia@example.com', topic: 'other' }).errors), ['topic_other']);
  // Project brief: website address only when there is a site.
  assert.ok(!visibleIds(byId['project-brief'], { has_site: 'no' }).includes('site_url'));
  assert.ok(visibleIds(byId['project-brief'], { has_site: 'yes' }).includes('site_url'));
  // Session feedback: email is required only when a follow-up is wanted.
  assert.deepEqual(validateSubmission(byId['session-feedback'], { rating: 'very', follow_up: 'no' }).errors, {});
  assert.deepEqual(Object.keys(validateSubmission(byId['session-feedback'], { rating: 'very', follow_up: 'yes' }).errors), ['email']);
  // Programme enquiry: says plainly that interest does not reserve a place.
  assert.match(byId['programme-interest'].description, /does not reserve a place/);
});

test('creating from a template saves an unpublished draft that is not publicly reachable', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Templates');
    for (const template of FORM_TEMPLATES) {
      const created = await owner.post(`/api/workspaces/${ws.id}/forms`, { definition: template.definition });
      assert.equal(created.status, 201, template.id);
      assert.equal(created.body.published_version, null, `${template.id} is not published`);
      assert.equal(created.body.draft.title, template.definition.title);
      assert.equal((await env.client().get(`/api/public/forms/${created.body.slug}`)).status, 404, `${template.id} is not public`);
    }
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_versions').count, 0, 'no version is published by choosing a template');
  } finally { await env.close(); }
});
