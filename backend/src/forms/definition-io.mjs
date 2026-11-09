// Form definitions as files (docs/FORMS.md, "Import and export"). A file holds one form's questions,
// pages, choices, ids, required settings, logic, descriptions, endings, URL parameters and theme, and
// nothing else: never responses, credentials or integration settings such as routing or webhooks.
// Import is strict. Every key must be one Schedora understands, so a setting is refused by name rather
// than silently dropped, and the checks run on the server before anything is created.
import { fail } from '../http.mjs';
import { definitionAssets, definitionProblems, DESCRIPTION_LIMITS, FIELD_TYPES } from '../shared/forms-logic.mjs';
import { createForm, normalizeDefinition } from './service.mjs';
import { assertAuthoringOpen } from './freeze.mjs';

export const DEFINITION_FORMAT = 'schedora.form-definition';
export const DEFINITION_FORMAT_VERSION = 1;
/** Largest file accepted, in bytes of JSON text. 100 questions with full descriptions fit well inside. */
export const IMPORT_MAX_BYTES = 1024 * 1024;
const MAX_PROBLEMS = 40;

// Keys each part of a definition may hold. Anything else is refused by name.
const ENVELOPE_KEYS = ['format', 'version', 'exported_at', 'definition'];
const DEFINITION_KEYS = ['title', 'description', 'presentation', 'submit_label', 'fields', 'logic', 'choice_rules', 'url_params', 'endings', 'theme'];
const FIELD_KEYS = ['id', 'type', 'label', 'help', 'required', 'group', 'placeholder', 'show_if', 'media'];
const CHOICE_FIELD_KEYS = [...FIELD_KEYS, 'options'];
const PAGE_KEYS = ['id', 'type', 'label', 'help', 'grouped', 'show_if'];
const OPTION_KEYS = ['id', 'label', 'image'];
const SHOW_IF_KEYS = ['field', 'op', 'value'];
const CONDITION_KEYS = ['field', 'param', 'op', 'value'];
const MEDIA_KEYS = { image: ['type', 'asset', 'alt', 'decorative'], video: ['type', 'provider', 'video', 'title'] };
const THEME_KEYS = ['name', 'source', 'font', 'background', 'question', 'answer', 'button', 'button_text', 'question_size', 'description_size', 'answer_size'];

// Data a form file must never carry. Named separately so the message says why, not just "unsupported".
const EXCLUDED = {
  responses: 'responses', submissions: 'responses', answers: 'responses', response_count: 'responses',
  routing: 'integration settings', webhooks: 'integration settings', integrations: 'integration settings', flows: 'integration settings', handoffs: 'integration settings',
  api_key: 'credentials', api_keys: 'credentials', credentials: 'credentials', secret: 'credentials', secrets: 'credentials', token: 'credentials', password: 'credentials', client_secret: 'credentials'
};
// Set by Schedora itself; harmless in an exported version but never taken from a file.
const SERVER_KEYS = { evaluation_policy: 'is set when you publish', id: 'is assigned when the draft is created', slug: 'is assigned when the draft is created', published_version: 'is assigned when you publish', revision: 'is assigned when the draft is saved', locked_ids: 'is worked out from published versions' };

const quote = text => `“${text}”`;
const short = text => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > 60 ? value.slice(0, 57) + '…' : value; };
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const plural = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`;

// Human names for items: questions are numbered as respondents count them, page breaks separately.
function namer(fields) {
  let question = 0;
  let page = 1;
  const names = fields.map(field => {
    if (!isObject(field)) return `Item ${++question}`;
    if (field.type === 'page_break') { page++; return `Page ${page}${field.label ? ` (${quote(short(field.label))})` : ''}`; }
    question++;
    return `Question ${question}${typeof field.label === 'string' && field.label.trim() ? ` (${quote(short(field.label))})` : ''}`;
  });
  return index => names[index] ?? `Item ${index + 1}`;
}

/** Parses JSON text, or explains where it broke in line and column terms. */
export function parseDefinitionText(source) {
  if (typeof source !== 'string' || !source.trim()) fail(400, 'validation_failed', 'Choose a .json file or paste the JSON text.', { field: 'source', problems: ['Choose a .json file or paste the JSON text.'] });
  if (Buffer.byteLength(source, 'utf8') > IMPORT_MAX_BYTES) fail(400, 'validation_failed', `This file is over ${IMPORT_MAX_BYTES / 1024 / 1024} MB. A form definition is much smaller; check that you chose the right file.`, { field: 'source', problems: ['File too large.'] });
  const text = source.replace(/^﻿/, '');
  try { return JSON.parse(text); }
  catch (error) {
    const at = /position (\d+)/.exec(error.message);
    let where = '';
    if (at) {
      const before = text.slice(0, Number(at[1]));
      const line = before.split('\n').length;
      where = ` near line ${line}, column ${before.length - before.lastIndexOf('\n')}`;
    }
    const detail = error.message.replace(/\s*in JSON at position \d+.*$/, '').replace(/^Unexpected end of JSON input$/, 'The text ends before the JSON is complete');
    const message = `This is not valid JSON${where}: ${detail}. Check for a missing comma, quote or bracket.`;
    fail(400, 'validation_failed', message, { field: 'source', problems: [message] });
  }
}

// Unknown, excluded and server-owned keys on one object.
function keyProblems(object, allowed, where) {
  const problems = [];
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    if (EXCLUDED[key]) problems.push(`${where} contains ${quote(key)}. Form files never carry ${EXCLUDED[key]}; remove ${quote(key)} and import again.`);
    else if (SERVER_KEYS[key]) problems.push(`${where} sets ${quote(key)}, which ${SERVER_KEYS[key]}. Remove it and import again.`);
    else problems.push(`${where} has the setting ${quote(key)}, which Schedora Forms does not support. Remove it, or download the example to see the supported settings.`);
  }
  return problems;
}

function conditionKeyProblems(condition, where, keys = CONDITION_KEYS) {
  if (!isObject(condition)) return [`${where} must be a condition like { "field": "…", "op": "answered" }.`];
  return keyProblems(condition, keys, where);
}

// Every key in the file must be supported, before any other check, so nothing is dropped unseen.
function shapeProblems(definition) {
  const problems = keyProblems(definition, DEFINITION_KEYS, 'The form');
  if (!Array.isArray(definition.fields)) return [...problems, 'The form needs a "fields" list of questions and page breaks.'];
  const name = namer(definition.fields);
  definition.fields.forEach((field, index) => {
    if (!isObject(field)) return problems.push(`${name(index)} must be an object with an id, a type and a label.`);
    if (field.title != null && field.label == null) problems.push(`${name(index)} uses ${quote('title')} for its text. This looks like a file from another form tool; Schedora uses ${quote('label')}. Download the example to see the format.`);
    if (!FIELD_TYPES[field.type]) {
      problems.push(`${name(index)} has the type ${quote(String(field.type))}, which is not supported. Use one of: ${Object.keys(FIELD_TYPES).join(', ')}.`);
      return;
    }
    const page = field.type === 'page_break';
    const choice = field.type.endsWith('_choice');
    problems.push(...keyProblems(field, page ? PAGE_KEYS : choice ? CHOICE_FIELD_KEYS : FIELD_KEYS, name(index)).map(text => {
      if (text.includes(quote('options'))) return `${name(index)} is ${FIELD_TYPES[field.type].toLowerCase()}, so it cannot have options. Change its type to single or multiple choice, or remove the options.`;
      if (page && text.includes(quote('required'))) return `${name(index)} is a page break, which cannot be required. Remove ${quote('required')} from it.`;
      if (!page && text.includes(quote('grouped'))) return `${name(index)}: only a page break can set ${quote('grouped')}.`;
      return text;
    }));
    if (field.show_if != null) problems.push(...conditionKeyProblems(field.show_if, `${name(index)}'s display rule`, SHOW_IF_KEYS));
    if (isObject(field.media) && MEDIA_KEYS[field.media.type]) problems.push(...keyProblems(field.media, MEDIA_KEYS[field.media.type], `${name(index)}'s ${field.media.type}`));
    if (choice && Array.isArray(field.options)) field.options.forEach((option, position) => {
      if (!isObject(option)) return problems.push(`${name(index)}, choice ${position + 1} must be an object with an id and a label.`);
      problems.push(...keyProblems(option, OPTION_KEYS, `${name(index)}, choice ${position + 1}`));
      if (isObject(option.image)) problems.push(...keyProblems(option.image, ['asset'], `${name(index)}, choice ${position + 1} image`));
    });
  });
  for (const [list, label] of [['logic', 'Jump logic'], ['choice_rules', 'Hide-choice rules']]) {
    if (definition[list] == null) continue;
    if (!Array.isArray(definition[list])) { problems.push(`${label} must be a list.`); continue; }
    definition[list].forEach((entry, position) => {
      const where = `${label} entry ${position + 1}`;
      if (!isObject(entry)) return problems.push(`${where} must be an object with a field and rules.`);
      problems.push(...keyProblems(entry, ['field', 'rules'], where));
      (Array.isArray(entry.rules) ? entry.rules : []).forEach((rule, index) => {
        const at = `${where}, rule ${index + 1}`;
        if (!isObject(rule)) return problems.push(`${at} must be an object.`);
        problems.push(...keyProblems(rule, list === 'logic' ? ['when', 'to'] : ['when', 'hide'], at));
        if (list === 'logic' && isObject(rule.to)) problems.push(...keyProblems(rule.to, ['type', 'id'], `${at} destination`));
        const when = rule.when;
        if (when == null) return;
        if (isObject(when) && (when.all || when.any)) {
          problems.push(...keyProblems(when, [when.all ? 'all' : 'any'], `${at} condition`));
          (Array.isArray(when.all ?? when.any) ? when.all ?? when.any : []).forEach((condition, n) => problems.push(...conditionKeyProblems(condition, `${at}, condition ${n + 1}`)));
        } else problems.push(...conditionKeyProblems(when, `${at} condition`));
      });
    });
  }
  if (Array.isArray(definition.endings)) definition.endings.forEach((ending, index) => { if (isObject(ending)) problems.push(...keyProblems(ending, ['id', 'title', 'message'], `Ending ${index + 1}`)); });
  if (Array.isArray(definition.url_params)) definition.url_params.forEach((param, index) => { if (isObject(param)) problems.push(...keyProblems(param, ['key', 'record'], `URL parameter ${index + 1}`)); });
  if (isObject(definition.theme)) problems.push(...keyProblems(definition.theme, THEME_KEYS, 'The theme'));
  if (typeof definition.submit_label === 'string' && definition.submit_label.trim().length > 40) problems.push(`The submit button label is ${definition.submit_label.trim().length} characters; keep it to 40 or fewer.`);
  return problems;
}

// References between items, explained with the names an author sees. The shared validator still runs
// afterwards; this only says the common mistakes more precisely than it can.
function referenceProblems(definition) {
  const problems = [];
  const name = namer(definition.fields);
  const position = new Map();
  definition.fields.forEach((field, index) => {
    if (!isObject(field) || typeof field.id !== 'string') return;
    if (position.has(field.id)) problems.push(`${name(index)} uses the id ${quote(field.id)}, which ${name(position.get(field.id))} already uses. Every question and page needs its own id.`);
    else position.set(field.id, index);
    if (Array.isArray(field.options)) {
      const seen = new Set();
      for (const option of field.options) {
        if (!isObject(option) || typeof option.id !== 'string') continue;
        if (seen.has(option.id)) problems.push(`${name(index)} has two choices with the id ${quote(option.id)}. Each choice in a question needs its own id.`);
        seen.add(option.id);
      }
    }
  });
  const describeOptions = field => (field.options || []).filter(isObject).map(option => option.id).join(', ');
  const checkCondition = (condition, index, where) => {
    if (!isObject(condition) || condition.param != null || typeof condition.field !== 'string') return;
    const sourceIndex = position.get(condition.field);
    if (sourceIndex == null) return problems.push(`${where} refers to the question ${quote(condition.field)}, which doesn't exist in this file.`);
    if (sourceIndex > index) return problems.push(`${where} refers to ${name(sourceIndex)}, which comes later. A rule can only use an answer given before it.`);
    const source = definition.fields[sourceIndex];
    if (source.type?.endsWith?.('_choice') && ['equals', 'not_equals', 'contains'].includes(condition.op) && typeof condition.value === 'string' && !(source.options || []).some(option => option?.id === condition.value)) {
      problems.push(`${where} refers to the choice ${quote(condition.value)} in ${name(sourceIndex)}, which doesn't exist. Its choices are: ${describeOptions(source)}.`);
    }
  };
  definition.fields.forEach((field, index) => { if (isObject(field?.show_if)) checkCondition(field.show_if, index, `${name(index)} has a display rule that`); });
  for (const [list, label] of [['logic', 'jump rule'], ['choice_rules', 'hide-choice rule']]) {
    (Array.isArray(definition[list]) ? definition[list] : []).forEach(entry => {
      if (!isObject(entry)) return;
      const index = position.get(entry.field);
      if (index == null) return problems.push(`A ${label} belongs to the question ${quote(String(entry.field))}, which doesn't exist in this file.`);
      (Array.isArray(entry.rules) ? entry.rules : []).forEach((rule, number) => {
        const where = `${name(index)}, ${label} ${number + 1},`;
        const conditions = isObject(rule?.when) && (rule.when.all || rule.when.any) ? rule.when.all ?? rule.when.any : [rule?.when];
        (Array.isArray(conditions) ? conditions : []).forEach(condition => checkCondition(condition, index, where));
        if (list === 'logic' && isObject(rule?.to) && ['field', 'group'].includes(rule.to.type) && !position.has(rule.to.id)) problems.push(`${where} jumps to ${quote(String(rule.to.id))}, which doesn't exist in this file.`);
        if (list === 'logic' && rule?.to?.type === 'ending' && !(definition.endings || []).some(ending => ending?.id === rule.to.id)) problems.push(`${where} jumps to the ending ${quote(String(rule.to.id))}, which doesn't exist in this file.`);
        if (list === 'choice_rules' && Array.isArray(rule?.hide)) for (const id of rule.hide) if (!(definition.fields[index].options || []).some(option => option?.id === id)) problems.push(`${where} hides the choice ${quote(String(id))}, which doesn't exist in that question.`);
      });
    });
  }
  return problems;
}

// The shared validator numbers every item ("Item 12"); restate that with the author's names.
const restate = (definition, problems) => {
  const name = namer(definition.fields || []);
  return problems.map(problem => problem.replace(/\bItem (\d+)\b/g, (_, n) => name(Number(n) - 1)));
};

function pipeWarnings(definition) {
  const ids = new Set(definition.fields.map(field => field.id));
  const name = namer(definition.fields);
  const warnings = [];
  definition.fields.forEach((field, index) => {
    for (const text of [field.label, field.help]) for (const [, id] of String(text ?? '').matchAll(/\{\{\s*([a-z0-9_]{1,40})\s*\}\}/g)) {
      if (!ids.has(id)) warnings.push(`${name(index)} shows the answer to {{${id}}}, but no question has that id, so nothing will appear there.`);
    }
  });
  return warnings;
}

const pageCount = fields => (fields.length && fields[0].type !== 'page_break' ? 1 : 0) + fields.filter(field => field.type === 'page_break').length;

/** What a file would create: the summary shown before importing, and the clean definition. */
export function inspectDefinition(app, workspaceId, source) {
  const parsed = typeof source === 'string' ? parseDefinitionText(source) : source;
  const refuse = problems => fail(400, 'validation_failed', problems[0], { field: 'definition', problems: problems.slice(0, MAX_PROBLEMS), problem_count: problems.length });
  if (!isObject(parsed)) refuse(['The file must contain one JSON object: a form definition with a title and a list of fields.']);
  const warnings = [];
  let input = parsed;
  if (parsed.format != null || parsed.definition != null) {
    const envelope = keyProblems(parsed, ENVELOPE_KEYS, 'The file');
    if (envelope.length) refuse(envelope);
    if (parsed.format !== DEFINITION_FORMAT) refuse([`The file's format is ${quote(String(parsed.format))}. Schedora imports ${quote(DEFINITION_FORMAT)} files.`]);
    if (parsed.version != null && (!Number.isInteger(parsed.version) || parsed.version > DEFINITION_FORMAT_VERSION || parsed.version < 1)) refuse([`This file uses format version ${parsed.version}, but this Schedora reads version ${DEFINITION_FORMAT_VERSION}. Export it again from a current Schedora.`]);
    if (!isObject(parsed.definition)) refuse(['The file has no "definition" object.']);
    input = parsed.definition;
  }
  const shape = shapeProblems(input);
  if (shape.length) refuse(shape);
  const references = referenceProblems(input);
  if (references.length) refuse(references);
  const structural = restate(input, definitionProblems({ ...input, presentation: input.presentation ?? 'classic' }));
  if (structural.length) refuse(structural);
  let definition;
  try { definition = normalizeDefinition(input); }
  catch (error) { if (error.details?.problems) refuse(restate(input, error.details.problems)); throw error; }
  // Images live in a workspace and are never inside a file, so each must already be in this one.
  const assets = definitionAssets(definition);
  if (assets.length) {
    const found = new Set(app.db.all(`SELECT id FROM form_assets WHERE workspace_id = ? AND id IN (${assets.map(() => '?').join(', ')})`, workspaceId, ...assets).map(row => row.id));
    const name = namer(definition.fields);
    const missing = definition.fields.flatMap((field, index) => [field.media?.type === 'image' ? field.media.asset : null, ...(field.options || []).map(option => option.image?.asset)].some(id => id && !found.has(id)) ? [`${name(index)} shows an image that is not in this workspace. Files carry a reference to the image, not the image itself. Remove the image from the file, import, then upload it again in the builder.`] : []);
    if (missing.length) refuse(missing);
  }
  warnings.push(...pipeWarnings(definition));
  const existing = app.db.all('SELECT draft FROM forms WHERE workspace_id = ?', workspaceId).filter(row => { try { return JSON.parse(row.draft).title === definition.title; } catch { return false; } }).length;
  if (existing) warnings.push(`This workspace already has ${plural(existing, 'form')} called ${quote(definition.title)}. Importing adds another draft; nothing existing changes.`);
  if (input.presentation == null) warnings.push('The file does not say how to present the form, so it will use the classic layout. You can switch to conversational in Settings.');
  const questions = definition.fields.filter(field => field.type !== 'page_break');
  const longest = Math.max(0, ...questions.map(field => field.help?.length || 0));
  if (longest > DESCRIPTION_LIMITS.question * 0.8) warnings.push(`One description is ${longest.toLocaleString('en-US')} characters, close to the ${DESCRIPTION_LIMITS.question.toLocaleString('en-US')} limit. Respondents see it folded with a "Show more" control.`);
  return {
    definition,
    summary: {
      title: definition.title,
      presentation: definition.presentation,
      question_count: questions.length,
      required_count: questions.filter(field => field.required).length,
      page_count: pageCount(definition.fields),
      conditional_count: definition.fields.filter(field => field.show_if).length,
      jump_count: (definition.logic || []).reduce((total, entry) => total + entry.rules.length, 0),
      hide_rule_count: (definition.choice_rules || []).reduce((total, entry) => total + entry.rules.length, 0),
      ending_count: (definition.endings || []).length,
      url_param_count: (definition.url_params || []).length,
      theme: definition.theme?.name || null,
      format: input === parsed ? 'definition' : 'envelope'
    },
    warnings
  };
}

/** The file for one form: its saved draft only. Routing, responses and anything workspace-private stay out. */
export function exportDefinition(form, now) {
  return { format: DEFINITION_FORMAT, version: DEFINITION_FORMAT_VERSION, exported_at: new Date(now).toISOString(), definition: form.draft };
}

export const exportFilename = form => `${String(form.slug || 'form').replace(/-[0-9a-f]{8}$/, '').replace(/[^a-z0-9-]/gi, '_').slice(0, 60) || 'form'}.schedora-form.json`;

/** Creates an unpublished draft from a file, after the same checks as inspectDefinition. */
export function importForm(app, workspaceId, userId, body) {
  assertAuthoringOpen(app);
  const { definition, summary, warnings } = inspectDefinition(app, workspaceId, body?.source);
  const form = createForm(app, workspaceId, userId, { definition });
  return { form, summary, warnings };
}
