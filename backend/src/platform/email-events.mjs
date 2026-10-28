import { createHmac, timingSafeEqual } from 'node:crypto';

// Delivery reports from the email provider (Resend), delivered as Svix-signed webhooks:
// HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" with the base64 key after "whsec_".
// Only the event type and provider message id are used; addresses, subjects and bodies in the
// payload are neither stored nor logged. Opens and clicks are not tracked.

const TOLERANCE_MS = 5 * 60000;

// Provider event type -> stored delivery_status, with a rank: a report never replaces a more
// definite one (a late "delayed" cannot undo "delivered"; "complained" follows "delivered").
const REPORTS = {
  'email.delivery_delayed': ['delayed', 1],
  'email.delivered': ['delivered', 2],
  'email.complained': ['complained', 3],
  'email.bounced': ['bounced', 3],
  'email.failed': ['provider_failed', 3],
  'email.suppressed': ['suppressed', 3]
};
const RANK = Object.fromEntries(Object.values(REPORTS));

export function validWebhookSecret(secret) {
  return /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) && Buffer.from(secret.slice(6), 'base64').length >= 16;
}

export function verifySignature(secret, headers, raw, now) {
  const id = String(headers['svix-id'] || '');
  const timestamp = String(headers['svix-timestamp'] || '');
  const signatures = String(headers['svix-signature'] || '');
  if (!id || !/^\d{1,12}$/.test(timestamp) || !signatures) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > TOLERANCE_MS) return false;
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${raw}`).digest();
  return signatures.split(' ').some(entry => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// Returns 'recorded', 'duplicate', 'ignored' (a type Schedora does not track) or 'unknown_message'.
export function recordEmailEvent(app, headers, raw) {
  const event = JSON.parse(raw);
  const type = String(event?.type || '');
  const report = REPORTS[type];
  return app.db.transaction(() => {
    const first = app.db.run('INSERT OR IGNORE INTO email_provider_events (event_key, type, received_at) VALUES (?, ?, ?)', String(headers['svix-id']), type.slice(0, 60), app.now());
    if (!first.changes) return 'duplicate';
    if (!report) return 'ignored';
    const messageId = String(event.data?.email_id || '');
    const email = messageId && app.db.get("SELECT id, delivery_status, delivery_event_at FROM emails WHERE provider_message_id = ? AND accepted_transport = 'http'", messageId);
    if (!email) return 'unknown_message';
    const [status, rank] = report;
    const at = Date.parse(event.created_at || event.data?.created_at) || app.now();
    const current = RANK[email.delivery_status] || 0;
    if (rank > current || (rank === current && at >= (email.delivery_event_at || 0))) {
      app.db.run('UPDATE emails SET delivery_status = ?, delivery_event_at = ? WHERE id = ?', status, at, email.id);
    }
    return 'recorded';
  });
}
