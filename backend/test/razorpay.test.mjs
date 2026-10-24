import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';

const credentials = { key_id: 'rzp_test_schedora123', key_secret: 'fake_secret_for_test', webhook_secret: 'fake_webhook_for_tests', customer_pays_processing: true };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fixture() {
  const env = await setup();
  const links = new Map();
  const calls = [];
  let failCheckout = false;
  env.app.fetchProvider = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const path = new URL(url).pathname;
    if (url.includes('count=1')) return json({ payment_links: [] });
    if (failCheckout) return json({ error: {} }, 500);
    if (url.includes('reference_id=')) return json({ payment_links: [...links.values()].filter(link => link.reference_id === new URL(url).searchParams.get('reference_id')) });
    if (path === '/v1/payment_links' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const link = { ...body, id: 'plink_' + (links.size + 1), status: 'created', amount_paid: 0, short_url: 'https://rzp.io/i/test' + links.size };
      links.set(link.id, link);
      return json(link);
    }
    const link = links.get(path.split('/').at(-1));
    return link ? json(link) : json({}, 404);
  };
  const host = env.client();
  const { ws } = await signUp(host, 'Host');
  assert.equal((await host.post(`/api/workspaces/${ws.id}/integrations/razorpay`, credentials)).status, 200);
  const type = await publishedEventType(host, ws, { price_cents: 50000, currency: 'inr', timezone: 'UTC' });
  const book = async () => {
    const response = await env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: 'Invitee', email: 'invitee@example.com', timezone: 'UTC', start: '2026-10-26T09:00:00.000Z' }, idem());
    assert.equal(response.status, 201);
    return response.body;
  };
  const webhook = async link => {
    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: link } } });
    const signature = createHmac('sha256', credentials.webhook_secret).update(raw).digest('hex');
    return env.client().post(`/api/payments/razorpay/${ws.id}`, raw, { 'X-Razorpay-Signature': signature });
  };
  return { ...env, host, ws, type, links, calls, book, webhook, failCheckout: () => { failCheckout = true; } };
}

test('Razorpay checkout preserves base price, discloses provider fees, encrypts secrets, and reuses links', async () => {
  const env = await fixture();
  try {
    const publicType = (await env.client().get(`/api/public/meet/${env.ws.slug}/${env.type.slug}`)).body;
    assert.equal(publicType.price.fee_policy.customer_pays_processing, true);
    assert.equal(publicType.price.fee_policy.schedora_fee_cents, 0);
    const booked = await env.book();
    assert.equal(booked.booking.status, 'pending');
    assert.equal(booked.checkout.provider, 'razorpay');
    const [link] = env.links.values();
    assert.equal(link.amount, 50000, 'provider adds approved fees; Schedora does not double charge');
    assert.equal(link.accept_partial, false);
    assert.equal(link.notify.email, false);
    assert.equal(link.expire_by, Math.floor(booked.booking.payment.hold_expires_at / 1000));
    assert.ok(!link.notes.schedora_token.includes(booked.manage_token));
    const stored = env.app.db.get("SELECT credentials FROM integrations WHERE provider = 'razorpay'").credentials;
    assert.ok(!stored.includes(credentials.key_secret));
    const list = (await env.host.get(`/api/workspaces/${env.ws.id}/integrations`)).body;
    assert.ok(!JSON.stringify(list).includes(credentials.key_secret));
    const checkoutPath = `/api/public/bookings/${booked.manage_token}/checkout`;
    await Promise.all([env.client().post(checkoutPath), env.client().post(checkoutPath)]);
    assert.equal(env.links.size, 1);
    assert.equal((await env.client().post(`/api/public/bookings/${booked.manage_token}/test-pay`)).status, 409);
    assert.equal((await env.host.del(`/api/workspaces/${env.ws.id}/integrations/razorpay`)).status, 409);
  } finally { await env.close(); }
});

test('signed Razorpay webhook verifies provider state and confirms exactly once', async () => {
  const env = await fixture();
  try {
    const booked = await env.book();
    const [link] = env.links.values();
    const path = `/api/payments/razorpay/${env.ws.id}`;
    assert.equal((await env.client().post(path, '{}', { 'X-Razorpay-Signature': '0'.repeat(64) })).status, 400);
    assert.equal((await env.webhook(link)).body.result, 'unpaid');
    assert.equal((await env.client().post(`/api/public/bookings/${booked.manage_token}/verify-payment`, { paid: true, amount: 1 })).body.result, 'unpaid');
    link.status = 'paid'; link.amount_paid = 49999;
    assert.equal((await env.webhook(link)).status, 400);
    link.amount_paid = 50000;
    assert.equal((await env.webhook(link)).body.result, 'confirmed');
    assert.equal((await env.webhook(link)).body.result, 'duplicate');
    assert.equal((await env.client().post(`/api/public/bookings/${booked.manage_token}/verify-payment`)).body.result, 'duplicate');
    await env.app.worker.tick();
    const confirmation = env.sent.filter(message => message.subject.startsWith('Confirmed'));
    assert.equal(confirmation.length, 1);
    assert.match(confirmation[0].body, new RegExp(booked.manage_token));
    const result = (await env.client().get(`/api/public/bookings/${booked.manage_token}`)).body.booking;
    assert.equal(result.payment.status, 'paid');
    assert.equal(result.status, 'confirmed');
    const other = await signUp(env.client(), 'Other');
    assert.equal((await env.client().post(`/api/payments/razorpay/${other.ws.id}`, '{}')).status, 404);
    const secondOwner = env.client();
    const second = await signUp(secondOwner, 'Second');
    await secondOwner.post(`/api/workspaces/${second.ws.id}/integrations/razorpay`, credentials);
    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: link } } });
    const signature = createHmac('sha256', credentials.webhook_secret).update(raw).digest('hex');
    assert.equal((await env.client().post(`/api/payments/razorpay/${second.ws.id}`, raw, { 'X-Razorpay-Signature': signature })).body.result, 'unknown_booking');
  } finally { await env.close(); }
});

test('payment after hold expiry never reclaims a slot and is flagged for refund review', async () => {
  const env = await fixture();
  try {
    const booked = await env.book();
    const [link] = env.links.values();
    env.clock.now += 21 * 60000;
    link.status = 'paid'; link.amount_paid = 50000;
    assert.equal((await env.webhook(link)).body.result, 'refund_review_required');
    const result = (await env.client().get(`/api/public/bookings/${booked.manage_token}`)).body.booking;
    assert.equal(result.status, 'canceled');
    assert.equal(result.payment.status, 'paid');
    assert.equal((await env.webhook(link)).body.result, 'duplicate');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM emails WHERE kind = 'confirmation'").count, 0);
  } finally { await env.close(); }
});

test('checkout failure returns a recoverable pending booking, never a false confirmation', async () => {
  const env = await fixture();
  try {
    env.failCheckout();
    const booked = await env.book();
    assert.equal(booked.booking.status, 'pending');
    assert.equal(booked.checkout, null);
    assert.ok(booked.manage_token);
    assert.match(booked.checkout_error, /Retry payment/);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});
