// Interview prototype of proposed plans. It never calls billing or checkout and offers nothing to
// buy; the live, purchasable state stays on /billing. Not linked from marketing navigation.
import { $, browserZone, fmtFull, html, mount, showErrors, zoneLabel } from './core.mjs';
import { setTitle } from './pages.mjs';
import { METERS, PROPOSAL_LABEL, PROPOSED_PLANS, annualDifference, annualMonthlyEquivalent, annualTotal, estimate, formatINR, nextReset, validUsage } from './pricing-proposal.mjs';

const priceBlock = (plan, billing) => billing === 'annual'
  ? html`<p class="proposal-price"><strong>${formatINR(annualTotal(plan.monthly))}</strong> paid once a year</p>
    <p class="proposal-price-detail">Works out to ${formatINR(annualMonthlyEquivalent(plan.monthly))} a month · ${formatINR(annualDifference(plan.monthly))} less than 12 monthly payments</p>`
  : html`<p class="proposal-price"><strong>${formatINR(plan.monthly)}</strong> per workspace, per month</p>`;

const allowance = (meter, included) => html`<li>${included.toLocaleString('en-IN')} ${METERS[meter].unit}</li>`;

export function pricingProposal(ctx) {
  setTitle('Proposed pricing (not available for purchase) · Schedora');
  // Interview material: keep it out of search results.
  const meta = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex' });
  meta.dataset.pageMeta = '1';
  document.head.append(meta);
  let billing = 'monthly';
  const reset = nextReset();
  const zone = browserZone();

  mount(ctx.main, html`<div class="container page pricing-proposal">
    <div class="proposal-banner" role="note" aria-labelledby="proposal-label"><p class="proposal-label" id="proposal-label">${PROPOSAL_LABEL}</p>
      <p>These figures are research prompts for customer interviews. They have not been approved, are not an offer and cannot be bought. Prices exclude any applicable taxes, whose treatment is not yet decided. What you can use or buy today is on <a href="/billing">Plans</a>.</p></div>
    <h1>Proposed plans</h1>
    <p class="lead">Each product works on its own. Suite is optional: buy only what your work needs.</p>
    <fieldset class="billing-choice"><legend>Show proposed prices</legend>
      <label class="check"><input type="radio" name="billing" value="monthly" checked> Monthly</label>
      <label class="check"><input type="radio" name="billing" value="annual"> Annual (later concept)</label></fieldset>
    <p class="hint" id="billing-hint">Interviews start with monthly prices. Annual is a later concept: ten monthly payments, paid once a year.</p>
    <div class="proposal-plans" id="proposal-plans"></div>

    <section class="proposal-section" aria-labelledby="usage-heading"><h2 id="usage-heading">How usage works</h2>
      <p>Each product has its own allowance. Allowances reset at 00:00 UTC on the 1st of each month, including on annual billing. Next reset: <strong>${fmtFull(reset)}</strong> <span class="muted">(${zoneLabel(zone, reset)})</span>.</p>
      <p class="hint">The volumes above are proposals for cost testing. They are not the current limits; today's limits are on Plans.</p>
      <div class="table-wrap stack-on-mobile"><table><thead><tr><th scope="col">Meter</th><th scope="col">Counts</th><th scope="col">Does not count</th><th scope="col">When the allowance is used up</th></tr></thead>
        <tbody>${Object.entries(METERS).map(([key, meter]) => html`<tr><td data-label="Meter"><strong>${meter.unit[0].toUpperCase() + meter.unit.slice(1)}</strong></td><td data-label="Counts">${meter.counts}</td><td data-label="Does not count">${meter.excluded}</td><td data-label="At the limit">${meter.atLimit}</td></tr>`)}</tbody></table></div>
      <h3>Proposed safeguards <span class="proposal-tag">Proposed, not built</span></h3>
      <ul><li>Usage warnings at 50%, 75%, 90% and 100% of each allowance.</li>
        <li>No automatic overage charges or top-ups. An owner could opt in later only with a visible rate and a hard spending limit.</li>
        <li>Exports, invoices and cancellation stay easy to find.</li></ul></section>

    <section class="proposal-section" aria-labelledby="estimate-heading"><h2 id="estimate-heading">Estimate a month</h2>
      <p>Enter what a typical month looks like. The estimate shows which proposed plans cover it and what would happen beyond an allowance.</p>
      <form id="estimate-form" class="estimate-form" novalidate>
        <div class="inline-fields">
          <div><label for="est-bookings">Bookings per month</label><input id="est-bookings" name="bookings" inputmode="numeric" autocomplete="off" placeholder="0"></div>
          <div><label for="est-responses">Form responses per month</label><input id="est-responses" name="responses" inputmode="numeric" autocomplete="off" placeholder="0"></div>
          <div><label for="est-runs">Flow runs per month</label><input id="est-runs" name="runs" inputmode="numeric" autocomplete="off" placeholder="0"></div>
        </div>
        <div data-form-status tabindex="-1"></div>
        <div class="actions"><button class="btn btn-primary" type="submit">Estimate</button></div>
      </form>
      <div id="estimate-result" role="status" aria-live="polite"></div></section>

    <section class="proposal-section" aria-labelledby="separate-heading"><h2 id="separate-heading">Not included in these plans</h2>
      <ul class="proposal-separate">
        <li><strong>Built-in video meetings.</strong> Not included and no rate is proposed. Built-in video is not available for sale.</li>
        <li><strong>SMS and WhatsApp messages.</strong> Priced separately if offered, based on measured provider costs.</li>
        <li><strong>AI features.</strong> Priced separately if offered; nothing unlimited.</li>
        <li><strong>Payment-provider fees</strong> for paid appointments, charged by the provider.</li></ul>
      <p class="hint">The proposed Suite is ${formatINR(PROPOSED_PLANS.filter(plan => plan.key !== 'suite').reduce((sum, plan) => sum + plan.monthly, 0) - PROPOSED_PLANS.find(plan => plan.key === 'suite').monthly)} a month less than buying Meet, Forms and Flow at these proposed prices. That is not a saving against other companies' products, and it is only worth it if you use all three.</p></section>
  </div>`);

  const drawPlans = () => mount($('#proposal-plans'), html`${PROPOSED_PLANS.map(plan => html`<article class="proposal-plan ${plan.key}" aria-labelledby="plan-${plan.key}">
    <h2 id="plan-${plan.key}">${plan.name}</h2><p class="muted">${plan.fit}</p>
    ${priceBlock(plan, billing)}
    <p class="proposal-tag">Proposed · not available</p>
    <h3>Who can use it</h3><p>${plan.people}</p>
    <h3>Included each month</h3><ul>${Object.entries(plan.included).map(([meter, included]) => allowance(meter, included))}</ul></article>`)}`);
  drawPlans();
  $('.billing-choice').addEventListener('change', event => {
    billing = event.target.value;
    drawPlans();
    if ($('#estimate-result').innerHTML) $('#estimate-form').requestSubmit();
  });

  const form = $('#estimate-form');
  form.addEventListener('submit', event => {
    event.preventDefault();
    const raw_ = Object.fromEntries(new FormData(form));
    const errors = {};
    for (const [key, value] of Object.entries(raw_)) if (!validUsage(value.trim())) errors[key] = 'Enter a whole number from 0 to 1,000,000.';
    form.querySelectorAll('.field-error').forEach(element => element.remove());
    form.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'));
    $('[data-form-status]', form).innerHTML = '';
    if (Object.keys(errors).length) { mount($('#estimate-result'), ''); return showErrors(form, { message: 'Check the highlighted numbers.', details: { errors } }); }
    const usage = Object.fromEntries(Object.entries(raw_).map(([key, value]) => [key, Number(value.trim() || 0)]));
    const result = estimate(usage);
    if (!result.needed.length) return mount($('#estimate-result'), html`<p class="muted">Enter at least one number above 0.</p>`);
    const cost = monthly => billing === 'annual' ? html`<strong>${formatINR(annualTotal(monthly))}</strong> a year (works out to ${formatINR(annualMonthlyEquivalent(monthly))} a month)` : html`<strong>${formatINR(monthly)}</strong> a month`;
    const [first, second] = result.options;
    const cheaper = second && first.monthly !== second.monthly ? (first.monthly < second.monthly ? first : second) : null;
    mount($('#estimate-result'), html`<div class="estimate-options">${result.options.map(option => html`<article class="estimate-option"><h3>${option.label}</h3><p>${cost(option.monthly)}, before taxes</p>
        <ul>${option.lines.map(line => html`<li>${METERS[line.meter].unit[0].toUpperCase() + METERS[line.meter].unit.slice(1)}: ${line.used.toLocaleString('en-IN')} of ${line.included.toLocaleString('en-IN')} included${line.over ? html` · <strong class="estimate-over">${line.over.toLocaleString('en-IN')} would be refused</strong>` : ''}</li>`)}</ul></article>`)}</div>
      ${cheaper ? html`<p>${cheaper.label} costs ${billing === 'annual' ? `${formatINR(Math.abs(annualTotal(first.monthly) - annualTotal(second.monthly)))} a year` : `${formatINR(Math.abs(first.monthly - second.monthly))} a month`} less for this mix${cheaper.key === 'suite' ? '' : ', so Suite is not needed'}.</p>` : ''}
      <p class="notice notice-info">The bill stays at the plan price. Usage beyond an allowance is refused, not charged; no extra capacity is proposed for sale yet.${result.options.some(option => option.overLimit.length) ? ' This month would exceed an allowance on at least one option.' : ''}</p>`);
  });
}
