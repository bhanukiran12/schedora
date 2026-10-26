import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../http.mjs';
import { PLANS } from './plans.mjs';
import { applyBillingEvent } from './webhooks.mjs';
import { rechargeWebhook } from '../video/recharge.mjs';

const cfg = app => app.config.razorpayBilling || {};
const subscriptionLocks = new WeakMap();
function serialized(app, id, operation) {
  let locks = subscriptionLocks.get(app);
  if (!locks) { locks = new Map(); subscriptionLocks.set(app, locks); }
  const previous = locks.get(id) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  locks.set(id, task);
  return task.finally(() => { if (locks.get(id) === task) locks.delete(id); });
}
export const configured = app => app.config.billingProvider === 'razorpay' && /^rzp_(live|test)_[A-Za-z0-9]+$/.test(cfg(app).keyId || '') && Boolean(cfg(app).keySecret && app.config.billingWebhookSecret);
function planConfig(app, id) {
  const plan = cfg(app).plans?.[id];
  return PLANS[id] && plan && /^plan_[A-Za-z0-9]+$/.test(plan.id || '') &&
    Number.isSafeInteger(plan.amount_cents) && plan.amount_cents > 0 && plan.currency === 'INR' &&
    Number.isInteger(plan.cycles) && plan.cycles >= 1 && plan.cycles <= 1200 ? plan : null;
}
export function subscriptionCatalog(app) {
  return Object.entries(PLANS).map(([id, plan]) => {
    const price = planConfig(app, id);
    return { id, ...plan, price: price ? { amount_cents: price.amount_cents, currency: price.currency, interval: 'month', cycles: price.cycles } : null,
      checkout_available: Boolean(configured(app) && cfg(app).checkoutEnabled && app.config.commercialBillingConfirmed && app.config.billingMode === 'enforced' && price) };
  });
}
function checkoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(502, 'billing_provider_error', 'Razorpay did not return a subscription checkout URL.'); }
  if (url.protocol !== 'https:' || !['rzp.io', 'rzp.in', 'razorpay.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail(502, 'billing_provider_error', 'Invalid Razorpay checkout URL.');
  return url.href;
}
export async function request(app, path, body) {
  if (!configured(app)) fail(503, 'billing_not_configured', 'Razorpay subscription billing is not configured.');
  const config = cfg(app);
  const response = await app.fetchProvider('https://api.razorpay.com/v1/' + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Basic ' + Buffer.from(config.keyId + ':' + config.keySecret).toString('base64'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) fail(502, 'billing_provider_error', 'Razorpay could not complete the subscription request. Please try refreshing its status.');
  return result;
}

export async function subscriptionCheckout(app, workspaceId, planId, requestKey) {
  const catalog = subscriptionCatalog(app).find(plan => plan.id === planId);
  if (!catalog?.checkout_available) fail(409, 'billing_checkout_disabled', 'Subscription checkout is not enabled for this plan yet.');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey || '')) fail(400, 'idempotency_required', 'A valid checkout request key is required.');
  const plan = planConfig(app, planId);
  const reserve = app.db.transaction(() => {
    const existing = app.db.get('SELECT * FROM billing_checkouts WHERE workspace_id = ? AND request_key = ?', workspaceId, requestKey);
    if (existing) {
      if (existing.plan !== planId) fail(409, 'idempotency_conflict', 'This checkout key was used for another plan.');
      return { existing };
    }
    const overlapping = id => PLANS[id].products.some(product => PLANS[planId].products.includes(product));
    const active = app.db.all("SELECT plan FROM subscriptions WHERE workspace_id = ? AND status IN ('active','trialing','incomplete','past_due')", workspaceId);
    const pending = app.db.all("SELECT plan FROM billing_checkouts WHERE workspace_id = ? AND status IN ('creating','open','uncertain')", workspaceId);
    if ([...active, ...pending].some(item => overlapping(item.plan))) fail(409, 'subscription_exists', 'An overlapping plan or checkout already exists. Manage it before starting another subscription.');
    const id = randomUUID();
    app.db.run(`INSERT INTO billing_checkouts (id, workspace_id, request_key, plan, provider_plan_id, amount_cents, currency, billing_cycles, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`, id, workspaceId, requestKey, planId, plan.id, plan.amount_cents, plan.currency, plan.cycles, app.now(), app.now());
    return { id };
  });
  if (reserve.existing) {
    if (reserve.existing.checkout_url && reserve.existing.status === 'open') return { url: reserve.existing.checkout_url, checkout_id: reserve.existing.id };
    fail(409, 'checkout_pending', 'This checkout is being processed or has finished. Refresh billing before trying again.');
  }
  const id = reserve.id;
  try {
    const remotePlan = await request(app, 'plans/' + plan.id);
    if (remotePlan.id !== plan.id || remotePlan.period !== 'monthly' || remotePlan.interval !== 1 || remotePlan.item?.amount !== plan.amount_cents || remotePlan.item?.currency !== plan.currency) {
      app.db.run("UPDATE billing_checkouts SET status = 'invalid_plan', updated_at = ? WHERE id = ?", app.now(), id);
      fail(409, 'billing_plan_mismatch', 'The Razorpay plan does not match the approved monthly price.');
    }
    // Reserve before the API call. An ambiguous failure remains blocked instead of creating
    // a second recurring mandate on retry. Signed webhooks can recover using checkout_id.
    const subscription = await request(app, 'subscriptions', {
      plan_id: plan.id, total_count: plan.cycles, quantity: 1, customer_notify: true,
      expire_by: Math.floor(app.now() / 1000) + 86400,
      notes: { schedora_checkout_id: id, schedora_workspace_id: workspaceId }
    });
    if (!/^sub_[A-Za-z0-9]+$/.test(subscription.id || '') || subscription.plan_id !== plan.id) fail(502, 'billing_provider_error', 'Invalid subscription response.');
    const url = checkoutUrl(subscription.short_url);
    app.db.run("UPDATE billing_checkouts SET provider_subscription_id = ?, checkout_url = ?, status = CASE WHEN status IN ('creating','uncertain') THEN 'open' ELSE status END, updated_at = ? WHERE id = ?", subscription.id, url, app.now(), id);
    return { url, checkout_id: id };
  } catch (error) {
    app.db.run("UPDATE billing_checkouts SET status = 'uncertain', updated_at = ? WHERE id = ? AND status = 'creating'", app.now(), id);
    throw error;
  }
}

const TERMINAL = ['cancelled', 'completed', 'expired'];
async function reconcile(app, remote, eventId, created) {
  const checkout = app.db.get('SELECT * FROM billing_checkouts WHERE id = ?', remote.notes?.schedora_checkout_id || '');
  if (!checkout) return 'unknown_checkout';
  if (remote.notes?.schedora_workspace_id !== checkout.workspace_id || remote.plan_id !== checkout.provider_plan_id || remote.quantity !== 1 || remote.total_count !== checkout.billing_cycles || (checkout.provider_subscription_id && checkout.provider_subscription_id !== remote.id)) fail(400, 'subscription_mismatch', 'Subscription does not match the reserved workspace plan.');
  const remotePlan = await request(app, 'plans/' + remote.plan_id);
  if (remotePlan.item?.amount !== checkout.amount_cents || remotePlan.item?.currency !== checkout.currency || remotePlan.period !== 'monthly' || remotePlan.interval !== 1) fail(400, 'subscription_mismatch', 'Subscription price does not match.');
  const periodEnd = Number.isInteger(remote.current_end) ? remote.current_end : null;
  const paid = Number.isInteger(remote.paid_count) && remote.paid_count > 0;
  let status = 'incomplete';
  if (remote.status === 'active' && paid && periodEnd && periodEnd * 1000 > app.now()) status = 'active';
  if (['pending', 'halted'].includes(remote.status)) status = 'past_due';
  const paidThroughEnd = ['cancelled', 'completed'].includes(remote.status) && paid && periodEnd && periodEnd * 1000 > app.now();
  if (TERMINAL.includes(remote.status)) status = paidThroughEnd ? 'active' : 'canceled';
  const existing = app.db.get("SELECT * FROM subscriptions WHERE provider = 'razorpay' AND external_id = ?", remote.id);
  if (existing?.workspace_id && existing.workspace_id !== checkout.workspace_id) fail(400, 'subscription_mismatch', 'Workspace does not match.');
  if (checkout.status === 'closed' && !TERMINAL.includes(remote.status)) return 'stale';
  // Never grant a failure grace period to an account that has not paid even once.
  const eventType = status === 'past_due' && paid ? 'invoice.payment_failed' : 'subscription.updated';
  if (status === 'past_due' && !paid) status = 'incomplete';
  const normalized = { id: eventId, created, type: eventType, data: { subscription: {
    id: remote.id, workspace_id: checkout.workspace_id, plan: checkout.plan, status,
    current_period_end: periodEnd,
    cancel_at_period_end: Boolean(paidThroughEnd || existing?.cancel_at_period_end)
  } } };
  return app.db.transaction(() => {
    const result = applyBillingEvent(app, 'razorpay', normalized);
    if (result === 'applied') app.db.run('UPDATE billing_checkouts SET provider_subscription_id = ?, status = ?, updated_at = ? WHERE id = ?', remote.id, TERMINAL.includes(remote.status) ? 'closed' : remote.status === 'created' ? 'open' : 'complete', app.now(), checkout.id);
    return result;
  });
}

export async function subscriptionWebhook(app, raw, signature) {
  if (!configured(app)) fail(503, 'billing_not_configured', 'Razorpay billing is not configured.');
  const expected = createHmac('sha256', app.config.billingWebhookSecret).update(raw).digest();
  if (!/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(400, 'invalid_signature', 'Invalid Razorpay billing signature.');
  let event;
  try { event = JSON.parse(raw); } catch { fail(400, 'invalid_event', 'Invalid webhook JSON.'); }
  // Meet credit purchases (payment links, refunds, disputes) share this verified endpoint.
  const recharge = await rechargeWebhook(app, event);
  if (recharge !== null) return recharge;
  if (!['subscription.authenticated','subscription.activated','subscription.charged','subscription.pending','subscription.halted','subscription.cancelled','subscription.completed','subscription.expired','subscription.paused','subscription.resumed','subscription.updated'].includes(event.event)) return 'ignored';
  const id = event.payload?.subscription?.entity?.id;
  if (!/^sub_[A-Za-z0-9]+$/.test(id || '') || !Number.isInteger(event.created_at) || event.created_at > Math.floor(app.now() / 1000) + 300) fail(400, 'invalid_event', 'Missing or invalid subscription timestamp.');
  const eventId = createHash('sha256').update(raw).digest('hex');
  if (app.db.get("SELECT 1 FROM billing_events WHERE provider = 'razorpay' AND event_id = ?", eventId)) return 'duplicate';
  return serialized(app, id, async () => {
    const remote = await request(app, 'subscriptions/' + id);
    if (remote.id !== id) fail(400, 'subscription_mismatch', 'Subscription ID does not match.');
    return reconcile(app, remote, eventId, event.created_at);
  });
}

export async function refreshSubscription(app, workspaceId, localId) {
  const row = app.db.get("SELECT * FROM subscriptions WHERE id = ? AND workspace_id = ? AND provider = 'razorpay'", localId, workspaceId);
  if (!row) fail(404, 'not_found', 'Subscription not found.');
  return serialized(app, row.external_id, async () => {
    const remote = await request(app, 'subscriptions/' + row.external_id);
    if (remote.id !== row.external_id) fail(400, 'subscription_mismatch', 'Subscription ID does not match.');
    return reconcile(app, remote, 'refresh_' + randomUUID(), Math.floor(app.now() / 1000));
  });
}

export async function refreshCheckout(app, workspaceId, checkoutId) {
  const row = app.db.get('SELECT * FROM billing_checkouts WHERE id = ? AND workspace_id = ?', checkoutId, workspaceId);
  if (!row) fail(404, 'not_found', 'Checkout not found.');
  if (!row.provider_subscription_id) fail(409, 'checkout_uncertain', 'The provider response is uncertain. Contact support to reconcile this checkout before retrying.');
  return serialized(app, row.provider_subscription_id, async () => {
    const remote = await request(app, 'subscriptions/' + row.provider_subscription_id);
    if (remote.id !== row.provider_subscription_id) fail(400, 'subscription_mismatch', 'Subscription ID does not match.');
    return reconcile(app, remote, 'refresh_' + randomUUID(), Math.floor(app.now() / 1000));
  });
}

export async function cancelSubscription(app, workspaceId, localId) {
  const found = app.db.get("SELECT external_id FROM subscriptions WHERE id = ? AND workspace_id = ? AND provider = 'razorpay'", localId, workspaceId);
  if (!found) fail(404, 'not_found', 'Subscription not found.');
  return serialized(app, found.external_id, async () => {
    const row = app.db.get("SELECT * FROM subscriptions WHERE id = ? AND workspace_id = ? AND provider = 'razorpay'", localId, workspaceId);
    if (!row) fail(404, 'not_found', 'Subscription not found.');
    if (row.status === 'canceled' || row.cancel_at_period_end) return { scheduled: Boolean(row.cancel_at_period_end) };
    const atEnd = Boolean(row.current_period_end && row.current_period_end > app.now());
    const remote = await request(app, 'subscriptions/' + row.external_id + '/cancel', { cancel_at_cycle_end: atEnd });
    if (remote.id !== row.external_id) fail(502, 'billing_provider_error', 'Unexpected cancellation response. Refresh billing before retrying.');
    if (!atEnd) return { scheduled: false, result: await reconcile(app, remote, 'cancel_' + randomUUID(), Math.floor(app.now() / 1000)) };
    app.db.run('UPDATE subscriptions SET cancel_at_period_end = 1, last_event_at = ? WHERE id = ?', Math.floor(app.now() / 1000) * 1000, row.id);
    return { scheduled: true };
  });
}
