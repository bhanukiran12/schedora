import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fail, HttpError } from '../http.mjs';
import { slugify } from '../validate.mjs';
import { consumeQuota, entitlementsFor, requireEntitlement, usageFor } from '../billing/entitlements.mjs';
import { answerText, conditionHolds, definitionProblems, starterDefinition, validateSubmission } from '../shared/forms-logic.mjs';
import { upsertContact } from '../platform/contacts.mjs';
import { invalid, text } from '../validate.mjs';

const MINUTE = 60 * 1000;
// A respondent who opened an earlier version may still submit it for this long after it was
// replaced; their answers are validated and stored against that version, never the new one.
export const VERSION_GRACE_MS = 24 * 60 * MINUTE;
// Booking handoff links stay usable for this long after the response is accepted.
export const HANDOFF_TTL_MS = 2 * 60 * MINUTE;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const parse = value => value ? JSON.parse(value) : null;

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
      // Page-break defaults come before show_if so normalizing twice gives identical JSON; the
      // unpublished-changes check compares stored JSON.
      if (clean.type === 'page_break') { delete clean.required; clean.label = clean.label || ''; }
      if (field.show_if) clean.show_if = pick(field.show_if, ['field', 'op', 'value']);
      return clean;
    }) : input.fields
  };
  const problems = definitionProblems(definition);
  if (problems.length) fail(400, 'validation_failed', problems[0], { field: 'definition', problems });
  return definition;
}

function present(row) {
  const routing = parse(row.routing);
  return {
    id: row.id, slug: row.slug, draft: JSON.parse(row.draft), published_version: row.published_version, routing,
    published_routing: parse(row.published_routing),
    revision: row.draft_revision, updated_at: row.updated_at, created_at: row.created_at, response_count: row.response_count ?? undefined,
    has_unpublished_changes: row.published_definition
      ? row.published_definition !== row.draft || (row.published_routing || null) !== (row.routing || null)
      : row.published_version == null
  };
}

const FORM_SELECT = `SELECT f.*, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count,
  (SELECT definition FROM form_versions v WHERE v.form_id = f.id AND v.version = f.published_version) AS published_definition,
  (SELECT routing FROM form_versions v WHERE v.form_id = f.id AND v.version = f.published_version) AS published_routing FROM forms f`;

export function listForms(app, workspaceId) {
  return app.db.all(`${FORM_SELECT} WHERE f.workspace_id = ? ORDER BY f.updated_at DESC`, workspaceId).map(present);
}

export function getForm(app, workspaceId, id) {
  const row = app.db.get(`${FORM_SELECT} WHERE f.id = ? AND f.workspace_id = ?`, id, workspaceId);
  if (!row) fail(404, 'not_found', 'Form not found.');
  const form = present(row);
  // Question keys that any published version used. The builder keeps them fixed so historical
  // answers stay attached to the right question.
  const locked = new Set();
  for (const version of app.db.all('SELECT definition FROM form_versions WHERE form_id = ?', id)) for (const field of JSON.parse(version.definition).fields) locked.add(field.id);
  form.locked_ids = [...locked];
  return form;
}

export function createForm(app, workspaceId, userId, body) {
  const definition = normalizeDefinition(body.definition ?? starterDefinition(typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled form'));
  const id = randomUUID();
  const slug = `${slugify(definition.title).slice(0, 40)}-${randomBytes(4).toString('hex')}`;
  const now = app.now();
  app.db.run('INSERT INTO forms (id, workspace_id, slug, draft, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, workspaceId, slug, JSON.stringify(definition), userId, now, now);
  return getForm(app, workspaceId, id);
}

function baseRevision(body) {
  if (body.base_revision == null) return null;
  if (!Number.isInteger(body.base_revision) || body.base_revision < 1) invalid('base_revision', 'Reload the form and try again.');
  return body.base_revision;
}

function conflict(app, workspaceId, id) {
  fail(409, 'draft_conflict', 'This form was changed elsewhere after you opened it. Your edits are still on this page; choose whether to keep them or load the latest version.',
    { current: getForm(app, workspaceId, id) });
}

// Saves the draft. With base_revision (the builder always sends it) a save based on an older
// revision is rejected, so concurrent editors never silently overwrite each other.
function writeDraft(app, workspaceId, id, body, column, value) {
  const expected = baseRevision(body);
  return app.db.transaction(() => {
    getForm(app, workspaceId, id);
    const result = app.db.run(`UPDATE forms SET ${column} = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?${expected == null ? '' : ' AND draft_revision = ?'}`,
      value, app.now(), id, workspaceId, ...(expected == null ? [] : [expected]));
    if (!result.changes) conflict(app, workspaceId, id);
    return getForm(app, workspaceId, id);
  });
}

export function saveDraft(app, workspaceId, id, body) {
  return writeDraft(app, workspaceId, id, body, 'draft', JSON.stringify(normalizeDefinition(body.definition)));
}

function validatePublish(app, workspaceId, form) {
  requireEntitlement(app, workspaceId, 'forms');
  const definition = normalizeDefinition(form.draft);
  if (!definition.fields.some(field => field.type !== 'page_break')) fail(400, 'validation_failed', 'Add at least one question before publishing.', { field: 'definition' });
  const problems = form.routing ? routingProblems(app, workspaceId, definition, form.routing) : [];
  if (problems.length) fail(400, 'validation_failed', problems[0], { field: 'routing', problems });
  return definition;
}

// Runs the very same saved-draft checks as Publish, without creating a version or any side effect.
export function checkFormPublish(app, workspaceId, id, body = {}) {
  const expected = baseRevision(body);
  return app.db.transaction(() => {
    const form = getForm(app, workspaceId, id);
    if (expected != null && expected !== form.revision) conflict(app, workspaceId, id);
    const result = { revision: form.revision, checked_at: app.now(), can_publish: true, problems: [] };
    try { validatePublish(app, workspaceId, form); }
    catch (error) {
      if (!(error instanceof HttpError) || !['validation_failed', 'entitlement_required'].includes(error.code)) throw error;
      result.can_publish = false;
      result.problems = (error.details?.problems || [error.message]).map(message => ({ code: error.code, field: error.details?.field || 'plan', message }));
    }
    return result;
  });
}

// Publishing snapshots the draft questions and routing together as one immutable version;
// responses record the version they answered.
export function publishForm(app, workspaceId, userId, id, body = {}) {
  requireEntitlement(app, workspaceId, 'forms');
  const expected = baseRevision(body);
  return app.db.transaction(() => {
    const form = getForm(app, workspaceId, id);
    if (expected != null && expected !== form.revision) conflict(app, workspaceId, id);
    const definition = validatePublish(app, workspaceId, form);
    const version = (app.db.get('SELECT MAX(version) AS version FROM form_versions WHERE form_id = ?', id).version || 0) + 1;
    app.db.run('INSERT INTO form_versions (form_id, version, definition, routing, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?)',
      id, version, JSON.stringify(definition), form.routing ? JSON.stringify(form.routing) : null, app.now(), userId);
    app.db.run('UPDATE forms SET published_version = ?, updated_at = ? WHERE id = ?', version, app.now(), id);
    return getForm(app, workspaceId, id);
  });
}

// Stops collection. Accepted responses and their handoffs are kept.
export function unpublishForm(app, workspaceId, id) {
  getForm(app, workspaceId, id);
  app.db.run('UPDATE forms SET published_version = NULL, updated_at = ? WHERE id = ?', app.now(), id);
  return getForm(app, workspaceId, id);
}

export function deleteForm(app, workspaceId, id) {
  getForm(app, workspaceId, id);
  app.db.run('DELETE FROM forms WHERE id = ?', id);
}

function formBySlug(app, slug) {
  const form = app.db.get('SELECT f.id, f.workspace_id, f.slug, f.published_version, w.name AS workspace_name FROM forms f JOIN workspaces w ON w.id = f.workspace_id WHERE f.slug = ?', String(slug));
  if (!form) fail(404, 'not_found', 'This form is not available.');
  return form;
}

function closed(app, form) {
  // A form that was never published is indistinguishable from a missing one.
  if (!app.db.get('SELECT 1 FROM form_versions WHERE form_id = ?', form.id)) fail(404, 'not_found', 'This form is not available.');
  fail(410, 'form_closed', 'This form is no longer accepting responses.');
}

// Whether the public can start a response now. Capacity is checked again, atomically, on submit.
export function availability(app, workspaceId) {
  if (!entitlementsFor(app, workspaceId).forms.active) return 'not_accepting';
  const usage = usageFor(app, workspaceId).responses;
  return usage.limit != null && usage.used >= usage.limit ? 'capacity_reached' : 'open';
}

export function publishedForm(app, slug) {
  const form = formBySlug(app, slug);
  if (form.published_version == null) closed(app, form);
  const version = app.db.get('SELECT definition FROM form_versions WHERE form_id = ? AND version = ?', form.id, form.published_version);
  return { ...form, definition: JSON.parse(version.definition) };
}

const answersHash = answers => sha256(JSON.stringify(Object.keys(answers).sort().map(key => [key, answers[key]])));

// Accepts a response against the version the respondent was shown. The response, its usage and
// its event are written in one transaction; a retry with the same submission id returns the first
// accepted result (including across republishing or closing) and never writes anything again.
export function submitResponse(app, slug, body) {
  const form = formBySlug(app, slug);
  if (body.website) fail(400, 'rejected', 'Submission rejected.');
  const key = typeof body.submission_id === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(body.submission_id) ? body.submission_id : randomUUID();
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) fail(400, 'validation_failed', 'Answers are missing.');
  if (body.version != null && !Number.isInteger(body.version)) invalid('version', 'Reload the form and try again.');
  try {
    return app.db.transaction(() => {
      const existing = app.db.get('SELECT id, form_version, request_hash, created_at FROM responses WHERE form_id = ? AND idempotency_key = ?', form.id, key);
      if (existing) {
        const version = loadVersion(app, form.id, existing.form_version);
        const retry = validateSubmission(version.definition, body.answers);
        const changed = Object.keys(retry.errors).length > 0 || (existing.request_hash != null && answersHash(retry.answers) !== existing.request_hash);
        return { ...receipt(existing, existing.form_version), replay: true, answers_changed: changed, next: replayNextStep(app, form, existing.id, version) };
      }
      const live = app.db.get('SELECT published_version FROM forms WHERE id = ?', form.id).published_version;
      if (live == null) closed(app, form);
      const pinned = body.version ?? live;
      const version = app.db.get('SELECT 1 FROM form_versions WHERE form_id = ? AND version = ?', form.id, pinned) ? loadVersion(app, form.id, pinned) : null;
      if (pinned !== live) {
        const replacedAt = app.db.get('SELECT MIN(published_at) AS at FROM form_versions WHERE form_id = ? AND version > ?', form.id, pinned).at;
        if (!version || replacedAt == null || app.now() - replacedAt > VERSION_GRACE_MS) {
          fail(409, 'form_version_changed', 'This form was updated while you were answering. Nothing was submitted. Review the updated questions and submit again.', { version: live });
        }
      }
      const { answers, errors } = validateSubmission(version.definition, body.answers);
      if (Object.keys(errors).length) fail(400, 'validation_failed', 'Please check the highlighted answers.', { errors });
      requireEntitlement(app, form.workspace_id, 'forms');
      consumeQuota(app, form.workspace_id, 'responses');
      const id = randomUUID();
      const now = app.now();
      const emailField = version.definition.fields.find(field => field.type === 'email' && answers[field.id]);
      const contactId = emailField ? upsertContact(app, form.workspace_id, { email: answers[emailField.id], name: typeof answers.name === 'string' ? answers.name : '' }) : null;
      app.db.run('INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, request_hash, created_at, contact_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, form.workspace_id, form.id, pinned, JSON.stringify(answers), key, answersHash(answers), now, contactId);
      // The event carries identifiers only; Flow loads the answers it needs at run time.
      app.db.run("INSERT INTO outbox (id, workspace_id, type, subject_id, source_id, created_at) VALUES (?, ?, 'forms.response.created', ?, ?, ?)", randomUUID(), form.workspace_id, id, form.id, now);
      return { ...receipt({ id, created_at: now }, pinned), replay: false, answers_changed: false, next: decideNextStep(app, form, id, version, answers) };
    });
  } finally { app.nudge?.(); }
}

function loadVersion(app, formId, version) {
  const row = app.db.get('SELECT definition, routing FROM form_versions WHERE form_id = ? AND version = ?', formId, version);
  return { definition: JSON.parse(row.definition), routing: parse(row.routing) };
}

// The receipt reference is derived from the response id; it identifies nothing else.
const receipt = (row, version) => ({ id: row.id, reference: row.id.replace(/-/g, '').slice(0, 8).toUpperCase(), created_at: row.created_at, version });

export function listResponses(app, workspaceId, formId, { before, limit = 50 } = {}) {
  getForm(app, workspaceId, formId);
  const rows = app.db.all(`SELECT r.id, r.form_version, r.answers, r.created_at, h.status AS handoff_status, h.reason AS handoff_reason, h.booking_id, h.expires_at AS handoff_expires_at
    FROM responses r LEFT JOIN form_handoffs h ON h.response_id = r.id WHERE r.form_id = ? AND r.workspace_id = ? AND r.created_at < ?
    ORDER BY r.created_at DESC LIMIT ?`, formId, workspaceId, Number(before) || Number.MAX_SAFE_INTEGER, Math.min(200, Number(limit) || 50));
  return rows.map(row => ({ id: row.id, form_version: row.form_version, answers: JSON.parse(row.answers), created_at: row.created_at, next_step: nextStepSummary(app, workspaceId, row) }));
}

// Booking state is read from Meet, following reschedules, so the inbox never claims more than Meet records.
// An offer carries the server's stored expiry, so clients never infer it from the response's age.
export function nextStepSummary(app, workspaceId, row) {
  if (!row.handoff_status) return null;
  if (row.handoff_status === 'offered') return { status: 'offered', reason: row.handoff_reason || null, expires_at: row.handoff_expires_at ?? null };
  if (row.handoff_status !== 'booked') return { status: row.handoff_status, reason: row.handoff_reason || null };
  const load = id => app.db.get('SELECT id, reference, status, starts_at, rescheduled_to FROM bookings WHERE id = ? AND workspace_id = ?', id, workspaceId);
  let booking = load(row.booking_id);
  for (let hops = 0; booking?.rescheduled_to && hops < 10; hops++) booking = load(booking.rescheduled_to) || { ...booking, rescheduled_to: null };
  if (!booking) return { status: 'booking_removed' };
  return { status: booking.status === 'canceled' ? 'booking_canceled' : booking.status === 'confirmed' ? 'booked' : 'booking_pending', reference: booking.reference, starts_at: booking.starts_at, booking_id: booking.id };
}

// Deleting a response does not return its unit to the monthly allowance and does not cancel a
// booking made from it.
export function deleteResponse(app, workspaceId, formId, responseId) {
  const result = app.db.run('DELETE FROM responses WHERE id = ? AND form_id = ? AND workspace_id = ?', responseId, formId, workspaceId);
  if (!result.changes) fail(404, 'not_found', 'Response not found.');
}

export function formVersions(app, formId) {
  return Object.fromEntries(app.db.all('SELECT version, definition FROM form_versions WHERE form_id = ?', formId).map(row => [row.version, JSON.parse(row.definition)]));
}

// Columns for every question across all published versions, in latest-version order.
function exportColumns(versions, draft) {
  const columns = new Map();
  for (const definition of [...Object.keys(versions).sort((a, b) => b - a).map(key => versions[key]), draft]) {
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

const NEXT_STEP_TEXT = { offered: 'Booking offered', unavailable: 'Booking unavailable', booked: 'Booking confirmed', booking_pending: 'Booking pending', booking_canceled: 'Booking canceled', booking_removed: 'Booking removed' };

// Each answer is written using the version the respondent answered, so renamed or removed options
// keep their original labels.
export function exportCsv(app, workspaceId, formId) {
  const form = getForm(app, workspaceId, formId);
  const versions = formVersions(app, formId);
  const columns = exportColumns(versions, form.draft);
  const rows = app.db.all(`SELECT r.id, r.form_version, r.answers, r.created_at, h.status AS handoff_status, h.reason AS handoff_reason, h.booking_id, h.expires_at AS handoff_expires_at
    FROM responses r LEFT JOIN form_handoffs h ON h.response_id = r.id WHERE r.form_id = ? AND r.workspace_id = ? ORDER BY r.created_at`, formId, workspaceId);
  const lines = [['Response ID', 'Submitted at (UTC)', 'Form version', 'Next step', ...columns.map(field => field.label || field.id)].map(csvCell).join(',')];
  for (const row of rows) {
    const answers = JSON.parse(row.answers);
    const fields = versions[row.form_version]?.fields || [];
    const step = nextStepSummary(app, workspaceId, row);
    const stepText = step ? [NEXT_STEP_TEXT[step.status], step.reference].filter(Boolean).join(' ') : '';
    lines.push([row.id, new Date(row.created_at).toISOString(), row.form_version, stepText,
      ...columns.map(column => answerText(fields.find(field => field.id === column.id) || column, answers[column.id]))].map(csvCell).join(','));
  }
  return { filename: `${form.slug}-responses.csv`, body: '﻿' + lines.join('\r\n') + '\r\n' };
}

// ---- Routing and the Meet handoff -----------------------------------------------------------------
// Routing is part of the draft and is published with the questions. After a response is accepted
// the first matching rule (in the order shown) decides the next step; when no rule matches, the
// fallback applies; with neither, the respondent sees the receipt only. A booking destination is
// offered through a short-lived opaque token, never through personal details in the address.

const ROUTE_OPS = ['equals', 'not_equals', 'contains', 'answered', 'not_answered'];

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

// Problems that block publishing: rules must refer to questions and options of the version being
// published, and booking destinations must be live pages of this workspace.
export function routingProblems(app, workspaceId, definition, routing) {
  const problems = [];
  const fields = new Map(definition.fields.filter(field => field.type !== 'page_break').map(field => [field.id, field]));
  routing.rules.forEach((rule, index) => {
    const name = `Routing rule ${index + 1}`;
    const field = fields.get(rule.condition.field);
    if (!field) problems.push(`${name} refers to a question that is no longer in the form.`);
    else if (field.type.endsWith('_choice') && ['equals', 'not_equals', 'contains'].includes(rule.condition.op) && !field.options.some(option => option.id === rule.condition.value)) {
      problems.push(`${name} refers to an option that is no longer in "${field.label}".`);
    }
  });
  const destinations = [...routing.rules.map((rule, index) => [`Routing rule ${index + 1}`, rule.action]), ['The fallback', routing.fallback]];
  for (const [name, action] of destinations) {
    if (action?.type !== 'event') continue;
    const eventType = app.db.get('SELECT title, published, managed_template, expires_at FROM event_types WHERE id = ? AND workspace_id = ?', action.event_type_id, workspaceId);
    if (!eventType) problems.push(`${name} sends people to a booking page that was deleted.`);
    else if (!eventType.published || eventType.managed_template || (eventType.expires_at && eventType.expires_at <= app.now())) problems.push(`${name} sends people to "${eventType.title}", which is not published.`);
  }
  if (destinations.some(([, action]) => action?.type === 'event') && !entitlementsFor(app, workspaceId).meet.active) {
    problems.push('Booking destinations need an active Meet or Suite plan. Remove the booking rules to publish without Meet.');
  }
  return problems;
}

export function saveRouting(app, workspaceId, id, body) {
  const form = getForm(app, workspaceId, id);
  if (body.routing === null) return writeDraft(app, workspaceId, id, body, 'routing', null);
  const routing = body.routing || {};
  if (!Array.isArray(routing.rules) || routing.rules.length > 50) invalid('routing', 'Add up to 50 routing rules.');
  const fields = new Map(form.draft.fields.filter(field => field.type !== 'page_break').map(field => [field.id, field]));
  const rules = routing.rules.map((rule, index) => {
    const condition = rule?.condition;
    const field = fields.get(condition?.field);
    if (!field || !ROUTE_OPS.includes(condition.op)) invalid(`routing.rules.${index}`, `Rule ${index + 1} needs a question and a condition.`);
    const needsValue = ['equals', 'not_equals', 'contains'].includes(condition.op);
    if (needsValue && (condition.value == null || String(condition.value).trim() === '')) invalid(`routing.rules.${index}`, `Rule ${index + 1} needs a value to compare.`);
    if (needsValue && field.type.endsWith('_choice') && !field.options.some(option => option.id === condition.value)) invalid(`routing.rules.${index}`, `Rule ${index + 1} must use one of the options of "${field.label}".`);
    return { condition: { field: condition.field, op: condition.op, value: needsValue ? String(condition.value).slice(0, 300) : undefined }, action: normalizeAction(app, workspaceId, rule.action, `routing.rules.${index}.action`) };
  });
  const value = { rules, fallback: routing.fallback ? normalizeAction(app, workspaceId, routing.fallback, 'routing.fallback') : null };
  return writeDraft(app, workspaceId, id, body, 'routing', JSON.stringify(value));
}

// First matching rule, else the fallback, else nothing. Pure, so retries decide the same way.
export function chooseAction(routing, answers) {
  if (!routing) return null;
  return routing.rules.find(rule => conditionHolds(rule.condition, answers))?.action || routing.fallback || null;
}

const respondentAction = action => action && action.type !== 'event' ? action : null;

function liveDestination(app, workspaceId, eventTypeId) {
  const eventType = app.db.get(`SELECT e.id, e.title, e.slug, e.published, e.managed_template, e.expires_at, w.slug AS workspace_slug
    FROM event_types e JOIN workspaces w ON w.id = e.workspace_id WHERE e.id = ? AND e.workspace_id = ?`, eventTypeId, workspaceId);
  if (!eventType || !eventType.published || eventType.managed_template || (eventType.expires_at && eventType.expires_at <= app.now())) return { problem: 'destination_unavailable' };
  if (!entitlementsFor(app, workspaceId).meet.active) return { problem: 'meet_inactive' };
  return { eventType };
}

function offer(app, handoffId, eventType, expiresAt) {
  const token = randomBytes(24).toString('base64url');
  app.db.run('UPDATE form_handoffs SET token_hash = ?, updated_at = ? WHERE id = ?', sha256(token), app.now(), handoffId);
  return { type: 'booking', status: 'offered', title: eventType.title, url: `/meet/${eventType.workspace_slug}/${eventType.slug}?handoff=${token}`, expires_at: expiresAt };
}

// Runs inside the submission transaction, so the decision is recorded with the response.
function decideNextStep(app, form, responseId, version, answers) {
  const action = chooseAction(version.routing, answers);
  if (action?.type !== 'event') return action;
  const now = app.now();
  const id = randomUUID();
  const { eventType, problem } = liveDestination(app, form.workspace_id, action.event_type_id);
  const expiresAt = now + HANDOFF_TTL_MS;
  app.db.run('INSERT INTO form_handoffs (id, workspace_id, response_id, form_id, event_type_id, status, reason, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, form.workspace_id, responseId, form.id, action.event_type_id, problem ? 'unavailable' : 'offered', problem || null, problem ? null : expiresAt, now, now);
  if (problem) return { type: 'booking', status: 'unavailable', fallback: respondentAction(version.routing.fallback) };
  return offer(app, id, eventType, expiresAt);
}

// A retry sees the recorded decision. A still-valid offer gets a fresh token (the earlier one stops
// working), so only the latest page the respondent holds can book.
function replayNextStep(app, form, responseId, version) {
  const handoff = app.db.get('SELECT * FROM form_handoffs WHERE response_id = ?', responseId);
  if (!handoff) {
    const answers = JSON.parse(app.db.get('SELECT answers FROM responses WHERE id = ?', responseId).answers);
    return respondentAction(chooseAction(version.routing, answers));
  }
  const fallback = respondentAction(version.routing?.fallback);
  if (handoff.status === 'booked') return { type: 'booking', status: 'booked' };
  if (handoff.status === 'unavailable') return { type: 'booking', status: 'unavailable', fallback };
  if (handoff.expires_at <= app.now()) return { type: 'booking', status: 'expired', fallback };
  const { eventType, problem } = liveDestination(app, form.workspace_id, handoff.event_type_id);
  if (problem) return { type: 'booking', status: 'unavailable', fallback };
  return offer(app, handoff.id, eventType, handoff.expires_at);
}

function handoffByToken(app, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return app.db.get('SELECT * FROM form_handoffs WHERE token_hash = ?', sha256(token)) || null;
}

// Public: what the booking page may pre-fill for this handoff. Only the respondent's name, email and
// answers to questions the booking page itself asks are returned.
export function handoffDetails(app, token) {
  const handoff = handoffByToken(app, token);
  if (!handoff) fail(404, 'handoff_not_found', 'This booking link is not valid. Your form response is not affected.');
  if (handoff.status === 'booked') return { status: 'booked' };
  if (handoff.expires_at <= app.now()) return { status: 'expired' };
  const { eventType, problem } = liveDestination(app, handoff.workspace_id, handoff.event_type_id);
  if (problem) return { status: 'unavailable' };
  const response = app.db.get('SELECT r.answers, r.form_version, v.definition FROM responses r JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version WHERE r.id = ?', handoff.response_id);
  const answers = JSON.parse(response.answers);
  const definition = JSON.parse(response.definition);
  const questions = JSON.parse(app.db.get('SELECT questions FROM event_types WHERE id = ?', eventType.id).questions || '[]');
  const email = definition.fields.find(field => field.type === 'email' && answers[field.id]);
  const prefill = { name: typeof answers.name === 'string' ? answers.name : '', email: email ? answers[email.id] : '', answers: {} };
  for (const question of questions) if (answers[question.id] !== undefined) prefill.answers[question.id] = answers[question.id];
  return { status: 'offered', event: { workspace_slug: eventType.workspace_slug, slug: eventType.slug, title: eventType.title }, expires_at: handoff.expires_at, prefill };
}

export function claimHandoff(app, token, eventTypeId) {
  const handoff = handoffByToken(app, token);
  if (!handoff || handoff.event_type_id !== eventTypeId) fail(404, 'handoff_not_found', 'This booking link is not valid. Your form response is not affected.');
  if (handoff.status === 'booked') fail(409, 'handoff_used', 'A booking was already made from this form response. Check your confirmation email to change it.');
  if (handoff.expires_at <= app.now()) fail(410, 'handoff_expired', 'This booking link has expired. Your form response is kept. Contact the team for the next step.');
  if (handoff.status !== 'offered') fail(409, 'handoff_unavailable', 'This booking link is unavailable. Your form response is kept. Contact the team for the next step.');
  return handoff;
}

export function completeHandoff(app, handoff, bookingId) {
  app.db.run("UPDATE form_handoffs SET status = 'booked', booking_id = ?, updated_at = ? WHERE id = ? AND status = 'offered'", bookingId, app.now(), handoff.id);
}
