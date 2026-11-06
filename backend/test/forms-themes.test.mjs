// Form themes: values are allow-listed, reusable themes belong to a workspace, and a form only ever
// shows the copy it holds, so editing a theme cannot restyle anything already saved or published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { contrastRatio, definitionProblems, starterDefinition, themeProblems, themeWarnings } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { MAX_THEMES } from '../src/forms/themes.mjs';
import { THEME_PRESETS, applyTheme, presetById, themeCopy, tokensOf } from '../../frontend/js/forms-themes.mjs';

const tokens = { font: 'serif', background: '#10243a', question: '#ffffff', answer: '#d7e6f5', button: '#f4b942', button_text: '#1a1200' };
const themed = (theme = { ...tokens, name: 'Night' }) => ({ ...starterDefinition('Themed'), theme });

test('only known fonts and plain hex colours are accepted', () => {
  assert.deepEqual(themeProblems({ ...tokens, name: 'Night' }), []);
  for (const bad of ['red', '#12', '#12345g', 'url(https://evil.example/x.png)', '#000000; background: url(x)', 'var(--x)', 'expression(alert(1))', '', null, 7]) {
    assert.match(themeProblems({ ...tokens, name: 'T', background: bad }).join(' '), /colour/, String(bad));
  }
  assert.match(themeProblems({ ...tokens, name: 'T', font: 'Comic Sans", url(x)' }).join(' '), /font/);
  assert.match(themeProblems({ ...tokens, name: '' }).join(' '), /name/);
  assert.match(themeProblems({ ...tokens, name: 'x'.repeat(61) }).join(' '), /name/);
  assert.match(definitionProblems(themed({ ...tokens, name: 'T', question: 'javascript:alert(1)' })).join(' '), /colour/);
  assert.match(definitionProblems({ ...starterDefinition('T'), theme: 'dark' }).join(' '), /Theme is invalid/);
  assert.match(themeProblems({ ...tokens, name: 'T', source: '../x' }).join(' '), /source/);
});

test('a form without a theme stores no theme key; a theme keeps only known values, identically twice', () => {
  assert.equal('theme' in normalizeDefinition(starterDefinition('Plain')), false);
  const once = normalizeDefinition(themed({ ...tokens, background: '#10243A', name: ' Night ', source: 'preset:harbour', extra: 'x' }));
  assert.deepEqual(once.theme, { name: 'Night', source: 'preset:harbour', ...tokens });
  assert.equal(JSON.stringify(normalizeDefinition(once)), JSON.stringify(once));
});

test('contrast is computed correctly and weak pairs are named', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
  assert.deepEqual(themeWarnings(tokens), []);
  assert.deepEqual(themeWarnings({ ...tokens, question: '#20344a', button_text: '#f4b942' }).map(item => item.pair), ['question', 'button']);
});

test('every preset is valid, readable and has a stable unique id', () => {
  assert.ok(THEME_PRESETS.length >= 6);
  assert.equal(new Set(THEME_PRESETS.map(preset => preset.id)).size, THEME_PRESETS.length);
  for (const preset of THEME_PRESETS) {
    assert.deepEqual(themeProblems(themeCopy(preset, `preset:${preset.id}`)), [], preset.id);
    assert.deepEqual(themeWarnings(preset), [], preset.id);
  }
  assert.equal(presetById(THEME_PRESETS[0].id), THEME_PRESETS[0]);
});

test('applying a theme gives the draft its own copy, and the page only ever receives checked values', () => {
  const source = { id: 'abc', ...tokens, name: 'Night', revision: 3, updated_at: 1 };
  const copy = themeCopy(source, 'workspace:abc');
  assert.deepEqual(copy, { name: 'Night', source: 'workspace:abc', ...tokens });
  source.background = '#000000';
  assert.equal(copy.background, tokens.background, 'later edits to the source do not reach the copy');
  assert.deepEqual(tokensOf(copy), tokens);

  const set = new Map();
  const element = { dataset: {}, style: { setProperty: (key, value) => set.set(key, value), removeProperty: key => set.delete(key) } };
  applyTheme(element, copy);
  assert.equal(element.dataset.themed, '1');
  assert.equal(set.get('--t-background'), tokens.background);
  assert.ok(set.get('--t-font').includes('serif'));
  applyTheme(element, { ...copy, background: 'url(https://evil.example)' });
  assert.equal(element.dataset.themed, undefined, 'an unchecked theme is not applied');
  assert.equal(set.size, 0);
  applyTheme(element, copy);
  applyTheme(element, undefined);
  assert.equal(element.dataset.themed, undefined);
  assert.equal(set.size, 0);
});

test('workspace themes: create, edit with conflict protection, isolation, permissions and limits', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const stranger = env.client();
    const { ws: other } = await signUp(stranger, 'Stranger');
    const path = `/api/workspaces/${ws.id}/form-themes`;
    assert.deepEqual((await owner.get(path)).body, []);
    assert.equal((await env.client().get(path)).status, 401);
    assert.equal((await owner.post(path, { ...tokens, name: 'Bad', background: 'url(x)' })).status, 400);
    const created = await owner.post(path, { ...tokens, background: '#10243A', name: '  Night  ', extra: 'dropped' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Night');
    assert.equal(created.body.background, '#10243a');
    assert.equal(created.body.extra, undefined);
    assert.equal(created.body.revision, 1);

    const item = `${path}/${created.body.id}`;
    assert.equal((await stranger.patch(`/api/workspaces/${other.id}/form-themes/${created.body.id}`, { ...tokens, name: 'Stolen' })).status, 404);
    assert.equal((await stranger.get(path)).status, 404, 'another workspace is not revealed');
    assert.equal((await stranger.del(`/api/workspaces/${other.id}/form-themes/${created.body.id}`)).status, 404);

    const edited = await owner.patch(item, { ...tokens, name: 'Night two', button: '#ffffff', base_revision: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.revision, 2);
    const stale = await owner.patch(item, { ...tokens, name: 'Stale', base_revision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'theme_conflict');
    assert.equal((await owner.get(path)).body[0].name, 'Night two');

    for (let index = 1; index < MAX_THEMES; index++) env.app.db.run('INSERT INTO form_themes (id, workspace_id, name, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', `filler-${index}`, ws.id, `Filler ${index}`, JSON.stringify(tokens));
    assert.equal((await owner.post(path, { ...tokens, name: 'One too many' })).status, 409);

    assert.equal((await owner.del(item)).status, 204);
    assert.equal((await owner.del(item)).status, 404);
  } finally { await env.close(); }
});

test('editing or deleting a theme restyles nothing; a published form keeps its appearance until republished', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const themes = `/api/workspaces/${ws.id}/form-themes`;
    const forms = `/api/workspaces/${ws.id}/forms`;
    const theme = (await owner.post(themes, { ...tokens, name: 'Night' })).body;
    const definition = themed({ ...tokens, name: 'Night', source: `workspace:${theme.id}` });
    const created = (await owner.post(forms, { definition })).body;
    assert.equal((await owner.post(`${forms}/${created.id}/publish`)).body.published_version, 1);
    const live = async () => (await env.client().get(`/api/public/forms/${created.slug}`)).body;
    assert.equal((await live()).definition.theme.background, tokens.background, 'the public form carries its own copy');
    assert.equal((await live()).definition.theme.source, undefined, 'the public form does not reveal where the theme came from');

    // The reusable theme changes: neither the draft nor the published form moves.
    await owner.patch(`${themes}/${theme.id}`, { ...tokens, name: 'Night', background: '#ffffff', question: '#000000' });
    assert.equal((await live()).definition.theme.background, tokens.background);
    assert.equal((await owner.get(`${forms}/${created.id}`)).body.draft.theme.background, tokens.background);
    assert.equal((await owner.get(`${forms}/${created.id}`)).body.has_unpublished_changes, false);

    // A later draft change stays in the draft until it is published.
    const current = (await owner.get(`${forms}/${created.id}`)).body;
    const restyled = { ...current.draft, theme: { ...current.draft.theme, background: '#222222' } };
    assert.equal((await owner.patch(`${forms}/${created.id}`, { definition: restyled, base_revision: current.revision })).status, 200);
    assert.equal((await live()).definition.theme.background, tokens.background, 'unpublished draft change is not live');
    assert.equal((await owner.get(`${forms}/${created.id}`)).body.has_unpublished_changes, true);

    // Deleting the theme leaves both copies working, and publishing takes the draft's copy.
    await owner.del(`${themes}/${theme.id}`);
    assert.equal((await live()).definition.theme.background, tokens.background);
    await owner.post(`${forms}/${created.id}/publish`);
    assert.equal((await live()).definition.theme.background, '#222222');
    const version1 = env.app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = 1', created.id);
    assert.equal(JSON.parse(version1.definition).theme.background, tokens.background, 'version 1 keeps the look it was published with');

    // Removing the theme is a normal draft change too.
    const latest = (await owner.get(`${forms}/${created.id}`)).body;
    const { theme: removed, ...plain } = latest.draft;
    assert.ok(removed);
    await owner.patch(`${forms}/${created.id}`, { definition: plain, base_revision: latest.revision });
    assert.equal('theme' in (await owner.get(`${forms}/${created.id}`)).body.draft, false);
    assert.equal((await live()).definition.theme.background, '#222222');
  } finally { await env.close(); }
});
