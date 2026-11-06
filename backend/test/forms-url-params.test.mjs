// URL parameters: declared names only, kept apart from answers, read by one evaluator in preview, the
// public form and server validation. Values are untrusted, and only opted-in ones are ever stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';
import { attributionColumns, attributionValues, choiceRuleConflicts, definitionProblems, dropHiddenChoices, formEnding, starterDefinition, URL_PARAM_LIMITS, urlParamKeyProblem, urlParamRuleConflicts, urlParamValues, validateSubmission, visibleFields } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition } from '../src/forms/service.mjs';
import { addUrlParam, exampleLink, paramSourceValue, parseParamSource, removeUrlParam, setUrlParamRecorded, urlParamUses } from '../../frontend/js/forms-url-params.mjs';
import { newChoiceRule } from '../../frontend/js/forms-choice-rules.mjs';
import { jumpSentence, paramCondition, renameInLogic } from '../../frontend/js/forms-jumps.mjs';
import { draftChanges } from '../../frontend/js/forms-readiness.mjs';
import { dependentRules } from '../../frontend/js/forms-type-change.mjs';

const options = (...ids) => ids.map(id => ({ id, label: id.toUpperCase() }));
const param = (key, value, op = 'equals') => ({ param: key, op, ...(value === undefined ? {} : { value }) });
const form = (extra = {}) => ({
  title: 'Enquiry', description: '', presentation: 'classic', submit_label: 'Send',
  url_params: [{ key: 'utm_source', record: true }, { key: 'campaign' }],
  fields: [
    { id: 'help', type: 'single_choice', label: 'How can we help?', required: true, options: options('email', 'phone', 'visit') },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false }
  ],
  choice_rules: [{ field: 'help', rules: [{ when: param('utm_source', 'partner'), hide: ['visit'] }] }],
  ...extra
});
const values = (definition, source) => ({ ...urlParamValues(definition, source) });
const offered = (definition, answers, params) => visibleFields(definition, answers, params).find(field => field.id === 'help')?.options.map(option => option.id);

test('declaring: names are checked, app options are reserved, and nothing new is stored unless used', () => {
  for (const bad of ['', 'UTM', '1st', '_x', 'a-b', 'a b', 'a'.repeat(41), 5, null]) assert.ok(urlParamKeyProblem(bad), String(bad));
  for (const reserved of ['mode', 'embed', 'product']) assert.match(urlParamKeyProblem(reserved), /used by form links/);
  assert.equal(urlParamKeyProblem('utm_source'), null);
  assert.match(urlParamKeyProblem('a', ['a']), /already declared/);

  const bad = url_params => definitionProblems(form({ choice_rules: [], url_params }));
  assert.deepEqual(bad([{ key: 'ok' }]), []);
  assert.ok(bad('utm').length);
  assert.ok(bad([{ key: 'mode' }]).length);
  assert.ok(bad([{ key: 'a' }, { key: 'a' }]).length);
  assert.ok(bad([{ key: 'a', record: 'yes' }]).length);
  assert.ok(bad(Array.from({ length: URL_PARAM_LIMITS.count + 1 }, (_, index) => ({ key: `k${index}` }))).length);

  const starter = starterDefinition();
  const stored = normalizeDefinition(starter);
  assert.equal('url_params' in stored, false);
  assert.deepEqual(normalizeDefinition({ ...starter, url_params: [] }), stored);
  const kept = normalizeDefinition(form({ url_params: [{ key: 'utm_source', record: true, extra: 1 }, { key: 'campaign', record: false }] }));
  assert.deepEqual(kept.url_params, [{ key: 'utm_source', record: true }, { key: 'campaign' }]);
  assert.deepEqual(normalizeDefinition(kept), kept, 'normalizing twice gives identical JSON');
});

test('values: missing, empty, duplicate, oversized and undeclared are defined, from a link and from a request', () => {
  const definition = form();
  const link = query => values(definition, new URLSearchParams(query));

  assert.deepEqual(link('utm_source=partner'), { utm_source: 'partner' });
  assert.deepEqual(link(''), {}, 'missing');
  assert.deepEqual(link('utm_source='), {}, 'empty counts as missing');
  assert.deepEqual(link('utm_source=%20%20'), {}, 'only spaces counts as missing');
  assert.deepEqual(link('utm_source=partner&utm_source=other'), { utm_source: 'partner' }, 'duplicate: the first counts');
  assert.deepEqual(link('utm_source=&utm_source=partner'), {}, 'duplicate: the first counts even when empty');
  assert.deepEqual(link(`utm_source=${'a'.repeat(URL_PARAM_LIMITS.value)}`), { utm_source: 'a'.repeat(URL_PARAM_LIMITS.value) }, 'exactly at the limit');
  assert.deepEqual(link(`utm_source=${'a'.repeat(URL_PARAM_LIMITS.value + 1)}`), {}, 'oversized counts as missing, never cut down');
  assert.deepEqual(link('utm_medium=email&UTM_SOURCE=partner&__proto__=x&constructor=y'), {}, 'undeclared keys, including a different case, are ignored');
  assert.deepEqual(link('utm_source=%20Partner%20%20Co%20'), { utm_source: 'Partner Co' }, 'spacing is tidied, case is kept');
  assert.deepEqual(link('utm_source=a%00b'), {}, 'control characters count as missing');
  assert.deepEqual(link('utm_source=caf%C3%A9'), { utm_source: 'café' });

  // A crafted request can send anything; nothing but a declared string gets through, and none of this is an error.
  for (const junk of [null, 'x', 5, true, [], ['utm_source'], { utm_source: 5 }, { utm_source: ['partner'] }, { utm_source: { a: 1 } }, { utm_source: null }]) assert.deepEqual(values(definition, junk), {}, JSON.stringify(junk));
  assert.deepEqual(values(definition, JSON.parse('{"__proto__":{"utm_source":"partner"}}')), {});
  assert.deepEqual(values(definition, { get: 'x', utm_source: 'partner', other: 'y' }), { utm_source: 'partner' });
  assert.deepEqual(values(starterDefinition(), { utm_source: 'partner' }), {}, 'a form that declares nothing reads nothing');

  // A declared name that matches an object method is still just missing.
  const odd = form({ url_params: [{ key: 'constructor' }], choice_rules: [{ field: 'help', rules: [{ when: param('constructor', undefined, 'not_answered'), hide: ['visit'] }] }] });
  assert.deepEqual(offered(odd, {}, {}), ['email', 'phone']);
  assert.deepEqual(offered(odd, {}, { constructor: 'x' }), ['email', 'phone', 'visit']);
});

test('conditional choices: a parameter hides a choice, the default link does not, and the server enforces it', () => {
  const definition = form();
  assert.deepEqual(definitionProblems(definition), []);
  assert.deepEqual(choiceRuleConflicts(definition), []);
  assert.deepEqual(offered(definition, {}), ['email', 'phone', 'visit']);
  assert.deepEqual(offered(definition, {}, {}), ['email', 'phone', 'visit']);
  assert.deepEqual(offered(definition, {}, { utm_source: 'other' }), ['email', 'phone', 'visit']);
  assert.deepEqual(offered(definition, {}, { utm_source: 'Partner' }), ['email', 'phone', 'visit'], 'is compares exactly');
  assert.deepEqual(offered(definition, {}, { utm_source: 'partner' }), ['email', 'phone']);
  assert.deepEqual(offered(definition, {}, new URLSearchParams('utm_source=partner')), ['email', 'phone'], 'the same result from a link');
  assert.deepEqual(offered(definition, {}, { utm_source: ` ${'partner'}  ` }), ['email', 'phone']);
  assert.deepEqual(offered(definition, {}, { other: 'partner' }), ['email', 'phone', 'visit']);

  assert.deepEqual(validateSubmission(definition, { help: 'visit' }).answers, { help: 'visit' });
  assert.deepEqual(Object.keys(validateSubmission(definition, { help: 'visit' }, { utm_source: 'partner' }).errors), ['help'], 'required, and the hidden choice does not count');
  assert.deepEqual(validateSubmission(definition, { help: 'email' }, { utm_source: 'partner' }).answers, { help: 'email' });

  const answers = { help: 'visit' };
  dropHiddenChoices(definition, answers, { utm_source: 'partner' });
  assert.deepEqual(answers, {}, 'preview and the public form drop it from the active answer');

  const allHidden = form({ choice_rules: [{ field: 'help', rules: [{ when: param('utm_source', undefined, 'answered'), hide: ['email', 'phone', 'visit'] }] }] });
  assert.deepEqual(validateSubmission(allHidden, { help: 'visit', notes: 'x' }, { utm_source: 'any' }), { answers: { notes: 'x' }, errors: {} }, 'all hidden: skipped even when required');
  const missing = form({ choice_rules: [{ field: 'help', rules: [{ when: param('utm_source', undefined, 'not_answered'), hide: ['visit'] }] }] });
  assert.deepEqual(offered(missing, {}, {}), ['email', 'phone'], 'a rule can read a missing parameter');
  assert.deepEqual(offered(missing, {}, { utm_source: '' }), ['email', 'phone'], 'and empty is the same as missing');
  assert.deepEqual(offered(missing, {}, { utm_source: 'x'.repeat(URL_PARAM_LIMITS.value + 1) }), ['email', 'phone'], 'and so is oversized');
});

test('jumps: a parameter chooses the path and the ending, and every operator treats missing the same way', () => {
  const definition = form({
    choice_rules: [],
    fields: [
      { id: 'name', type: 'short_text', label: 'Name', required: true },
      { id: 'size', type: 'short_text', label: 'Team size', required: true },
      { id: 'notes', type: 'long_text', label: 'Notes', required: false }
    ],
    logic: [{ field: 'name', rules: [
      { when: param('campaign', 'spring'), to: { type: 'ending', id: 'offer' } },
      { when: { all: [param('utm_source', 'partner'), param('campaign', undefined, 'not_answered')] }, to: { type: 'field', id: 'notes' } }
    ] }],
    endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'offer', title: 'Spring offer' }]
  });
  assert.deepEqual(definitionProblems(definition), []);
  const ids = params => visibleFields(definition, { name: 'A' }, params).map(field => field.id);
  assert.deepEqual(ids({}), ['name', 'size', 'notes']);
  assert.deepEqual(ids({ campaign: 'spring' }), ['name']);
  assert.deepEqual(ids({ utm_source: 'partner' }), ['name', 'notes']);
  assert.deepEqual(ids({ utm_source: 'partner', campaign: 'x' }), ['name', 'size', 'notes']);
  assert.equal(formEnding(definition, { name: 'A' }, { campaign: 'spring' }).id, 'offer');
  assert.equal(formEnding(definition, { name: 'A' }).id, 'thanks');

  assert.deepEqual(Object.keys(validateSubmission(definition, { name: 'A' }).errors), ['size'], 'the default link asks the question');
  const jumped = validateSubmission(definition, { name: 'A', size: 'dropped' }, { campaign: 'spring' });
  assert.deepEqual(jumped.errors, {});
  assert.deepEqual(jumped.answers, { name: 'A' }, 'answers on the skipped path are discarded');
  assert.equal(jumped.ending.id, 'offer');

  const op = (operator, value, source) => visibleFields(form({ choice_rules: [], fields: [form().fields[1], { id: 'x', type: 'short_text', label: 'X' }], logic: [{ field: 'notes', rules: [{ when: param('campaign', value, operator), to: { type: 'ending', id: 'e' } }] }], endings: [{ id: 'e', title: 'E' }] }), {}, source).length === 1;
  assert.equal(op('equals', 'a', {}), false);
  assert.equal(op('not_equals', 'a', {}), true, 'is not: true when missing');
  assert.equal(op('contains', 'a', {}), false);
  assert.equal(op('contains', 'SPR', { campaign: 'spring' }), true, 'includes ignores case, like other text rules');
  assert.equal(op('answered', undefined, {}), false);
  assert.equal(op('answered', undefined, { campaign: 'x' }), true);
  assert.equal(op('not_answered', undefined, { campaign: '' }), true);
});

test('parameters stay apart from answers: same name, no crossover, and no display rules or routing', () => {
  const definition = form({
    url_params: [{ key: 'source', record: true }],
    fields: [
      { id: 'source', type: 'short_text', label: 'How did you find us?', required: false },
      { id: 'help', type: 'single_choice', label: 'Help', required: false, options: options('email', 'visit') }
    ],
    choice_rules: [{ field: 'help', rules: [{ when: param('source', 'partner'), hide: ['visit'] }] }]
  });
  assert.deepEqual(definitionProblems(definition), []);
  assert.deepEqual(offered(definition, { source: 'partner' }, {}), ['email', 'visit'], 'an answer never acts as a parameter');
  assert.deepEqual(offered(definition, {}, { source: 'partner' }), ['email']);
  const both = validateSubmission(definition, { source: 'typed', help: 'email' }, { source: 'partner' });
  assert.deepEqual(both.answers, { source: 'typed', help: 'email' }, 'and a parameter never becomes an answer');
  assert.deepEqual(validateSubmission(definition, { help: 'email' }, { source: 'partner' }).answers, { help: 'email' });

  const wordsOnly = form({ choice_rules: [], fields: [form().fields[0], { ...form().fields[1], show_if: param('campaign', 'x') }] });
  assert.ok(definitionProblems(wordsOnly).length, 'a display rule cannot read a parameter in this slice');
  const mixed = form({ choice_rules: [], logic: [{ field: 'help', rules: [{ when: { field: 'help', ...param('campaign', 'x') }, to: { type: 'field', id: 'notes' } }] }] });
  assert.match(definitionProblems(mixed).join(), /either a question or a URL parameter/);
});

test('undeclared or blank rules: refused at save or publish, with the draft kept where repair is possible', () => {
  const undeclaredJump = form({ choice_rules: [], logic: [{ field: 'help', rules: [{ when: param('nope', 'x'), to: { type: 'field', id: 'notes' } }] }] });
  assert.match(definitionProblems(undeclaredJump).join(), /“nope”, which is not declared/);
  const undeclaredHide = form({ url_params: [] });
  assert.deepEqual(definitionProblems(undeclaredHide), [], 'a hide rule can be saved for repair');
  assert.match(choiceRuleConflicts(undeclaredHide)[0].message, /not declared/);
  assert.deepEqual(offered(undeclaredHide, {}, { utm_source: 'partner' }), ['email', 'phone', 'visit'], 'and does nothing until repaired');

  const blankHide = form({ choice_rules: [{ field: 'help', rules: [{ when: param('utm_source', '  '), hide: ['visit'] }] }] });
  assert.match(choiceRuleConflicts(blankHide)[0].message, /needs a value/);
  const blankJump = form({ choice_rules: [], logic: [{ field: 'help', rules: [{ when: paramCondition('campaign'), to: { type: 'field', id: 'notes' } }] }] });
  assert.deepEqual(definitionProblems(blankJump), [], 'a jump can be saved while its value is typed');
  assert.match(urlParamRuleConflicts(blankJump)[0], /empty value/);
  const longJump = form({ choice_rules: [], logic: [{ field: 'help', rules: [{ when: param('campaign', 'x'.repeat(URL_PARAM_LIMITS.value + 1)), to: { type: 'field', id: 'notes' } }] }] });
  assert.match(definitionProblems(longJump).join(), /up to 200 characters/, 'a value no link could ever carry');

  assert.deepEqual(normalizeDefinition(form({ choice_rules: [{ field: 'help', rules: [{ when: param('utm_source', '  partner   co '), hide: ['visit'] }] }] })).choice_rules[0].rules[0].when.value, 'partner co', 'rule values are stored as link values are read');
});

test('builder helpers: declaring, what depends on a parameter, the example link and sentences', () => {
  const definition = form({ url_params: undefined, choice_rules: undefined });
  delete definition.url_params;
  addUrlParam(definition, 'utm_source');
  addUrlParam(definition, 'ref');
  setUrlParamRecorded(definition, 'ref', true);
  assert.deepEqual(definition.url_params, [{ key: 'utm_source' }, { key: 'ref', record: true }]);
  setUrlParamRecorded(definition, 'ref', false);
  assert.deepEqual(definition.url_params[1], { key: 'ref' });
  assert.equal(exampleLink('https://x.test/f/a', definition), 'https://x.test/f/a?utm_source=example&ref=example');
  assert.equal(exampleLink('https://x.test/f/a', form()), 'https://x.test/f/a?utm_source=partner&campaign=example', 'a value a rule looks for is more useful');
  assert.equal(exampleLink('https://x.test/f/a', starterDefinition()), 'https://x.test/f/a');
  assert.equal(parseParamSource(paramSourceValue('utm_source')), 'utm_source');
  assert.equal(parseParamSource('kind'), null);

  const used = form({ logic: [{ field: 'notes', rules: [{ when: { any: [param('campaign', 'spring')] }, to: { type: 'ending', id: 'e' } }] }], endings: [{ id: 'e', title: 'E' }] });
  assert.deepEqual(urlParamUses(used, 'utm_source'), ['“How can we help?”: When the link’s utm_source is “partner”, hide “VISIT”.']);
  assert.equal(urlParamUses(used, 'campaign').length, 1);
  assert.deepEqual(urlParamUses(used, 'none'), []);
  assert.equal(jumpSentence({ when: param('campaign', undefined, 'not_answered'), to: { type: 'ending', id: 'e' } }, used), 'When the link has no campaign, go to the ending “E”.');

  removeUrlParam(definition, 'ref');
  removeUrlParam(definition, 'utm_source');
  assert.equal('url_params' in definition, false);

  const first = form();
  assert.deepEqual(newChoiceRule(first, 0), { when: paramCondition('utm_source'), hide: ['email'] }, 'the first question can still use a parameter');
  renameInLogic(used, 'help', 'help_two');
  assert.equal(used.logic[0].rules[0].when.any[0].param, 'campaign', 'a question rename does not touch a parameter of any name');
  assert.deepEqual(dependentRules('utm_source', form().fields, null, form().choice_rules), [], 'nor does a question with that name count as read');
  assert.deepEqual(draftChanges(form(), form({ url_params: [] })), ['URL parameters changed']);

  assert.deepEqual({ ...attributionValues(form(), { utm_source: 'partner', campaign: 'spring', other: 'x' }) }, { utm_source: 'partner' }, 'only opted-in');
  assert.equal(attributionValues(form(), { campaign: 'spring' }), null);
  assert.deepEqual(attributionColumns([form(), starterDefinition()], [{ attribution: { old_key: 'x' } }, {}]), ['utm_source', 'old_key']);
});

test('the legacy text comparison is unchanged: declaring parameters alone does not switch a form to tidied comparison', () => {
  // Tracked in docs/FORMS.md, "Known limits". Tidying here would change paths on published forms.
  const fields = [{ id: 'code', type: 'short_text', label: 'Code', required: false }, { id: 'more', type: 'short_text', label: 'More', required: true, show_if: { field: 'code', op: 'equals', value: 'yes' } }];
  for (const definition of [{ title: 'T', presentation: 'classic', fields }, { title: 'T', presentation: 'classic', fields, url_params: [{ key: 'ref' }] }]) {
    assert.deepEqual(visibleFields(definition, { code: 'yes ' }, { ref: 'x' }).map(field => field.id), ['code'], 'compared as typed');
    assert.deepEqual(validateSubmission(definition, { code: 'yes ' }, { ref: 'x' }).answers, { code: 'yes' }, 'stored tidied');
  }
});

test('server: partner and default links, enforcement, opt-in attribution in the inbox and CSV, and identity untouched', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(base, { definition: form({ url_params: [{ key: 'utm_source', record: true }, { key: 'campaign' }, { key: 'email' }, { key: 'name', record: true }] }) })).body;
    assert.equal((await owner.post(`${base}/${created.id}/publish`)).body.published_version, 1);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const row = id => env.app.db.get('SELECT * FROM responses WHERE id = ?', id);
    const inboxRow = async id => (await owner.get(`${base}/${created.id}/responses`)).body.responses.find(item => item.id === id);

    // Partner link: the hidden choice is refused and nothing is stored or counted.
    const refused = await submit({ answers: { help: 'visit' }, url_params: { utm_source: 'partner' } });
    assert.equal(refused.status, 400);
    assert.deepEqual(Object.keys(refused.body.error.errors), ['help']);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 0);

    // Partner link, visible choice: the opted-in value is kept, apart from the answers.
    const partner = await submit({ answers: { help: 'email', utm_source: 'typed into the request' }, url_params: { utm_source: 'partner', campaign: 'spring', utm_medium: 'undeclared', __proto__: { x: 1 } } });
    assert.equal(partner.status, 201);
    assert.deepEqual(JSON.parse(row(partner.body.id).answers), { help: 'email' }, 'answers hold no parameter, and an unknown answer key is dropped');
    assert.deepEqual(JSON.parse(row(partner.body.id).attribution), { utm_source: 'partner' });
    const stored = JSON.stringify(row(partner.body.id));
    assert.equal(stored.includes('spring'), false, 'a parameter not opted in is stored nowhere');
    assert.equal(stored.includes('undeclared'), false, 'nor an undeclared one');
    assert.deepEqual((await inboxRow(partner.body.id)).attribution, { utm_source: 'partner' });

    // Default link: the same choice is allowed, with no attribution.
    const plain = await submit({ answers: { help: 'visit' } });
    assert.equal(plain.status, 201);
    assert.deepEqual(JSON.parse(row(plain.body.id).answers), { help: 'visit' });
    assert.equal(row(plain.body.id).attribution, null);
    assert.equal('attribution' in (await inboxRow(plain.body.id)), false);

    // Junk in the parameters is ignored, not an error, and cannot hide or record anything.
    for (const url_params of ['partner', 5, ['partner'], { utm_source: ['partner'] }, { utm_source: 'x'.repeat(URL_PARAM_LIMITS.value + 1) }, { utm_source: '' }, { utm_source: 'a\u0000b' }]) {
      const junk = await submit({ answers: { help: 'visit' }, url_params });
      assert.equal(junk.status, 201, JSON.stringify(url_params));
      assert.equal(row(junk.body.id).attribution, null, JSON.stringify(url_params));
    }

    // Never identity: a link naming an email or a person creates no contact and sets no answer.
    const identity = await submit({ answers: { help: 'email' }, url_params: { email: 'victim@example.com', name: 'Someone Else' } });
    assert.equal(identity.status, 201);
    assert.equal(row(identity.body.id).contact_id, null);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM contacts WHERE email = 'victim@example.com'").count, 0);
    assert.deepEqual(JSON.parse(row(identity.body.id).attribution), { name: 'Someone Else' }, 'name was opted in as attribution, and that is all it is');

    // Spreadsheet and markup payloads stay inert text.
    const payload = await submit({ answers: { help: 'email' }, url_params: { utm_source: '=HYPERLINK("http://x.test","<b>go</b>")' } });
    assert.equal(payload.status, 201);

    const csv = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    const [header] = csv.replace(/^﻿/, '').split('\r\n');
    assert.ok(header.endsWith('"Notes","Attribution: utm_source","Attribution: name"'), header);
    assert.equal(csv.includes('campaign'), false);
    assert.equal(csv.includes('spring'), false);
    assert.equal(csv.includes('undeclared'), false);
    assert.equal(csv.includes('victim@example.com'), false);
    assert.ok(csv.includes('"partner"'));
    assert.ok(csv.includes('"\'=HYPERLINK(""http://x.test"",""<b>go</b>"")"'), 'the formula is neutralized');

    // A retry replays the first response: its parameters neither overwrite attribution nor store anything.
    const first = await submit({ answers: { help: 'email' }, url_params: { utm_source: 'first' }, submission_id: 'url-params-retry-0001' });
    const retry = await submit({ answers: { help: 'email' }, url_params: { utm_source: 'changed' }, submission_id: 'url-params-retry-0001' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replay, true);
    assert.equal(retry.body.answers_changed, false);
    assert.deepEqual(JSON.parse(row(first.body.id).attribution), { utm_source: 'first' });
  } finally { await env.close(); }
});

test('server: a parameter chooses the ending on the receipt, its retry keeps it, and routing cannot read a parameter', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const definition = form({
      choice_rules: [],
      logic: [{ field: 'help', rules: [{ when: param('campaign', 'spring'), to: { type: 'ending', id: 'offer' } }] }],
      endings: [{ id: 'thanks', title: 'Thanks' }, { id: 'offer', title: 'Spring offer' }]
    });
    const created = (await owner.post(base, { definition })).body;
    await owner.post(`${base}/${created.id}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);

    const offer = await submit({ answers: { help: 'email', notes: 'on the skipped path' }, url_params: { campaign: 'spring' }, submission_id: 'url-params-ending-0001' });
    assert.equal(offer.status, 201);
    assert.equal(offer.body.ending.id, 'offer', 'the receipt follows the same path the answers were judged on');
    assert.deepEqual(JSON.parse(env.app.db.get('SELECT answers FROM responses WHERE id = ?', offer.body.id).answers), { help: 'email' });
    const retry = await submit({ answers: { help: 'email', notes: 'on the skipped path' }, url_params: { campaign: 'spring' }, submission_id: 'url-params-ending-0001' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.ending.id, 'offer');
    assert.equal(retry.body.answers_changed, false);
    assert.equal((await submit({ answers: { help: 'email' } })).body.ending.id, 'thanks');

    const current = (await owner.get(`${base}/${created.id}`)).body;
    const routing = await owner.raw("PUT", `${base}/${created.id}/routing`, { routing: { rules: [{ condition: param('campaign', 'spring'), action: { type: 'message', message: 'Hi' } }] }, base_revision: current.revision });
    assert.equal(routing.status, 400, 'post-submit routing stays on answers in this slice');
  } finally { await env.close(); }
});

test('server: each response follows the version it answered; older forms and responses are unchanged', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}/forms`;
    const old = form({ url_params: [], choice_rules: [] });
    const created = (await owner.post(base, { definition: old })).body;
    assert.equal('url_params' in created.draft, false);
    await owner.post(`${base}/${created.id}/publish`);
    const submit = body => env.client().post(`/api/public/forms/${created.slug}/responses`, body);
    const row = id => env.app.db.get('SELECT answers, attribution, form_version FROM responses WHERE id = ?', id);

    // Version 1 declares nothing: parameters do nothing, and the export keeps its exact columns.
    const historical = await submit({ answers: { help: 'visit' }, url_params: { utm_source: 'partner' } });
    assert.equal(historical.status, 201);
    assert.equal(row(historical.body.id).attribution, null);
    const beforeCsv = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    assert.equal(beforeCsv.includes('Attribution'), false);
    assert.equal((await owner.get(`${base}/${created.id}`)).body.has_unpublished_changes, false);

    const current = (await owner.get(`${base}/${created.id}`)).body;
    const refreshed = await owner.patch(`${base}/${created.id}`, { definition: form(), base_revision: current.revision });
    assert.equal(refreshed.body.has_unpublished_changes, true, 'declaring parameters is a change to publish');
    assert.equal((await env.client().get(`/api/public/forms/${created.slug}`)).body.definition.url_params, undefined, 'and is not live until then');
    await owner.post(`${base}/${created.id}/publish`);

    assert.equal((await submit({ answers: { help: 'visit' }, url_params: { utm_source: 'partner' }, version: 2 })).status, 400);
    const pinned = await submit({ answers: { help: 'visit' }, url_params: { utm_source: 'partner' }, version: 1 });
    assert.equal(pinned.status, 201, 'someone still on version 1 is judged by version 1');
    assert.equal(row(pinned.body.id).attribution, null, 'and version 1 records nothing');
    const allowed = await submit({ answers: { help: 'email' }, url_params: { utm_source: 'partner' }, version: 2 });
    assert.deepEqual(JSON.parse(row(allowed.body.id).attribution), { utm_source: 'partner' });

    const listed = (await owner.get(`${base}/${created.id}/responses`)).body.responses;
    assert.equal(listed.find(item => item.id === historical.body.id).attribution, undefined);
    const csv = (await owner.get(`${base}/${created.id}/responses.csv`)).body;
    assert.ok(csv.split('\r\n')[0].endsWith('"Attribution: utm_source"'));
    assert.deepEqual(JSON.parse(row(historical.body.id).answers), { help: 'visit' }, 'the historical response is untouched');

    // A later version that stops recording keeps earlier values, which were collected under opt-in.
    const latest = (await owner.get(`${base}/${created.id}`)).body;
    await owner.patch(`${base}/${created.id}`, { definition: form({ url_params: [{ key: 'utm_source' }, { key: 'campaign' }] }), base_revision: latest.revision });
    await owner.post(`${base}/${created.id}/publish`);
    const unrecorded = await submit({ answers: { help: 'email' }, url_params: { utm_source: 'partner' } });
    assert.equal(row(unrecorded.body.id).attribution, null);
    assert.ok((await owner.get(`${base}/${created.id}/responses.csv`)).body.includes('"partner"'));
  } finally { await env.close(); }
});
