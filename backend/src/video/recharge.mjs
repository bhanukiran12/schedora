import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { configured as razorpayConfigured, request as razorpayRequest } from '../billing/razorpay.mjs';
import { UNITS_PER_CREDIT } from './config.mjs';
import { grantPurchase, reverseLot, spendableUnits } from './credits.mjs';

// Meet credit recharge through the platform Razorpay account (hosted Payment Links), separate
// from subscriptions (billing_checkouts) and from invitee booking payments. The server owns the
// catalog: the browser sends only a package id. Credits are granted only after the server has
// verified a captured payment with Razorpay (webhook-triggered fetch or explicit refresh), and
// exactly once per order (unique lot source key + order state, in one transaction).

const OPEN = ['creating', 'open', 'uncertain'];

function providerFor(app) {
  if (app.config.billingProvider === 'test' && !app.config.production) return 'test';
  if (app.config.billingProvider === 'razorpay' && razorpayConfigured(app)) return 'razorpay';
  return null;
}

export function rechargeCatalog(app) {
  const video = app.config.video;
  const provider = providerFor(app);
  const live = provider === 'razorpay' && video.rechargeEnabled && app.config.commercialBillingConfirmed && app.config.billingMode === 'enforced';
  return {
    version: video.catalogVersion, provider, units_per_credit: UNITS_PER_CREDIT,
    packages: video.packs.filter(pack => pack.enabled !== false).map(pack => ({
      id: pack.id, name: pack.name, credits: pack.credits, amount_minor: pack.amount_minor, currency: pack.currency, fixture: Boolean(pack.fixture),
      // Fixtures only work with the simulated provider; real packs need approved commercial configuration.
      checkout_available: pack.fixture ? provider === 'test' : (live || provider === 'test')
    }))
  };
}

export function calculate(app, workspaceId, { participants, minutes }) {
  const people = Number(participants);
  const length = Number(minutes);
  if (!Number.isInteger(people) || people < 1 || people > 100) fail(400, 'validation_failed', 'Enter from 1 to 100 participants.', { field: 'participants' });
  if (!Number.isInteger(length) || length < 1 || length > 1440) fail(400, 'validation_failed', 'Enter from 1 to 1440 minutes.', { field: 'minutes' });
  const units = people * length * UNITS_PER_CREDIT;
  const available = spendableUnits(app, workspaceId);
  const shortfall = Math.max(0, units - available);
  const packages = rechargeCatalog(app).packages.filter(pack => pack.checkout_available);
  const suggested = shortfall ? packages.filter(pack => pack.credits * UNITS_PER_CREDIT >= shortfall).sort((a, b) => a.credits - b.credits)[0] || packages.sort((a, b) => b.credits - a.credits)[0] || null : null;
  return {
    participants: people, minutes: length, participant_minutes: people * length,
    credits_required: people * length, available_credits: Math.floor(available / UNITS_PER_CREDIT * 10) / 10,
    shortfall_credits: Math.ceil(shortfall / UNITS_PER_CREDIT), suggested_package: suggested?.id || null,
    // Each connected person must have the next block of credits reserved before joining.
    admission_buffer_credits: Math.ceil(app.config.video.blockSeconds / 60),
    note: 'Estimate only. Credits are charged for actual connected time of each participant, including hosts, measured by the video provider.'
  };
}

function orderView(order) {
  return { id: order.id, package_id: order.package_id, credits: order.credits, amount_minor: order.amount_minor, currency: order.currency, status: order.status,
    checkout_url: order.status === 'open' ? order.checkout_url : null, provider: order.provider, created_at: order.created_at, updated_at: order.updated_at, refunded_minor: order.refunded_minor, uncollectable_credits: Math.ceil(order.uncollectable_units / UNITS_PER_CREDIT) };
}

function checkoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(502, 'billing_provider_error', 'Razorpay did not return a checkout link.'); }
  if (url.protocol !== 'https:' || !['rzp.io', 'rzp.in', 'razorpay.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail(502, 'billing_provider_error', 'Razorpay returned an invalid checkout address.');
  return url.href;
}

export async function createRecharge(app, workspaceId, userId, packageId, requestKey) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey || '')) fail(400, 'idempotency_required', 'A valid Idempotency-Key header is required.');
  const pack = rechargeCatalog(app).packages.find(item => item.id === packageId);
  if (!pack?.checkout_available) fail(409, 'recharge_unavailable', 'Credit purchases are not available yet.');
  const provider = providerFor(app);
  const reserved = app.db.transaction(() => {
    const existing = app.db.get('SELECT * FROM credit_recharge_orders WHERE workspace_id = ? AND request_key = ?', workspaceId, requestKey);
    if (existing) {
      if (existing.package_id !== packageId) fail(409, 'idempotency_conflict', 'This request key was used for another package.');
      return { existing };
    }
    if (app.db.get('SELECT restricted_reason FROM credit_accounts WHERE workspace_id = ?', workspaceId)?.restricted_reason) fail(409, 'recharge_restricted', 'Credit purchases are on hold for this workspace. Contact support.');
    if (app.db.get(`SELECT COUNT(*) AS count FROM credit_recharge_orders WHERE workspace_id = ? AND status IN ('creating', 'open', 'uncertain')`, workspaceId).count >= 3) fail(409, 'recharge_pending', 'Finish or refresh your pending credit purchases first.');
    const order = { id: randomUUID(), workspace_id: workspaceId, request_key: requestKey, package_id: pack.id, catalog_version: app.config.video.catalogVersion, credits: pack.credits, units: pack.credits * UNITS_PER_CREDIT,
      amount_minor: pack.amount_minor, currency: pack.currency, provider, status: 'creating', created_by: userId, created_at: app.now(), updated_at: app.now() };
    app.db.run(`INSERT INTO credit_recharge_orders (${Object.keys(order).join(', ')}) VALUES (${Object.keys(order).map(() => '?').join(', ')})`, ...Object.values(order));
    return { order };
  });
  if (reserved.existing) {
    if (reserved.existing.status === 'open') return orderView(reserved.existing);
    fail(409, 'recharge_pending', 'This purchase is being processed or has finished. Refresh its status.');
  }
  const order = reserved.order;
  if (provider === 'test') {
    app.db.run("UPDATE credit_recharge_orders SET status = 'open', checkout_url = ?, updated_at = ? WHERE id = ?", `/billing?recharge=${order.id}`, app.now(), order.id);
    return orderView(app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', order.id));
  }
  try {
    const link = await razorpayRequest(app, 'payment_links', {
      amount: order.amount_minor, currency: order.currency, accept_partial: false, reference_id: order.id,
      description: `Schedora Meet credits: ${order.credits} credits`, expire_by: Math.floor(app.now() / 1000) + 86400,
      notify: { sms: false, email: false }, reminder_enable: false,
      callback_url: `${app.config.baseUrl}/billing?recharge=${order.id}`, callback_method: 'get',
      notes: { purpose: 'meet_credits', schedora_recharge_id: order.id, schedora_workspace_id: workspaceId }
    });
    if (!/^plink_[A-Za-z0-9]+$/.test(link.id || '') || link.reference_id !== order.id || link.amount !== order.amount_minor || link.currency !== order.currency) fail(502, 'billing_provider_error', 'The payment link does not match this purchase.');
    app.db.run("UPDATE credit_recharge_orders SET provider_link_id = ?, checkout_url = ?, status = CASE WHEN status IN ('creating', 'uncertain') THEN 'open' ELSE status END, updated_at = ? WHERE id = ?", link.id, checkoutUrl(link.short_url), app.now(), order.id);
    return orderView(app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', order.id));
  } catch (error) {
    // Ambiguous: the link may exist. Never retry blindly; refresh recovers it by reference id.
    app.db.run("UPDATE credit_recharge_orders SET status = 'uncertain', updated_at = ? WHERE id = ? AND status = 'creating'", app.now(), order.id);
    throw error;
  }
}

// Applies a payment link state fetched from Razorpay (or synthesized by the test provider).
export function applyLink(app, orderId, link) {
  return app.db.transaction(() => {
    const order = app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', orderId);
    if (!order) return 'unknown_order';
    if (link.reference_id !== order.id || link.amount !== order.amount_minor || link.currency !== order.currency || (link.notes?.schedora_workspace_id && link.notes.schedora_workspace_id !== order.workspace_id)) {
      app.log('error', 'recharge_mismatch', { order: order.id });
      fail(400, 'payment_mismatch', 'Payment does not match this credit purchase.');
    }
    if (order.provider_link_id && link.id && order.provider_link_id !== link.id) fail(400, 'payment_mismatch', 'Payment link does not match this credit purchase.');
    if (link.status === 'paid') {
      const captured = (link.payments || []).find(payment => payment.status === 'captured' && /^pay_[A-Za-z0-9]+$/.test(payment.payment_id || ''));
      if (!captured || !Number.isSafeInteger(link.amount_paid) || link.amount_paid < order.amount_minor) return 'awaiting_capture';
      if (!OPEN.includes(order.status) && !['expired', 'failed'].includes(order.status)) return 'duplicate';
      if (app.db.get('SELECT 1 FROM credit_recharge_orders WHERE provider_payment_id = ? AND id <> ?', captured.payment_id, order.id)) fail(400, 'payment_mismatch', 'Payment is already linked to another purchase.');
      const lotId = grantPurchase(app, { workspaceId: order.workspace_id, orderId: order.id, units: order.units, note: `${order.credits} credits (${order.package_id}, catalog ${order.catalog_version})` });
      app.db.run("UPDATE credit_recharge_orders SET status = 'paid', provider_link_id = COALESCE(provider_link_id, ?), provider_payment_id = ?, lot_id = ?, updated_at = ? WHERE id = ?", link.id ?? null, captured.payment_id, lotId, app.now(), order.id);
      return 'granted';
    }
    if (['expired', 'cancelled'].includes(link.status) && OPEN.includes(order.status)) {
      app.db.run("UPDATE credit_recharge_orders SET status = ?, provider_link_id = COALESCE(provider_link_id, ?), updated_at = ? WHERE id = ?", link.status === 'expired' ? 'expired' : 'failed', link.id ?? null, app.now(), order.id);
      return link.status;
    }
    if (OPEN.includes(order.status) && link.id) app.db.run("UPDATE credit_recharge_orders SET status = 'open', provider_link_id = COALESCE(provider_link_id, ?), updated_at = ? WHERE id = ?", link.id, app.now(), order.id);
    return 'pending';
  });
}

export async function refreshRecharge(app, workspaceId, orderId) {
  const order = app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ? AND workspace_id = ?', orderId, workspaceId);
  if (!order) fail(404, 'not_found', 'Purchase not found.');
  if (order.provider !== 'razorpay') return { result: order.status, order: orderView(order) };
  let link;
  if (order.provider_link_id) link = await razorpayRequest(app, 'payment_links/' + encodeURIComponent(order.provider_link_id));
  else {
    const found = await razorpayRequest(app, 'payment_links?reference_id=' + encodeURIComponent(order.id));
    link = found.payment_links?.find(item => item.reference_id === order.id);
    if (!link) {
      // Nothing was created at Razorpay: the uncertain order can be closed safely.
      if (order.status === 'uncertain' && app.now() - order.created_at > 15 * 60000) app.db.run("UPDATE credit_recharge_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'uncertain'", app.now(), order.id);
      return { result: 'not_found', order: orderView(app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', order.id)) };
    }
  }
  const result = applyLink(app, order.id, link);
  return { result, order: orderView(app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', order.id)) };
}

// Refunds and chargebacks take back unspent purchased credits from that purchase. Credits already
// consumed (or currently reserved) cannot be taken back; that amount is recorded as uncollectable.
export function applyReversal(app, { orderId, eventKey, kind, amountMinor }) {
  return app.db.transaction(() => {
    const seen = app.db.run('INSERT OR IGNORE INTO credit_payment_events (provider, event_key, order_id, type, result, received_at) VALUES (?, ?, ?, ?, ?, ?)', 'razorpay', eventKey, orderId, kind, 'applied', app.now());
    if (!seen.changes) return 'duplicate';
    const order = app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', orderId);
    if (!order?.lot_id) return 'not_paid';
    const refunded = kind === 'chargeback' ? order.amount_minor : Math.min(order.amount_minor, order.refunded_minor + amountMinor);
    const targetUnits = Math.floor(order.units * refunded / order.amount_minor);
    const delta = targetUnits - order.reversed_units - order.uncollectable_units;
    let result = { reversed: 0, uncollectable: 0 };
    if (delta > 0) result = reverseLot(app, { lotId: order.lot_id, units: delta, key: `${kind}:${eventKey}`, type: kind === 'chargeback' ? 'reversal' : 'refund', referenceType: 'recharge_order', referenceId: order.id, note: kind === 'chargeback' ? 'Payment disputed and lost' : 'Purchase refunded' });
    const status = kind === 'chargeback' ? 'charged_back' : refunded >= order.amount_minor ? 'refunded' : 'partially_refunded';
    app.db.run('UPDATE credit_recharge_orders SET status = ?, refunded_minor = ?, reversed_units = reversed_units + ?, uncollectable_units = uncollectable_units + ?, updated_at = ? WHERE id = ?',
      status, kind === 'chargeback' ? order.refunded_minor : refunded, result.reversed, result.uncollectable, app.now(), order.id);
    if (kind === 'chargeback' || result.uncollectable) {
      app.db.run(`INSERT INTO credit_accounts (workspace_id, restricted_reason, updated_at) VALUES (?, ?, ?) ON CONFLICT (workspace_id) DO UPDATE SET restricted_reason = excluded.restricted_reason, updated_at = excluded.updated_at`,
        order.workspace_id, kind === 'chargeback' ? 'chargeback' : 'refund_after_use', app.now());
      app.log('warn', 'recharge_reversal_uncollectable', { order: order.id, kind, uncollectable_units: result.uncollectable });
    }
    return status;
  });
}

// Razorpay platform webhook events for credit purchases. Called after the signature check in
// billing/razorpay.mjs. Returns null for events that are not about Meet credits.
export async function rechargeWebhook(app, event) {
  if (event.event?.startsWith('payment_link.')) {
    const entity = event.payload?.payment_link?.entity;
    if (entity?.notes?.purpose !== 'meet_credits') return null;
    const order = app.db.get('SELECT * FROM credit_recharge_orders WHERE id = ?', entity.notes.schedora_recharge_id || '');
    if (!order || !/^plink_[A-Za-z0-9]+$/.test(entity.id || '')) return 'unknown_order';
    // Never trust the payload: fetch the link server-to-server and validate it.
    return applyLink(app, order.id, await razorpayRequest(app, 'payment_links/' + entity.id));
  }
  if (event.event === 'refund.processed') {
    const refund = event.payload?.refund?.entity;
    const order = refund?.payment_id && app.db.get('SELECT * FROM credit_recharge_orders WHERE provider_payment_id = ?', refund.payment_id);
    if (!order) return null;
    const verified = await razorpayRequest(app, `payments/${encodeURIComponent(refund.payment_id)}/refunds/${encodeURIComponent(refund.id)}`);
    if (verified.id !== refund.id || verified.payment_id !== refund.payment_id || verified.status !== 'processed' || !Number.isSafeInteger(verified.amount) || verified.amount <= 0) fail(400, 'invalid_event', 'Refund could not be verified.');
    return applyReversal(app, { orderId: order.id, eventKey: 'refund:' + verified.id, kind: 'refund', amountMinor: verified.amount });
  }
  if (event.event === 'payment.dispute.lost') {
    const dispute = event.payload?.dispute?.entity;
    const order = dispute?.payment_id && app.db.get('SELECT * FROM credit_recharge_orders WHERE provider_payment_id = ?', dispute.payment_id);
    if (!order) return null;
    return applyReversal(app, { orderId: order.id, eventKey: 'dispute:' + dispute.id, kind: 'chargeback', amountMinor: order.amount_minor });
  }
  return null;
}

// Test provider only (never in production): simulates provider outcomes through the same
// validation and grant path as verified Razorpay data.
export function testRechargeEvent(app, workspaceId, orderId, body) {
  if (providerFor(app) !== 'test') fail(404, 'not_found', 'Not available.');
  const order = app.db.get("SELECT * FROM credit_recharge_orders WHERE id = ? AND workspace_id = ? AND provider = 'test'", orderId, workspaceId);
  if (!order) fail(404, 'not_found', 'Purchase not found.');
  const link = { id: null, reference_id: order.id, amount: Number.isSafeInteger(body.amount_minor) ? body.amount_minor : order.amount_minor, currency: body.currency || order.currency, notes: { schedora_workspace_id: order.workspace_id } };
  switch (body.action) {
    case 'pay': return applyLink(app, order.id, { ...link, status: 'paid', amount_paid: link.amount, payments: [{ payment_id: body.payment_id || 'pay_test' + order.id.replace(/-/g, '').slice(0, 14), status: 'captured' }] });
    case 'expire': return applyLink(app, order.id, { ...link, status: 'expired' });
    case 'refund': return applyReversal(app, { orderId: order.id, eventKey: 'refund:test:' + (body.event_id || randomUUID()), kind: 'refund', amountMinor: Number.isSafeInteger(body.amount_minor) ? body.amount_minor : order.amount_minor });
    case 'chargeback': return applyReversal(app, { orderId: order.id, eventKey: 'dispute:test:' + (body.event_id || randomUUID()), kind: 'chargeback', amountMinor: order.amount_minor });
    default: fail(400, 'validation_failed', 'Unknown test action.');
  }
}

export function listRecharges(app, workspaceId) {
  return app.db.all('SELECT * FROM credit_recharge_orders WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', workspaceId).map(orderView);
}

// Worker: recover purchases whose callback or webhook was missed.
export async function reconcileRecharges(app) {
  if (providerFor(app) !== 'razorpay') return 0;
  const now = app.now();
  const due = app.db.all("SELECT id, workspace_id FROM credit_recharge_orders WHERE provider = 'razorpay' AND status IN ('open', 'uncertain') AND updated_at < ? AND created_at > ? LIMIT 10", now - 10 * 60000, now - 8 * 86400000);
  for (const order of due) {
    try { await refreshRecharge(app, order.workspace_id, order.id); app.db.run('UPDATE credit_recharge_orders SET updated_at = ? WHERE id = ?', app.now(), order.id); }
    catch (error) { app.log('warn', 'recharge_reconcile_failed', { order: order.id, error: error.message }); }
  }
  return due.length;
}
