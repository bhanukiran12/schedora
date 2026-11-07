// Typography and description limits. Text sizes are optional named steps on a theme, so every theme and
// form saved before them is unchanged. Page and question descriptions share a 3,000-character limit;
// the form's own description, titles and answers keep their limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { DESCRIPTION_LIMITS, THEME_SIZES, definitionProblems, starterDefinition, themeProblems, validateSubmission } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { SIZE_SCALE, applyTheme, defaultStyleWith, themeCopy, tokensOf } from '../../frontend/js/forms-themes.mjs';

const tokens = { font: 'serif', background: '#faf6ee', question: '#2b2419', answer: '#4c4231', button: '#2b2419', button_text: '#faf6ee' };
const sized = { ...tokens, question_size: 'large', description_size: 'small', answer_size: 'large' };
const withHelp = (help, type = 'short_text') => {
  const definition = starterDefinition('Limits');
  const field = type === 'page_break'
    ? { id: 'details_page', type: 'page_break', grouped: true, label: 'Details', help }
    : { ...definition.fields[0], help };
  return { ...definition, fields: type === 'page_break' ? [field, ...definition.fields.map(item => ({ ...item, group: 'details_page' }))] : [field, ...definition.fields.slice(1)] };
};

test('the limits are 2,000 for the form description and 3,000 for page and question descriptions', () => {
  assert.deepEqual(DESCRIPTION_LIMITS, { form: 2000, page: 3000, question: 3000 });
});

test('question descriptions: 3,000 characters with line breaks are accepted, 3,001 are refused', () => {
  const text = ('Line one of the instructions.\nLine two.\n').repeat(100).slice(0, 2999) + '.';
  assert.equal(text.length, 3000);
  assert.deepEqual(definitionProblems(withHelp(text)), []);
  assert.match(definitionProblems(withHelp(text + 'x')).join(' '), /Item 1 description must be 3,000 characters or fewer/);
  // The server keeps the line breaks; only the ends are trimmed.
  assert.equal(normalizeDefinition(withHelp(`  ${text}\n`)).fields[0].help, text);
});

test('page descriptions have their own message and the same 3,000-character limit', () => {
  assert.deepEqual(definitionProblems(withHelp('p'.repeat(3000), 'page_break')), []);
  assert.match(definitionProblems(withHelp('p'.repeat(3001), 'page_break')).join(' '), /Item 1 page description must be 3,000 characters or fewer/);
});

test('the form description, titles, labels and answers keep their limits', () => {
  const definition = starterDefinition('Limits');
  assert.deepEqual(definitionProblems({ ...definition, description: 'd'.repeat(2000) }), []);
  assert.match(definitionProblems({ ...definition, description: 'd'.repeat(2001) }).join(' '), /form description to 2,000 characters/);
  assert.match(definitionProblems({ ...definition, title: 't'.repeat(151) }).join(' '), /title of up to 150/);
  assert.match(definitionProblems({ ...definition, fields: [{ ...definition.fields[0], label: 'q'.repeat(301) }, ...definition.fields.slice(1)] }).join(' '), /question of up to 300/);
  const answers = { name: 'n'.repeat(301), email: 'a@example.com', topic: 'support' };
  assert.equal(validateSubmission(definition, answers).errors.name, 'Use 300 characters or fewer.', 'a short answer over 300 characters is still refused');
});

test('size steps are optional, named, and anything else is refused', () => {
  assert.deepEqual(Object.keys(THEME_SIZES), ['small', 'medium', 'large']);
  assert.deepEqual(themeProblems({ ...tokens, name: 'Plain' }), [], 'a theme saved before sizes existed is still valid');
  assert.deepEqual(themeProblems({ ...sized, name: 'Sized' }), []);
  for (const bad of ['huge', '20px', 'calc(1px)', 1.2, '']) assert.match(themeProblems({ ...tokens, name: 'T', question_size: bad }).join(' '), /question size must be small, medium or large/, String(bad));
});

test('Standard is never stored, so a theme nobody resized keeps exactly the JSON it had', () => {
  const plain = { name: 'Paper', ...tokens };
  assert.equal(JSON.stringify(normalizeDefinition({ ...starterDefinition('T'), theme: plain }).theme), JSON.stringify(plain));
  assert.deepEqual(normalizeDefinition({ ...starterDefinition('T'), theme: { ...plain, question_size: 'medium', answer_size: 'LARGE' } }).theme, { ...plain, answer_size: 'large' });
  assert.deepEqual(tokensOf({ ...tokens, question_size: 'medium' }), tokens);
  assert.deepEqual(tokensOf(themeCopy({ name: 'Sized', ...sized }, 'preset:paper')), sized);
});

test('the page receives each step as a scale, and nothing when a size is Standard', () => {
  const set = new Map();
  const element = { dataset: {}, style: { setProperty: (key, value) => set.set(key, value), removeProperty: key => set.delete(key) } };
  applyTheme(element, { name: 'Sized', ...sized });
  assert.equal(set.get('--t-question-scale'), String(SIZE_SCALE.large));
  assert.equal(set.get('--t-description-scale'), String(SIZE_SCALE.small));
  assert.equal(set.get('--t-answer-scale'), String(SIZE_SCALE.large));
  applyTheme(element, { name: 'Plain', ...tokens });
  assert.equal(set.has('--t-question-scale') || set.has('--t-description-scale') || set.has('--t-answer-scale'), false, 'switching themes clears earlier sizes');
  applyTheme(element, { name: 'Bad', ...tokens, answer_size: 'enormous' });
  assert.equal(set.size, 0, 'an unchecked size is not applied at all');
});

test('workspace themes store sizes only when set, and draft sizes never reach the published form until published', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const themes = `/api/workspaces/${ws.id}/form-themes`;
    const plain = (await owner.post(themes, { ...tokens, name: 'Plain', question_size: 'medium' })).body;
    assert.deepEqual(JSON.parse(env.app.db.get('SELECT tokens FROM form_themes WHERE id = ?', plain.id).tokens), tokens, 'Standard sizes are not stored');
    const resized = (await owner.post(themes, { ...sized, name: 'Sized' })).body;
    assert.equal(resized.question_size, 'large');
    assert.equal((await owner.post(themes, { ...tokens, name: 'Bad', answer_size: '40px' })).status, 400);

    const forms = `/api/workspaces/${ws.id}/forms`;
    const long = ('Step one.\nStep two.\n').repeat(200).slice(0, 2999) + '.'; // ends in text: the server trims the ends
    const definition = { ...withHelp(long), theme: { name: 'Plain', ...tokens } };
    const created = (await owner.post(forms, { definition })).body;
    await owner.post(`${forms}/${created.id}/publish`);
    const live = async () => (await env.client().get(`/api/public/forms/${created.slug}`)).body.definition;
    assert.equal((await live()).fields[0].help, long, 'the published description keeps every line break');

    const current = (await owner.get(`${forms}/${created.id}`)).body;
    const larger = { ...current.draft, theme: { ...current.draft.theme, question_size: 'large' } };
    assert.equal((await owner.patch(`${forms}/${created.id}`, { definition: larger, base_revision: current.revision })).status, 200);
    assert.equal((await owner.get(`${forms}/${created.id}`)).body.draft.theme.question_size, 'large', 'reopened draft keeps the size');
    assert.equal((await live()).theme.question_size, undefined, 'the published form is unchanged until republished');
    assert.equal(JSON.parse(env.app.db.get('SELECT tokens FROM form_themes WHERE id = ?', plain.id).tokens).question_size, undefined, 'the workspace theme is unchanged');
    await owner.post(`${forms}/${created.id}/publish`);
    assert.equal((await live()).theme.question_size, 'large');

    const tooLong = (await owner.get(`${forms}/${created.id}`)).body;
    const refused = await owner.patch(`${forms}/${created.id}`, { definition: withHelp('x'.repeat(3001)), base_revision: tooLong.revision });
    assert.equal(refused.status, 400, 'the server applies the same limit');
  } finally { await env.close(); }
});

test('a draft without a theme can hold typography alone, on the default style; a workspace theme still needs every colour', async () => {
  const typography = { name: 'Default style', font: 'rounded', question_size: 'large' };
  assert.deepEqual(definitionProblems({ ...starterDefinition('T'), theme: typography }), []);
  assert.deepEqual(normalizeDefinition({ ...starterDefinition('T'), theme: typography }).theme, typography);
  assert.match(definitionProblems({ ...starterDefinition('T'), theme: { ...typography, background: '#ffffff' } }).join(' '), /colour/, 'some colours but not all is refused');
  assert.match(definitionProblems({ ...starterDefinition('T'), theme: { ...typography, source: 'preset:paper' } }).join(' '), /colour/, 'a theme that came from somewhere has colours');
  assert.match(themeProblems(typography).join(' '), /colour/, 'outside a form, colours are required');

  // Back at the default values there is nothing to store.
  assert.equal(defaultStyleWith({ font: 'system', question_size: 'medium' }), null);
  assert.deepEqual(defaultStyleWith({ font: 'system', answer_size: 'small' }), { name: 'Default style', font: 'system', answer_size: 'small' });

  // On the page: font and sizes only. The default colours, and dark mode, are untouched.
  const set = new Map();
  const element = { dataset: {}, style: { setProperty: (key, value) => set.set(key, value), removeProperty: key => set.delete(key) } };
  applyTheme(element, typography);
  assert.equal(element.dataset.typography, '1');
  assert.equal(element.dataset.themed, undefined);
  assert.ok(set.get('--t-font').includes('rounded'));
  assert.equal(set.get('--t-question-scale'), String(SIZE_SCALE.large));
  assert.equal(set.has('--t-background'), false);
  applyTheme(element, { name: 'Night', ...tokens });
  assert.equal(element.dataset.typography, undefined, 'a full theme replaces it cleanly');
  assert.equal(element.dataset.themed, '1');

  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/form-themes`, typography)).status, 400, 'never a workspace theme');
    const forms = `/api/workspaces/${ws.id}/forms`;
    const plain = (await owner.post(forms, { definition: starterDefinition('Other') })).body;
    await owner.post(`${forms}/${plain.id}/publish`);
    const otherBefore = JSON.stringify((await env.client().get(`/api/public/forms/${plain.slug}`)).body.definition);
    const created = (await owner.post(forms, { definition: { ...starterDefinition('Typed'), theme: typography } })).body;
    assert.equal((await owner.post(`${forms}/${created.id}/publish`)).status, 200);
    assert.deepEqual((await env.client().get(`/api/public/forms/${created.slug}`)).body.definition.theme, typography);
    assert.equal(JSON.stringify((await env.client().get(`/api/public/forms/${plain.slug}`)).body.definition), otherBefore, 'other forms are untouched');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_themes').count, 0, 'no workspace theme was created');
  } finally { await env.close(); }
});
