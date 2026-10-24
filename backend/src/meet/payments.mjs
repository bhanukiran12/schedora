import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { text } from '../validate.mjs';
import { decryptJson, encryptJson } from '../platform/crypto.mjs';
import { confirmPayment } from './bookings.mjs';
import { createRazorpay, razorpayCredentials, razorpayFeePolicy } from './razorpay.mjs';

// Paid bookings. Each workspace connects its own Stripe account (restricted secret key and webhook
// signing secret, stored encrypted), so payments go to the host, not to Schedora. Outside
// production a test provider simulates checkout so the whole flow can be exercised.

function stripeCredentials(app, workspaceId) {
  const row = app.db.get("SELECT credentials FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'stripe' AND status = 'active'", workspaceId);
  return row ? decryptJson(app.config, row.credentials) : null;
}

export function createPayments(app, fetchImpl = fetch) {
  const testMode = () => !app.config.production || app.config.allowTestPayments;
  const razorpay = createRazorpay(app);
  return {
    razorpay,
    feePolicy: workspaceId => razorpayFeePolicy(app, workspaceId),
    holdMinutes: workspaceId => razorpayCredentials(app, workspaceId) ? 20 : 15,
    available(workspaceId, currency) {
      if (razorpayCredentials(app, workspaceId) && currency && currency.toUpperCase() !== 'INR') return false;
      return Boolean(razorpayCredentials(app, workspaceId) || stripeCredentials(app, workspaceId)) || testMode();
    },

    // Returns the URL where the invitee pays for a pending booking.
    async checkout(booking, eventType, token) {
      if (razorpayCredentials(app, booking.workspace_id)) return razorpay.checkout(booking, eventType, token);
      const stripe = stripeCredentials(app, booking.workspace_id);
      if (!stripe) {
        if (!testMode()) fail(409, 'payments_unavailable', 'Online payment is not set up for this workspace.');
        return { provider: 'test', url: `${app.config.baseUrl}/meet/pay/${token}` };
      }
      const form = new URLSearchParams({
        mode: 'payment',
        success_url: `${app.config.baseUrl}/meet/manage/${token}?paid=1`,
        cancel_url: `${app.config.baseUrl}/meet/${eventType.workspace_slug}/${eventType.slug}`,
        customer_email: booking.invitee_email,
        client_reference_id: booking.id,
        expires_at: String(Math.floor(booking.hold_expires_at / 1000) + 1800),
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': booking.currency,
        'line_items[0][price_data][unit_amount]': String(booking.amount_cents),
        'line_items[0][price_data][product_data][name]': `${eventType.title} (${booking.reference})`,
        'metadata[booking_id]': booking.id,
        'metadata[manage_token]': token
      });
      const response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', body: form, signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${stripe.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `checkout-${booking.id}` }
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok || !session.url) fail(502, 'payment_provider_error', session.error?.message || 'The payment provider did not accept the checkout.');
      app.db.run('UPDATE bookings SET payment_ref = ? WHERE id = ?', session.id, booking.id);
      return { provider: 'stripe', url: session.url };
    },

    // Stripe webhook, one endpoint per workspace: /api/payments/stripe/<workspace id>
    handleStripeWebhook(workspaceId, raw, header) {
      const stripe = stripeCredentials(app, workspaceId);
      if (!stripe) fail(404, 'not_found', 'Not configured.');
      const parts = Object.fromEntries(String(header || '').split(',').map(part => part.split('=')).filter(pair => pair.length === 2 && pair[0] !== 'v1'));
      const signatures = String(header || '').split(',').filter(part => part.startsWith('v1=')).map(part => part.slice(3));
      const timestamp = Number(parts.t);
      if (!timestamp || Math.abs(app.now() / 1000 - timestamp) > 300) fail(400, 'invalid_signature', 'Signature timestamp outside tolerance.');
      const expected = createHmac('sha256', stripe.webhook_secret).update(`${timestamp}.${raw}`).digest();
      if (!signatures.some(signature => /^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(expected, Buffer.from(signature, 'hex')))) fail(400, 'invalid_signature', 'Signature does not match.');
      const event = JSON.parse(raw);
      if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return 'ignored';
      const session = event.data?.object || {};
      if (session.payment_status !== 'paid') return 'unpaid';
      const booking = app.db.get('SELECT id, workspace_id FROM bookings WHERE id = ?', session.metadata?.booking_id || '');
      if (!booking || booking.workspace_id !== workspaceId) return 'unknown_booking';
      const result = confirmPayment(app, booking.id, session.payment_intent || session.id, session.metadata?.manage_token);
      app.nudge?.();
      return result;
    },

    // Test provider: only outside production.
    testPay(token, bookingId) {
      if (!testMode()) fail(404, 'not_found', 'Not available.');
      const booking = app.db.get('SELECT workspace_id FROM bookings WHERE id = ?', bookingId);
      if (booking && (razorpayCredentials(app, booking.workspace_id) || stripeCredentials(app, booking.workspace_id))) fail(409, 'real_payments_connected', 'Use the connected payment provider. Simulated payment is disabled.');
      const result = confirmPayment(app, bookingId, 'test_' + bookingId, token);
      app.nudge?.();
      return result;
    }
  };
}

export function connectStripe(app, workspaceId, body) {
  if (razorpayCredentials(app, workspaceId)) fail(409, 'payment_provider_connected', 'Disconnect Razorpay before switching to Stripe.');
  const secretKey = text(body.secret_key, 'secret_key', { min: 10, max: 200 });
  const webhookSecret = text(body.webhook_secret, 'webhook_secret', { min: 10, max: 200 });
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) fail(400, 'validation_failed', 'Use a Stripe secret or restricted key (sk_… or rk_…).', { field: 'secret_key' });
  if (!webhookSecret.startsWith('whsec_')) fail(400, 'validation_failed', 'Use the webhook signing secret (whsec_…).', { field: 'webhook_secret' });
  const now = app.now();
  const credentials = encryptJson(app.config, { secret_key: secretKey, webhook_secret: webhookSecret });
  app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'stripe'", workspaceId);
  app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES (?, ?, NULL, 'stripe', ?, ?, 'active', ?, ?)",
    crypto.randomUUID(), workspaceId, secretKey.includes('_live_') ? 'live' : 'test', credentials, now, now);
  return { connected: true, mode: secretKey.includes('_live_') ? 'live' : 'test', webhook_url: `${app.config.apiBaseUrl || app.config.baseUrl}/api/payments/stripe/${workspaceId}` };
}
