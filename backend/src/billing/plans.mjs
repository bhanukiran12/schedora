// Product plans with the owner-approved monthly prices (10 November 2026) in paise, and the Meet
// video credits each paid month includes. Razorpay checkout uses its configured plan amount; keep
// that dashboard amount aligned with the approved monthly price before enabling checkout.
// Quotas are proposed fair-use limits for planning and enforcement tests, not approved terms.
export const PRODUCTS = ['meet', 'forms', 'flow'];

export const PLANS = {
  meet: { name: 'Meet', products: ['meet'], monthly_amount_cents: 39900, included_video_credits: 200 },
  forms: { name: 'Forms', products: ['forms'], monthly_amount_cents: 49900, included_video_credits: 0 },
  flow: { name: 'Flow', products: ['flow'], monthly_amount_cents: 69900, included_video_credits: 0 },
  suite: { name: 'Suite', products: ['meet', 'forms', 'flow'], monthly_amount_cents: 119900, included_video_credits: 600 }
};
export const PLAN_CURRENCY = 'INR';
export const ANNUAL_DISCOUNT_PERCENT = 12;

// Approved Meet video credit terms. One credit is five participant-minutes (hosts count); extra
// credits cost ₹2 each (₹0.40 per participant-minute). No trial amount or pack sizes are approved.
export const VIDEO_CREDIT_MINUTES = 5;
export const VIDEO_CREDIT_PRICE_MINOR = 200;

// Monthly metered usage per product entitlement.
export const QUOTAS = {
  bookings: { product: 'meet', monthly: 1000 },
  responses: { product: 'forms', monthly: 5000 },
  flow_runs: { product: 'flow', monthly: 5000 }
};

export const GRACE_DAYS = 7;
// Tolerance after a period ends before access lapses if the renewal webhook is late.
export const RENEWAL_TOLERANCE_MS = 2 * 86400000;
