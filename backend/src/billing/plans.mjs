// Product plans. Prices are intentionally absent: they require the owner's approval using the
// pricing worksheet (docs/PRICING_WORKSHEET.md). Quotas are proposed fair-use limits for
// planning and enforcement tests, not approved commercial terms.
export const PRODUCTS = ['meet', 'forms', 'flow'];

export const PLANS = {
  meet: { name: 'Meet', products: ['meet'] },
  forms: { name: 'Forms', products: ['forms'] },
  flow: { name: 'Flow', products: ['flow'] },
  suite: { name: 'Suite', products: ['meet', 'forms', 'flow'] }
};

// Monthly metered usage per product entitlement.
export const QUOTAS = {
  bookings: { product: 'meet', monthly: 1000 },
  responses: { product: 'forms', monthly: 5000 },
  flow_runs: { product: 'flow', monthly: 5000 }
};

export const GRACE_DAYS = 7;
// Tolerance after a period ends before access lapses if the renewal webhook is late.
export const RENEWAL_TOLERANCE_MS = 2 * 86400000;
