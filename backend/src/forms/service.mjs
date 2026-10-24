import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { slugify } from '../validate.mjs';
import { consumeQuota, requireEntitlement } from '../billing/entitlements.mjs';
import { answerText, conditionHolds, definitionProblems, starterDefinition, validateSubmission } from '../shared/forms-logic.mjs';
import { upsertContact } from '../platform/contacts.mjs';
import { invalid, text } from '../validate.mjs';

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));

// Copies only known keys so stored definitions never carry unexpected data.
export function normalizeDefinition(input) {
  if (!input || typeof input !== 'object') fail(400, 'validation_failed', 'Form definition is missing.', { field: 'definition' });
  const definition = {
    title: typeof input.title === 'string' ? input.title.trim() : input.title,
    description: typeof input.description === 'string' ? input.description.trim() : '',
    presentation: input.presentation ?? 'classic',
    submit_label: typeof input.submit_label === 'string' && input.submit_label.trim() ? input.submit_label.trim().slice(0, 40) : 'Submit',
    fields: Array.isArray(input.fields) ? input.fields.map(field => {
      if (!field || typeof field !== 'object') return field;
      const clean = pick(field, ['id', 'type', 'label', 'help', 'required']);
      if (typeof clean.label === 'string') clean.label = clean.label.trim();
      if (typeof clean.help === 'string') clean.help = clean.help.trim() || undefined;
      if (field.type?.endsWith?.('_choice')) clean.options = Array.isArray(field.options) ? field.options.map(option => option && pick(option, ['id', 'label'])) : field.options;
      if (field.show_if) clean.show_if = pick(field.show_if, ['field', 'op', 'value']);
      if (clean.type === 'page_break') { delete clean.required; clean.label = clean.label || ''; }
      return clean;
    }) : input.fields
  };
  const problems = definitionProblems(definition);
  if (problems.length) fail(400, 'validation_failed', problems[0], { field: 'definition', problems });
  return definition;
}

function present(row) {
  return {
    id: row.id, slug: row.slug, draft: JSON.parse(row.draft), published_version: row.published_version, routing: row.routing ? JSON.parse(row.routing) : null,
    updated_at: row.updated_at, created_at: row.created_at, response_count: row.response_count ?? undefined,
    has_unpublished_changes: row.published_definition ? row.published_definition !== row.draft : row.published_version == null
  };
}

const FORM_SELECT = `SELECT f.*, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count,
  (SELECT definition FROM form_versions v WHERE v.form_id = f.id AND v.version = f.published_version) AS published_definition FROM forms f`;

export function listForms(app, workspaceId) {
  return app.db.all(`${FORM_SELECT} WHERE f.workspace_id = ? ORDER BY f.updated_at DESC`, workspaceId).map(present);
}

export function getForm(app, workspaceId, id) {
  const row = app.db.get(`${FORM_SELECT} WHERE f.id = ? AND f.workspace_id = ?`, id, workspaceId);
  if (!row) fail(404, 'not_found', 'Form not found.');
  return present(row);
}

export function createForm(app, workspaceId, userId, body) {
  const definition = normalizeDefinition(body.definition ?? starterDefinition(typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled form'));
  const id = randomUUID();
  const slug = `${slugify(definition.title).slice(0, 40)}-${randomBytes(4).toString('hex')}`;
  const now = app.now();
  app.db.run('INSERT INTO forms (id, workspace_id, slug, draft, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, workspaceId, slug, JSON.stringify(definition), userId, now, now);
  return getForm(app, workspaceId, id);
}

export function saveDraft(app, workspaceId, id, body) {
  getForm(app, workspaceId, id);
  const definition = normalizeDefinition(body.definition);
  app.db.run('UPDATE forms SET draft = ?, updated_at = ? WHERE id = ?', JSON.stringify(definition), app.now(), id);
  return getForm(app, workspaceId, id);
}

// Publishing snapshots the draft as an immutable version; responses record the version they answered.
export function publishForm(app, workspaceId, userId, id) {
  requireEntitlement(app, workspaceId, 'forms');
  return app.db.transaction(() => {
    const form = getForm(app, workspaceId, id);
    const definition = JSON.stringify(normalizeDefinition(form.draft));
    if (!form.draft.fields.some(field => field.type !== 'page_break')) fail(400, 'validation_failed', 'Add at least one question before publishing.', { field: 'definition' });
    const version = (app.db.get('SELECT MAX(version) AS version FROM form_versions WHERE form_id = ?', id).version || 0) + 1;
    app.db.run('INSERT INTO form_versions (form_id, version, definition, published_at, published_by) VALUES (?, ?, ?, ?, ?)', id, version, definition, app.now(), userId);
    app.db.run('UPDATE forms SET published_version = ?, updated_at = ? WHERE id = ?', version, app.now(), id);
    return getForm(app, workspaceId, id);
  });
}

export function unpublishForm(app, workspaceId, id) {
  getForm(app, workspaceId, id);
  app.db.run('UPDATE forms SET published_version = NULL, updated_at = ? WHERE id = ?', app.now(), id);
  return getForm(app, workspaceId, id);
}

export function deleteForm(app, workspaceId, id) {
  getForm(app, workspaceId, id);
  app.db.run('DELETE FROM forms WHERE id = ?', id);
}

export function publishedForm(app, slug) {
  const row = app.db.get(`SELECT f.id, f.workspace_id, f.slug, f.published_version, f.routing, v.definition, w.name AS workspace_name
    FROM forms f JOIN form_versions v ON v.form_id = f.id AND v.version = f.published_version JOIN workspaces w ON w.id = f.workspace_id
    WHERE f.slug = ?`, String(slug));
  if (!row) fail(404, 'not_found', 'This form is not available.');
  return { ...row, definition: JSON.parse(row.definition) };
}

export function submitResponse(app, slug, body) {
  const form = publishedForm(app, slug);
  if (body.website) fail(400, 'rejected', 'Submission rejected.');
  const key = typeof body.submission_id === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(body.submission_id) ? body.submission_id : randomUUID();
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) fail(400, 'validation_failed', 'Answers are missing.');
  const { answers, errors } = validateSubmission(form.definition, body.answers);
  if (Object.keys(errors).length) fail(400, 'validation_failed', 'Please check the highlighted answers.', { errors });
  try {
    return app.db.transaction(() => {
      const existing = app.db.get('SELECT id, created_at FROM responses WHERE form_id = ? AND idempotency_key = ?', form.id, key);
      if (existing) return { id: existing.id, created_at: existing.created_at, replay: true, route: routeFor(app, form, answers) };
      requireEntitlement(app, form.workspace_id, 'forms');
      consumeQuota(app, form.workspace_id, 'responses');
      const id = randomUUID();
      const now = app.now();
      const emailField = form.definition.fields.find(field => field.type === 'email' && answers[field.id]);
      const contactId = emailField ? upsertContact(app, form.workspace_id, { email: answers[emailField.id], name: typeof answers.name === 'string' ? answers.name : '' }) : null;
      app.db.run('INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, created_at, contact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, form.workspace_id, form.id, form.published_version, JSON.stringify(answers), key, now, contactId);
      // The event carries identifiers only; Flow loads the answers it needs at run time.
      app.db.run("INSERT INTO outbox (id, workspace_id, type, subject_id, source_id, created_at) VALUES (?, ?, 'forms.response.created', ?, ?, ?)", randomUUID(), form.workspace_id, id, form.id, now);
      return { id, created_at: now, replay: false, route: routeFor(app, form, answers) };
    });
  } finally { app.nudge?.(); }
}

export function listResponses(app, workspaceId, formId, { before, limit = 50 } = {}) {
  getForm(app, workspaceId, formId);
  const rows = app.db.all(`SELECT id, form_version, answers, created_at FROM responses WHERE form_id = ? AND workspace_id = ? AND created_at < ?
    ORDER BY created_at DESC LIMIT ?`, formId, workspaceId, Number(before) || Number.MAX_SAFE_INTEGER, Math.min(200, Number(limit) || 50));
  return rows.map(row => ({ ...row, answers: JSON.parse(row.answers) }));
}

export function deleteResponse(app, workspaceId, formId, responseId) {
  const result = app.db.run('DELETE FROM responses WHERE id = ? AND form_id = ? AND workspace_id = ?', responseId, formId, workspaceId);
  if (!result.changes) fail(404, 'not_found', 'Response not found.');
}

// Columns for every question across all published versions, in latest-version order.
function exportColumns(app, formId, draft) {
  const versions = app.db.all('SELECT definition FROM form_versions WHERE form_id = ? ORDER BY version DESC', formId).map(row => JSON.parse(row.definition));
  const columns = new Map();
  for (const definition of [...versions, draft]) {
    for (const field of definition.fields) if (field.type !== 'page_break' && !columns.has(field.id)) columns.set(field.id, field);
  }
  return [...columns.values()];
}

// Neutralizes spreadsheet formulas (CSV injection) and quotes every cell.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function exportCsv(app, workspaceId, formId) {
  const form = getForm(app, workspaceId, formId);
  const columns = exportColumns(app, formId, form.draft);
  const rows = app.db.all('SELECT id, answers, created_at FROM responses WHERE form_id = ? AND workspace_id = ? ORDER BY created_at', formId, workspaceId);
  const lines = [['Response ID', 'Submitted at (UTC)', ...columns.map(field => field.label || field.id)].map(csvCell).join(',')];
  for (const row of rows) {
    const answers = JSON.parse(row.answers);
    lines.push([row.id, new Date(row.created_at).toISOString(), ...columns.map(field => answerText(field, answers[field.id]))].map(csvCell).join(','));
  }
  return { filename: `${form.slug}-responses.csv`, body: '﻿' + lines.join('\r\n') + '\r\n' };
}

// ---- Routing (lead routing forms) -----------------------------------------------------------
// After a response is saved, the first matching rule decides where the respondent goes: a booking
// page pre-filled with their answers, an external URL or a message. Round-robin booking pages then
// assign known leads to their contact owner.

function normalizeAction(app, workspaceId, action, field) {
  if (!action || !['event', 'url', 'message'].includes(action.type)) invalid(field, 'Choose a booking page, a URL or a message.');
  if (action.type === 'event') {
    if (!app.db.get('SELECT 1 FROM event_types WHERE id = ? AND workspace_id = ?', action.event_type_id ?? '', workspaceId)) invalid(field, 'Choose an event type from this workspace.');
    return { type: 'event', event_type_id: action.event_type_id };
  }
  if (action.type === 'url') {
    let url;
    try { url = new URL(text(action.url, field, { min: 1, max: 2000 })); } catch { invalid(field, 'Enter a full https:// link.'); }
    if (url.protocol !== 'https:') invalid(field, 'Links must use https.');
    return { type: 'url', url: url.href };
  }
  return { type: 'message', message: text(action.message, field, { min: 1, max: 1000, multiline: true }) };
}

export function saveRouting(app, workspaceId, id, body) {
  const form = getForm(app, workspaceId, id);
  if (body.routing === null) {
    app.db.run('UPDATE forms SET routing = NULL WHERE id = ?', id);
    return getForm(app, workspaceId, id);
  }
  const routing = body.routing || {};
  if (!Array.isArray(routing.rules) || routing.rules.length > 50) invalid('routing', 'Add up to 50 routing rules.');
  const fieldIds = new Set(form.draft.fields.map(field => field.id));
  const rules = routing.rules.map((rule, index) => {
    const condition = rule?.condition;
    if (!condition || !fieldIds.has(condition.field) || !['equals', 'not_equals', 'contains', 'answered', 'not_answered'].includes(condition.op)) invalid(`routing.rules.${index}`, 'Each rule needs a question and a condition.');
    return { condition: { field: condition.field, op: condition.op, value: condition.value == null ? undefined : String(condition.value).slice(0, 300) }, action: normalizeAction(app, workspaceId, rule.action, `routing.rules.${index}.action`) };
  });
  const value = { rules, fallback: routing.fallback ? normalizeAction(app, workspaceId, routing.fallback, 'routing.fallback') : null };
  app.db.run('UPDATE forms SET routing = ?, updated_at = ? WHERE id = ?', JSON.stringify(value), app.now(), id);
  return getForm(app, workspaceId, id);
}

export function routeFor(app, form, answers) {
  const routing = form.routing ? (typeof form.routing === 'string' ? JSON.parse(form.routing) : form.routing) : null;
  if (!routing) return null;
  const action = routing.rules.find(rule => conditionHolds(rule.condition, answers))?.action || routing.fallback;
  if (!action) return null;
  if (action.type !== 'event') return action;
  const eventType = app.db.get(`SELECT e.slug, e.questions, w.slug AS workspace_slug FROM event_types e JOIN workspaces w ON w.id = e.workspace_id
    WHERE e.id = ? AND e.published = 1`, action.event_type_id);
  if (!eventType) return routing.fallback && routing.fallback.type !== 'event' ? routing.fallback : null;
  const params = new URLSearchParams();
  const email = form.definition.fields.find(field => field.type === 'email' && answers[field.id]);
  if (typeof answers.name === 'string') params.set('name', answers.name);
  if (email) params.set('email', answers[email.id]);
  for (const question of JSON.parse(eventType.questions)) {
    const answer = answers[question.id];
    if (answer !== undefined) params.set('a_' + question.id, Array.isArray(answer) ? answer.join(',') : String(answer));
  }
  return { type: 'event', url: `/meet/${eventType.workspace_slug}/${eventType.slug}${params.toString() ? '?' + params : ''}` };
}
