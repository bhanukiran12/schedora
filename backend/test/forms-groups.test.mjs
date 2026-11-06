// Multi-question pages: one titled page of independent questions, each with its own key. Evaluated by
// the shared logic, so the conversational screen, classic pages and server validation walk the same path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { definitionProblems, formEnding, formScreens, pruneLogic, starterDefinition, validateSubmission, visibleFields, visiblePages } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { blockEnd, canMove, contactInfoBlock, dropItem, duplicateBlock, moveItem, outlineMarks, uniqueKey } from '../../frontend/js/forms-groups.mjs';

const contact = (prefix = []) => contactInfoBlock(prefix);
const form = (extra = {}) => ({
  title: 'Enquiry', description: '', presentation: 'conversational', submit_label: 'Send',
  fields: [
    { id: 'kind', type: 'single_choice', label: 'Who is this for?', required: true, options: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }, { id: 'press', label: 'Press' }] },
    { id: 'size', type: 'short_text', label: 'Team size?', required: true },
    ...contact(),
    { id: 'notes', type: 'long_text', label: 'Notes', required: true }
  ],
  ...extra
});
const ids = list => list.map(field => field.id);
const screens = (definition, answers, mode = 'conversational') => formScreens(definition, answers, mode).map(ids);
const keys = fields => fields.map(field => field.id);
const MEMBERS = ['first_name', 'last_name', 'phone', 'email', 'company'];

test('the Contact Info page is valid, has readable keys, and is independent questions under one title', () => {
  const block = contact();
  assert.deepEqual(keys(block), ['contact_info', ...MEMBERS]);
  assert.equal(block[0].label, 'Contact Info');
  assert.ok(block.slice(1).every(field => field.group === 'contact_info' && field.label && field.type !== 'page_break'));
  assert.deepEqual(block.slice(1).map(field => field.type), ['short_text', 'short_text', 'phone', 'email', 'short_text']);
  assert.deepEqual(definitionProblems(form()), []);
  assert.deepEqual(keys(contactInfoBlock(['email', 'email_2', 'contact_info'])), ['contact_info_2', 'first_name', 'last_name', 'phone', 'email_3', 'company'], 'a key in use, including a published one, is never reused');
  assert.equal(uniqueKey('a', []), 'a');
});

test('conversational mode shows the whole page on one screen and everything else one at a time', () => {
  assert.deepEqual(screens(form(), {}), [['kind'], ['size'], MEMBERS, ['notes']]);
  assert.equal(formScreens(form(), {}, 'conversational')[2].length, 5);
  assert.deepEqual(visibleFields(form(), {}).length, 8, 'each answer is still its own question');
});

test('classic mode gives the page its own page, and questions after it do not join it', () => {
  assert.deepEqual(screens(form(), {}, 'classic'), [['kind', 'size'], MEMBERS, ['notes']]);
  assert.deepEqual(visiblePages(form(), {}).map(ids), [['kind', 'size'], MEMBERS, ['notes']]);
});

test('ordinary page breaks and forms without pages behave exactly as before', () => {
  const plain = { ...form(), fields: [{ id: 'a', type: 'short_text', label: 'A' }, { id: 'p', type: 'page_break', label: '' }, { id: 'b', type: 'short_text', label: 'B' }, { id: 'c', type: 'short_text', label: 'C' }] };
  assert.deepEqual(definitionProblems(plain), []);
  assert.deepEqual(screens(plain, {}, 'classic'), [['a'], ['b', 'c']]);
  assert.deepEqual(screens(plain, {}), [['a'], ['b'], ['c']]);
  assert.deepEqual(screens(starterDefinition(), { topic: 'other' }), [['name'], ['email'], ['topic'], ['details']]);
  const stored = normalizeDefinition(starterDefinition());
  assert.ok(stored.fields.every(field => !('group' in field) && !('placeholder' in field) && !('grouped' in field)));
});

test('required questions on a page are validated individually, and each answer has its own key', () => {
  const missing = validateSubmission(form(), { kind: 'home', size: '3', notes: 'n' });
  assert.deepEqual(Object.keys(missing.errors).sort(), ['email', 'first_name']);
  const bad = validateSubmission(form(), { kind: 'home', size: '3', notes: 'n', first_name: 'A', email: 'nope', phone: 'x' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'phone']);
  const good = validateSubmission(form(), { kind: 'home', size: '3', notes: 'n', first_name: 'Asha', last_name: 'Rao', phone: '+91 98765 43210', email: 'ASHA@example.com', company: 'Acme' });
  assert.deepEqual(good.errors, {});
  assert.deepEqual(good.answers, { kind: 'home', size: '3', notes: 'n', first_name: 'Asha', last_name: 'Rao', phone: '+91 98765 43210', email: 'asha@example.com', company: 'Acme' });
});

test('branching: into the page, to a question on it, past it, and from inside it', () => {
  const jump = (field, to, when) => ({ logic: [{ field, rules: [{ ...(when ? { when } : {}), to }] }] });
  const is = value => ({ field: 'kind', op: 'equals', value });
  const into = form(jump('kind', { type: 'group', id: 'contact_info' }, is('home')));
  assert.deepEqual(definitionProblems(into), []);
  assert.deepEqual(screens(into, { kind: 'home' }), [['kind'], MEMBERS, ['notes']]);
  assert.deepEqual(screens(into, { kind: 'office' }), [['kind'], ['size'], MEMBERS, ['notes']]);

  const onto = form(jump('kind', { type: 'field', id: 'email' }, is('home')));
  assert.deepEqual(screens(onto, { kind: 'home' }), [['kind'], ['email', 'company'], ['notes']]);

  const past = form(jump('kind', { type: 'field', id: 'notes' }, is('home')));
  assert.deepEqual(screens(past, { kind: 'home' }), [['kind'], ['notes']]);
  const skipped = validateSubmission(past, { kind: 'home', notes: 'n', first_name: 'Dropped', email: 'dropped@example.com', company: 'Dropped' });
  assert.deepEqual(skipped.errors, {}, 'required questions on a skipped page are not required');
  assert.deepEqual(skipped.answers, { kind: 'home', notes: 'n' }, 'answers on a skipped page are excluded');

  const out = form({ ...jump('phone', { type: 'field', id: 'notes' }, { field: 'phone', op: 'answered' }) });
  assert.deepEqual(screens(out, { phone: '+91 98765 43210' }), [['kind'], ['size'], ['first_name', 'last_name', 'phone'], ['notes']]);
  assert.deepEqual(screens(out, {}), [['kind'], ['size'], MEMBERS, ['notes']]);

  const end = form({ ...jump('email', { type: 'ending', id: 'done' }), endings: [{ id: 'other', title: 'Other' }, { id: 'done', title: 'Done' }] });
  assert.deepEqual(screens(end, {}), [['kind'], ['size'], ['first_name', 'last_name', 'phone', 'email']]);
  assert.equal(formEnding(end, {}).id, 'done');
});

test('a hidden page hides only its own questions, and later questions still show', () => {
  const definition = form();
  definition.fields.find(field => field.id === 'contact_info').show_if = { field: 'kind', op: 'equals', value: 'office' };
  assert.deepEqual(definitionProblems(definition), []);
  assert.deepEqual(screens(definition, { kind: 'home' }), [['kind'], ['size'], ['notes']]);
  assert.deepEqual(screens(definition, { kind: 'office' }), [['kind'], ['size'], MEMBERS, ['notes']]);
  assert.deepEqual(Object.keys(validateSubmission(definition, { kind: 'home', size: '1', notes: 'n' }).errors), []);
});

test('definitions that break the page shape are refused with a named reason', () => {
  const problem = fields => definitionProblems({ ...form(), fields }).join(' ');
  const block = () => contact();
  assert.match(problem([{ id: 'x', type: 'short_text', label: 'X', group: 'nowhere' }]), /directly under its page/);
  const split = block();
  split.splice(2, 0, { id: 'gap', type: 'short_text', label: 'Gap' });
  assert.match(problem(split), /directly under its page/);
  const titleless = block();
  titleless[0].label = ' ';
  assert.match(problem(titleless), /page needs a title/);
  const long = block();
  long[0].label = 'x'.repeat(151);
  assert.match(problem(long), /page needs a title/);
  const groupedBreak = block();
  groupedBreak[0].group = 'other';
  assert.match(problem(groupedBreak), /cannot sit inside/);
  const tooLong = block();
  tooLong[1].placeholder = 'x'.repeat(101);
  assert.match(problem(tooLong), /placeholder/);
  const notText = [{ id: 'c', type: 'single_choice', label: 'C', placeholder: 'x', options: [{ id: 'a', label: 'A' }] }];
  assert.match(problem(notText), /placeholder/);
  const notFlag = block();
  notFlag[0].grouped = 'yes';
  assert.match(problem(notFlag), /grouped/);
});

test('normalizing keeps the page shape and gives identical JSON twice', () => {
  const once = normalizeDefinition(form());
  assert.equal(once.fields[2].grouped, true);
  assert.equal(once.fields[3].group, 'contact_info');
  assert.equal(once.fields[3].placeholder, 'Asha');
  assert.equal(JSON.stringify(normalizeDefinition(once)), JSON.stringify(once));
  const padded = normalizeDefinition({ ...form(), fields: form().fields.map(field => field.id === 'contact_info' ? { ...field, label: '  Contact Info ', help: ' Tell us ' } : field) });
  assert.equal(padded.fields[2].label, 'Contact Info');
  assert.equal(padded.fields[2].help, 'Tell us');
});

test('outline marks: a number per question or page, letters inside a page', () => {
  assert.deepEqual(outlineMarks(form().fields), ['1', '2', '3', 'A', 'B', 'C', 'D', 'E', '4']);
  assert.deepEqual(outlineMarks([{ id: 'a', type: 'short_text' }, { id: 'p', type: 'page_break' }, { id: 'b', type: 'short_text' }]), ['1', '', '2']);
});

test('↑/↓: inside a page, out of it at either end, and pages move whole, past neighbours', () => {
  const list = () => structuredClone(form().fields);
  let fields = list();
  assert.equal(moveItem(fields, 4, 1).to, 5, 'moves within the page');
  assert.deepEqual(keys(fields).slice(3, 6), ['first_name', 'phone', 'last_name']);
  assert.ok(fields.slice(3, 8).every(field => field.group === 'contact_info'));

  fields = list();
  const up = moveItem(fields, 3, -1);
  assert.deepEqual([up.to, up.left], [2, true]);
  assert.deepEqual(keys(fields).slice(1, 4), ['size', 'first_name', 'contact_info']);
  assert.equal(fields[2].group, undefined);
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);

  fields = list();
  const down = moveItem(fields, 7, 1);
  assert.deepEqual([down.to, down.left], [7, true]);
  assert.equal(fields[7].id, 'company');
  assert.equal(fields[7].group, undefined);
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);

  fields = list();
  assert.equal(moveItem(fields, 2, -1).to, 1, 'the page moves as a whole');
  assert.deepEqual(keys(fields), ['kind', 'contact_info', ...MEMBERS, 'size', 'notes']);
  assert.equal(moveItem(fields, 1, 1).to, 2, 'and back');
  assert.deepEqual(keys(fields), ['kind', 'size', 'contact_info', ...MEMBERS, 'notes']);

  fields = list();
  const past = moveItem(fields, 1, 1);
  assert.equal(past.to, 7, 'a question outside moves past the whole page, never into it');
  assert.deepEqual(keys(fields), ['kind', 'contact_info', ...MEMBERS, 'size', 'notes']);
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);
  const back = moveItem(fields, 7, -1);
  assert.equal(back.to, 1);
  assert.deepEqual(keys(fields), ['kind', 'size', 'contact_info', ...MEMBERS, 'notes']);

  fields = list();
  assert.equal(canMove(fields, 0, -1), false);
  assert.equal(canMove(fields, 3, -1), true, 'the first question on a page can leave it');
  assert.equal(canMove(fields, 8, 1), false);
  const last = [...contact()];
  assert.equal(canMove(last, 0, 1), false, 'a page at the end cannot go further');
  assert.equal(canMove(last, 5, 1), true, 'its last question can still leave it');
});

test('drag: a dropped question joins or leaves a page; a page travels whole and never splits another', () => {
  const list = () => structuredClone(form().fields);
  let fields = list();
  const join = dropItem(fields, 1, 5);
  assert.equal(join.to, 4);
  assert.equal(fields[4].id, 'size');
  assert.equal(fields[4].group, 'contact_info');
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);

  fields = list();
  const leave = dropItem(fields, 4, 9);
  assert.equal(leave.left, true);
  assert.equal(fields.at(-1).id, 'last_name');
  assert.equal(fields.at(-1).group, undefined);
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);

  fields = list();
  dropItem(fields, 7, 3);
  assert.deepEqual(keys(fields).slice(3, 8), ['company', 'first_name', 'last_name', 'phone', 'email'], 'reordered within the page');
  assert.ok(fields.slice(3, 8).every(field => field.group === 'contact_info'));

  fields = list();
  dropItem(fields, 2, 0);
  assert.deepEqual(keys(fields), ['contact_info', ...MEMBERS, 'kind', 'size', 'notes']);

  fields = [...contact(), ...contactInfoBlock(keys(contact()))];
  const before = keys(fields);
  assert.equal(dropItem(fields, 0, 3), null, 'dropping a page inside itself changes nothing');
  assert.deepEqual(keys(fields), before);
  dropItem(fields, 0, 8);
  assert.deepEqual(definitionProblems({ ...form(), fields }), [], 'a page dropped inside another lands after it');
  assert.equal(fields[0].id, 'contact_info_2');
  assert.equal(fields[6].id, 'contact_info');

  fields = list();
  assert.equal(dropItem(fields, 1, 1), null);
  assert.equal(dropItem(fields, 1, 2), null);
});

test('duplicating a page gives every copy new keys; pruning follows a removed page', () => {
  const fields = structuredClone(form().fields);
  let serial = 0;
  const at = duplicateBlock(fields, 2, prefix => `${prefix}_${++serial}`);
  assert.equal(at, 8);
  assert.equal(blockEnd(fields, at), 14);
  assert.deepEqual(definitionProblems({ ...form(), fields }), []);
  assert.equal(new Set(keys(fields)).size, fields.length);
  assert.equal(fields[at].label, 'Contact Info (copy)');
  assert.ok(fields.slice(at + 1, at + 6).every(field => field.group === fields[at].id));

  const definition = form({ logic: [{ field: 'kind', rules: [{ to: { type: 'group', id: 'contact_info' } }] }] });
  definition.fields.splice(2, 6);
  assert.equal(pruneLogic(definition), 1);
  assert.deepEqual(definitionProblems(definition), []);
});

test('server: answers keep their own keys through publish, CSV, versions and skipped paths', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const definition = form({ logic: [{ field: 'kind', rules: [{ when: { field: 'kind', op: 'equals', value: 'press' }, to: { type: 'field', id: 'notes' } }] }] });
    const created = (await owner.post(base, { definition })).body;
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 1);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);

    const missing = await submit({ answers: { kind: 'office', size: '3', notes: 'n', first_name: 'Asha' } });
    assert.equal(missing.status, 400);
    assert.deepEqual(Object.keys(missing.body.error.errors), ['email']);

    const full = await submit({ answers: { kind: 'office', size: '3', notes: 'n', first_name: 'Asha', last_name: 'Rao', phone: '+91 98765 43210', email: 'asha@example.com', company: 'Acme' } });
    assert.equal(full.status, 201);
    const skipped = await submit({ answers: { kind: 'press', notes: 'n', first_name: 'Dropped', email: 'dropped@example.com' } });
    assert.equal(skipped.status, 201);
    const rows = (await owner.get(`${base}/${created.id}/responses`)).body.responses;
    const stored = rows.map(row => row.answers);
    assert.deepEqual(stored.find(answers => answers.kind === 'press'), { kind: 'press', notes: 'n' });
    assert.equal(stored.find(answers => answers.kind === 'office').company, 'Acme');

    const csv = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    for (const column of ['First name', 'Last name', 'Phone number', 'Email', 'Company']) assert.ok(csv.includes(`"${column}"`), column);
    assert.equal(csv.includes('Contact Info'), false, 'the page title is not an answer column');
    assert.ok(csv.includes('asha@example.com'));
    assert.equal(csv.includes('dropped@example.com'), false);

    const contactRow = env.app.db.get('SELECT name, email FROM contacts WHERE email = ?', 'asha@example.com');
    assert.equal(contactRow.name, 'Asha Rao', 'the contact record gets the split name');

    // A later version can reorder and drop a question; version 1's answers keep reading the same.
    const current = (await owner.get(`${base}/${created.id}`)).body;
    const next = { ...current.draft, fields: current.draft.fields.filter(field => field.id !== 'company') };
    assert.equal((await owner.patch(`${base}/${created.id}`, { definition: next, base_revision: current.revision })).status, 200);
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 2);
    const later = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    assert.ok(later.includes('"Company"') && later.includes('"Acme"'), 'the old column and its answer remain');
  } finally { await env.close(); }
});
