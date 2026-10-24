// Sprint 9: verified webhooks, idempotent replay, entitlements, grace, cancellation, quotas and isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, publishedEventType, setup, signUp } from './helpers.mjs';
import { sign } from '../src/billing/webhooks.mjs';

const DAY = 86400000;
async function webhook(env, event, { secret = 'whsec_test', at = env.clock.now } = {}) {
  const raw = JSON.stringify(event);
  return env.client().raw('POST', '/api/billing/webhook', raw, { 'Content-Type': 'application/json', 'Schedora-Signature': sign(secret, raw, Math.floor(at / 1000)) });
}
const event = (env, type, subscription, id = 'evt_' + Math.random().toString(36).slice(2)) => ({ id, type, created: Math.floor(env.clock.now / 1000), data: { subscription } });
const entitlements = async (http, ws) => (await http.get(`/api/workspaces/${ws.id}`)).body.entitlements;

test('webhook signatures, replay and out-of-order events', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Payer');
    const created = event(env, 'subscription.updated', { id: 'sub_1', workspace_id: ws.id, plan: 'meet', status: 'active', current_period_end: Math.floor((env.clock.now + 30 * DAY) / 1000) });
    assert.equal((await webhook(env, created, { secret: 'wrong' })).body.error.code, 'invalid_signature');
    assert.equal((await webhook(env, created, { at: env.clock.now - 10 * 60000 })).body.error.code, 'invalid_signature', 'stale timestamp');
    assert.equal((await webhook(env, created)).body.result, 'applied');
    assert.equal((await webhook(env, created)).body.result, 'duplicate', 'replay is a no-op');
    assert.deepEqual(Object.fromEntries(Object.entries(await entitlements(http, ws)).map(([key, value]) => [key, value.active])), { meet: true, forms: false, flow: false });

    const older = event(env, 'subscription.deleted', { id: 'sub_1' });
    older.created -= 3600;
    assert.equal((await webhook(env, older)).body.result, 'stale');
    assert.equal((await entitlements(http, ws)).meet.active, true);

    const other = env.client();
    const { ws: otherWs } = await signUp(other, 'Other');
    const hijack = event(env, 'subscription.updated', { id: 'sub_1', workspace_id: otherWs.id, plan: 'suite', status: 'active' });
    assert.equal((await webhook(env, hijack)).body.result, 'rejected_workspace_mismatch');
    assert.equal((await entitlements(other, otherWs)).meet.active, false, 'no cross-workspace effect');
    assert.equal((await webhook(env, event(env, 'subscription.updated', { id: 'sub_x', workspace_id: 'nope', plan: 'suite', status: 'active' }))).body.result, 'rejected_unknown_workspace');
  } finally { await env.close(); }
});

test('purchase, renewal, failed payment with grace, cancellation and downgrade', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const testEvent = body => owner.post(`/api/workspaces/${ws.id}/billing/test-events`, body);
    // Without a plan, nothing can be published or booked.
    const type = await publishedEventType(owner, ws);
    const slots = (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body;
    assert.equal(slots.accepting, false);
    assert.deepEqual(slots.slots, []);

    assert.equal((await testEvent({ action: 'checkout', plan: 'suite' })).body.result, 'applied');
    let billing = (await owner.get(`/api/workspaces/${ws.id}/billing`)).body;
    const subscription = billing.subscriptions[0];
    assert.equal(subscription.status, 'active');
    assert.ok(Object.values(billing.entitlements).every(value => value.active && value.source === 'suite'));
    assert.ok(billing.plans.every(plan => plan.price === null), 'no invented prices');

    await testEvent({ action: 'payment_failed', subscription: subscription.id });
    billing = (await owner.get(`/api/workspaces/${ws.id}/billing`)).body;
    assert.equal(billing.subscriptions[0].status, 'past_due');
    assert.equal(billing.entitlements.meet.active, true, 'access continues during grace');
    env.clock.now += 8 * DAY;
    assert.equal((await entitlements(owner, ws)).meet.active, false, 'access lapses after grace');
    await testEvent({ action: 'renew', subscription: subscription.id });
    assert.equal((await entitlements(owner, ws)).meet.active, true, 'payment restores access');

    await testEvent({ action: 'cancel', subscription: subscription.id });
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/billing`)).body.subscriptions[0].cancel_at_period_end, 1);
    assert.equal((await entitlements(owner, ws)).forms.active, true, 'kept until period end');
    await testEvent({ action: 'checkout', plan: 'meet' });
    await testEvent({ action: 'end', subscription: subscription.id });
    const after = await entitlements(owner, ws);
    assert.deepEqual([after.meet.active, after.forms.active, after.flow.active], [true, false, false], 'downgraded to Meet only');
    // Data is kept on downgrade; only new Forms activity is blocked.
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`)).status, 402);

    const member = env.client();
    const m = await signUp(member, 'Member');
    await owner.post(`/api/workspaces/${ws.id}/members`, { email: m.email, role: 'admin' });
    assert.equal((await member.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'suite' })).status, 403, 'only owners manage billing');
  } finally { await env.close(); }
});

test('monthly quotas are metered and enforced', async () => {
  const env = await setup({ config: { billingMode: 'enforced' } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'meet' });
    const type = await publishedEventType(owner, ws);
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const { slots } = (await env.client().get(base + '/slots')).body;
    assert.equal((await env.client().post(base + '/bookings', { name: 'A', email: 'a@example.com', timezone: 'UTC', start: slots[0] }, idem())).status, 201);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/billing`)).body.usage.bookings.used, 1);
    env.app.db.run("UPDATE usage_counters SET count = 1000 WHERE metric = 'bookings'");
    const blocked = await env.client().post(base + '/bookings', { name: 'B', email: 'b@example.com', timezone: 'UTC', start: slots[1] }, idem());
    assert.equal(blocked.body.error.code, 'quota_exceeded');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM bookings').count, 1, 'no booking without allowance');
  } finally { await env.close(); }
});
