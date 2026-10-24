import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { GRACE_DAYS, PLANS } from './plans.mjs';

const TOLERANCE_SECONDS = 300;

// Signature scheme: header "Schedora-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + '.' + rawBody)>".
// A production payment provider adapter must translate its own verified events into the
// normalized events below; until a provider is chosen, the 'test' provider signs events locally.
export function sign(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(secret, rawBody, header, nowMs) {
  if (!secret) fail(503, 'billing_not_configured', 'Billing webhooks are not configured.');
  const fields = Object.fromEntries(String(header || '').split(',').map(part => part.split('=')).filter(pair => pair.length === 2));
  const timestamp = Number(fields.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(fields.v1 || '')) fail(400, 'invalid_signature', 'Missing or malformed signature.');
  if (Math.abs(nowMs / 1000 - timestamp) > TOLERANCE_SECONDS) fail(400, 'invalid_signature', 'Signature timestamp outside tolerance.');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(fields.v1, 'hex'))) fail(400, 'invalid_signature', 'Signature does not match.');
}

const EVENT_TYPES = ['subscription.updated', 'subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
const STATUSES = ['incomplete', 'trialing', 'active', 'past_due', 'canceled'];

// Applies one verified event exactly once. Replays return 'duplicate'; events older than the
// last applied event for the subscription are recorded but ignored ('stale').
export function applyBillingEvent(app, provider, event) {
  if (typeof event?.id !== 'string' || !EVENT_TYPES.includes(event.type) || !Number.isInteger(event.created)) fail(400, 'invalid_event', 'Unsupported billing event.');
  const data = event.data?.subscription || {};
  if (typeof data.id !== 'string' || !data.id) fail(400, 'invalid_event', 'Event has no subscription.');
  const now = app.now();
  return app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ?', provider, event.id)) return 'duplicate';
    const existing = app.db.get('SELECT * FROM subscriptions WHERE provider = ? AND external_id = ?', provider, data.id);
    let result;
    if (existing && data.workspace_id && data.workspace_id !== existing.workspace_id) {
      result = 'rejected_workspace_mismatch';
    } else if (existing && event.created * 1000 < existing.last_event_at) {
      result = 'stale';
    } else if (!existing && !app.db.get('SELECT 1 FROM workspaces WHERE id = ?', data.workspace_id || '')) {
      result = 'rejected_unknown_workspace';
    } else {
      result = 'applied';
      const plan = data.plan ?? existing?.plan;
      if (!PLANS[plan]) fail(400, 'invalid_event', 'Unknown plan.');
      const eventAt = event.created * 1000;
      let status = data.status ?? existing?.status ?? 'incomplete';
      let graceUntil = existing?.grace_until ?? null;
      if (event.type === 'invoice.payment_failed') {
        status = 'past_due';
        graceUntil = graceUntil ?? now + GRACE_DAYS * 86400000;
      } else if (event.type === 'invoice.paid') {
        status = 'active';
        graceUntil = null;
      } else if (event.type === 'subscription.deleted') {
        status = 'canceled';
      }
      if (!STATUSES.includes(status)) fail(400, 'invalid_event', 'Unknown status.');
      if (status === 'active' || status === 'trialing') graceUntil = null;
      const periodEnd = Number.isInteger(data.current_period_end) ? data.current_period_end * 1000 : existing?.current_period_end ?? null;
      const cancelAtPeriodEnd = data.cancel_at_period_end === undefined ? existing?.cancel_at_period_end ?? 0 : data.cancel_at_period_end ? 1 : 0;
      if (existing) {
        app.db.run(`UPDATE subscriptions SET plan = ?, status = ?, current_period_end = ?, cancel_at_period_end = ?, grace_until = ?, last_event_at = ? WHERE id = ?`,
          plan, status, periodEnd, cancelAtPeriodEnd, graceUntil, eventAt, existing.id);
      } else {
        app.db.run(`INSERT INTO subscriptions (id, workspace_id, provider, external_id, plan, status, current_period_end, cancel_at_period_end, grace_until, last_event_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), data.workspace_id, provider, data.id, plan, status, periodEnd, cancelAtPeriodEnd, graceUntil, eventAt, now);
      }
    }
    app.db.run('INSERT INTO billing_events (provider, event_id, type, workspace_id, received_at, result) VALUES (?, ?, ?, ?, ?, ?)',
      provider, event.id, event.type, existing?.workspace_id ?? data.workspace_id ?? null, now, result);
    return result;
  });
}

export function handleWebhook(app, rawBody, signatureHeader) {
  verifySignature(app.config.billingWebhookSecret, rawBody, signatureHeader, app.now());
  let event;
  try { event = JSON.parse(rawBody); } catch { fail(400, 'invalid_json', 'Invalid JSON.'); }
  return applyBillingEvent(app, app.config.billingProvider, event);
}

// Test provider: produces the same signed events a real provider adapter would deliver, and sends
// them through the verified webhook path. Never available when billingProvider is not 'test'.
export function testProviderEvent(app, workspaceId, type, subscription) {
  if (app.config.billingProvider !== 'test') fail(501, 'provider_not_configured', 'A payment provider has not been connected yet.');
  const event = { id: 'evt_' + randomUUID(), type, created: Math.floor(app.now() / 1000), data: { subscription: { workspace_id: workspaceId, ...subscription } } };
  const raw = JSON.stringify(event);
  return handleWebhook(app, raw, sign(app.config.billingWebhookSecret, raw, Math.floor(app.now() / 1000)));
}
