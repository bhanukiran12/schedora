import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { text } from '../validate.mjs';
import { encryptJson, decryptJson } from '../platform/crypto.mjs';
import { confirmPayment, expireHolds } from './bookings.mjs';

export function razorpayCredentials(app, workspaceId) {
  const row = app.db.get("SELECT credentials FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'razorpay' AND status = 'active'", workspaceId);
  return row ? decryptJson(app.config, row.credentials) : null;
}

export function razorpayFeePolicy(app, workspaceId) {
  const config = razorpayCredentials(app, workspaceId);
  return config ? { provider: 'razorpay', customer_pays_processing: Boolean(config.customer_pays_processing), schedora_fee_cents: 0 } : null;
}

async function request(app, credentials, path, body) {
  const response = await app.fetchProvider('https://api.razorpay.com/v1/' + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Basic ' + Buffer.from(credentials.key_id + ':' + credentials.key_secret).toString('base64'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) fail(502, 'payment_provider_error', 'Razorpay could not complete this request. Check the account setup or try again.');
  return result;
}

export async function connectRazorpay(app, workspaceId, body) {
  const key_id = text(body.key_id, 'key_id', { min: 10, max: 100 });
  const key_secret = text(body.key_secret, 'key_secret', { min: 10, max: 200 });
  const webhook_secret = text(body.webhook_secret, 'webhook_secret', { min: 16, max: 200 });
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(key_id)) fail(400, 'validation_failed', 'Use your Razorpay test or live Key ID.', { field: 'key_id' });
  if (app.config.production && !app.config.allowTestPayments && key_id.startsWith('rzp_test_')) fail(400, 'validation_failed', 'Test keys are disabled on this server.');
  if (app.db.get("SELECT 1 FROM integrations WHERE workspace_id = ? AND provider = 'stripe' AND status = 'active'", workspaceId)) fail(409, 'payment_provider_connected', 'Disconnect Stripe before switching to Razorpay.');
  if (app.db.get("SELECT 1 FROM bookings WHERE workspace_id = ? AND status = 'pending' AND payment_ref LIKE 'razorpay:%'", workspaceId)) fail(409, 'payments_pending', 'Wait for pending payments before replacing Razorpay credentials.');
  const credentials = { key_id, key_secret, webhook_secret, customer_pays_processing: body.customer_pays_processing === true };
  await request(app, credentials, 'payment_links?count=1');
  const now = app.now();
  app.db.transaction(() => {
    app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'razorpay'", workspaceId);
    app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES (?, ?, NULL, 'razorpay', ?, ?, 'active', ?, ?)", randomUUID(), workspaceId, key_id.startsWith('rzp_live_') ? 'live' : 'test', encryptJson(app.config, credentials), now, now);
  });
  return { connected: true, mode: key_id.startsWith('rzp_live_') ? 'live' : 'test', webhook_url: `${app.config.apiBaseUrl || app.config.baseUrl}/api/payments/razorpay/${workspaceId}` };
}

// Hosted Payment Links use Razorpay's account-approved convenience-fee calculation.
// Schedora never adds a second fee, estimates a rate, or treats a browser redirect as payment proof.
export function createRazorpay(app) {
  const inFlight = new Map();
  async function createLink(booking, eventType, token) {
    const credentials = razorpayCredentials(app, booking.workspace_id);
    if (!credentials) fail(409, 'payments_unavailable', 'Razorpay is not connected.');
    if (booking.currency.toUpperCase() !== 'INR') fail(400, 'unsupported_currency', 'Razorpay booking payments currently support INR only.');
    if (booking.hold_expires_at <= app.now()) fail(409, 'payment_expired', 'The payment hold has expired. Choose a new time.');
    let link;
    const current = app.db.get('SELECT payment_ref FROM bookings WHERE id = ?', booking.id);
    if (current.payment_ref?.startsWith('razorpay:')) link = await request(app, credentials, 'payment_links/' + encodeURIComponent(current.payment_ref.slice(9)));
    else {
      // reference_id is unique at Razorpay. Recover an interrupted creation before issuing another.
      const found = await request(app, credentials, 'payment_links?reference_id=' + encodeURIComponent(booking.id));
      link = found.payment_links?.find(item => item.reference_id === booking.id);
      if (!link) {
        if (booking.hold_expires_at - app.now() < 16 * 60000) fail(409, 'payment_expired', 'Too little time remains to create a new Razorpay checkout. Choose a new appointment after this hold expires.');
        try {
          link = await request(app, credentials, 'payment_links', {
            amount: booking.amount_cents, currency: 'INR', accept_partial: false,
            reference_id: booking.id, expire_by: Math.floor(booking.hold_expires_at / 1000),
            description: `${eventType.title} (${booking.reference})`.slice(0, 200),
            customer: { name: booking.invitee_name, email: booking.invitee_email },
            notify: { sms: false, email: false }, reminder_enable: false,
            callback_url: `${app.config.baseUrl}/meet/manage/${token}?paid=1`, callback_method: 'get',
            notes: { schedora_token: encryptJson(app.config, { token }) }
          });
        } catch (error) {
          const recovered = await request(app, credentials, 'payment_links?reference_id=' + encodeURIComponent(booking.id));
          link = recovered.payment_links?.find(item => item.reference_id === booking.id);
          if (!link) throw error;
        }
      }
    }
    if (!/^plink_[A-Za-z0-9]+$/.test(link.id || '') || link.reference_id !== booking.id || link.amount !== booking.amount_cents || link.currency !== 'INR') fail(502, 'payment_mismatch', 'The payment link does not match this booking.');
    let url;
    try { url = new URL(link.short_url); } catch { fail(502, 'payment_provider_error', 'Razorpay did not return a checkout link.'); }
    if (url.protocol !== 'https:' || !['rzp.io', 'rzp.in', 'razorpay.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail(502, 'payment_provider_error', 'Razorpay returned an invalid checkout address.');
    app.db.run('UPDATE bookings SET payment_ref = ? WHERE id = ?', 'razorpay:' + link.id, booking.id);
    if (link.status === 'paid') {
      await settle(booking.workspace_id, link, token);
      return { provider: 'razorpay', url: `${app.config.baseUrl}/meet/manage/${token}?paid=1` };
    }
    if (link.status !== 'created' && link.status !== 'partially_paid') fail(409, 'payment_expired', 'This checkout is no longer available. Choose a new time.');
    return { provider: 'razorpay', url: url.href, fee_policy: razorpayFeePolicy(app, booking.workspace_id) };
  }

  async function settle(workspaceId, link, suppliedToken) {
    if (link.status !== 'paid') return 'unpaid';
    const booking = app.db.get("SELECT * FROM bookings WHERE workspace_id = ? AND payment_ref = ?", workspaceId, 'razorpay:' + link.id);
    if (!booking) return 'unknown_booking';
    if (link.reference_id !== booking.id || link.currency !== booking.currency.toUpperCase() || link.amount !== booking.amount_cents || link.amount_paid < booking.amount_cents || !Number.isSafeInteger(link.amount_paid)) fail(400, 'payment_mismatch', 'Razorpay payment amount or booking does not match.');
    expireHolds(app);
    const current = app.db.get('SELECT status, payment_status FROM bookings WHERE id = ?', booking.id);
    if (current.payment_status === 'paid') return 'duplicate';
    if (current.status === 'canceled') {
      app.db.run("UPDATE bookings SET payment_status = 'paid', cancel_reason = 'Payment received after cancellation or hold expiry. Host must review and refund in Razorpay.' WHERE id = ?", booking.id);
      app.log('warn', 'payment_requires_refund_review', { booking_id: booking.id, provider: 'razorpay', payment_link_id: link.id });
      return 'refund_review_required';
    }
    let token = suppliedToken;
    if (!token && link.notes?.schedora_token) { try { token = decryptJson(app.config, link.notes.schedora_token).token; } catch {} }
    const result = confirmPayment(app, booking.id, 'razorpay:' + link.id, token);
    app.nudge?.();
    return result;
  }

  return {
    checkout(booking, eventType, token) {
      if (inFlight.has(booking.id)) return inFlight.get(booking.id);
      const task = createLink(booking, eventType, token).finally(() => inFlight.delete(booking.id));
      inFlight.set(booking.id, task);
      return task;
    },
    async verify(booking, token) {
      const credentials = razorpayCredentials(app, booking.workspace_id);
      if (!credentials || !booking.payment_ref?.startsWith('razorpay:')) fail(409, 'not_razorpay', 'This booking has no Razorpay checkout.');
      const link = await request(app, credentials, 'payment_links/' + encodeURIComponent(booking.payment_ref.slice(9)));
      return settle(booking.workspace_id, link, token);
    },
    async webhook(workspaceId, raw, signature) {
      const credentials = razorpayCredentials(app, workspaceId);
      if (!credentials) fail(404, 'not_found', 'Not configured.');
      const expected = createHmac('sha256', credentials.webhook_secret).update(raw).digest();
      if (!/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(400, 'invalid_signature', 'Razorpay signature does not match.');
      let event;
      try { event = JSON.parse(raw); } catch { fail(400, 'invalid_payload', 'Invalid webhook JSON.'); }
      if (event.event !== 'payment_link.paid') return 'ignored';
      const entity = event.payload?.payment_link?.entity;
      if (!/^plink_[A-Za-z0-9]+$/.test(entity?.id || '')) fail(400, 'invalid_payload', 'Missing payment link.');
      const link = await request(app, credentials, 'payment_links/' + entity.id);
      return settle(workspaceId, link);
    }
  };
}
