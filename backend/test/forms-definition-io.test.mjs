// Import JSON and Export form definition (docs/FORMS.md, "Import and export"). Files are checked on the
// server, unsupported settings are refused by name, and an import is always an unpublished draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setup, signUp } from './helpers.mjs';
import { validateSubmission, visibleFields } from '../src/shared/forms-logic.mjs';
import { EXAMPLE_DEFINITION_FILE } from '../../frontend/js/forms-definition-example.mjs';

// The acceptance fixture lives beside this checkout; a copy of its shape is used when it is absent.
const FIXTURE_PATH = new URL('../../../technical-profile-draft/definition.json', import.meta.url);
const fixtureText = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH, 'utf8') : null;

const tiny = (overrides = {}) => ({
  title: 'Tiny', presentation: 'classic',
  fields: [
    { id: 'name', type: 'short_text', label: 'Name', required: true },
    { id: 'colour', type: 'single_choice', label: 'Colour', required: true, options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }] },
    { id: 'why', type: 'long_text', label: 'Why?', show_if: { field: 'colour', op: 'equals', value: 'red' } }
  ],
  ...overrides
});

async function host() {
  const ctx = await setup();
  const http = ctx.client();
  const { ws } = await signUp(http, 'Importer');
  const path = suffix => `/api/workspaces/${ws.id}/forms${suffix}`;
  return { ...ctx, http, ws, path };
}

const check = (http, path, source) => http.post(path('/import-check'), { source: typeof source === 'string' ? source : JSON.stringify(source) });
const importFile = (http, path, source) => http.post(path('/import'), { source: typeof source === 'string' ? source : JSON.stringify(source) });

test('the Technical Profile Details fixture imports as an unpublished draft with its logic, descriptions and Loom field', { skip: !fixtureText && 'fixture not present' }, async () => {
  const { http, path, close } = await host();
  try {
    const preview = await check(http, path, fixtureText);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.summary.title, 'Technical Profile Details');
    assert.equal(preview.body.summary.question_count, 39);
    assert.equal(preview.body.summary.page_count, 7);
    assert.equal(preview.body.summary.conditional_count, 1);
    assert.equal(preview.body.summary.format, 'definition');

    const created = await importFile(http, path, fixtureText);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const form = (await http.get(path('/' + created.body.form.id))).body;
    assert.equal(form.published_version, null, 'never published');
    const source = JSON.parse(fixtureText);
    assert.deepEqual(form.draft.fields.map(field => field.id), source.fields.map(field => field.id), 'stable ids and order kept');
    const byId = Object.fromEntries(form.draft.fields.map(field => [field.id, field]));
    assert.equal(byId.project_name.required, true, 'required project');
    assert.equal(byId.project_description.required, true);
    assert.deepEqual(byId.other_tech_level.show_if, { field: 'other_tech', op: 'answered' }, 'conditional proficiency question');
    assert.match(byId.loom_url.help, /^Question Bank \(copy this link into your browser\): https:\/\/docs\.google\.com\//, 'Question Bank instructions');
    assert.equal(byId.loom_url.help, source.fields.find(field => field.id === 'loom_url').help);
    assert.equal(byId.loom_url.required, true, 'Loom field');
    assert.equal(byId.state.options.length, 36);
    // The conditional proficiency question appears only once another technology is named.
    assert.ok(!visibleFields(form.draft, {}).some(field => field.id === 'other_tech_level'));
    assert.ok(visibleFields(form.draft, { other_tech: 'Go' }).some(field => field.id === 'other_tech_level'));
    assert.ok('other_tech_level' in validateSubmission(form.draft, { other_tech: 'Go' }).errors);
  } finally { await close(); }
});

test('the downloadable example imports, and export then reimport keeps every supported setting', async () => {
  const { http, path, close } = await host();
  try {
    const preview = await check(http, path, EXAMPLE_DEFINITION_FILE);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.summary.format, 'envelope');
    assert.equal(preview.body.summary.jump_count, 1);
    assert.equal(preview.body.summary.ending_count, 1);
    assert.equal(preview.body.summary.theme, 'Example theme');
    const first = await importFile(http, path, EXAMPLE_DEFINITION_FILE);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const exported = await http.get(path(`/${first.body.form.id}/definition.json`));
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment; filename="workshop-registration\.schedora-form\.json"/);
    assert.equal(exported.body.format, 'schedora.form-definition');
    assert.equal(exported.body.version, 1);
    assert.deepEqual(Object.keys(exported.body).sort(), ['definition', 'exported_at', 'format', 'version']);
    const again = await importFile(http, path, exported.body);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const original = (await http.get(path('/' + first.body.form.id))).body.draft;
    const reimported = (await http.get(path('/' + again.body.form.id))).body.draft;
    assert.deepEqual(reimported, original, 'nothing lost in the round trip');
    assert.ok(again.body.warnings.some(text => /already has 1 form called “Workshop registration”/.test(text)));
  } finally { await close(); }
});

test('export excludes routing and responses, and reimport of a published form starts as a draft', async () => {
  const { http, path, ws, close } = await host();
  try {
    const created = await importFile(http, path, tiny());
    const id = created.body.form.id;
    const routed = await http.raw('PUT', path(`/${id}/routing`), { routing: { rules: [{ condition: { field: 'colour', op: 'equals', value: 'red' }, action: { type: 'message', message: 'Red!' } }], fallback: null }, base_revision: created.body.form.revision });
    assert.equal(routed.status, 200, JSON.stringify(routed.body));
    assert.equal((await http.post(path(`/${id}/publish`), {})).status, 200);
    const form = (await http.get(path('/' + id))).body;
    assert.equal((await http.post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Asha', colour: 'blue' }, version: 1 })).status, 201);
    const file = (await http.get(path(`/${id}/definition.json`))).body;
    const text = JSON.stringify(file);
    assert.ok(!/routing|Red!|Asha|response|evaluation_policy|slug|workspace/.test(text), text);
    const copy = await importFile(http, path, file);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.form.published_version, null);
    assert.equal(copy.body.form.routing, null);
    assert.notEqual(copy.body.form.slug, form.slug);
    assert.equal((await http.get(`/api/workspaces/${ws.id}/forms`)).body.length, 2);
  } finally { await close(); }
});

test('invalid JSON reports where it broke and creates nothing', async () => {
  const { http, path, close } = await host();
  try {
    const broken = '{\n  "title": "Broken",\n  "fields": [\n    { "id": "a", "type": "short_text" "label": "A" }\n  ]\n}';
    for (const route of ['/import-check', '/import']) {
      const result = await http.post(path(route), { source: broken });
      assert.equal(result.status, 400);
      assert.match(result.body.error.message, /^This is not valid JSON near line 4, column \d+/);
    }
    assert.equal((await http.post(path('/import'), { source: '' })).body.error.message, 'Choose a .json file or paste the JSON text.');
    assert.match((await http.post(path('/import'), { source: '[1, 2]' })).body.error.message, /one JSON object/);
    assert.match((await http.post(path('/import'), { source: '{"title": "x", "fields": [' })).body.error.message, /not valid JSON/);
    assert.equal((await http.get(path(''))).body.length, 0);
  } finally { await close(); }
});

test('broken logic references and duplicate ids are explained with question numbers', async () => {
  const { http, path, close } = await host();
  try {
    const problem = async definition => { const result = await check(http, path, definition); assert.equal(result.status, 400, JSON.stringify(result.body)); return result.body.error.problems; };
    const missingChoice = tiny();
    missingChoice.fields[2].show_if.value = 'green';
    assert.deepEqual(await problem(missingChoice), ['Question 3 (“Why?”) has a display rule that refers to the choice “green” in Question 2 (“Colour”), which doesn\'t exist. Its choices are: red, blue.']);
    const missingField = tiny();
    missingField.fields[2].show_if.field = 'favourite';
    assert.match((await problem(missingField))[0], /refers to the question “favourite”, which doesn't exist/);
    const later = tiny();
    later.fields[1].show_if = { field: 'why', op: 'answered' };
    assert.match((await problem(later))[0], /^Question 2 \(“Colour”\) .* refers to Question 3 \(“Why\?”\), which comes later/);
    const jump = tiny({ logic: [{ field: 'name', rules: [{ to: { type: 'field', id: 'nowhere' } }] }] });
    assert.match((await problem(jump))[0], /jumps to “nowhere”, which doesn't exist/);
    const ending = tiny({ logic: [{ field: 'name', rules: [{ to: { type: 'ending', id: 'done' } }] }] });
    assert.match((await problem(ending))[0], /jumps to the ending “done”, which doesn't exist/);
    const duplicate = tiny();
    duplicate.fields[2].id = 'name';
    delete duplicate.fields[2].show_if;
    assert.deepEqual(await problem(duplicate), ['Question 3 (“Why?”) uses the id “name”, which Question 1 (“Name”) already uses. Every question and page needs its own id.']);
    const duplicateChoice = tiny();
    duplicateChoice.fields[1].options[1].id = 'red';
    assert.match((await problem(duplicateChoice))[0], /Question 2 \(“Colour”\) has two choices with the id “red”/);
    // Page breaks are named by page, and numbering of questions skips them.
    const paged = tiny();
    paged.fields.splice(1, 0, { id: 'p2', type: 'page_break', label: 'More' });
    paged.fields[3].show_if.value = 'green';
    assert.match((await problem(paged))[0], /^Question 3 \(“Why\?”\)/);
    const badId = tiny();
    badId.fields[0].id = 'Full Name';
    assert.match((await problem(badId))[0], /^Question 1 \(“Name”\) needs an id of lowercase letters/);
  } finally { await close(); }
});

test('unsupported, excluded and server-owned settings are refused by name instead of dropped', async () => {
  const { http, path, close } = await host();
  try {
    const first = async definition => (await check(http, path, definition)).body.error.message;
    const extra = tiny();
    extra.fields[0].validation = { min: 3 };
    assert.match(await first(extra), /^Question 1 \(“Name”\) has the setting “validation”, which Schedora Forms does not support/);
    assert.match(await first(tiny({ responses: [] })), /The form contains “responses”. Form files never carry responses/);
    assert.match(await first(tiny({ routing: { rules: [] } })), /never carry integration settings/);
    assert.match(await first(tiny({ api_key: 'sch_x' })), /never carry credentials/);
    assert.match(await first({ format: 'schedora.form-definition', version: 1, definition: tiny(), webhooks: [] }), /The file contains “webhooks”/);
    assert.match(await first(tiny({ evaluation_policy: 'normalized_v1' })), /“evaluation_policy”, which is set when you publish/);
    const textOptions = tiny();
    textOptions.fields[0].options = [{ id: 'a', label: 'A' }];
    assert.match(await first(textOptions), /is short text, so it cannot have options/);
    const pageRequired = tiny();
    pageRequired.fields.splice(1, 0, { id: 'p2', type: 'page_break', required: true });
    assert.match(await first(pageRequired), /Page 2 is a page break, which cannot be required/);
    const unknownType = tiny();
    unknownType.fields[0].type = 'rating';
    assert.match(await first(unknownType), /has the type “rating”, which is not supported/);
    const foreign = { title: 'Typeform-ish', fields: [{ ref: 'abc', title: 'Name?', type: 'short_text' }] };
    assert.match(await first(foreign), /looks like a file from another form tool/);
    assert.match(await first({ format: 'schedora.form-definition', version: 2, definition: tiny() }), /format version 2/);
    assert.match(await first({ format: 'typeform', definition: tiny() }), /Schedora imports “schedora.form-definition” files/);
    assert.match(await first(tiny({ submit_label: 'x'.repeat(41) })), /keep it to 40 or fewer/);
    const long = tiny();
    long.fields[0].help = 'x'.repeat(3001);
    assert.match(await first(long), /^Question 1 \(“Name”\) description must be 3,000 characters or fewer/);
    assert.equal((await http.get(path(''))).body.length, 0, 'nothing created');
  } finally { await close(); }
});

test('while authoring is frozen, import is refused and creates nothing; checking and exporting still work', async () => {
  const { app, http, path, close } = await host();
  try {
    const created = await importFile(http, path, tiny());
    app.config.formsAuthoringFrozen = true;
    const refused = await importFile(http, path, tiny());
    assert.equal(refused.status, 423);
    assert.equal(refused.body.error.code, 'forms_authoring_frozen');
    assert.equal((await check(http, path, tiny())).status, 200);
    assert.equal((await http.get(path(`/${created.body.form.id}/definition.json`))).status, 200);
    assert.equal((await http.get(path(''))).body.length, 1);
  } finally { await close(); }
});

test('import and export need forms access in that workspace; images must belong to it', async () => {
  const { http, path, base, close } = await host();
  try {
    const other = (await import('./helpers.mjs')).client(base);
    const { ws: otherWs } = await signUp(other, 'Other');
    const created = await importFile(http, path, tiny());
    assert.equal((await other.get(`/api/workspaces/${otherWs.id}/forms/${created.body.form.id}/definition.json`)).status, 404, 'another workspace cannot export it');
    assert.equal((await other.get(path(`/${created.body.form.id}/definition.json`))).status, 404, 'not a member: the form is not found');
    assert.equal((await other.post(path('/import'), { source: JSON.stringify(tiny()) })).status, 404);
    const anonymous = (await import('./helpers.mjs')).client(base);
    assert.equal((await anonymous.post(path('/import-check'), { source: '{}' })).status, 401);
    const withImage = tiny();
    withImage.fields[0].media = { type: 'image', asset: 'a'.repeat(32), alt: 'Logo' };
    const refused = await check(http, path, withImage);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /^Question 1 \(“Name”\) shows an image that is not in this workspace/);
  } finally { await close(); }
});
