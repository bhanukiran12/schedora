import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { bool, invalid, text } from '../validate.mjs';
import { newToken, sha256 } from './auth.mjs';
import { sign } from '../billing/webhooks.mjs';
import { assertPublicHost } from '../meet/calendar.mjs';
import { answerText } from '../shared/forms-logic.mjs';

export const WEBHOOK_EVENTS = ['meet.booking.created', 'meet.booking.canceled', 'meet.booking.rescheduled', 'forms.response.created'];
const MAX_ATTEMPTS = 8;
const backoff = attempts => Math.min(6 * 3600000, 60000 * 2 ** (attempts - 1));

// ---- Outgoing webhooks -----------------------------------------------------------------------

function webhookUrl(value) {
  let url;
  try { url = new URL(text(value, 'url', { min: 1, max: 2000 })); } catch { invalid('url', 'Enter the full https:// address of your endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid('url', 'Webhook endpoints must use https.');
  return url.href;
}
function eventList(events) {
  if (!Array.isArray(events) || !events.length || events.some(event => !WEBHOOK_EVENTS.includes(event))) invalid('events', 'Choose events from: ' + WEBHOOK_EVENTS.join(', ') + '.');
  return [...new Set(events)];
}
const presentEndpoint = row => row && { id: row.id, url: row.url, events: JSON.parse(row.events), active: Boolean(row.active), description: row.description, created_at: row.created_at };

export function listEndpoints(app, workspaceId) {
  return app.db.all('SELECT * FROM webhook_endpoints WHERE workspace_id = ? ORDER BY created_at', workspaceId).map(row => ({
    ...presentEndpoint(row),
    recent: app.db.all('SELECT id, event_type, status, attempts, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT 20', row.id)
  }));
}

export function createEndpoint(app, workspaceId, body) {
  const id = randomUUID();
  const secret = 'whsec_' + newToken(24);
  app.db.run('INSERT INTO webhook_endpoints (id, workspace_id, url, secret, events, active, description, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    id, workspaceId, webhookUrl(body.url), secret, JSON.stringify(eventList(body.events)), text(body.description, 'description', { max: 200 }), app.now());
  // The signing secret is shown once; endpoints verify the Schedora-Signature header with it.
  return { ...presentEndpoint(app.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id)), secret };
}

export function updateEndpoint(app, workspaceId, id, body) {
  const row = app.db.get('SELECT * FROM webhook_endpoints WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!row) fail(404, 'not_found', 'Webhook not found.');
  app.db.run('UPDATE webhook_endpoints SET url = ?, events = ?, active = ?, description = ? WHERE id = ?',
    body.url !== undefined ? webhookUrl(body.url) : row.url, body.events !== undefined ? JSON.stringify(eventList(body.events)) : row.events,
    body.active !== undefined ? (bool(body.active, 'active') ? 1 : 0) : row.active, body.description !== undefined ? text(body.description, 'description', { max: 200 }) : row.description, id);
  return presentEndpoint(app.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', id));
}

export function deleteEndpoint(app, workspaceId, id) {
  if (!app.db.run('DELETE FROM webhook_endpoints WHERE id = ? AND workspace_id = ?', id, workspaceId).changes) fail(404, 'not_found', 'Webhook not found.');
}

// Builds the payload for an outbox event. Booking and response payloads include the data the
// workspace owner already holds, so the receiving system can act on it.
export function eventPayload(app, event) {
  const base = { id: event.id, type: event.type, created_at: new Date(event.created_at).toISOString(), workspace_id: event.workspace_id };
  if (event.type.startsWith('meet.booking.')) {
    const booking = app.db.get(`SELECT b.*, e.title AS event_title, e.slug AS event_slug, e.questions FROM bookings b JOIN event_types e ON e.id = b.event_type_id WHERE b.id = ?`, event.subject_id);
    if (!booking) return { ...base, data: null };
    const questions = JSON.parse(booking.questions);
    const answers = JSON.parse(booking.answers);
    const hosts = app.db.all('SELECT u.name, u.email FROM meeting_hosts h JOIN users u ON u.id = h.host_id WHERE h.meeting_id = ?', booking.meeting_id);
    return { ...base, data: {
      booking: { id: booking.id, reference: booking.reference, status: booking.status, starts_at: new Date(booking.starts_at).toISOString(), ends_at: new Date(booking.ends_at).toISOString(),
        cancel_reason: booking.cancel_reason, rescheduled_from: booking.rescheduled_from, payment_status: booking.payment_status },
      invitee: { name: booking.invitee_name, email: booking.invitee_email, timezone: booking.invitee_timezone, phone: booking.invitee_phone, notes: booking.notes },
      answers: questions.filter(question => answers[question.id] !== undefined).map(question => ({ id: question.id, question: question.label, answer: answerText(question, answers[question.id]) })),
      event_type: { id: booking.event_type_id, title: booking.event_title, slug: booking.event_slug }, hosts
    } };
  }
  const response = app.db.get('SELECT r.id, r.form_id, r.form_version, r.answers, r.created_at, v.definition FROM responses r JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version WHERE r.id = ?', event.subject_id);
  if (!response) return { ...base, data: null };
  const definition = JSON.parse(response.definition);
  const answers = JSON.parse(response.answers);
  return { ...base, data: { response: { id: response.id, form_id: response.form_id, form_title: definition.title, version: response.form_version, submitted_at: new Date(response.created_at).toISOString() },
    answers: definition.fields.filter(field => answers[field.id] !== undefined).map(field => ({ id: field.id, question: field.label, answer: answerText(field, answers[field.id]) })) } };
}

// Called by the outbox dispatcher inside its transaction; one delivery per endpoint and event.
export function enqueueWebhooks(app, event) {
  const endpoints = app.db.all('SELECT id, events FROM webhook_endpoints WHERE workspace_id = ? AND active = 1', event.workspace_id).filter(endpoint => JSON.parse(endpoint.events).includes(event.type));
  if (!endpoints.length) return;
  const payload = JSON.stringify(eventPayload(app, event));
  for (const endpoint of endpoints) {
    app.db.run(`INSERT OR IGNORE INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      randomUUID(), endpoint.id, event.id, event.type, payload, app.now(), app.now());
  }
}

export async function deliverWebhooks(app, limit = 25) {
  const due = app.db.all(`SELECT d.*, e.url, e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
    WHERE d.status = 'queued' AND d.next_attempt_at <= ? AND e.active = 1 ORDER BY d.next_attempt_at LIMIT ?`, app.now(), limit);
  for (const delivery of due) {
    const attempts = delivery.attempts + 1;
    let status = 0;
    let error = null;
    try {
      await app.assertPublicHost(delivery.url);
      const response = await app.fetchWebhook(delivery.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), body: delivery.payload,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Schedora-Webhooks/1', 'Schedora-Event': delivery.event_type, 'Schedora-Delivery': delivery.id,
          'Schedora-Signature': sign(delivery.secret, delivery.payload, Math.floor(app.now() / 1000)) }
      });
      status = response.status;
      if (status < 200 || status >= 300) error = `Endpoint responded ${status}`;
    } catch (failure) { error = failure.message; }
    if (!error) app.db.run("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?", attempts, status, app.now(), delivery.id);
    else app.db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
      attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', attempts, status || null, String(error).slice(0, 300), app.now() + backoff(attempts), delivery.id);
  }
  return due.length;
}

export function redeliver(app, workspaceId, deliveryId) {
  const result = app.db.run(`UPDATE webhook_deliveries SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed'
    AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE workspace_id = ?)`, app.now(), deliveryId, workspaceId);
  if (!result.changes) fail(409, 'not_retryable', 'Only failed deliveries can be resent.');
  app.nudge?.();
}

// ---- API keys --------------------------------------------------------------------------------

export function listKeys(app, workspaceId, userId) {
  return app.db.all('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC', workspaceId, userId);
}

export function createKey(app, workspaceId, userId, body) {
  const token = 'sch_' + newToken(30);
  const id = randomUUID();
  app.db.run('INSERT INTO api_keys (id, workspace_id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, workspaceId, userId, text(body.name, 'name', { min: 1, max: 80 }), sha256(token), token.slice(0, 10), app.now());
  return { id, token, note: 'Copy this key now. It is not shown again.' };
}

export function revokeKey(app, workspaceId, userId, id) {
  if (!app.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND user_id = ? AND revoked_at IS NULL', app.now(), id, workspaceId, userId).changes) fail(404, 'not_found', 'Key not found.');
}

// Resolves "Authorization: Bearer sch_..." to the key's user, limited to the key's workspace.
export function authenticateKey(app, header) {
  const match = /^Bearer (sch_[A-Za-z0-9_-]{20,80})$/.exec(String(header || ''));
  if (!match) return null;
  const key = app.db.get(`SELECT k.id, k.workspace_id, u.id AS user_id, u.email, u.name FROM api_keys k JOIN users u ON u.id = k.user_id
    JOIN memberships m ON m.workspace_id = k.workspace_id AND m.user_id = k.user_id WHERE k.token_hash = ? AND k.revoked_at IS NULL`, sha256(match[1]));
  if (!key) return { invalid: true };
  app.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', app.now(), key.id);
  return { workspaceId: key.workspace_id, user: { id: key.user_id, email: key.email, name: key.name } };
}

// ---- Audit log -------------------------------------------------------------------------------

export function audit(app, workspaceId, actorId, action, target) {
  app.db.run('INSERT INTO audit_log (id, workspace_id, actor_id, action, target, created_at) VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), workspaceId, actorId ?? null, action, target ?? null, app.now());
}

export function listAudit(app, workspaceId) {
  return app.db.all(`SELECT a.action, a.target, a.created_at, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 200`, workspaceId);
}
