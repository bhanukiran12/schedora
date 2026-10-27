// PROPOSED PRICING — NOT AVAILABLE FOR PURCHASE. Research stimuli from docs/PRICING_PROPOSAL.md
// for customer interviews. Nothing here is read by billing, checkout or entitlements, and these
// amounts are not approved offers. Plain data and arithmetic only, so it is unit-tested.

export const PROPOSAL_LABEL = 'Proposed pricing — not available for purchase';

export const PROPOSED_PLANS = [
  { key: 'meet', name: 'Meet', monthly: 399, fit: 'For consultants and coaches who share availability and take bookings.',
    people: 'One host and two collaborators who are not hosts.', included: { bookings: 300 } },
  { key: 'forms', name: 'Forms', monthly: 499, fit: 'For teams that collect enquiries, briefs, registrations or feedback.',
    people: 'Three editors. People who answer your forms are never charged as seats.', included: { responses: 1000 } },
  { key: 'flow', name: 'Flow', monthly: 699, fit: 'For simple follow-up after bookings and form responses.',
    people: 'Three editors.', included: { runs: 1000 } },
  { key: 'suite', name: 'Suite', monthly: 1199, fit: 'For teams using all three products in one workspace.',
    people: 'Three people who can host or edit across all three products: one shared group, not three.', included: { bookings: 300, responses: 1000, runs: 1000 } }
];

// How each meter behaves. "atLimit" describes what the current engine does when an allowance is
// used up; the proposed volumes above are not today's limits.
export const METERS = {
  bookings: {
    unit: 'bookings', product: 'meet',
    counts: 'Each new booking, including one held while payment is pending.',
    excluded: 'Rescheduling, cancelling and a repeated submission of the same booking.',
    atLimit: 'New bookings are refused until the reset. Existing appointments, rescheduling and cancellation keep working.'
  },
  responses: {
    unit: 'accepted responses', product: 'forms',
    counts: 'Each response the server accepts.',
    excluded: 'Previews, answers that fail validation, and a retried submission of the same response. Deleting a response does not return its unit.',
    atLimit: 'The form says it has reached its limit and refuses new responses, without showing a receipt. Responses already accepted are kept.'
  },
  runs: {
    unit: 'flow runs', product: 'flow',
    counts: 'Each time an enabled flow starts for a booking or a response.',
    excluded: 'Simulations, and automatic retries of the same run.',
    atLimit: 'New runs are recorded as failed with the allowance message and are not run automatically after the reset. Bookings and responses themselves are unaffected.'
  }
};

// Annual is a later interview concept: ten monthly payments, paid once a year.
export const annualTotal = monthly => monthly * 10;
export const annualMonthlyEquivalent = monthly => Math.round(annualTotal(monthly) / 12 * 100) / 100;
export const annualDifference = monthly => monthly * 12 - annualTotal(monthly);

export function formatINR(amount) {
  const fractional = Math.round(amount * 100) % 100 !== 0;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: fractional ? 2 : 0, maximumFractionDigits: 2 }).format(amount);
}

// Usage resets with the current meters: 00:00 UTC on the first day of each calendar month.
export function nextReset(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/**
 * Estimates one month on the proposed plans. Bills never grow with usage in this proposal:
 * no overage is charged, so usage beyond an allowance is refused, not billed.
 * @param usage { bookings, responses, runs } non-negative integers
 */
export function estimate(usage) {
  const needed = Object.keys(METERS).filter(meter => usage[meter] > 0);
  const lines = plan => Object.entries(plan.included).map(([meter, included]) => ({ meter, included, used: usage[meter] || 0, over: Math.max(0, (usage[meter] || 0) - included) }));
  const singles = PROPOSED_PLANS.filter(plan => plan.key !== 'suite' && needed.some(meter => METERS[meter].product === plan.key));
  const suite = PROPOSED_PLANS.find(plan => plan.key === 'suite');
  const options = [];
  if (singles.length) options.push({ key: 'individual', label: singles.map(plan => plan.name).join(' + '), plans: singles.map(plan => plan.key), monthly: singles.reduce((sum, plan) => sum + plan.monthly, 0), lines: singles.flatMap(lines) });
  if (needed.length) options.push({ key: 'suite', label: 'Suite', plans: ['suite'], monthly: suite.monthly, lines: lines(suite).filter(line => needed.includes(line.meter)) });
  for (const option of options) option.overLimit = option.lines.filter(line => line.over > 0);
  return { needed, options };
}

export function validUsage(value) {
  return value === '' || (/^\d{1,7}$/.test(String(value)) && Number(value) <= 1000000);
}
