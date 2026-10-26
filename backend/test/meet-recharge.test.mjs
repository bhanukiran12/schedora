import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signUp } from './helpers.mjs';
import { videoSetup } from './video-helpers.mjs';
import { reconcileWallet, reserve, settleReservation, walletSummary } from '../src/video/credits.mjs';

const secret = 'fake_platform_webhook_secret';
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
// Test fixture packs only; they are not approved commercial prices.
const packs = [{ id: 'small', name: 'Test small', credits: 100, amount_minor: 10000, currency: 'INR' }, { id: 'large', name: 'Test large', credits: 1000, amount_minor: 90000, currency: 'INR' }];

test('test provider: idempotent orders, server-priced, exactly-once grant, mismatch rejected, refunds and chargebacks', async () => {
  const env = await videoSetup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Buyer');
    const wallet = await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet`);
    assert.equal(wallet.status, 200);
    assert.ok(wallet.body.catalog.packages.every(pack => pack.fixture), 'development fixtures are labeled');
    const key = { 'Idempotency-Key': 'recharge-key-0000000001' };
    // The browser cannot choose the price or quantity.
    const order = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'small', credits: 999999, amount_minor: 1 }, key);
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.credits, 500);
    assert.equal(order.body.amount_minor, 50000);
    const replay = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'small' }, key);
    assert.equal(replay.body.id, order.body.id);
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'large' }, key)).body.error.code, 'idempotency_conflict');
    // Members and administrators cannot buy; non-members cannot see.
    const stranger = env.client(); await signUp(stranger, 'Other');
    assert.equal((await stranger.get(`/api/workspaces/${ws.id}/meet-video/wallet`)).status, 404);
    const event = action => owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${order.body.id}/test-event`, action);
    assert.equal((await event({ action: 'pay', amount_minor: 100 })).status, 400, 'amount mismatch rejected');
    assert.equal((await event({ action: 'pay', currency: 'USD' })).status, 400, 'currency mismatch rejected');
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 0);
    // Callback, webhook and polling races: one grant.
    const results = await Promise.all([event({ action: 'pay' }), event({ action: 'pay' }), event({ action: 'pay' })]);
    assert.deepEqual(results.map(result => result.body.result).sort(), ['duplicate', 'duplicate', 'granted']);
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 500);
    // Partial refund after some use: unspent credits are reversed proportionally.
    const used = reserve(env.app, { workspaceId: ws.id, coversFrom: env.clock.now, seconds: 600, key: 'use' });
    settleReservation(env.app, used.id, 600);
    assert.equal((await event({ action: 'refund', amount_minor: 25000, event_id: 'rf1' })).body.result, 'partially_refunded');
    assert.equal((await event({ action: 'refund', amount_minor: 25000, event_id: 'rf1' })).body.result, 'duplicate');
    const lot = env.app.db.get("SELECT * FROM credit_lots WHERE kind = 'purchase' AND workspace_id = ?", ws.id);
    assert.equal(lot.units_revoked, 250 * 60);
    // Chargeback after consumption: the consumed part is uncollectable, recorded, and purchases pause.
    assert.equal((await event({ action: 'chargeback', event_id: 'dp1' })).body.result, 'charged_back');
    const after = env.app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', order.body.id);
    assert.equal(after.reversed_units + after.uncollectable_units, 500 * 60);
    assert.equal(env.app.db.get('SELECT restricted_reason FROM credit_accounts WHERE workspace_id = ?', ws.id).restricted_reason, 'chargeback');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'small' }, { 'Idempotency-Key': 'recharge-key-0000000002' })).body.error.code, 'recharge_restricted');
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
  } finally { await env.close(); }
});

test('Razorpay: production-style catalog stays disabled until approved; verified webhook grants once; uncertain creation recovers', async () => {
  const config = { billingMode: 'enforced', billingProvider: 'razorpay', billingWebhookSecret: secret, commercialBillingConfirmed: false,
    razorpayBilling: { keyId: 'rzp_test_platform123', keySecret: 'fake_platform_secret', checkoutEnabled: true, plans: {} } };
  const env = await videoSetup({ config, video: { packs, rechargeEnabled: true, catalogVersion: 'test-1' } });
  try {
    const links = new Map();
    let lose = false;
    env.app.fetchProvider = async (url, init = {}) => {
      const target = new URL(url);
      if (target.pathname === '/v1/payment_links' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        const link = { ...body, id: 'plink_' + (links.size + 1), status: 'created', amount_paid: 0, short_url: 'https://rzp.io/i/' + links.size, payments: [] };
        links.set(link.id, link);
        if (lose) throw new Error('lost response');
        return json(link);
      }
      if (target.pathname === '/v1/payment_links') return json({ payment_links: [...links.values()].filter(link => link.reference_id === target.searchParams.get('reference_id')) });
      if (target.pathname.startsWith('/v1/payment_links/')) return json(links.get(target.pathname.split('/').at(-1)));
      return new Response('{}', { status: 404 });
    };
    const owner = env.client();
    const { ws } = await signUp(owner, 'RzpBuyer');
    let catalog = (await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet`)).body.catalog;
    assert.ok(catalog.packages.every(pack => !pack.checkout_available), 'disabled until commercial billing is confirmed');
    env.app.config.commercialBillingConfirmed = true;
    catalog = (await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet`)).body.catalog;
    assert.ok(catalog.packages.every(pack => pack.checkout_available));
    const created = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'small' }, { 'Idempotency-Key': 'rzp-key-000000000001' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.checkout_url, /^https:\/\/rzp\.io\//);
    const link = links.get('plink_1');
    assert.equal(link.amount, 10000);
    assert.equal(link.reference_id, created.body.id);
    // A forged browser "success" redirect grants nothing: refresh asks Razorpay.
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${created.body.id}/refresh`)).body.result, 'pending');
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 0);
    // Paid at Razorpay; webhook (signature verified, then fetched server-to-server) and refresh race.
    Object.assign(link, { status: 'paid', amount_paid: 10000, payments: [{ payment_id: 'pay_abc123', status: 'captured' }] });
    const raw = JSON.stringify({ event: 'payment_link.paid', created_at: Math.floor(env.clock.now / 1000), payload: { payment_link: { entity: { id: 'plink_1', notes: { purpose: 'meet_credits', schedora_recharge_id: created.body.id } } } } });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const bad = await env.client().raw('POST', '/api/billing/razorpay/webhook', raw, { 'X-Razorpay-Signature': '0'.repeat(64) });
    assert.equal(bad.status, 400);
    const [hook, refresh, hook2] = await Promise.all([
      env.client().raw('POST', '/api/billing/razorpay/webhook', raw, { 'X-Razorpay-Signature': signature }),
      owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${created.body.id}/refresh`),
      env.client().raw('POST', '/api/billing/razorpay/webhook', raw, { 'X-Razorpay-Signature': signature })
    ]);
    assert.deepEqual([hook.body.result, refresh.body.result, hook2.body.result].sort(), ['duplicate', 'duplicate', 'granted']);
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 100);
    // Amount tampering at the provider is rejected.
    lose = true;
    const uncertain = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'large' }, { 'Idempotency-Key': 'rzp-key-000000000002' });
    assert.ok(uncertain.status >= 500 || uncertain.status === 502);
    assert.equal(env.app.db.get('SELECT status FROM credit_recharge_orders WHERE request_key = ?', 'rzp-key-000000000002').status, 'uncertain');
    lose = false;
    const orderId = env.app.db.get('SELECT id FROM credit_recharge_orders WHERE request_key = ?', 'rzp-key-000000000002').id;
    const recovered = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${orderId}/refresh`);
    assert.equal(recovered.body.order.status, 'open', 'link found by reference id instead of creating a second one');
    assert.equal(links.size, 2);
    Object.assign(links.get('plink_2'), { status: 'paid', amount: 1, amount_paid: 1, payments: [{ payment_id: 'pay_x', status: 'captured' }] });
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${orderId}/refresh`)).status, 400);
    assert.equal(walletSummary(env.app, ws.id).purchased.credits, 100);
  } finally { await env.close(); }
});

test('separation of payments: subscriptions, booking payments and credit recharges never mix', async () => {
  const env = await videoSetup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Separate');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'meet' });
    const order = await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges`, { package_id: 'medium' }, { 'Idempotency-Key': 'separate-key-00000001' });
    await owner.post(`/api/workspaces/${ws.id}/meet-video/recharges/${order.body.id}/test-event`, { action: 'pay' });
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM billing_checkouts').c, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM subscriptions').c, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS c FROM bookings WHERE payment_status <> 'none'").c, 0);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS c FROM credit_lots WHERE kind = 'purchase'").c, 1);
  } finally { await env.close(); }
});
