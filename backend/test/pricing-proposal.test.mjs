// Proposed pricing prototype (frontend/js/pricing-proposal.mjs): arithmetic shown to interview
// participants is exact, limits are refused rather than charged, and nothing in billing uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PROPOSAL_LABEL, PROPOSED_PLANS, annualDifference, annualMonthlyEquivalent, annualTotal, estimate, formatINR, nextReset, validUsage } from '../../frontend/js/pricing-proposal.mjs';
import { setup } from './helpers.mjs';

test('proposed amounts match docs/PRICING_PROPOSAL.md and annual figures show the full payment', () => {
  assert.equal(PROPOSAL_LABEL, 'Proposed pricing — not available for purchase');
  assert.deepEqual(PROPOSED_PLANS.map(plan => [plan.key, plan.monthly]), [['meet', 399], ['forms', 499], ['flow', 699], ['suite', 1199]]);
  assert.deepEqual(PROPOSED_PLANS.map(plan => annualTotal(plan.monthly)), [3990, 4990, 6990, 11990]);
  assert.deepEqual(PROPOSED_PLANS.map(plan => annualMonthlyEquivalent(plan.monthly)), [332.5, 415.83, 582.5, 999.17]);
  assert.equal(annualDifference(399), 798);
  assert.equal(formatINR(11990), '₹11,990');
  assert.equal(formatINR(332.5), '₹332.50');
  const singles = PROPOSED_PLANS.filter(plan => plan.key !== 'suite').reduce((sum, plan) => sum + plan.monthly, 0);
  assert.equal(singles - 1199, 398, 'Suite difference is against these proposed plans only');
});

test('allowances reset at 00:00 UTC on the 1st, including across the year boundary', () => {
  assert.equal(new Date(nextReset(Date.UTC(2026, 9, 27, 10))).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(nextReset(Date.UTC(2026, 11, 31, 23, 59))).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('estimates compare only the products needed, and usage beyond an allowance is refused, not billed', () => {
  const formsOnly = estimate({ bookings: 0, responses: 1200, runs: 0 });
  assert.deepEqual(formsOnly.needed, ['responses']);
  assert.deepEqual(formsOnly.options.map(option => [option.label, option.monthly]), [['Forms', 499], ['Suite', 1199]]);
  assert.deepEqual(formsOnly.options[0].lines, [{ meter: 'responses', included: 1000, used: 1200, over: 200 }]);
  assert.equal(formsOnly.options[0].overLimit.length, 1);
  const all = estimate({ bookings: 120, responses: 400, runs: 300 });
  assert.deepEqual(all.options.map(option => [option.label, option.monthly]), [['Meet + Forms + Flow', 1597], ['Suite', 1199]]);
  assert.ok(all.options.every(option => option.overLimit.length === 0));
  assert.deepEqual(estimate({ bookings: 0, responses: 0, runs: 0 }).options, []);
  assert.ok(validUsage('') && validUsage('0') && validUsage('1000000'));
  assert.ok(!validUsage('-1') && !validUsage('1.5') && !validUsage('1000001') && !validUsage('ten'));
});

test('billing, checkout and entitlements never read the proposal, and the prototype page is served', async () => {
  const sources = dir => readdirSync(new URL(dir, import.meta.url), { recursive: true }).filter(file => file.endsWith('.mjs')).map(file => readFileSync(new URL(dir + file.replaceAll('\\', '/'), import.meta.url), 'utf8'));
  for (const source of sources('../src/')) assert.ok(!source.includes('pricing-proposal'), 'no backend module imports the proposal');
  const account = readFileSync(new URL('../../frontend/js/account.mjs', import.meta.url), 'utf8');
  assert.ok(!account.includes('pricing-proposal'), 'the live Plans page does not use proposed prices');
  const env = await setup();
  try {
    assert.equal((await fetch(env.base + '/pricing/proposal')).status, 200);
    assert.equal((await fetch(env.base + '/js/pricing-proposal-page.mjs')).status, 200);
  } finally { await env.close(); }
});
