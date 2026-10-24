import { fail } from '../http.mjs';
import { PLANS, PRODUCTS, QUOTAS, RENEWAL_TOLERANCE_MS } from './plans.mjs';

export function subscriptionGrantsAccess(subscription, now) {
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    return subscription.current_period_end == null || subscription.current_period_end + RENEWAL_TOLERANCE_MS > now;
  }
  if (subscription.status === 'past_due') return subscription.grace_until != null && subscription.grace_until > now;
  return false;
}

// Server-verified product access for a workspace. In 'open' billing mode (development and
// evaluation) every product is available and labelled as such; 'enforced' mode uses only
// subscriptions written by verified payment webhooks.
export function entitlementsFor(app, workspaceId) {
  const result = {};
  for (const product of PRODUCTS) result[product] = { active: false, source: null };
  if (app.config.billingMode === 'open') {
    for (const product of PRODUCTS) result[product] = { active: true, source: 'evaluation' };
    return result;
  }
  const now = app.now();
  for (const subscription of app.db.all('SELECT * FROM subscriptions WHERE workspace_id = ?', workspaceId)) {
    if (!subscriptionGrantsAccess(subscription, now)) continue;
    for (const product of PLANS[subscription.plan].products) {
      if (!result[product].active || subscription.plan === 'suite') {
        result[product] = { active: true, source: subscription.plan, status: subscription.status, grace_until: subscription.grace_until };
      }
    }
  }
  return result;
}

export function requireEntitlement(app, workspaceId, product) {
  if (!entitlementsFor(app, workspaceId)[product].active) {
    fail(402, 'entitlement_required', `This workspace does not have an active ${product[0].toUpperCase() + product.slice(1)} or Suite plan.`);
  }
}

export const usagePeriod = now => new Date(now).toISOString().slice(0, 7);

export function usageFor(app, workspaceId) {
  const period = usagePeriod(app.now());
  const rows = app.db.all('SELECT metric, count FROM usage_counters WHERE workspace_id = ? AND period = ?', workspaceId, period);
  const counts = Object.fromEntries(rows.map(row => [row.metric, row.count]));
  return Object.fromEntries(Object.entries(QUOTAS).map(([metric, quota]) => [metric, {
    used: counts[metric] || 0,
    limit: app.config.billingMode === 'enforced' ? quota.monthly : null,
    period
  }]));
}

// Call inside the same transaction as the metered write so usage and records stay consistent.
export function consumeQuota(app, workspaceId, metric) {
  const period = usagePeriod(app.now());
  if (app.config.billingMode === 'enforced') {
    const used = app.db.get('SELECT count FROM usage_counters WHERE workspace_id = ? AND period = ? AND metric = ?', workspaceId, period, metric)?.count || 0;
    if (used >= QUOTAS[metric].monthly) fail(429, 'quota_exceeded', 'This workspace has reached its monthly allowance. The owner can review usage on the Plans page.');
  }
  app.db.run(`INSERT INTO usage_counters (workspace_id, period, metric, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (workspace_id, period, metric) DO UPDATE SET count = usage_counters.count + 1`, workspaceId, period, metric);
}
