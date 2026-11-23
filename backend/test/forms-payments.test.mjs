import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { definitionProblems } from '../src/shared/forms-logic.mjs';
import { normalizeDefinition, publicDefinition } from '../src/forms/service.mjs';
import { reconcileFormPayments } from '../src/forms/payments.mjs';
import { dispatchOutbox } from '../src/flow/service.mjs';
import { setup, signUp, publishedEventType } from './helpers.mjs';

const HOUR = 3600000;
const definition = (extra = {}) => ({ title: 'Workshop registration', presentation: 'classic', fields: [
  { id: 'name', type: 'short_text', label: 'Name', required: true },
  { id: 'email', type: 'email', label: 'Email', required: true }
], payment: { amount_cents: 49900, currency: 'INR', description: 'Workshop seat', window_hours: 2 }, ...extra });
const answers = { name: 'Asha Rao', email: 'asha@example.com' };
const credentials = { key_id: 'rzp_test_schedora123', key_secret: 'fake_secret_for_test', webhook_secret: 'fake_webhook_for_tests' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function publishPaid(owner, ws, extra) {
  const forms = `/api/workspaces/${ws.id}/forms`;
  const created = await owner.post(forms, { definition: definition(extra) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `${forms}/${created.body.id}`;
  const published = await owner.post(path + '/publish');
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return { form: created.body, path, publicPath: '/api/public/forms/' + created.body.slug };
}
const outboxFor = (env, responseId) => env.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE type = 'forms.response.created' AND subject_id = ?", responseId).n;

test('payment settings are validated, kept in the immutable version and shown to respondents', () => {
  assert.deepEqual(definitionProblems(definition()), []);
  assert.match(definitionProblems(definition({ payment: { amount_cents: 50, currency: 'INR' } })).join(' '), /₹1 to ₹5,00,000/);
  assert.match(definitionProblems(definition({ payment: { amount_cents: 1000, currency: 'USD' } })).join(' '), /INR/);
  assert.match(definitionProblems(definition({ payment: { amount_cents: 1000, currency: 'INR', window_hours: 100 } })).join(' '), /1 to 72 hours/);
  assert.match(definitionProblems(definition({ responses: { allow_edit: true } })).join(' '), /cannot let respondents edit/);
  const clean = normalizeDefinition({ ...definition(), payment: { amount_cents: 49900, description: '  Seat  ', extra: 'dropped' } });
  assert.deepEqual(clean.payment, { amount_cents: 49900, description: 'Seat', currency: 'INR' });
  assert.equal(publicDefinition(clean).payment.amount_cents, 49900);
});

test('test checkout: a paid response stays incomplete until the server confirms payment, then runs downstream actions once', async () => {
  const env = await setup();
  try {
    const owner = env.client(), visitor = env.client();
    const { ws } = await signUp(owner, 'Paid forms');
    const event = await publishedEventType(owner, ws);
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(forms, { definition: definition() })).body;
    const path = `${forms}/${created.id}`;
    const routed = await owner.raw('PUT', path + '/routing', { routing: { rules: [], fallback: { type: 'event', event_type_id: event.id } } });
    assert.equal(routed.status, 200, JSON.stringify(routed.body));
    assert.equal((await owner.post(path + '/publish')).status, 200);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/forms-payment-readiness`)).body.payments.provider, 'test');
    const publicPath = '/api/public/forms/' + created.slug;
    assert.equal((await visitor.get(publicPath)).body.definition.payment.amount_cents, 49900);

    const submitted = await visitor.post(publicPath + '/responses', { answers, submission_id: 'paid-submission-0001' });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const { payment } = submitted.body;
    assert.equal(payment.status, 'pending');
    assert.equal(payment.amount_text, '₹499.00');
    assert.equal(submitted.body.next, null, 'no booking offer before payment');
    const responseId = submitted.body.id;
    assert.equal(outboxFor(env, responseId), 0, 'Flow and webhooks wait for payment');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ?', ws.id).n, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_handoffs').n, 0);

    // A retry of the same submission returns the same private link and creates nothing.
    const replay = await visitor.post(publicPath + '/responses', { answers, submission_id: 'paid-submission-0001' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.payment.token, payment.token);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_payments').n, 1);

    const pay = `/api/public/form-payments/${payment.token}`;
    assert.equal((await env.client().get(pay)).body.status, 'pending');
    assert.equal((await env.client().post(pay + '/test-pay', { action: 'pay' })).status, 409, 'needs a checkout first');
    const checkout = await env.client().post(pay + '/checkout');
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    assert.match(checkout.body.url, /\/forms\/pay\//);
    assert.equal((await env.client().post(pay + '/checkout')).body.url, checkout.body.url, 'an open checkout is reused');

    const declined = await env.client().post(pay + '/test-pay', { action: 'fail' });
    assert.equal(declined.body.status, 'failed');
    assert.equal(declined.body.can_pay, true);
    let listed = (await owner.get(path + '/responses')).body.responses[0];
    assert.equal(listed.payment.status, 'failed');
    assert.equal(outboxFor(env, responseId), 0);

    const paid = await env.client().post(pay + '/test-pay', { action: 'pay' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'paid');
    assert.equal(paid.body.complete, true);
    assert.equal(paid.body.next.type, 'booking');
    assert.equal(paid.body.next.status, 'offered');
    assert.equal(outboxFor(env, responseId), 1);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM contacts WHERE workspace_id = ?', ws.id).n, 1);
    // Repeating confirmation (or a redelivered event) never repeats the downstream actions.
    assert.equal((await env.client().post(pay + '/test-pay', { action: 'pay' })).status, 409);
    assert.equal((await env.client().post(pay + '/verify')).body.status, 'paid');
    assert.equal(outboxFor(env, responseId), 1);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM form_handoffs').n, 1);
    dispatchOutbox(env.app);

    listed = (await owner.get(path + '/responses')).body.responses[0];
    assert.equal(listed.payment.status, 'paid');
    assert.equal(listed.payment.amount_paid, 49900);
    const csv = (await owner.get(path + '/responses.csv')).body;
    assert.match(csv, /"Payment status","Payment amount \(INR\)","Amount paid \(INR\)"/);
    assert.match(csv, /"Paid","499\.00","499\.00","0\.00"/);
    const grid = (await owner.get(path + '/workbook/responses')).body;
    assert.equal(grid.rows[0][grid.header.indexOf('Payment status')], 'Paid');
    assert.equal(grid.rows[0][grid.header.indexOf('Amount paid (INR)')], '499.00');
  } finally { await env.close(); }
});

test('unpaid responses expire after the window, stop counting toward limits and cannot start a new checkout', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Expiring payments');
    const { path, publicPath } = await publishPaid(owner, ws, { responses: { limit: 1 } });
    const first = await env.client().post(publicPath + '/responses', { answers, submission_id: 'paid-limit-000001' });
    assert.equal(first.status, 201);
    assert.equal((await env.client().post(publicPath + '/responses', { answers, submission_id: 'paid-limit-000002' })).status, 410, 'a pending payment holds the place');
    env.clock.now += 2 * HOUR + 1;
    await reconcileFormPayments(env.app);
    const status = (await env.client().get(`/api/public/form-payments/${first.body.payment.token}`)).body;
    assert.equal(status.status, 'expired');
    assert.equal(status.can_pay, false);
    assert.equal((await env.client().post(`/api/public/form-payments/${first.body.payment.token}/checkout`)).status, 409);
    assert.equal(outboxFor(env, first.body.id), 0);
    assert.equal((await owner.get(path + '/responses')).body.responses[0].payment.status, 'expired');
    assert.match((await owner.get(path + '/responses.csv')).body, /Payment window ended/);
    assert.equal((await env.client().post(publicPath + '/responses', { answers, submission_id: 'paid-limit-000003' })).status, 201, 'expired responses free their place');
  } finally { await env.close(); }
});

test('publishing a paid form needs Razorpay or the test checkout; Stripe-only and production without Razorpay are refused', async () => {
  const env = await setup({ config: { production: false } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Stripe only');
    env.app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES ('stripe-1', ?, NULL, 'stripe', 'test', 'x', 'active', 0, 0)", ws.id);
    const forms = `/api/workspaces/${ws.id}/forms`;
    const created = (await owner.post(forms, { definition: definition() })).body;
    const refused = await owner.post(`${forms}/${created.id}/publish`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /Razorpay/);
    const check = (await owner.post(`${forms}/${created.id}/publish-check`, {})).body;
    assert.equal(check.can_publish, false);
    assert.equal(check.problems[0].field, 'payment');
    env.app.db.run("DELETE FROM integrations WHERE id = 'stripe-1'");
    env.app.config.production = true;
    env.app.config.allowTestPayments = false;
    assert.match((await owner.post(`${forms}/${created.id}/publish-check`, {})).body.problems[0].message, /Connect Razorpay/);
  } finally { await env.close(); }
});

async function razorpayFixture() {
  const env = await setup();
  const links = new Map();
  const payments = new Map();
  const calls = [];
  env.app.fetchProvider = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    const parsed = new URL(url);
    if (url.includes('count=1')) return json({ payment_links: [] });
    if (parsed.searchParams.has('reference_id')) return json({ payment_links: [...links.values()].filter(link => link.reference_id === parsed.searchParams.get('reference_id')) });
    if (parsed.pathname === '/v1/payment_links' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const link = { ...body, id: 'plink_F' + (links.size + 1), status: 'created', amount_paid: 0, payments: [], short_url: 'https://rzp.io/i/form' + links.size };
      links.set(link.id, link);
      return json(link);
    }
    const id = parsed.pathname.split('/').at(-1);
    if (parsed.pathname.startsWith('/v1/payments/')) return payments.has(id) ? json(payments.get(id)) : json({}, 404);
    return links.has(id) ? json(links.get(id)) : json({}, 404);
  };
  const owner = env.client();
  const { ws } = await signUp(owner, 'Razorpay forms');
  assert.equal((await owner.post(`/api/workspaces/${ws.id}/integrations/razorpay`, credentials)).status, 200);
  const signed = (body, eventId) => {
    const raw = JSON.stringify(body);
    return env.client().post(`/api/payments/razorpay/${ws.id}`, raw, { 'X-Razorpay-Signature': createHmac('sha256', credentials.webhook_secret).update(raw).digest('hex'), ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}) });
  };
  return { ...env, owner, ws, links, payments, calls, signed };
}

test('Razorpay: the redirect proves nothing, a verified webhook re-reads the link, redeliveries are idempotent and refunds are tracked', async () => {
  const env = await razorpayFixture();
  try {
    const { path, publicPath } = await publishPaid(env.owner, env.ws);
    const submitted = (await env.client().post(publicPath + '/responses', { answers, submission_id: 'razorpay-form-0001' })).body;
    const pay = `/api/public/form-payments/${submitted.payment.token}`;
    const [first, second] = await Promise.all([env.client().post(pay + '/checkout'), env.client().post(pay + '/checkout')]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.url, second.body.url);
    assert.equal(env.links.size, 1, 'concurrent checkouts share one payment link');
    const [link] = env.links.values();
    assert.equal(link.amount, 49900);
    assert.equal(link.accept_partial, false);
    assert.match(link.reference_id, /^fp_[a-f0-9]{32}$/);
    assert.match(link.callback_url, /\/f\/.+\?payment=/);
    assert.equal(link.customer.email, 'asha@example.com');
    assert.equal((await env.client().post(pay + '/test-pay', { action: 'pay' })).status, 409, 'simulation is off once Razorpay is connected');

    // Returning from checkout (or forging the redirect) only triggers a provider read.
    assert.equal((await env.client().post(pay + '/verify')).body.status, 'pending');
    assert.equal(outboxFor(env, submitted.id), 0);

    // An unsigned or wrongly signed webhook changes nothing.
    const event = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.id, reference_id: link.reference_id, status: 'paid' } } } };
    assert.equal((await env.client().post(`/api/payments/razorpay/${env.ws.id}`, JSON.stringify(event), { 'X-Razorpay-Signature': 'f'.repeat(64) })).status, 400);
    // A signed event whose link is still unpaid at Razorpay is not trusted either.
    assert.equal((await env.signed(event, 'evt_unpaid_000001')).body.result, 'pending');

    Object.assign(link, { status: 'paid', amount_paid: 49900, payments: [{ payment_id: 'pay_FORM001', status: 'captured', amount: 49900 }] });
    const settled = await env.signed(event, 'evt_paid_000001');
    assert.equal(settled.body.result, 'paid');
    assert.equal((await env.signed(event, 'evt_paid_000001')).body.result, 'duplicate');
    assert.equal((await env.signed(event, 'evt_paid_000002')).body.result, 'duplicate');
    assert.equal(outboxFor(env, submitted.id), 1);
    let listed = (await env.owner.get(path + '/responses')).body.responses[0];
    assert.equal(listed.payment.status, 'paid');
    assert.equal(listed.payment.provider_payment_id, 'pay_FORM001');
    assert.equal((await env.owner.del(`/api/workspaces/${env.ws.id}/integrations/razorpay`)).status, 204, 'no pending payment blocks disconnect after settling');
    assert.equal((await env.owner.post(`/api/workspaces/${env.ws.id}/integrations/razorpay`, credentials)).status, 200);

    // Refunds: the webhook only names the payment; the refunded amount comes from Razorpay.
    env.payments.set('pay_FORM001', { id: 'pay_FORM001', amount: 49900, amount_refunded: 10000, status: 'captured' });
    assert.equal((await env.signed({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_FORM001', amount: 99999999 } } } }, 'evt_refund_000001')).body.result, 'partially_refunded');
    env.payments.set('pay_FORM001', { id: 'pay_FORM001', amount: 49900, amount_refunded: 49900, status: 'refunded' });
    const refreshed = await env.owner.post(`${path}/responses/${submitted.id}/payment/refresh`);
    assert.equal(refreshed.body.status, 'refunded');
    assert.equal(refreshed.body.amount_refunded, 49900);
    assert.match((await env.owner.get(path + '/responses.csv')).body, /"Refunded","499\.00","499\.00","499\.00","[^"]+","pay_FORM001"/);
    assert.equal(outboxFor(env, submitted.id), 1, 'a refund does not rerun or undo downstream actions');
  } finally { await env.close(); }
});

test('Razorpay: mismatched amounts go to review, missed webhooks are reconciled, and pending payments block credential changes', async () => {
  const env = await razorpayFixture();
  try {
    const { path, publicPath } = await publishPaid(env.owner, env.ws);
    const one = (await env.client().post(publicPath + '/responses', { answers, submission_id: 'razorpay-form-0101' })).body;
    const two = (await env.client().post(publicPath + '/responses', { answers, submission_id: 'razorpay-form-0102' })).body;
    await env.client().post(`/api/public/form-payments/${one.payment.token}/checkout`);
    await env.client().post(`/api/public/form-payments/${two.payment.token}/checkout`);
    assert.equal((await env.owner.post(`/api/workspaces/${env.ws.id}/integrations/razorpay`, credentials)).status, 409);
    assert.equal((await env.owner.del(`/api/workspaces/${env.ws.id}/integrations/razorpay`)).status, 409);
    const [linkOne, linkTwo] = env.links.values();
    Object.assign(linkOne, { status: 'paid', amount_paid: 100, payments: [{ payment_id: 'pay_SHORT', status: 'captured' }] });
    Object.assign(linkTwo, { status: 'paid', amount_paid: 49900, payments: [{ payment_id: 'pay_LATE', status: 'captured' }] });
    // No webhook arrived: the worker reads both links.
    env.clock.now += 6 * 60000;
    assert.equal(await reconcileFormPayments(env.app), 2);
    const rows = Object.fromEntries((await env.owner.get(path + '/responses')).body.responses.map(row => [row.id, row.payment]));
    assert.equal(rows[one.id].status, 'review');
    assert.match(rows[one.id].review_reason, /less than the full amount/);
    assert.equal(rows[two.id].status, 'paid');
    assert.equal(outboxFor(env, one.id), 0, 'an underpaid response never completes');
    assert.equal(outboxFor(env, two.id), 1);
    assert.equal((await env.client().get(`/api/public/form-payments/${one.payment.token}`)).body.message.includes('Do not pay again'), true);
    assert.equal((await env.client().post(`/api/public/form-payments/${one.payment.token}/checkout`)).status, 409);
    // Another workspace's webhook endpoint cannot settle this workspace's payment.
    const other = env.client();
    const { ws: otherWs } = await signUp(other, 'Other workspace');
    await other.post(`/api/workspaces/${otherWs.id}/integrations/razorpay`, credentials);
    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkOne.id, reference_id: linkOne.reference_id } } } });
    const crossed = await env.client().post(`/api/payments/razorpay/${otherWs.id}`, raw, { 'X-Razorpay-Signature': createHmac('sha256', credentials.webhook_secret).update(raw).digest('hex') });
    assert.equal(crossed.body.result, 'unknown_payment');
  } finally { await env.close(); }
});

test('existing Meet Razorpay bookings keep their webhook handling alongside form payments', async () => {
  const env = await razorpayFixture();
  try {
    const type = await publishedEventType(env.owner, env.ws, { price_cents: 50000, currency: 'inr', timezone: 'UTC' });
    const booked = (await env.client().post(`/api/public/meet/${env.ws.slug}/${type.slug}/bookings`, { name: 'Invitee', email: 'invitee@example.com', timezone: 'UTC', start: '2026-10-26T09:00:00.000Z' }, { 'Idempotency-Key': 'meet-and-forms-0001' })).body;
    const link = [...env.links.values()].find(item => item.reference_id === booked.booking.id);
    Object.assign(link, { status: 'paid', amount_paid: 50000 });
    const result = await env.signed({ event: 'payment_link.paid', payload: { payment_link: { entity: link } } });
    assert.equal(result.body.result, 'confirmed');
    assert.equal(env.app.db.get('SELECT status FROM bookings WHERE id = ?', booked.booking.id).status, 'confirmed');
  } finally { await env.close(); }
});
