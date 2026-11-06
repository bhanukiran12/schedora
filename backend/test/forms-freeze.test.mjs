// The Forms authoring freeze: every write an author can make is refused on the server, nothing changes,
// and what respondents and reviewers need keeps working. A new write route must be classified here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicConfig } from '../src/config.mjs';
import { setup, signUp } from './helpers.mjs';

const FROZEN = ['POST /forms', 'PATCH /forms/:id', 'DELETE /forms/:id', 'PUT /forms/:id/routing', 'POST /forms/:id/publish', 'POST /forms/:id/unpublish', 'POST /form-themes', 'PATCH /form-themes/:id', 'DELETE /form-themes/:id', 'POST /form-assets'];
// Not authoring: checking changes nothing, respondents keep responding, and removing a response is a data request.
const ALLOWED = ['POST /forms/:id/publish-check', 'DELETE /forms/:id/responses/:rid', 'POST /public/forms/:slug/responses'];
const definition = (title = 'Frozen') => ({ title, description: '', presentation: 'classic', submit_label: 'Send', fields: [{ id: 'q', type: 'short_text', label: 'Q', required: false }] });

function writeRoutes() {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = [];
  const walk = path => statSync(path).isDirectory() ? readdirSync(path).forEach(name => walk(join(path, name))) : path.endsWith('.mjs') && files.push(path);
  walk(root);
  const verbs = { post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
  const found = new Set();
  for (const file of files) for (const [, verb, path] of readFileSync(file, 'utf8').matchAll(/\b(post|put|patch|del)\('(\/api\/[^']*(?:\/forms|\/form-themes|\/form-assets)[^']*)'/g)) found.add(verbs[verb] + ' ' + path.replace('/api/workspaces/:ws', '').replace('/api', ''));
  return [...found];
}

test('every Forms write route is classified as frozen or deliberately allowed', () => {
  const routes = writeRoutes();
  assert.ok(routes.length >= 8, 'the scan finds the routes');
  for (const route of routes) assert.ok(FROZEN.includes(route) || ALLOWED.includes(route), 'unclassified Forms write route: ' + route);
  for (const route of ['POST /forms', 'PATCH /forms/:id', 'POST /forms/:id/publish']) assert.ok(routes.includes(route), route);
});

test('the default state: this rollback build starts frozen in production, and an operator can set it', () => {
  assert.equal(loadConfig({ NODE_ENV: 'production', APP_ENCRYPTION_KEY: 'x'.repeat(64) }).formsAuthoringFrozen, true);
  assert.equal(loadConfig({}).formsAuthoringFrozen, false, 'not for local development and tests');
  assert.equal(loadConfig({ FORMS_AUTHORING_FREEZE: 'true' }).formsAuthoringFrozen, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', APP_ENCRYPTION_KEY: 'x'.repeat(64), FORMS_AUTHORING_FREEZE: 'false' }).formsAuthoringFrozen, false);
  assert.equal(publicConfig(loadConfig({})).formsAuthoringFrozen, undefined, 'an open deployment says nothing new');
  assert.equal(publicConfig(loadConfig({})).deployment, undefined);
  assert.equal(publicConfig(loadConfig({ FORMS_AUTHORING_FREEZE: 'true', RELEASE_ENVIRONMENT: 'staging' })).formsAuthoringFrozen, true);
  assert.equal(publicConfig(loadConfig({ RELEASE_ENVIRONMENT: 'staging' })).deployment, 'staging');
});

test('server: while frozen, direct writes are refused with nothing changed; reading, checking and responding still work', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}`;
    const forms = base + '/forms';
    const live = (await owner.post(forms, { definition: definition('Live') })).body;
    await owner.post(`${forms}/${live.id}/publish`);
    const draft = (await owner.post(forms, { definition: definition('Draft') })).body;
    const theme = await owner.post(base + '/form-themes', { name: 'T', font: 'serif', background: '#102405', question: '#ffffff', answer: '#ffffff', button: '#ffffff', button_text: '#102405' });
    const hasThemes = theme.status === 201;
    const removable = await env.client().post(`/api/public/forms/${live.slug}/responses`, { answers: { q: 'keep me until deleted' } });
    assert.equal(removable.status, 201);
    const state = () => JSON.stringify([
      env.app.db.all('SELECT id, draft, routing, draft_revision, published_version, updated_at FROM forms ORDER BY id'),
      env.app.db.all('SELECT form_id, version, definition FROM form_versions ORDER BY form_id, version'),
      hasThemes ? env.app.db.all('SELECT id, name, tokens, revision FROM form_themes ORDER BY id') : []
    ]);
    const before = state();
    env.app.config.formsAuthoringFrozen = true;

    const attempts = [
      ['POST', forms, { definition: definition('New') }],
      ['POST', forms, { title: 'From a template' }],
      ['PATCH', `${forms}/${draft.id}`, { definition: definition('Edited'), base_revision: draft.revision }],
      ['PATCH', `${forms}/${draft.id}`, { definition: 'not even valid' }],
      ['DELETE', `${forms}/${draft.id}`],
      ['PUT', `${forms}/${draft.id}/routing`, { routing: null, base_revision: draft.revision }],
      ['POST', `${forms}/${draft.id}/publish`, {}],
      ['POST', `${forms}/${live.id}/publish`, {}],
      ['POST', `${forms}/${live.id}/unpublish`, {}],
      ...(hasThemes ? [
        ['POST', base + '/form-themes', { name: 'X', font: 'serif', background: '#102405', question: '#ffffff', answer: '#ffffff', button: '#ffffff', button_text: '#102405' }],
        ['PATCH', `${base}/form-themes/${theme.body.id}`, { name: 'Y', font: 'serif', background: '#102405', question: '#ffffff', answer: '#ffffff', button: '#ffffff', button_text: '#102405' }],
        ['DELETE', `${base}/form-themes/${theme.body.id}`],
        ['POST', base + '/form-assets', { image: 'not an image' }]
      ] : [])
    ];
    for (const [method, path, body] of attempts) {
      const result = await owner.raw(method, path, body);
      assert.equal(result.status, 423, `${method} ${path}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error.code, 'forms_authoring_frozen');
    }
    assert.equal(state(), before, 'nothing changed');

    const stranger = await env.client().raw('PATCH', `${forms}/${draft.id}`, { definition: definition('Stranger') });
    assert.ok([401, 403].includes(stranger.status), 'signing in still comes first');

    assert.equal((await owner.get(forms)).status, 200);
    assert.equal((await owner.get(`${forms}/${draft.id}`)).body.draft.title, 'Draft');
    assert.equal((await owner.post(`${forms}/${draft.id}/publish-check`, {})).status, 200, 'checking changes nothing');
    assert.equal((await env.client().get(`/api/public/forms/${live.slug}`)).status, 200);
    const submitted = await env.client().post(`/api/public/forms/${live.slug}/responses`, { answers: { q: 'during the freeze' } });
    assert.equal(submitted.status, 201, 'respondents keep responding');
    assert.equal((await owner.get(`${forms}/${live.id}/responses`)).body.responses.length, 2);
    assert.ok((await owner.get(`${forms}/${live.id}/responses.csv`)).body.includes('during the freeze'));
    assert.equal((await owner.raw('DELETE', `${forms}/${live.id}/responses/${removable.body.id}`)).status, 204, 'a response can still be removed');
    assert.equal(state(), before, 'and none of that touched a form');

    env.app.config.formsAuthoringFrozen = false;
    const opened = await owner.patch(`${forms}/${draft.id}`, { definition: definition('Edited after'), base_revision: draft.revision });
    assert.equal(opened.status, 200, 'lifting it restores editing at the same revision');
  } finally { await env.close(); }
});
