import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { bool, integer, invalid, oneOf, text } from '../validate.mjs';
import { queueEmail, cancelPendingEmails, VIDEO_PLACEHOLDER } from '../platform/email.mjs';
import { conditionHolds } from '../shared/forms-logic.mjs';

export const TRIGGERS = { booked: 'When booked', before_start: 'Before the meeting', after_end: 'After the meeting', canceled: 'When canceled', rescheduled: 'When rescheduled' };
export const PLACEHOLDERS = ['invitee.name', 'invitee.email', 'invitee.phone', 'event.title', 'event.location', 'booking.start', 'booking.start_host', 'booking.reference', 'host.name', 'manage_url', 'video_url'];

const present = row => row && { ...row, active: Boolean(row.active), condition: row.condition ? JSON.parse(row.condition) : null };

function normalize(app, workspaceId, body, current) {
  const value = { ...current };
  const set = (field, fn) => { if (body[field] !== undefined || !current) value[field] = fn(body[field]); };
  set('name', v => text(v, 'name', { min: 1, max: 120 }));
  set('event_type_id', v => {
    if (!v) return null;
    if (!app.db.get('SELECT 1 FROM event_types WHERE id = ? AND workspace_id = ?', v, workspaceId)) invalid('event_type_id', 'Choose an event type from this workspace.');
    return v;
  });
  set('trigger_type', v => oneOf(v, 'trigger_type', Object.keys(TRIGGERS)));
  set('offset_min', v => ['before_start', 'after_end'].includes(value.trigger_type) ? integer(v ?? 60, 'offset_min', 0, 43200) : 0);
  set('channel', v => oneOf(v ?? 'email', 'channel', ['email', 'sms']));
  set('recipient', v => oneOf(v ?? 'invitee', 'recipient', ['invitee', 'host']));
  set('subject', v => value.channel === 'sms' ? '' : text(v, 'subject', { min: 1, max: 200 }));
  set('body', v => text(v, 'body', { min: 1, max: value.channel === 'sms' ? 600 : 5000, multiline: true }));
  set('condition', v => {
    if (!v) return null;
    if (typeof v.question !== 'string' || !['equals', 'not_equals', 'contains', 'answered', 'not_answered'].includes(v.op)) invalid('condition', 'Choose a question and a rule.');
    return { question: v.question, op: v.op, value: v.value == null ? undefined : text(String(v.value), 'condition.value', { max: 300 }) };
  });
  if (body.active !== undefined) value.active = bool(body.active, 'active') ? 1 : 0;
  else value.active = current ? (value.active ? 1 : 0) : 1;
  return value;
}

export function listWorkflows(app, workspaceId, eventTypeId) {
  return app.db.all(`SELECT w.*, e.title AS event_title FROM meet_workflows w LEFT JOIN event_types e ON e.id = w.event_type_id
    WHERE w.workspace_id = ? AND (? IS NULL OR w.event_type_id = ? OR w.event_type_id IS NULL) ORDER BY w.created_at`, workspaceId, eventTypeId ?? null, eventTypeId ?? null).map(present);
}

export function createWorkflow(app, workspaceId, body) {
  const value = normalize(app, workspaceId, body, null);
  const id = randomUUID();
  app.db.run(`INSERT INTO meet_workflows (id, workspace_id, event_type_id, name, trigger_type, offset_min, channel, recipient, subject, body, condition, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, workspaceId, value.event_type_id, value.name, value.trigger_type, value.offset_min, value.channel, value.recipient,
  value.subject, value.body, value.condition ? JSON.stringify(value.condition) : null, value.active, app.now());
  return present(app.db.get('SELECT * FROM meet_workflows WHERE id = ?', id));
}

export function updateWorkflow(app, workspaceId, id, body) {
  const current = present(app.db.get('SELECT * FROM meet_workflows WHERE id = ? AND workspace_id = ?', id, workspaceId));
  if (!current) fail(404, 'not_found', 'Workflow not found.');
  const value = normalize(app, workspaceId, body, current);
  app.db.run(`UPDATE meet_workflows SET event_type_id = ?, name = ?, trigger_type = ?, offset_min = ?, channel = ?, recipient = ?, subject = ?, body = ?, condition = ?, active = ? WHERE id = ?`,
    value.event_type_id, value.name, value.trigger_type, value.offset_min, value.channel, value.recipient, value.subject, value.body,
    value.condition ? JSON.stringify(value.condition) : null, value.active, id);
  return present(app.db.get('SELECT * FROM meet_workflows WHERE id = ?', id));
}

export function deleteWorkflow(app, workspaceId, id) {
  if (!app.db.run('DELETE FROM meet_workflows WHERE id = ? AND workspace_id = ?', id, workspaceId).changes) fail(404, 'not_found', 'Workflow not found.');
}

export const render = (template, values) => String(template).replace(/\{\{\s*([a-z0-9_.]{1,60})\s*\}\}/g, (_, key) => values[key] ?? '');

// Queues the messages for one booking event. Called inside the booking transaction; each message
// has an idempotency key per workflow and booking, so repeating the call never duplicates a message.
export function runWorkflows(app, { booking, eventType, hosts, trigger, values }) {
  const now = app.now();
  const answers = typeof booking.answers === 'string' ? JSON.parse(booking.answers) : booking.answers || {};
  const workflows = app.db.all(`SELECT * FROM meet_workflows WHERE workspace_id = ? AND active = 1 AND trigger_type = ? AND (event_type_id IS NULL OR event_type_id = ?)`,
    booking.workspace_id, trigger, booking.event_type_id).map(present);
  for (const workflow of workflows) {
    if (workflow.condition && !conditionHolds({ field: workflow.condition.question, op: workflow.condition.op, value: workflow.condition.value }, answers)) continue;
    const sendAt = trigger === 'before_start' ? booking.starts_at - workflow.offset_min * 60000 : trigger === 'after_end' ? booking.ends_at + workflow.offset_min * 60000 : now;
    if (trigger === 'before_start' && sendAt <= now) continue;
    const recipients = workflow.recipient === 'host'
      ? hosts.map(host => workflow.channel === 'sms' ? null : host.email)
      : [workflow.channel === 'sms' ? booking.invitee_phone : booking.invitee_email];
    recipients.forEach((to, index) => {
      if (!to) return;
      queueEmail(app, {
        workspaceId: booking.workspace_id, key: `workflow:${workflow.id}:${booking.id}:${trigger}:${index}`, kind: 'workflow', relatedId: booking.id, channel: workflow.channel,
        to, sendAt, subject: render(workflow.subject, values), body: render(workflow.body, { ...values, video_url: VIDEO_PLACEHOLDER })
      });
    });
  }
}

export function cancelScheduledWorkflows(app, bookingId) {
  cancelPendingEmails(app, bookingId, ['workflow', 'reminder', 'confirmation']);
}
