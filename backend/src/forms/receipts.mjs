import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { queueEmail } from '../platform/email.mjs';
import { e164Phone, WHATSAPP_RECEIPT_CONSENT } from '../shared/forms-logic.mjs';

// WhatsApp form receipts (docs/FORMS.md, "WhatsApp receipts").
//
// - Off unless the form names a phone question and the server has an approved receipt template
//   (TWILIO_WHATSAPP_RECEIPT_CONTENT_SID), separate from the booking reminder template.
// - Sent only when the respondent ticks an unchecked opt-in with fixed wording, to a number in
//   international format. The consent wording, time and number are stored with the response.
// - One receipt per response (idempotency key), suppressed if the same number received a receipt for
//   the same form in the last two minutes, and never to a number that withdrew. Paid forms send the
//   receipt only once the payment is confirmed.
// - The template's fourth variable is a private link that withdraws the number from this workspace's
//   WhatsApp messages; a STOP reply to the sender withdraws it everywhere.
// - Status moves queued → provider accepted → delivered (or read), or failed, from the queue and the
//   signed Twilio delivery reports.

const DUPLICATE_WINDOW_MS = 2 * 60000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const oneLine = (value, max) => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

export const whatsappReceiptsAvailable = app => app.config.whatsappProvider === 'twilio' && /^HX[a-f0-9]{32}$/i.test(app.config.twilioWhatsappReceiptContentSid || '');

export function receiptPublishProblems(app, definition) {
  if (!definition.receipts?.whatsapp) return [];
  return whatsappReceiptsAvailable(app) ? [] : ['WhatsApp receipts are not connected on this Schedora server (they need a Twilio WhatsApp sender and an approved receipt template). Turn off WhatsApp receipts to publish.'];
}

/** True when the number has withdrawn from this workspace's WhatsApp messages, or from the sender. */
export const optedOut = (app, workspaceId, phone) => Boolean(app.db.get("SELECT 1 FROM messaging_opt_outs WHERE channel = 'whatsapp' AND phone = ? AND (workspace_id IS NULL OR workspace_id = ?)", phone, workspaceId));

/** Inside the submission transaction. Records the opt-in; the message itself waits for releaseResponse. */
export function recordReceiptConsent(app, form, definition, responseId, answers, consented) {
  const setting = definition.receipts?.whatsapp;
  if (!setting || !consented) return;
  const phone = e164Phone(answers[setting.phone_field]);
  const now = app.now();
  const status = !phone ? 'invalid_number' : optedOut(app, form.workspace_id, phone) ? 'opted_out' : 'consented';
  app.db.run(`INSERT OR IGNORE INTO form_message_consents (response_id, workspace_id, form_id, channel, phone, consent_text, status, token_hash, consented_at, updated_at)
    VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?)`, responseId, form.workspace_id, form.id, phone, WHATSAPP_RECEIPT_CONSENT, status, sha256(randomBytes(24).toString('base64url') + responseId), now, now);
}

// The withdrawal link is derived from a fresh secret when the message is queued; only its hash is kept.
function withdrawalLink(app, responseId) {
  const token = randomBytes(24).toString('base64url');
  app.db.run('UPDATE form_message_consents SET token_hash = ? WHERE response_id = ?', sha256(token), responseId);
  return `${app.config.baseUrl}/messages/stop/${token}`;
}

/** Queues the receipt once, for a consented response whose downstream actions are running. */
export function queueFormReceipt(app, responseId) {
  const consent = app.db.get("SELECT * FROM form_message_consents WHERE response_id = ? AND status = 'consented'", responseId);
  if (!consent) return null;
  const now = app.now();
  const update = (status, messageId = null) => app.db.run('UPDATE form_message_consents SET status = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE response_id = ?', status, messageId, now, responseId);
  if (!whatsappReceiptsAvailable(app)) return update('unavailable');
  if (optedOut(app, consent.workspace_id, consent.phone)) return update('opted_out');
  const recent = app.db.get(`SELECT 1 FROM form_message_consents WHERE form_id = ? AND phone = ? AND response_id <> ? AND status = 'queued' AND updated_at > ?`, consent.form_id, consent.phone, responseId, now - DUPLICATE_WINDOW_MS);
  if (recent) return update('duplicate');
  const row = app.db.get('SELECT r.answers, r.form_version, f.draft, w.name AS workspace_name, v.definition FROM responses r JOIN forms f ON f.id = r.form_id JOIN workspaces w ON w.id = r.workspace_id JOIN form_versions v ON v.form_id = r.form_id AND v.version = r.form_version WHERE r.id = ?', responseId);
  const answers = JSON.parse(row.answers);
  const definition = JSON.parse(row.definition);
  const name = typeof answers.name === 'string' && answers.name ? answers.name : [answers.first_name, answers.last_name].filter(part => typeof part === 'string' && part).join(' ');
  const variables = {
    1: oneLine(name, 60) || 'there',
    2: oneLine(definition.title, 120) || 'your form',
    3: responseId.replace(/-/g, '').slice(0, 8).toUpperCase(),
    4: withdrawalLink(app, responseId)
  };
  const messageId = queueEmail(app, {
    workspaceId: consent.workspace_id, key: `form-receipt:whatsapp:${responseId}`, kind: 'form_receipt', relatedId: responseId, channel: 'whatsapp',
    to: consent.phone, subject: `Receipt for ${variables[2]}`.slice(0, 200), body: JSON.stringify({ template: 'form_receipt', variables })
  });
  update('queued', messageId);
  app.nudge?.();
  return messageId;
}

const DELIVERY = { delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };

/**
 * What happened to a response's WhatsApp receipt, in plain states: waiting_for_payment, queued,
 * accepted (the provider took it), delivered, read, failed, or why it was not sent.
 */
export function receiptStatus(app, responseId) {
  const consent = app.db.get('SELECT c.*, p.completed_at AS payment_completed, p.status AS payment_status FROM form_message_consents c LEFT JOIN form_payments p ON p.response_id = c.response_id WHERE c.response_id = ?', responseId);
  if (!consent) return null;
  const base = { channel: 'whatsapp', consented_at: consent.consented_at, ...(consent.withdrawn_at ? { withdrawn_at: consent.withdrawn_at } : {}) };
  if (consent.status === 'consented') return { ...base, status: consent.payment_status && !consent.payment_completed ? 'waiting_for_payment' : 'not_sent' };
  if (consent.status !== 'queued' && consent.status !== 'withdrawn') return { ...base, status: consent.status };
  const message = consent.message_id && app.db.get('SELECT status, delivery_status, last_error, sent_at, delivery_event_at FROM emails WHERE id = ?', consent.message_id);
  if (!message) return { ...base, status: consent.status === 'withdrawn' ? 'withdrawn' : 'queued' };
  const status = message.status === 'failed' ? 'failed' : message.status === 'canceled' ? 'canceled'
    : message.status !== 'sent' ? 'queued' : DELIVERY[message.delivery_status] || 'accepted';
  return { ...base, status, ...(message.sent_at ? { accepted_at: message.sent_at } : {}), ...(message.delivery_event_at ? { reported_at: message.delivery_event_at } : {}), ...(status === 'failed' && message.last_error ? { error: oneLine(message.last_error, 200) } : {}) };
}

function optOut(app, workspaceId, phone, source) {
  app.db.run("INSERT OR IGNORE INTO messaging_opt_outs (id, workspace_id, channel, phone, source, created_at) VALUES (?, ?, 'whatsapp', ?, ?, ?)", randomUUID(), workspaceId, phone, source, app.now());
  // Anything still waiting is canceled; messages already handed to the provider cannot be recalled.
  app.db.run(`UPDATE emails SET status = 'canceled', last_error = 'Recipient withdrew from WhatsApp messages.' WHERE channel = 'whatsapp' AND to_address = ? AND status IN ('queued', 'scheduled')${workspaceId ? ' AND workspace_id = ?' : ''}`, phone, ...(workspaceId ? [workspaceId] : []));
}

function consentByToken(app, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,40}$/.test(token)) fail(404, 'not_found', 'This link is not valid.');
  const consent = app.db.get('SELECT c.*, w.name AS workspace_name FROM form_message_consents c JOIN workspaces w ON w.id = c.workspace_id WHERE c.token_hash = ?', sha256(token));
  if (!consent) fail(404, 'not_found', 'This link is not valid.');
  return consent;
}

export function messageConsentStatus(app, token) {
  const consent = consentByToken(app, token);
  return { workspace_name: consent.workspace_name, channel: 'whatsapp', withdrawn: Boolean(consent.withdrawn_at) || optedOut(app, consent.workspace_id, consent.phone), number_ending: consent.phone ? consent.phone.slice(-4) : null };
}

/** The private link in each receipt: stops future WhatsApp messages from this workspace to that number. */
export function withdrawMessageConsent(app, token) {
  const consent = consentByToken(app, token);
  app.db.transaction(() => {
    app.db.run("UPDATE form_message_consents SET withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ? WHERE workspace_id = ? AND phone = ?", app.now(), app.now(), consent.workspace_id, consent.phone);
    app.db.run("UPDATE form_message_consents SET status = 'withdrawn' WHERE workspace_id = ? AND phone = ? AND status = 'consented'", consent.workspace_id, consent.phone);
    optOut(app, consent.workspace_id, consent.phone, 'link');
  });
  return messageConsentStatus(app, token);
}

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT']);

/** A signed inbound WhatsApp reply. STOP-style replies withdraw the number from every workspace. */
export function handleInboundReply(app, body) {
  const from = String(body.From || '');
  const phone = from.startsWith('whatsapp:') ? e164Phone(from.slice(9)) : null;
  const word = String(body.Body || '').trim().toUpperCase().replace(/[.!]+$/, '');
  if (!phone || !STOP_WORDS.has(word)) return 'ignored';
  app.db.transaction(() => {
    optOut(app, null, phone, 'reply');
    app.db.run("UPDATE form_message_consents SET withdrawn_at = COALESCE(withdrawn_at, ?), status = CASE WHEN status = 'consented' THEN 'withdrawn' ELSE status END, updated_at = ? WHERE phone = ?", app.now(), app.now(), phone);
  });
  return 'opted_out';
}
