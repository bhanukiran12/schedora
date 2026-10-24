import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { setup, signUp } from './helpers.mjs';
import { sign } from '../src/billing/webhooks.mjs';

const DAY = 86400000;
const secret = 'fake_platform_webhook_secret';
// Test fixture prices only; these do not set commercial Schedora prices.
const plans = Object.fromEntries(['meet','forms','flow','suite'].map((name, index) => [name, { id: 'plan_' + name, amount_cents: (index + 1) * 10000, currency: 'INR', cycles: 12 }]));
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
async function fixture() {
  const env = await setup({ config: { billingMode: 'enforced', billingProvider: 'razorpay', billingWebhookSecret: secret, commercialBillingConfirmed: true,
    razorpayBilling: { keyId: 'rzp_test_platform123', keySecret: 'fake_platform_secret', checkoutEnabled: true, plans } } });
  const remote = new Map();
  const calls = [];
  let ambiguous = false;
  env.app.fetchProvider = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/plans/')) {
      const id = path.split('/').at(-1);
      const plan = Object.values(plans).find(plan => plan.id === id);
      return json({ id, period: 'monthly', interval: 1, item: { amount: plan.amount_cents, currency: plan.currency } });
    }
    if (path === '/v1/subscriptions' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const sub = { ...body, id: 'sub_' + (remote.size + 1), status: 'created', paid_count: 0, current_end: null, short_url: 'https://rzp.io/rzp/subscribe' + remote.size };
      remote.set(sub.id, sub);
      if (ambiguous) throw new Error('simulated lost provider response');
      return json(sub);
    }
    const id = path.split('/')[3];
    const sub = remote.get(id);
    if (path.endsWith('/cancel')) {
      sub.scheduledCancellation = JSON.parse(init.body).cancel_at_cycle_end;
      if (!sub.scheduledCancellation) sub.status = 'cancelled';
    }
    return json(sub);
  };
  const host = env.client();
  const { ws, email } = await signUp(host, 'Subscriber');
  const checkout = (plan = 'meet', key = randomUUID()) => host.post(`/api/workspaces/${ws.id}/billing/checkout`, { plan }, { 'Idempotency-Key': key });
  const webhook = async (sub, event = 'subscription.charged') => {
    const raw = JSON.stringify({ event, created_at: Math.floor(env.clock.now / 1000), payload: { subscription: { entity: { id: sub.id } } } });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    return env.client().post('/api/billing/razorpay/webhook', raw, { 'X-Razorpay-Signature': signature });
  };
  const billing = async () => (await host.get(`/api/workspaces/${ws.id}/billing`)).body;
  return { ...env, host, ws, email, remote, calls, checkout, webhook, billing, loseResponse: () => { ambiguous = true; } };
}

test('platform checkout binds the workspace, excludes overlapping plans, and grants no access on authorization alone', async () => {
  const env = await fixture();
  try {
    const key = randomUUID();
    const first = await env.checkout('meet', key);
    assert.equal(first.status, 200);
    assert.equal((await env.checkout('meet', key)).body.url, first.body.url);
    assert.equal(env.remote.size, 1);
    assert.equal((await env.checkout('suite')).status, 409);
    let data = await env.billing();
    assert.equal(data.entitlements.meet.active, false);
    const sub = [...env.remote.values()][0];
    sub.status = 'authenticated';
    assert.equal((await env.webhook(sub, 'subscription.authenticated')).body.result, 'applied');
    assert.equal((await env.billing()).entitlements.meet.active, false);
    env.clock.now += 1000;
    sub.status = 'active'; sub.paid_count = 1; sub.current_end = Math.floor((env.clock.now + 30 * DAY) / 1000);
    assert.equal((await env.webhook(sub)).body.result, 'applied');
    assert.equal((await env.webhook(sub)).body.result, 'duplicate');
    data = await env.billing();
    assert.equal(data.entitlements.meet.active, true);
    assert.equal(data.entitlements.forms.active, false);
    assert.equal(data.entitlements.flow.active, false);
    assert.equal(data.checkouts.length, 0);
    assert.equal(data.plans[0].price.amount_cents, plans.meet.amount_cents);
    assert.ok(!JSON.stringify(data).includes('fake_platform_secret'));
    const normalized = JSON.stringify({ id: 'forged', type: 'invoice.paid', created: Math.floor(env.clock.now / 1000), data: { subscription: { id: sub.id } } });
    assert.equal((await env.client().post('/api/billing/webhook', normalized, { 'Schedora-Signature': sign(secret, normalized, Math.floor(env.clock.now / 1000)) })).status, 404);
  } finally { await env.close(); }
});

test('Razorpay renewal failure has bounded grace and cancellation retains only the paid period', async () => {
  const env = await fixture();
  try {
    await env.checkout('suite');
    const sub = [...env.remote.values()][0];
    sub.status = 'active'; sub.paid_count = 1; sub.current_end = Math.floor((env.clock.now + 30 * DAY) / 1000);
    await env.webhook(sub);
    env.clock.now += 1000; sub.status = 'pending'; await env.webhook(sub, 'subscription.pending');
    assert.equal((await env.billing()).entitlements.forms.active, true);
    env.clock.now += 8 * DAY;
    assert.equal((await env.billing()).entitlements.forms.active, false);
    sub.status = 'active'; sub.paid_count = 2; sub.current_end = Math.floor((env.clock.now + 30 * DAY) / 1000);
    await env.webhook(sub);
    let billing = await env.billing();
    const id = billing.subscriptions[0].id;
    assert.equal(billing.entitlements.flow.active, true);
    assert.equal((await env.host.post(`/api/workspaces/${env.ws.id}/billing/subscriptions/${id}/cancel`)).body.scheduled, true);
    assert.equal(sub.scheduledCancellation, true);
    assert.equal((await env.billing()).entitlements.meet.active, true);
    // Providers may report cancelled before the already-paid period ends.
    env.clock.now += 1000; sub.status = 'cancelled'; await env.webhook(sub, 'subscription.cancelled');
    assert.equal((await env.billing()).entitlements.meet.active, true);
    env.clock.now = sub.current_end * 1000 + 1;
    await env.host.post('/api/auth/login', { email: env.email, password: 'a sufficiently long password' });
    assert.equal((await env.billing()).entitlements.meet.active, false, 'cancellation has no extra renewal tolerance');
  } finally { await env.close(); }
});

test('subscription actions reject nonowners, forged signatures, and cross-workspace references', async () => {
  const env = await fixture();
  try {
    const member = env.client();
    const person = await signUp(member, 'Member');
    await env.host.post(`/api/workspaces/${env.ws.id}/members`, { email: person.email, role: 'admin' });
    assert.equal((await member.post(`/api/workspaces/${env.ws.id}/billing/checkout`, { plan: 'meet' }, { 'Idempotency-Key': randomUUID() })).status, 403);
    await env.checkout();
    const sub = [...env.remote.values()][0];
    sub.status = 'active'; sub.paid_count = 1; sub.current_end = Math.floor((env.clock.now + 30 * DAY) / 1000);
    assert.equal((await env.client().post('/api/billing/razorpay/webhook', '{}', { 'X-Razorpay-Signature': '0'.repeat(64) })).status, 400);
    const originalWorkspace = sub.notes.schedora_workspace_id;
    sub.notes.schedora_workspace_id = person.ws.id;
    assert.equal((await env.webhook(sub)).status, 400);
    sub.notes.schedora_workspace_id = originalWorkspace;
    await env.webhook(sub);
    const id = (await env.billing()).subscriptions[0].id;
    assert.equal((await member.post(`/api/workspaces/${person.ws.id}/billing/subscriptions/${id}/refresh`)).status, 404);
    assert.equal((await member.post(`/api/workspaces/${person.ws.id}/billing/subscriptions/${id}/cancel`)).status, 404);
  } finally { await env.close(); }
});

test('ambiguous subscription creation stays blocked across retries to prevent duplicate recurring mandates', async () => {
  const env = await fixture();
  try {
    env.loseResponse();
    const key = randomUUID();
    assert.equal((await env.checkout('meet', key)).status, 500);
    assert.equal((await env.checkout('meet', key)).status, 409);
    assert.equal((await env.checkout('meet')).status, 409);
    assert.equal(env.remote.size, 1);
    assert.equal((await env.billing()).checkouts[0].status, 'uncertain');
    // A verified provider event can bind the reserved checkout after the lost response.
    const sub = [...env.remote.values()][0];
    sub.status = 'active'; sub.paid_count = 1; sub.current_end = Math.floor((env.clock.now + 30 * DAY) / 1000);
    assert.equal((await env.webhook(sub)).body.result, 'applied');
    assert.equal((await env.billing()).entitlements.meet.active, true);
  } finally { await env.close(); }
});

test('unapproved or disabled subscription checkout never creates a provider mandate', async () => {
  const env = await fixture();
  try {
    env.app.config.razorpayBilling.checkoutEnabled = false;
    assert.equal((await env.checkout()).status, 409);
    env.app.config.razorpayBilling.checkoutEnabled = true;
    env.app.config.commercialBillingConfirmed = false;
    assert.equal((await env.checkout()).status, 409);
    assert.equal(env.remote.size, 0);
  } finally { await env.close(); }
});

test('an expired authorization checkout can be refreshed and an unpaid mandate canceled without granting access', async () => {
  const env = await fixture();
  try {
    const first = await env.checkout();
    const sub = [...env.remote.values()][0];
    sub.status = 'expired';
    assert.equal((await env.host.post(`/api/workspaces/${env.ws.id}/billing/checkouts/${first.body.checkout_id}/refresh`)).body.result, 'applied');
    assert.equal((await env.billing()).entitlements.meet.active, false);
    assert.equal((await env.billing()).checkouts.length, 0);
    assert.equal((await env.checkout()).status, 200);
    const second = [...env.remote.values()][1];
    second.status = 'authenticated';
    await env.webhook(second, 'subscription.authenticated');
    const row = (await env.billing()).subscriptions.find(item => item.status === 'incomplete');
    assert.equal((await env.host.post(`/api/workspaces/${env.ws.id}/billing/subscriptions/${row.id}/cancel`)).body.scheduled, false);
    assert.equal(second.status, 'cancelled');
    assert.equal((await env.billing()).entitlements.meet.active, false);
  } finally { await env.close(); }
});
