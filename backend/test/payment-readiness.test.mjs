import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRazorpayConnection } from '../scripts/check-razorpay-connection.mjs';
import { configured, subscriptionCatalog, subscriptionCheckout } from '../src/billing/razorpay.mjs';
import { rechargeCatalog, createRecharge } from '../src/video/recharge.mjs';

test('production refuses subscription and recharge checkout with Razorpay test keys before any provider or database action', async () => {
  const app = { config: { production: true, billingProvider: 'razorpay', billingMode: 'enforced', billingWebhookSecret: 'test-secret', commercialBillingConfirmed: true,
    razorpayBilling: { keyId: 'rzp_test_fixture', keySecret: 'test-secret', checkoutEnabled: true,
      plans: { meet: { id: 'plan_fixture', amount_cents: 10000, currency: 'INR', cycles: 12 } } },
    video: { rechargeEnabled: true, catalogVersion: 'test-only', packs: [{ id: 'testpack', name: 'Test only', enabled: true, credits: 100, amount_minor: 10000, currency: 'INR' }] } },
    db: { transaction() { throw new Error('Unexpected database write'); } }, fetchProvider() { throw new Error('Unexpected provider request'); } };
  assert.equal(configured(app), false);
  assert.ok(subscriptionCatalog(app).every(plan => !plan.checkout_available));
  assert.ok(rechargeCatalog(app).packages.every(pack => !pack.checkout_available));
  await assert.rejects(subscriptionCheckout(app, 'workspace', 'user', 'meet', 'test-request-000001'), error => error.code === 'billing_checkout_disabled');
  await assert.rejects(createRecharge(app, 'workspace', 'user', 'testpack', 'test-request-000002'), error => error.code === 'recharge_unavailable');
  app.config.production = false;
  assert.equal(configured(app), true, 'development keeps simulated Razorpay integration coverage');
  app.config.production = true;
  app.config.razorpayBilling.keyId = 'rzp_live_fixture';
  assert.equal(configured(app), true, 'a live-format key still needs separate authentication evidence');
});

test('read-only merchant check discards account contents and cannot redirect credentials or initiate payments', async () => {
  let requests = 0, discarded = false;
  const result = await checkRazorpayConnection({ BILLING_RAZORPAY_KEY_ID: 'rzp_live_fixture', BILLING_RAZORPAY_KEY_SECRET: 'private-fixture' }, async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.razorpay.com/v1/plans?count=1');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    return { status: 200, body: { async cancel() { discarded = true; } }, json() { throw new Error('Merchant contents must not be parsed'); } };
  });
  assert.equal(requests, 1); assert.equal(discarded, true); assert.equal(result.authenticated, true);
  assert.ok(!JSON.stringify(result).includes('private-fixture'));
});

test('read-only merchant check rejects missing/test credentials and reports denied/network failures without secrets', async () => {
  const never = () => { throw new Error('Must not contact provider'); };
  assert.equal((await checkRazorpayConnection({}, never)).authenticated, false);
  assert.equal((await checkRazorpayConnection({ BILLING_RAZORPAY_KEY_ID: 'rzp_test_fixture', BILLING_RAZORPAY_KEY_SECRET: 'secret' }, never)).authenticated, false);
  const env = { BILLING_RAZORPAY_KEY_ID: 'rzp_live_fixture', BILLING_RAZORPAY_KEY_SECRET: 'private-fixture' };
  const denied = await checkRazorpayConnection(env, async () => new Response('private merchant response', { status: 401 }));
  assert.equal(denied.authenticated, false); assert.equal(denied.http_status, 401);
  const failed = await checkRazorpayConnection(env, async () => { throw new Error(env.BILLING_RAZORPAY_KEY_SECRET); });
  assert.equal(failed.authenticated, false);
  assert.ok(!JSON.stringify([denied, failed]).includes('private'));
});
