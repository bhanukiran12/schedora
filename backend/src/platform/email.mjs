import { randomUUID } from 'node:crypto';
import { bookingJoinUrl, isNativeVideo } from '../video/rooms.mjs';

const MAX_ATTEMPTS = 6;
const backoff = attempts => Math.min(3600000, 30000 * 2 ** (attempts - 1));

// Providers. 'outbox' records messages locally (development: nothing leaves the server).
// 'http' posts a JSON message {from, to, subject, text, attachments} with a bearer token to
// EMAIL_HTTP_URL; this shape is accepted by several transactional providers or a small relay.
export function createEmailProvider(config, fetchImpl = fetch) {
  if (config.emailProvider === 'http') {
    return {
      name: 'http',
      async send(message) {
        const response = await fetchImpl(config.emailHttpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.emailHttpToken, 'Idempotency-Key': message.idempotencyKey },
          body: JSON.stringify({
            from: config.emailFrom, to: [message.to], subject: message.subject, text: message.body,
            attachments: message.ics ? [{ filename: 'invite.ics', content: Buffer.from(message.ics).toString('base64'), content_type: 'text/calendar' }] : undefined
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          const error = new Error(`Email provider returned ${response.status}`);
          error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
          throw error;
        }
        const result = await response.json().catch(() => ({}));
        return { id: result.id || null };
      }
    };
  }
  return { name: 'outbox', async send() { return { id: 'local-' + randomUUID() }; } };
}

// SMS providers. 'outbox' records messages locally; 'twilio' uses the Twilio Messages API.
export function createSmsProvider(config, fetchImpl = fetch) {
  if (config.smsProvider === 'twilio') {
    return {
      name: 'twilio',
      async send(message) {
        const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: message.to, From: config.twilioFrom, Body: message.body.slice(0, 1500) }),
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(`SMS provider returned ${response.status}${result.message ? ': ' + result.message : ''}`);
          error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
          throw error;
        }
        return { id: result.sid || null };
      }
    };
  }
  return { name: 'outbox', async send() { return { id: 'local-sms-' + randomUUID() }; } };
}

// Placeholder resolved at delivery time, so a video link created after booking still reaches the email.
export const VIDEO_PLACEHOLDER = '[[VIDEO_URL]]';

// Queues a message once per idempotency key. Returns the email id (existing or new).
export function queueEmail(app, { workspaceId, key, kind, relatedId, to, subject, body, ics, sendAt, channel = 'email' }) {
  const now = app.now();
  const existing = app.db.get('SELECT id FROM emails WHERE idempotency_key = ?', key);
  if (existing) return existing.id;
  const id = randomUUID();
  const status = sendAt && sendAt > now ? 'scheduled' : 'queued';
  app.db.run(`INSERT INTO emails (id, workspace_id, idempotency_key, kind, related_id, to_address, subject, body, ics, status, next_attempt_at, created_at, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, workspaceId, key, kind, relatedId ?? null, to, subject, body, ics ?? null, status, sendAt && sendAt > now ? sendAt : now, now, channel);
  return id;
}

export function cancelPendingEmails(app, relatedId, kinds) {
  const placeholders = kinds.map(() => '?').join(', ');
  app.db.run(`UPDATE emails SET status = 'canceled' WHERE related_id = ? AND status IN ('scheduled', 'queued') AND kind IN (${placeholders})`, relatedId, ...kinds);
}

// Attempts delivery of one message if it is due and not claimed by another attempt.
export async function deliverEmail(app, id) {
  const now = app.now();
  const claim = app.db.run(`UPDATE emails SET status = 'sending', claimed_until = ?, attempts = attempts + 1
    WHERE id = ? AND status IN ('queued', 'scheduled') AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until < ?)`, now + 120000, id, now, now);
  if (!claim.changes) return app.db.get('SELECT status FROM emails WHERE id = ?', id)?.status;
  const message = app.db.get('SELECT * FROM emails WHERE id = ?', id);
  let body = message.body;
  const nativeVideo = body.includes(VIDEO_PLACEHOLDER) && isNativeVideo(app.db.get('SELECT location FROM bookings WHERE id = ?', message.related_id)?.location);
  if (nativeVideo) body = body.replaceAll(VIDEO_PLACEHOLDER, bookingJoinUrl(app, message.related_id) || 'Your host will share the video link before the meeting.');
  if (body.includes(VIDEO_PLACEHOLDER)) {
    const meeting = app.db.get('SELECT m.video_url, m.created_at FROM bookings b JOIN meetings m ON m.id = b.meeting_id WHERE b.id = ?', message.related_id);
    // Give video-link creation a short head start before sending without it.
    if (meeting && !meeting.video_url && now - meeting.created_at < 120000) {
      app.db.run("UPDATE emails SET status = 'queued', next_attempt_at = ?, claimed_until = NULL, attempts = attempts - 1 WHERE id = ?", now + 15000, id);
      return 'retrying';
    }
    body = body.replaceAll(VIDEO_PLACEHOLDER, meeting?.video_url || 'Your host will share the video link before the meeting.');
  }
  try {
    const provider = message.channel === 'sms' ? app.smsProvider : app.emailProvider;
    const result = await provider.send({ to: message.to_address, subject: message.subject, body, ics: message.ics, idempotencyKey: message.idempotency_key });
    app.db.run("UPDATE emails SET status = 'sent', sent_at = ?, provider_message_id = ?, accepted_transport = ?, last_error = NULL, claimed_until = NULL WHERE id = ?", app.now(), result?.id ?? null, provider.name || null, id);
    return 'sent';
  } catch (error) {
    const permanent = error.permanent || message.attempts >= MAX_ATTEMPTS;
    app.db.run('UPDATE emails SET status = ?, next_attempt_at = ?, last_error = ?, claimed_until = NULL WHERE id = ?',
      permanent ? 'failed' : 'queued', app.now() + backoff(message.attempts), String(error.message).slice(0, 300), id);
    return permanent ? 'failed' : 'retrying';
  }
}

export async function deliverDueEmails(app, limit = 25) {
  const now = app.now();
  const due = app.db.all(`SELECT id FROM emails WHERE status IN ('queued', 'scheduled') AND next_attempt_at <= ?
    AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY next_attempt_at LIMIT ?`, now, now, limit);
  for (const { id } of due) await deliverEmail(app, id);
  // Release claims abandoned by a crashed attempt so they are retried.
  app.db.run("UPDATE emails SET status = 'queued', claimed_until = NULL WHERE status = 'sending' AND claimed_until < ?", now);
  return due.length;
}

export function emailStatusFor(app, relatedId, kind) {
  const row = app.db.get('SELECT status, last_error, attempts FROM emails WHERE related_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1', relatedId, kind);
  if (!row) return null;
  return { status: row.status === 'sending' ? 'queued' : row.status, attempts: row.attempts, error: row.status === 'failed' ? row.last_error : null };
}
