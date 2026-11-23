import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fail } from '../http.mjs';
import { razorpayCredentials, razorpayRequest } from '../meet/razorpay.mjs';
import { PAYMENT_LIMITS, paymentAmountText } from '../shared/forms-logic.mjs';
import { nextStepForResponse, releaseResponse, respondentContact } from './service.mjs';
import { emitEvent } from '../flow/events.mjs';

// Forms payments (docs/FORMS.md, "Payments").
//
// A response to a paid form is saved when it is submitted, with payment_status 'pending'. It becomes
// complete only when Schedora's server has confirmed with Razorpay that the payment link for this
// response is paid in full, in INR, for the amount in the published version the respondent answered.
// Confirmation comes from a signature-verified webhook followed by a fresh API read, from the
// respondent's "check payment" request (also an API read), or from the reconciliation worker. A browser
// redirect only triggers that API read; its query parameters are never trusted.
//
// Only on completion do the downstream actions run, once (releaseResponse): the contact record, the
// forms.response.created event (Flow and developer webhooks), the routed next step and the WhatsApp
// receipt. Unpaid responses stay visible to the team with their payment status and never trigger them.
//
// Outside production (or with ALLOW_TEST_PAYMENTS) a workspace without Razorpay uses a simulated
// checkout, so the whole flow can be exercised without moving money.

const MINUTE = 60000;
const RECHECK_MS = 5 * MINUTE;
const RAZORPAY_MIN_EXPIRY_MS = 16 * MINUTE;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const testMode = app => !app.config.production || app.config.allowTestPayments;
const PAID = ['paid', 'refunded', 'partially_refunded'];

function tokenKey(app) {
  if (!app.config.encryptionKey && app.config.production) fail(503, 'payments_unavailable', 'Form payments need APP_ENCRYPTION_KEY on the server.');
  return createHash('sha256').update('schedora-form-payment:' + (app.config.encryptionKey || 'schedora-development-only-key')).digest();
}
// Derived, not stored: only its hash is kept, and a retried submission gets the same private link back.
export const paymentToken = (app, responseId) => createHmac('sha256', tokenKey(app)).update('form-payment:' + responseId).digest('base64url');

/** Which checkout a workspace's paid forms use: its Razorpay account, the test checkout, or none. */
export function formPaymentProvider(app, workspaceId) {
  const razorpay = razorpayCredentials(app, workspaceId);
  if (razorpay) return { provider: 'razorpay', mode: razorpay.key_id.startsWith('rzp_live_') ? 'live' : 'test' };
  if (app.db.get("SELECT 1 FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'stripe' AND status = 'active'", workspaceId)) {
    return { provider: null, reason: 'stripe_only', message: 'Form payments use Razorpay. This workspace has Stripe connected for Meet, which paid forms do not use. Connect Razorpay instead to collect form payments.' };
  }
  if (testMode(app)) return { provider: 'test', mode: 'simulated' };
  return { provider: null, reason: 'not_connected', message: 'Connect Razorpay in Meet settings before publishing a paid form.' };
}

export function paymentPublishProblems(app, workspaceId, definition) {
  if (!definition.payment) return [];
  const { provider, message } = formPaymentProvider(app, workspaceId);
  return provider ? [] : [message];
}

/** Called inside the submission transaction. Returns the respondent's private payment link token. */
export function createFormPayment(app, form, responseId, payment, definition) {
  const { provider } = formPaymentProvider(app, form.workspace_id);
  if (!provider) fail(409, 'payments_unavailable', 'This form cannot take payments right now, so your response was not saved. Contact the team that shared it.');
  const now = app.now();
  const token = paymentToken(app, responseId);
  const hours = payment.window_hours ?? PAYMENT_LIMITS.windowHours.default;
  const description = (payment.description || definition.title || 'Form payment').slice(0, PAYMENT_LIMITS.description);
  app.db.run(`INSERT INTO form_payments (response_id, workspace_id, form_id, token_hash, provider, amount_cents, currency, description, status, window_ends_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, 'pending', ?, ?, ?)`, responseId, form.workspace_id, form.id, sha256(token), provider, payment.amount_cents, description, now + hours * 60 * MINUTE, now, now);
  return token;
}

/** The state a person sees: 'failed' is a pending payment whose last attempt was declined and can be retried. */
export const paymentState = row => row.status === 'pending' && row.last_failure ? 'failed' : row.status;

export function presentPayment(row, { includePrivate = false } = {}) {
  if (!row) return null;
  return {
    status: paymentState(row), amount_cents: row.amount_cents, currency: row.currency, amount_text: paymentAmountText(row.amount_cents),
    description: row.description, window_ends_at: row.window_ends_at, paid_at: row.paid_at ?? null,
    amount_paid: row.amount_paid, amount_refunded: row.amount_refunded, complete: Boolean(row.completed_at),
    ...(row.last_failure ? { last_failure: row.last_failure } : {}),
    ...(includePrivate ? { provider: row.provider, provider_payment_id: row.provider_payment_id ?? null, review_reason: row.review_reason ?? null, last_checked_at: row.last_checked_at ?? null } : {})
  };
}

export const paymentRow = (app, responseId) => app.db.get('SELECT * FROM form_payments WHERE response_id = ?', responseId);

function byToken(app, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) fail(404, 'payment_not_found', 'This payment link is not valid.');
  const row = app.db.get('SELECT * FROM form_payments WHERE token_hash = ?', sha256(token));
  if (!row) fail(404, 'payment_not_found', 'This payment link is not valid.');
  return row;
}

const openAttempts = (app, responseId) => app.db.all("SELECT * FROM form_payment_attempts WHERE response_id = ? AND status IN ('creating', 'created') ORDER BY created_at", responseId);

function setStatus(app, responseId, status, fields = {}) {
  const now = app.now();
  const sets = Object.keys(fields).map(key => `${key} = ?`);
  app.db.run(`UPDATE form_payments SET status = ?, updated_at = ?${sets.length ? ', ' + sets.join(', ') : ''} WHERE response_id = ?`, status, now, ...Object.values(fields), responseId);
  app.db.run('UPDATE responses SET payment_status = ? WHERE id = ?', status, responseId);
}

function markReview(app, payment, reason) {
  app.log?.('warn', 'form_payment_review', { response_id: payment.response_id, reason });
  if (payment.status === 'review') return 'review';
  setStatus(app, payment.response_id, 'review', { review_reason: reason });
  return 'review';
}

// The single path to "paid". Runs the response's downstream actions in the same transaction, once.
function markPaid(app, responseId, { amountPaid, paymentId, attemptId }) {
  return app.db.transaction(() => {
    const payment = paymentRow(app, responseId);
    if (!payment) return 'unknown_payment';
    if (PAID.includes(payment.status)) return 'duplicate';
    // A payment confirmed after the window closed is still the respondent's money: the response is
    // completed rather than refunded, because a form has no scarce slot to lose.
    setStatus(app, responseId, 'paid', { amount_paid: amountPaid, provider_payment_id: paymentId, paid_at: app.now(), last_failure: null, review_reason: null });
    if (attemptId) app.db.run("UPDATE form_payment_attempts SET status = 'paid', updated_at = ? WHERE id = ?", app.now(), attemptId);
    releaseResponse(app, responseId);
    // Flow: one event per confirmed payment (redeliveries and late confirmations cannot repeat it).
    emitEvent(app, { id: `payment:${responseId}`, workspaceId: payment.workspace_id, type: 'payments.captured', subjectId: responseId, sourceId: payment.form_id, payload: { amount: amountPaid } });
    app.db.run('UPDATE form_payments SET completed_at = ? WHERE response_id = ? AND completed_at IS NULL', app.now(), responseId);
    return 'paid';
  });
}

// Pending and past its window with no checkout still open: nothing can complete it any more.
function expireIfClosed(app, responseId) {
  return app.db.transaction(() => {
    const payment = paymentRow(app, responseId);
    if (payment.status !== 'pending' || payment.window_ends_at > app.now()) return payment.status;
    if (openAttempts(app, responseId).length) return payment.status;
    setStatus(app, responseId, 'expired');
    return 'expired';
  });
}

function validLink(link, attempt, payment) {
  return /^plink_[A-Za-z0-9]+$/.test(link?.id || '') && link.reference_id === attempt.id && link.amount === payment.amount_cents && link.currency === 'INR';
}

// Applies a payment link freshly read from Razorpay to its attempt.
function settleLink(app, payment, attempt, link) {
  if (!validLink(link, attempt, payment)) return markReview(app, payment, 'Razorpay returned a payment link whose amount, currency or reference does not match this response.');
  const now = app.now();
  if (!attempt.provider_ref) app.db.run('UPDATE form_payment_attempts SET provider_ref = ?, status = ?, updated_at = ? WHERE id = ?', 'razorpay:' + link.id, 'created', now, attempt.id);
  if (link.status === 'paid') {
    if (!Number.isSafeInteger(link.amount_paid) || link.amount_paid < payment.amount_cents) return markReview(app, payment, 'Razorpay reports a paid link with less than the full amount.');
    const captured = (Array.isArray(link.payments) ? link.payments : []).find(item => item?.status === 'captured' && /^pay_[A-Za-z0-9]+$/.test(item.payment_id || ''));
    return markPaid(app, payment.response_id, { amountPaid: link.amount_paid, paymentId: captured?.payment_id || null, attemptId: attempt.id });
  }
  if (link.status === 'expired' || link.status === 'cancelled') {
    app.db.run('UPDATE form_payment_attempts SET status = ?, updated_at = ? WHERE id = ?', link.status, now, attempt.id);
    return expireIfClosed(app, payment.response_id);
  }
  return 'pending';
}

async function linkFor(app, credentials, attempt) {
  if (attempt.provider_ref) return razorpayRequest(app, credentials, 'payment_links/' + encodeURIComponent(attempt.provider_ref.slice('razorpay:'.length)));
  // reference_id is unique at Razorpay, so an interrupted creation is found rather than repeated.
  const found = await razorpayRequest(app, credentials, 'payment_links?reference_id=' + encodeURIComponent(attempt.id));
  return found.payment_links?.find(item => item.reference_id === attempt.id) || null;
}

/** Re-reads every open checkout of a pending payment from the provider and applies what it says. */
export async function refreshPayment(app, payment) {
  const now = app.now();
  if (payment.status !== 'pending') return payment.status;
  if (payment.provider === 'razorpay') {
    const credentials = razorpayCredentials(app, payment.workspace_id);
    if (!credentials) return markReview(app, payment, 'Razorpay was disconnected before this payment could be confirmed. Check the Razorpay dashboard.');
    for (const attempt of openAttempts(app, payment.response_id)) {
      const link = await linkFor(app, credentials, attempt);
      if (!link) {
        // Never reached Razorpay: safe to close once its creation is clearly abandoned.
        if (attempt.created_at < now - 10 * MINUTE) app.db.run("UPDATE form_payment_attempts SET status = 'cancelled', updated_at = ? WHERE id = ?", now, attempt.id);
        continue;
      }
      const result = settleLink(app, paymentRow(app, payment.response_id), { ...attempt }, link);
      if (result === 'paid' || result === 'review') break;
    }
  } else {
    app.db.run("UPDATE form_payment_attempts SET status = 'expired', updated_at = ? WHERE response_id = ? AND status IN ('creating', 'created') AND expires_at <= ?", now, payment.response_id, now);
  }
  app.db.run('UPDATE form_payments SET last_checked_at = ? WHERE response_id = ?', now, payment.response_id);
  return expireIfClosed(app, payment.response_id);
}

async function refreshRefunds(app, payment) {
  if (payment.provider !== 'razorpay' || !payment.provider_payment_id || !PAID.includes(payment.status)) return payment.status;
  const credentials = razorpayCredentials(app, payment.workspace_id);
  if (!credentials) return payment.status;
  const remote = await razorpayRequest(app, credentials, 'payments/' + encodeURIComponent(payment.provider_payment_id));
  if (remote.id !== payment.provider_payment_id || !Number.isSafeInteger(remote.amount_refunded)) return markReview(app, payment, 'Razorpay returned refund details that do not match this payment.');
  const refunded = Math.max(payment.amount_refunded, remote.amount_refunded);
  const status = refunded <= 0 ? 'paid' : refunded >= payment.amount_paid ? 'refunded' : 'partially_refunded';
  app.db.transaction(() => {
    setStatus(app, payment.response_id, status, { amount_refunded: refunded, last_checked_at: app.now() });
  });
  return status;
}

// ---- Respondent: status, checkout, verification ----------------------------------------------

function respondentView(app, payment) {
  const form = app.db.get('SELECT f.slug, f.draft, w.name AS workspace_name FROM forms f JOIN workspaces w ON w.id = f.workspace_id WHERE f.id = ?', payment.form_id);
  const response = app.db.get('SELECT created_at FROM responses WHERE id = ?', payment.response_id);
  const now = app.now();
  const state = paymentState(payment);
  return {
    ...presentPayment(payment), reference: payment.response_id.replace(/-/g, '').slice(0, 8).toUpperCase(), submitted_at: response?.created_at ?? null,
    form: { slug: form.slug, workspace_name: form.workspace_name }, provider: payment.provider === 'test' ? 'test' : 'razorpay',
    can_pay: ['pending', 'failed'].includes(state) && now < payment.window_ends_at,
    message: {
      pending: 'Your answers are saved. They are sent to the team once your payment is confirmed.',
      failed: 'Your last payment attempt did not go through. No money was taken for it. You can try again.',
      paid: 'Payment confirmed. Your response is complete.',
      expired: 'The time to pay for this response has ended, so it was not completed. Submit the form again if you still want to take part.',
      refunded: 'This payment was refunded.',
      partially_refunded: 'Part of this payment was refunded.',
      review: 'We could not confirm this payment automatically. The team will check it. Do not pay again.'
    }[state]
  };
}

export function publicPaymentStatus(app, token) {
  const payment = byToken(app, token);
  if (payment.status === 'pending') expireIfClosed(app, payment.response_id);
  return respondentView(app, paymentRow(app, payment.response_id));
}

export async function verifyFormPayment(app, token) {
  const payment = byToken(app, token);
  if (payment.status === 'pending') await refreshPayment(app, payment);
  return { ...respondentView(app, paymentRow(app, payment.response_id)), next: nextAfterPayment(app, payment.response_id) };
}

// After completion the respondent sees the routed next step (for example choosing a time).
function nextAfterPayment(app, responseId) {
  const payment = paymentRow(app, responseId);
  if (!payment.completed_at) return null;
  return nextStepForResponse(app, responseId);
}

export function checkoutFormPayment(app, token) {
  const payment = byToken(app, token);
  app.formPaymentCheckouts ??= new Map();
  if (app.formPaymentCheckouts.has(payment.response_id)) return app.formPaymentCheckouts.get(payment.response_id);
  const task = startCheckout(app, payment, token).finally(() => app.formPaymentCheckouts.delete(payment.response_id));
  app.formPaymentCheckouts.set(payment.response_id, task);
  return task;
}

async function startCheckout(app, payment, token) {
  if (payment.status === 'pending') await refreshPayment(app, payment);
  payment = paymentRow(app, payment.response_id);
  if (PAID.includes(payment.status)) return { status: payment.status, paid: true };
  if (payment.status === 'review') fail(409, 'payment_review', 'This payment is being checked by the team. Do not pay again.');
  if (payment.status === 'expired') fail(409, 'payment_expired', 'The time to pay for this response has ended.');
  const now = app.now();
  const open = openAttempts(app, payment.response_id).find(attempt => attempt.status === 'created' && attempt.url && attempt.expires_at > now + MINUTE);
  if (open) return { status: 'pending', url: open.url, provider: payment.provider };
  if (now >= payment.window_ends_at) { expireIfClosed(app, payment.response_id); fail(409, 'payment_expired', 'The time to pay for this response has ended.'); }
  if (app.db.get('SELECT COUNT(*) AS count FROM form_payment_attempts WHERE response_id = ?', payment.response_id).count >= 10) fail(429, 'too_many_attempts', 'Too many payment attempts for this response. Contact the team that shared the form.');
  // Razorpay needs at least 15 minutes before a link expires, so a late attempt may outlive the window slightly.
  const expiresAt = Math.max(payment.window_ends_at, now + RAZORPAY_MIN_EXPIRY_MS);
  const id = 'fp_' + randomBytes(16).toString('hex');
  app.db.run("INSERT INTO form_payment_attempts (id, response_id, provider, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'creating', ?, ?, ?)", id, payment.response_id, payment.provider, expiresAt, now, now);
  if (payment.provider === 'test') {
    if (!testMode(app)) fail(409, 'payments_unavailable', 'Simulated payments are disabled on this server.');
    const url = `${app.config.baseUrl}/forms/pay/${token}`;
    app.db.run("UPDATE form_payment_attempts SET status = 'created', provider_ref = ?, url = ?, updated_at = ? WHERE id = ?", 'test:' + id, url, now, id);
    return { status: 'pending', url, provider: 'test' };
  }
  const credentials = razorpayCredentials(app, payment.workspace_id);
  if (!credentials) fail(409, 'payments_unavailable', 'This form cannot take payments right now. Your answers are saved; contact the team that shared it.');
  const form = app.db.get('SELECT slug FROM forms WHERE id = ?', payment.form_id);
  const response = app.db.get('SELECT answers, form_version FROM responses WHERE id = ?', payment.response_id);
  const customer = respondentContact(app, payment.response_id);
  let link;
  try {
    link = await razorpayRequest(app, credentials, 'payment_links', {
      amount: payment.amount_cents, currency: 'INR', accept_partial: false, reference_id: id, expire_by: Math.floor(expiresAt / 1000),
      description: payment.description.slice(0, 200),
      ...(customer.email || customer.name ? { customer: { ...(customer.name ? { name: customer.name.slice(0, 100) } : {}), ...(customer.email ? { email: customer.email } : {}) } } : {}),
      notify: { sms: false, email: false }, reminder_enable: false,
      callback_url: `${app.config.baseUrl}/f/${form.slug}?payment=${token}`, callback_method: 'get',
      notes: { schedora_form_response: payment.response_id, schedora_form_version: String(response.form_version) }
    });
  } catch (error) {
    link = await linkFor(app, credentials, { id, provider_ref: null }).catch(() => null);
    if (!link) throw error;
  }
  const attempt = app.db.get('SELECT * FROM form_payment_attempts WHERE id = ?', id);
  if (!validLink(link, attempt, payment)) { markReview(app, payment, 'Razorpay created a payment link that does not match this response.'); fail(502, 'payment_mismatch', 'The payment link does not match this response. The team will check it.'); }
  let url;
  try { url = new URL(link.short_url); } catch { fail(502, 'payment_provider_error', 'Razorpay did not return a checkout link.'); }
  if (url.protocol !== 'https:' || !['rzp.io', 'rzp.in', 'razorpay.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail(502, 'payment_provider_error', 'Razorpay returned an invalid checkout address.');
  app.db.run("UPDATE form_payment_attempts SET status = 'created', provider_ref = ?, url = ?, updated_at = ? WHERE id = ?", 'razorpay:' + link.id, url.href, app.now(), id);
  if (link.status === 'paid') { settleLink(app, payment, { ...attempt, provider_ref: 'razorpay:' + link.id }, link); return { status: 'paid', paid: true }; }
  return { status: 'pending', url: url.href, provider: 'razorpay' };
}

/** Simulated checkout (not in production): confirms or declines the open test attempt. */
export function testFormPayment(app, token, action) {
  if (!testMode(app)) fail(404, 'not_found', 'Not available.');
  const payment = byToken(app, token);
  if (payment.provider !== 'test') fail(409, 'real_payments_connected', 'This form uses Razorpay. Simulated payment is disabled.');
  const attempt = openAttempts(app, payment.response_id).find(item => item.status === 'created' && item.expires_at > app.now());
  if (!attempt) fail(409, 'checkout_required', 'Start the checkout again from your receipt.');
  if (action === 'fail') {
    app.db.run('UPDATE form_payments SET last_failure = ?, updated_at = ? WHERE response_id = ? AND status = ?', 'The test payment was declined.', app.now(), payment.response_id, 'pending');
    return { result: 'failed', ...respondentView(app, paymentRow(app, payment.response_id)) };
  }
  if (action !== 'pay') fail(400, 'validation_failed', 'Choose pay or fail.');
  const result = markPaid(app, payment.response_id, { amountPaid: payment.amount_cents, paymentId: null, attemptId: attempt.id });
  app.nudge?.();
  return { result, ...respondentView(app, paymentRow(app, payment.response_id)), next: nextAfterPayment(app, payment.response_id) };
}

// ---- Provider webhooks -------------------------------------------------------------------------

/**
 * Razorpay webhook events for form payments. The caller has verified the signature. Returns null for
 * events that belong to Meet bookings, so their existing handling continues unchanged.
 */
export async function formPaymentWebhook(app, workspaceId, credentials, event, eventId) {
  const type = String(event.event || '');
  let payment = null;
  let task;
  if (type.startsWith('payment_link.')) {
    const entity = event.payload?.payment_link?.entity;
    if (!String(entity?.reference_id || '').startsWith('fp_')) return null;
    if (!/^plink_[A-Za-z0-9]+$/.test(entity.id || '')) fail(400, 'invalid_payload', 'Missing payment link.');
    const attempt = app.db.get('SELECT a.* FROM form_payment_attempts a JOIN form_payments p ON p.response_id = a.response_id WHERE a.id = ? AND p.workspace_id = ?', entity.reference_id, workspaceId);
    if (!attempt) return 'unknown_payment';
    payment = paymentRow(app, attempt.response_id);
    task = async () => {
      // The payload only says where to look; the state applied is read back from Razorpay.
      const link = await razorpayRequest(app, credentials, 'payment_links/' + encodeURIComponent(entity.id));
      return payment.status === 'pending' || payment.status === 'expired' ? settleLink(app, payment, attempt, link) : 'duplicate';
    };
  } else if (type.startsWith('refund.')) {
    const paymentId = event.payload?.refund?.entity?.payment_id;
    payment = typeof paymentId === 'string' && app.db.get('SELECT * FROM form_payments WHERE provider_payment_id = ? AND workspace_id = ?', paymentId, workspaceId);
    if (!payment) return null;
    task = () => refreshRefunds(app, payment);
  } else if (type === 'payment.failed') {
    const entity = event.payload?.payment?.entity;
    const responseId = entity?.notes?.schedora_form_response;
    payment = typeof responseId === 'string' && app.db.get('SELECT * FROM form_payments WHERE response_id = ? AND workspace_id = ?', responseId, workspaceId);
    if (!payment) return null;
    task = () => {
      const reason = String(entity.error_description || 'The payment was declined.').replace(/[\r\n]+/g, ' ').slice(0, 200);
      app.db.run("UPDATE form_payments SET last_failure = ?, updated_at = ? WHERE response_id = ? AND status = 'pending'", reason, app.now(), payment.response_id);
      return 'failure_recorded';
    };
  } else return null;
  const key = eventId && /^[A-Za-z0-9_-]{6,100}$/.test(eventId) ? eventId : 'sha256:' + sha256(JSON.stringify(event));
  if (app.db.get('SELECT 1 FROM form_payment_events WHERE id = ?', key)) return 'duplicate';
  const result = await task();
  app.db.run('INSERT OR IGNORE INTO form_payment_events (id, workspace_id, response_id, type, result, received_at) VALUES (?, ?, ?, ?, ?, ?)', key, workspaceId, payment.response_id, type.slice(0, 60), String(result).slice(0, 40), app.now());
  app.nudge?.();
  return result;
}

// ---- Team: refresh, reconciliation ------------------------------------------------------------

export async function refreshFormPayment(app, workspaceId, formId, responseId) {
  const payment = app.db.get('SELECT * FROM form_payments WHERE response_id = ? AND form_id = ? AND workspace_id = ?', responseId, formId, workspaceId);
  if (!payment) fail(404, 'not_found', 'This response has no payment.');
  if (payment.status === 'pending') await refreshPayment(app, payment);
  else if (PAID.includes(payment.status)) await refreshRefunds(app, payment);
  return presentPayment(paymentRow(app, responseId), { includePrivate: true });
}

/** Worker: confirms or closes pending payments whose webhook may have been missed. Bounded per pass. */
export async function reconcileFormPayments(app, { limit = 10 } = {}) {
  const now = app.now();
  const due = app.db.all(`SELECT p.* FROM form_payments p WHERE p.status = 'pending' AND (p.last_checked_at IS NULL OR p.last_checked_at < ?)
      AND (p.window_ends_at <= ? OR EXISTS (SELECT 1 FROM form_payment_attempts a WHERE a.response_id = p.response_id AND a.status IN ('creating', 'created') AND (p.last_checked_at IS NULL OR p.last_checked_at < ?)))
    ORDER BY COALESCE(p.last_checked_at, 0) LIMIT ?`, now - MINUTE, now, now - RECHECK_MS, limit);
  let checked = 0;
  for (const payment of due) {
    try { await refreshPayment(app, payment); checked++; }
    catch (error) {
      app.db.run('UPDATE form_payments SET last_checked_at = ? WHERE response_id = ?', now, payment.response_id);
      app.log?.('warn', 'form_payment_reconcile_failed', { response_id: payment.response_id, error: String(error.message).slice(0, 200) });
    }
  }
  return checked;
}

/** Razorpay credentials cannot be replaced or removed while a form payment awaits confirmation. */
export const hasPendingFormPayments = (app, workspaceId) => Boolean(app.db.get("SELECT 1 FROM form_payments WHERE workspace_id = ? AND provider = 'razorpay' AND status = 'pending'", workspaceId));
