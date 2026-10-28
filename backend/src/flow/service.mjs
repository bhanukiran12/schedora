import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { email as validEmail, integer, invalid, oneOf, text } from '../validate.mjs';
import { deliverEmail, queueEmail } from '../platform/email.mjs';
import { entitlementsFor, consumeQuota } from '../billing/entitlements.mjs';
import { answerText } from '../shared/forms-logic.mjs';
import { formatInstant } from '../meet/bookings.mjs';
import { enqueueWebhooks } from '../platform/developer.mjs';

export const TRIGGERS = ['meet.booking.created', 'meet.booking.canceled', 'meet.booking.rescheduled', 'forms.response.created'];
const MAX_ATTEMPTS = 5;
const backoff = attempts => Math.min(3600000, 30000 * 2 ** (attempts - 1));

// ---- Configuration -------------------------------------------------------------------------

function normalizeAction(type, config, triggerType) {
  if (!config || typeof config !== 'object') invalid('action_config', 'Configure the action.');
  if (type === 'task') {
    // Optional deadline (hours after the task is created) and assignee: nobody, the booking's host,
    // or a fixed member (checked against the workspace in normalize).
    const dueInHours = config.due_in_hours === undefined || config.due_in_hours === null || config.due_in_hours === '' ? null : integer(config.due_in_hours, 'action_config.due_in_hours', 1, 720);
    const assignTo = config.assign_to || 'none';
    if (assignTo === 'host' && !triggerType.startsWith('meet.booking.')) invalid('action_config.assign_to', 'Assigning to the host needs a Meet booking trigger.');
    if (!['none', 'host'].includes(assignTo) && !/^member:[A-Za-z0-9-]{1,64}$/.test(assignTo)) invalid('action_config.assign_to', 'Choose who the task is assigned to.');
    return { title: text(config.title, 'action_config.title', { min: 1, max: 200 }), details: text(config.details, 'action_config.details', { max: 2000, multiline: true }), due_in_hours: dueInHours, assign_to: assignTo };
  }
  let to = config.to;
  if (to === 'invitee' || to === 'host') {
    if (!triggerType.startsWith('meet.booking.')) invalid('action_config.to', 'Invitee and host recipients need a Meet booking trigger.');
  } else if (typeof to === 'string' && to.startsWith('field:')) {
    if (triggerType !== 'forms.response.created') invalid('action_config.to', 'Answer recipients need a Forms response trigger.');
    if (!/^field:[a-z0-9_]{1,40}$/.test(to)) invalid('action_config.to', 'Choose an email question.');
  } else if (typeof to === 'string' && to.startsWith('address:')) {
    to = 'address:' + validEmail(to.slice(8), 'action_config.to');
  } else invalid('action_config.to', 'Choose who receives the email.');
  return { to, subject: text(config.subject, 'action_config.subject', { min: 1, max: 200 }), body: text(config.body, 'action_config.body', { min: 1, max: 5000, multiline: true }) };
}

function normalize(app, workspaceId, body, current) {
  const value = current ? { ...current } : {};
  if (!current || body.name !== undefined) value.name = text(body.name, 'name', { min: 1, max: 120 });
  if (!current || body.trigger_type !== undefined) value.trigger_type = oneOf(body.trigger_type, 'trigger_type', TRIGGERS);
  if (body.trigger_source !== undefined || !current) {
    const source = body.trigger_source || null;
    if (source) {
      const table = value.trigger_type.startsWith('meet.') ? 'event_types' : 'forms';
      if (!app.db.get(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`, source, workspaceId)) invalid('trigger_source', 'Choose an item from this workspace.');
    }
    value.trigger_source = source;
  }
  if (!current || body.action_type !== undefined) value.action_type = oneOf(body.action_type, 'action_type', ['email', 'task']);
  if (!current || body.action_config !== undefined || body.action_type !== undefined || body.trigger_type !== undefined) {
    value.action_config = normalizeAction(value.action_type, body.action_config ?? current?.action_config, value.trigger_type);
    const member = value.action_config.assign_to?.startsWith('member:') && value.action_config.assign_to.slice(7);
    if (member && !isMember(app, workspaceId, member)) invalid('action_config.assign_to', 'Choose a current member of this workspace.');
  }
  if (body.status !== undefined) value.status = oneOf(body.status, 'status', ['draft', 'enabled', 'paused']);
  else if (!current) value.status = 'draft';
  return value;
}

const presentFlow = row => row && { ...row, action_config: JSON.parse(row.action_config) };
const isMember = (app, workspaceId, userId) => Boolean(app.db.get('SELECT 1 AS member FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId));

export function listFlows(app, workspaceId) {
  return app.db.all(`SELECT f.*, (SELECT COUNT(*) FROM flow_runs r WHERE r.flow_id = f.id) AS run_count,
      (SELECT COUNT(*) FROM flow_runs r WHERE r.flow_id = f.id AND r.status = 'failed') AS failed_count
    FROM flows f WHERE workspace_id = ? ORDER BY created_at`, workspaceId).map(presentFlow);
}

export function getFlow(app, workspaceId, id) {
  const row = app.db.get('SELECT * FROM flows WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!row) fail(404, 'not_found', 'Flow not found.');
  return presentFlow(row);
}

export function createFlow(app, workspaceId, body) {
  const value = normalize(app, workspaceId, body, null);
  if (value.status === 'enabled' && !entitlementsFor(app, workspaceId).flow.active) fail(402, 'entitlement_required', 'This workspace does not have an active Flow or Suite plan.');
  const id = randomUUID();
  const now = app.now();
  app.db.run(`INSERT INTO flows (id, workspace_id, name, trigger_type, trigger_source, action_type, action_config, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, workspaceId, value.name, value.trigger_type, value.trigger_source, value.action_type, JSON.stringify(value.action_config), value.status, now, now);
  return getFlow(app, workspaceId, id);
}

export function updateFlow(app, workspaceId, id, body) {
  const current = getFlow(app, workspaceId, id);
  const value = normalize(app, workspaceId, body, current);
  if (value.status === 'enabled' && current.status !== 'enabled' && !entitlementsFor(app, workspaceId).flow.active) fail(402, 'entitlement_required', 'This workspace does not have an active Flow or Suite plan.');
  app.db.run('UPDATE flows SET name = ?, trigger_type = ?, trigger_source = ?, action_type = ?, action_config = ?, status = ?, updated_at = ? WHERE id = ?',
    value.name, value.trigger_type, value.trigger_source, value.action_type, JSON.stringify(value.action_config), value.status, app.now(), id);
  if (value.status === 'enabled') app.nudge?.();
  return getFlow(app, workspaceId, id);
}

export function deleteFlow(app, workspaceId, id) {
  getFlow(app, workspaceId, id);
  app.db.run('DELETE FROM flows WHERE id = ?', id);
}

// ---- Rendering -----------------------------------------------------------------------------

function loadContext(app, run) {
  if (run.event_type.startsWith('meet.booking.')) {
    const row = app.db.get(`SELECT b.*, e.title AS event_title, e.location, e.timezone AS host_timezone, u.name AS host_name, u.email AS host_email
      FROM bookings b JOIN event_types e ON e.id = b.event_type_id JOIN users u ON u.id = b.host_id WHERE b.id = ? AND b.workspace_id = ?`, run.subject_id, run.workspace_id);
    if (!row || row.anonymized_at) return null;
    return {
      kind: 'booking', status: row.status,
      values: {
        'invitee.name': row.invitee_name, 'invitee.email': row.invitee_email, 'booking.reference': row.reference,
        'booking.start': formatInstant(row.starts_at, row.invitee_timezone), 'booking.start_host': formatInstant(row.starts_at, row.host_timezone),
        'event.title': row.event_title, 'event.location': row.location, 'host.name': row.host_name
      },
      recipients: { invitee: row.invitee_email, host: row.host_email }, hostId: row.host_id
    };
  }
  const row = app.db.get(`SELECT r.*, v.definition FROM responses r JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version
    WHERE r.id = ? AND r.workspace_id = ?`, run.subject_id, run.workspace_id);
  if (!row) return null;
  const definition = JSON.parse(row.definition);
  const answers = JSON.parse(row.answers);
  const values = { 'form.title': definition.title, 'response.id': row.id };
  for (const field of definition.fields) if (field.type !== 'page_break') values['answer.' + field.id] = answerText(field, answers[field.id]);
  return { kind: 'response', values, answers, definition };
}

export const render = (template, values) => String(template).replace(/\{\{\s*([a-z0-9_.]{1,60})\s*\}\}/g, (_, key) => values[key] ?? '');

function recipient(config, context) {
  if (config.to.startsWith('address:')) return config.to.slice(8);
  if (config.to.startsWith('field:')) {
    const fieldId = config.to.slice(6);
    const field = context.definition?.fields.find(candidate => candidate.id === fieldId);
    return field?.type === 'email' ? context.answers?.[fieldId] || null : null;
  }
  return context.recipients?.[config.to] || null;
}

export function simulateFlow(app, workspaceId, id) {
  const flow = getFlow(app, workspaceId, id);
  const sample = flow.trigger_type.startsWith('meet.')
    ? { 'invitee.name': 'Sample Invitee', 'invitee.email': 'invitee@example.com', 'booking.reference': 'SCH-SAMPLE', 'booking.start': 'Monday, 2 November 2026 at 10:00 (Asia/Kolkata)', 'booking.start_host': 'Monday, 2 November 2026 at 10:00 (Asia/Kolkata)', 'event.title': 'Sample event', 'event.location': 'Online', 'host.name': 'Sample Host' }
    : { 'form.title': 'Sample form', 'response.id': 'sample-response' };
  const config = flow.action_config;
  return flow.action_type === 'email'
    ? { simulated: true, action: 'email', to: config.to, subject: render(config.subject, sample), body: render(config.body, sample), note: 'Simulation only. Nothing was sent.' }
    : { simulated: true, action: 'task', title: render(config.title, sample), details: render(config.details, sample), note: 'Simulation only. No task was created.' };
}

// ---- Engine --------------------------------------------------------------------------------

// Fans each outbox event out to matching flows. The (flow_id, event_id) unique key makes
// re-dispatching the same event a no-op, so duplicate delivery cannot create duplicate runs.
export function dispatchEvent(app, event) {
  app.db.transaction(() => {
    const flows = app.db.all(`SELECT id FROM flows WHERE workspace_id = ? AND trigger_type = ? AND status IN ('enabled', 'paused')
      AND (trigger_source IS NULL OR trigger_source = ?)`, event.workspace_id, event.type, event.source_id);
    const now = app.now();
    for (const flow of flows) {
      const exists = app.db.get('SELECT 1 FROM flow_runs WHERE flow_id = ? AND event_id = ?', flow.id, event.id);
      if (exists) continue;
      let status = 'queued';
      let error = null;
      try { consumeQuota(app, event.workspace_id, 'flow_runs'); } catch (quotaError) { status = 'failed'; error = quotaError.message; }
      app.db.run(`INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, next_attempt_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), event.workspace_id, flow.id, event.id, event.type, event.subject_id, status, now, error, now, now);
    }
    enqueueWebhooks(app, event);
    app.db.run('UPDATE outbox SET dispatched_at = ? WHERE id = ?', now, event.id);
  });
}

export function dispatchOutbox(app, limit = 100) {
  const events = app.db.all('SELECT * FROM outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT ?', limit);
  for (const event of events) dispatchEvent(app, event);
  return events.length;
}

async function performAction(app, flow, run) {
  if (!entitlementsFor(app, run.workspace_id).flow.active) throw Object.assign(new Error('The workspace Flow plan is not active.'), { permanent: true });
  const context = loadContext(app, run);
  if (!context) throw Object.assign(new Error('The booking or response no longer exists.'), { permanent: true });
  const config = flow.action_config;
  if (flow.action_type === 'task') {
    // An assignee who has since left the workspace is not used; the task is created unassigned.
    const wanted = config.assign_to === 'host' ? context.hostId : config.assign_to?.startsWith('member:') ? config.assign_to.slice(7) : null;
    const assignee = wanted && isMember(app, run.workspace_id, wanted) ? wanted : null;
    const now = app.now();
    app.db.run("INSERT OR IGNORE INTO tasks (id, workspace_id, source_run_id, title, details, status, created_at, due_at, assignee_id) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      randomUUID(), run.workspace_id, run.id, render(config.title, context.values).slice(0, 300), render(config.details, context.values).slice(0, 4000), now,
      config.due_in_hours ? now + config.due_in_hours * 3600000 : null, assignee);
    return { task: app.db.get('SELECT id FROM tasks WHERE source_run_id = ?', run.id).id };
  }
  const to = recipient(config, context);
  if (!to) throw Object.assign(new Error('No recipient email address was available for this run.'), { permanent: true });
  // The run id is the email idempotency key: retries reuse the same message and never send it twice.
  const emailId = queueEmail(app, {
    workspaceId: run.workspace_id, key: `flow-run:${run.id}`, kind: 'flow', relatedId: run.id, to,
    subject: render(config.subject, context.values).slice(0, 300), body: render(config.body, context.values)
  });
  const status = await deliverEmail(app, emailId);
  if (status === 'sent') return { email: emailId };
  const email = app.db.get('SELECT status, last_error FROM emails WHERE id = ?', emailId);
  if (email.status === 'failed') throw Object.assign(new Error('Email delivery failed: ' + email.last_error), { permanent: true });
  throw new Error('Email delivery is pending: ' + (email.last_error || 'queued'));
}

export async function processRun(app, runId) {
  const now = app.now();
  const claim = app.db.run(`UPDATE flow_runs SET status = 'running', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'retrying') AND next_attempt_at <= ?
    AND (SELECT status FROM flows WHERE flows.id = flow_runs.flow_id) = 'enabled'`, now, runId, now);
  if (!claim.changes) return null;
  const run = app.db.get('SELECT * FROM flow_runs WHERE id = ?', runId);
  const flow = presentFlow(app.db.get('SELECT * FROM flows WHERE id = ?', run.flow_id));
  try {
    const result = await performAction(app, flow, run);
    app.db.run("UPDATE flow_runs SET status = 'succeeded', result = ?, last_error = NULL, updated_at = ? WHERE id = ?", JSON.stringify(result), app.now(), runId);
    return 'succeeded';
  } catch (error) {
    const final = error.permanent || run.attempts >= MAX_ATTEMPTS;
    app.db.run('UPDATE flow_runs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?',
      final ? 'failed' : 'retrying', String(error.message).slice(0, 500), app.now() + backoff(run.attempts), app.now(), runId);
    return final ? 'failed' : 'retrying';
  }
}

export async function processDueRuns(app, limit = 25) {
  const now = app.now();
  // Recover runs interrupted mid-execution (for example by a restart).
  app.db.run("UPDATE flow_runs SET status = 'retrying', next_attempt_at = ?, last_error = 'Interrupted; retrying.' WHERE status = 'running' AND updated_at < ?", now, now - 300000);
  const due = app.db.all(`SELECT r.id FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE r.status IN ('queued', 'retrying') AND r.next_attempt_at <= ? AND f.status = 'enabled'
    ORDER BY r.next_attempt_at LIMIT ?`, now, limit);
  for (const { id } of due) await processRun(app, id);
  return due.length;
}

const RUN_SELECT = `SELECT r.id, r.flow_id, f.name AS flow_name, f.status AS flow_status, r.event_type, r.subject_id, r.status, r.attempts, r.next_attempt_at, r.last_error, r.result, r.created_at, r.updated_at,
      e.id AS email_id, e.status AS email_status, e.accepted_transport AS email_transport, e.sent_at AS email_accepted_at, e.delivery_status AS email_report
    FROM flow_runs r JOIN flows f ON f.id = r.flow_id
    LEFT JOIN emails e ON e.idempotency_key = 'flow-run:' || r.id AND e.workspace_id = r.workspace_id AND e.channel = 'email'`;

function presentRun({ email_id, email_status, email_transport, email_accepted_at, email_report, ...row }) {
  const result = row.result ? JSON.parse(row.result) : null;
  // Only expose coarse evidence for this run's actual result, never addresses, bodies or
  // provider message IDs. Missing/legacy transport evidence stays unknown after reconfiguration.
  return { ...row, result, email_delivery: result?.email === email_id
    ? { status: email_status, transport: email_transport, accepted_at: email_accepted_at, report: email_report } : null };
}

export function listRuns(app, workspaceId, { flowId, status } = {}) {
  return app.db.all(`${RUN_SELECT}
    WHERE r.workspace_id = ? AND (? IS NULL OR r.flow_id = ?) AND (? IS NULL OR r.status = ?)
    ORDER BY r.created_at DESC LIMIT 200`, workspaceId, flowId ?? null, flowId ?? null, status ?? null, status ?? null).map(presentRun);
}

// Every run for the given response or booking ids (no recency cap), oldest first.
export function runsForSubjects(app, workspaceId, subjectIds) {
  if (!subjectIds.length) return [];
  return app.db.all(`${RUN_SELECT} WHERE r.workspace_id = ? AND r.subject_id IN (${subjectIds.map(() => '?').join(', ')}) ORDER BY r.created_at, r.id`,
    workspaceId, ...subjectIds).map(presentRun);
}

// Manual retry of a failed run. Side effects stay idempotent because the run id is reused.
export function retryRun(app, workspaceId, runId) {
  const result = app.db.run("UPDATE flow_runs SET status = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'failed'",
    app.now(), app.now(), runId, workspaceId);
  if (!result.changes) fail(409, 'not_retryable', 'Only failed runs can be retried.');
  // A failed flow email is re-queued under the same idempotency key; a sent one is never resent.
  app.db.run("UPDATE emails SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE idempotency_key = ? AND status = 'failed'", app.now(), `flow-run:${runId}`);
  app.nudge?.();
}

export const TASK_SELECT = `SELECT t.id, t.title, t.details, t.status, t.source_run_id, t.created_at, t.completed_at, t.due_at, t.assignee_id, u.name AS assignee_name
  FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id`;

// assignee: a user id, or null for everyone's tasks. Open tasks are ordered by deadline (none last).
export function listTasks(app, workspaceId, status, assignee = null) {
  return app.db.all(`${TASK_SELECT} WHERE t.workspace_id = ? AND (? IS NULL OR t.status = ?) AND (? IS NULL OR t.assignee_id = ?)
    ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, CASE WHEN t.status = 'open' AND t.due_at IS NULL THEN 1 ELSE 0 END,
      CASE WHEN t.status = 'open' THEN t.due_at END, t.created_at DESC LIMIT 200`,
  workspaceId, status ?? null, status ?? null, assignee, assignee);
}

// Partial update: status, due_at (epoch ms or null) and assignee_id (a current member or null).
export function updateTask(app, workspaceId, id, body) {
  const task = app.db.get('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!task) fail(404, 'not_found', 'Task not found.');
  const next = { status: task.status, completed_at: task.completed_at, due_at: task.due_at, assignee_id: task.assignee_id };
  if (body.status !== undefined) {
    next.status = oneOf(body.status, 'status', ['open', 'done']);
    next.completed_at = next.status === 'done' ? (task.status === 'done' ? task.completed_at : app.now()) : null;
  }
  if (body.due_at !== undefined) next.due_at = body.due_at === null ? null : integer(body.due_at, 'due_at', 0, 8640000000000000);
  if (body.assignee_id !== undefined) {
    if (body.assignee_id !== null && (typeof body.assignee_id !== 'string' || !isMember(app, workspaceId, body.assignee_id))) invalid('assignee_id', 'Choose a current member of this workspace.');
    next.assignee_id = body.assignee_id;
  }
  if (body.status === undefined && body.due_at === undefined && body.assignee_id === undefined) invalid('status', 'Nothing to change.');
  app.db.run('UPDATE tasks SET status = ?, completed_at = ?, due_at = ?, assignee_id = ? WHERE id = ? AND workspace_id = ?', next.status, next.completed_at, next.due_at, next.assignee_id, id, workspaceId);
}
