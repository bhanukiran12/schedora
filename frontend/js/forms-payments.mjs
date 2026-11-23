import { $, api, fmtDateTime, html, loading, mount, notice, raw, toast } from './core.mjs';
import { setTitle } from './pages.mjs';
import { e164Phone, PAYMENT_LIMITS, paymentAmountText, WHATSAPP_RECEIPT_CONSENT } from '../shared/forms-logic.mjs';

// Forms payments and WhatsApp receipts in the browser (docs/FORMS.md, "Payments", "WhatsApp receipts").
// Nothing here decides that a payment happened: every state shown comes from the server, which reads it
// from the payment provider. A return from checkout only asks the server to check.

const STATE = {
  pending: ['warn', 'Awaiting payment'], failed: ['bad', 'Payment failed'], paid: ['good', 'Paid'], expired: ['neutral', 'Payment window ended'],
  refunded: ['neutral', 'Refunded'], partially_refunded: ['neutral', 'Partly refunded'], review: ['bad', 'Needs payment review']
};
const RECEIPT = {
  waiting_for_payment: 'Waits for payment', not_sent: 'Not sent', queued: 'Queued', accepted: 'Accepted by WhatsApp provider', delivered: 'Delivered', read: 'Delivered and read',
  failed: 'Failed', canceled: 'Canceled (number withdrew)', invalid_number: 'Not sent: number not in international format', opted_out: 'Not sent: number withdrew',
  duplicate: 'Not sent: same number just received one', unavailable: 'Not sent: WhatsApp not connected', withdrawn: 'Withdrawn by respondent'
};
const tone = { good: 'ok', warn: 'warn', bad: 'bad', neutral: 'neutral' };
const pill = (kind, label) => html`<span class="badge badge-${tone[kind] || 'neutral'}">${label}</span>`;
const storeKey = slug => 'schedora.form-payment.' + slug;
const remember = (slug, token) => { try { localStorage.setItem(storeKey(slug), token); } catch { /* the link on screen still works */ } };
const forget = slug => { try { localStorage.removeItem(storeKey(slug)); } catch { /* nothing kept */ } };

// ---- Builder ------------------------------------------------------------------------------------

/** Settings card. Payment and receipt choices are part of the draft and only go live when published. */
export function paymentSettingsCard(draft, readiness) {
  const payment = draft.payment;
  const provider = readiness?.payments?.provider;
  const phones = draft.fields.filter(field => field.type === 'phone');
  const receipt = draft.receipts?.whatsapp;
  const providerNote = !readiness ? html`<p class="hint">Checking the payment connection…</p>`
    : provider === 'razorpay' ? html`<p class="hint">Payments go to this workspace's Razorpay account (${readiness.payments.mode === 'live' ? 'live keys' : 'test keys'}).</p>`
    : provider === 'test' ? notice('info', html`<p><strong>Simulated checkout.</strong> Razorpay is not connected, so respondents on this non-production server get a test checkout and no money moves. Connect Razorpay in <a href="/meet?tab=settings">Meet settings</a> before taking real payments.</p>`)
    : notice('warn', html`<p>${readiness.payments.message || 'Online payment is not set up for this workspace.'} A paid form cannot be published until it is.</p>`);
  return html`<div class="card card-plain payment-controls"><h2 id="payment-settings-heading" tabindex="-1">Payment</h2>
    <p class="hint">Charge a fixed amount after someone submits. Their answers are saved straight away; the response is complete, and follow-ups such as Flow, webhooks, next steps and receipts run, only after Schedora confirms the payment with Razorpay. Published versions keep their payment settings unchanged.</p>
    <label class="check"><input type="checkbox" data-payment-setting="enabled" ${payment ? raw('checked') : ''} ${draft.responses?.allow_edit ? raw('disabled aria-describedby="payment-edit-note"') : ''}> Collect a payment with each response</label>
    ${draft.responses?.allow_edit ? html`<p class="hint" id="payment-edit-note">Turn off “Allow respondents to edit their answers” to take payments: a paid response cannot change afterwards.</p>` : ''}
    ${payment ? html`<div class="form-details"><div>
      <label for="pay-amount">Amount in rupees (₹)</label><input id="pay-amount" type="number" inputmode="decimal" min="${PAYMENT_LIMITS.min / 100}" max="${PAYMENT_LIMITS.max / 100}" step="0.01" data-payment-setting="amount" value="${(payment.amount_cents / 100).toFixed(2)}" aria-describedby="pay-amount-hint">
      <p class="hint" id="pay-amount-hint">Respondents see ${paymentAmountText(payment.amount_cents)} before they submit. Razorpay may add a convenience fee if your account is set up for it.</p>
      <label for="pay-description">What it is for <span class="muted">(shown at checkout)</span></label><input id="pay-description" maxlength="${PAYMENT_LIMITS.description}" data-payment-setting="description" value="${payment.description || ''}" placeholder="${draft.title || 'Form payment'}">
      </div><div>
      <label for="pay-window">Time to pay after submitting</label><select id="pay-window" data-payment-setting="window_hours">${[1, 2, 6, 12, 24, 48, 72].map(hours => html`<option value="${hours}" ${(payment.window_hours ?? PAYMENT_LIMITS.windowHours.default) === hours ? raw('selected') : ''}>${hours === 1 ? '1 hour' : `${hours} hours`}</option>`)}</select>
      <p class="hint">Unpaid responses stay in Responses as “Payment window ended” and stop counting toward a response limit. A payment confirmed late still completes the response.</p>
      ${providerNote}</div></div>` : providerNote}
  </div>
  <div class="card card-plain receipt-controls"><h2 id="receipt-settings-heading" tabindex="-1">WhatsApp receipt</h2>
    ${!readiness ? html`<p class="hint">Checking the WhatsApp connection…</p>` : !readiness.whatsapp_receipts?.available
      ? html`${notice('info', html`<p><strong>Not connected on this server.</strong> WhatsApp receipts need a Twilio WhatsApp sender and an approved receipt template. Until then, this option stays off.</p>`)}${receipt ? html`<label class="check"><input type="checkbox" data-receipt-setting="enabled" checked> Send a WhatsApp receipt (turn off to publish)</label>` : ''}`
      : html`<p class="hint">Respondents who tick an unchecked opt-in get one receipt with their receipt code and a private link to stop messages. Paid forms send it after payment is confirmed.</p>
        ${phones.length ? html`<label class="check"><input type="checkbox" data-receipt-setting="enabled" ${receipt ? raw('checked') : ''}> Offer a WhatsApp receipt</label>
          ${receipt ? html`<label for="receipt-phone">Send to the number from</label><select id="receipt-phone" data-receipt-setting="phone_field">${phones.map(field => html`<option value="${field.id}" ${receipt.phone_field === field.id ? raw('selected') : ''}>${field.label}</option>`)}</select>
          <p class="hint">Respondents see: “${WHATSAPP_RECEIPT_CONSENT}”</p>` : ''}`
          : html`<p class="hint">Add a phone question to offer WhatsApp receipts.</p>`}`}
  </div>`;
}

/** Applies a payment or receipt control to the draft. Returns true when the draft changed. */
export function applyPaymentSetting(draft, target) {
  const paymentKey = target.dataset.paymentSetting;
  const receiptKey = target.dataset.receiptSetting;
  if (paymentKey === 'enabled') {
    if (target.checked) draft.payment = { amount_cents: 10000, currency: 'INR' }; else delete draft.payment;
    return true;
  }
  if (paymentKey && draft.payment) {
    const payment = { ...draft.payment };
    const value = target.value.trim();
    if (paymentKey === 'amount') {
      const cents = Math.round(Number(value) * 100);
      if (!Number.isFinite(cents)) return false;
      payment.amount_cents = Math.min(PAYMENT_LIMITS.max, Math.max(PAYMENT_LIMITS.min, cents));
    } else if (paymentKey === 'description') { if (value) payment.description = value.slice(0, PAYMENT_LIMITS.description); else delete payment.description; }
    else if (paymentKey === 'window_hours') payment.window_hours = Number(value);
    draft.payment = payment;
    return true;
  }
  if (receiptKey === 'enabled') {
    const phone = draft.fields.find(field => field.type === 'phone');
    if (target.checked && phone) draft.receipts = { whatsapp: { phone_field: phone.id } }; else delete draft.receipts;
    return true;
  }
  if (receiptKey === 'phone_field' && draft.receipts?.whatsapp) { draft.receipts = { whatsapp: { phone_field: target.value } }; return true; }
  return false;
}

// ---- Respondent: before submitting --------------------------------------------------------------

/** Shown on the last page, above Submit: the amount to pay and the WhatsApp opt-in (unchecked). */
export function closingNotes(definition, { preview = false, consent = false, answers = {} } = {}) {
  const payment = definition.payment;
  const receipt = definition.receipts?.whatsapp;
  const number = receipt ? answers[receipt.phone_field] : null;
  return html`${payment ? html`<div class="form-payment-note" data-payment-note><p><strong>Payment: ${paymentAmountText(payment.amount_cents)}</strong>${payment.description ? html` · ${payment.description}` : ''}</p>
      <p class="hint">After you submit, you pay on a secure checkout. Your answers are saved first; your response is complete once the payment is confirmed${payment.window_hours ? `, within ${payment.window_hours} hour${payment.window_hours === 1 ? '' : 's'}` : ''}.${preview ? ' Preview does not charge anything.' : ''}</p></div>` : ''}
    ${receipt ? html`<div class="form-receipt-optin"><label class="check"><input type="checkbox" data-whatsapp-receipt ${consent ? raw('checked') : ''}> ${WHATSAPP_RECEIPT_CONSENT}</label>
      ${consent && number && !e164Phone(String(number)) ? html`<p class="hint" role="status">Add your country code (for example +91) to the phone number to get a WhatsApp receipt.</p>` : html`<p class="hint">Optional. Message and data rates may apply.</p>`}</div>` : ''}`;
}

// ---- Respondent: after submitting ---------------------------------------------------------------

/** The receipt section for a paid response; the Pay button asks the server for a checkout. */
export function paymentReceipt(result) {
  const payment = result.payment;
  if (!payment) return '';
  const [kind, label] = STATE[payment.status] || STATE.pending;
  const link = `/f/${encodeURIComponent(result.slug)}?payment=${encodeURIComponent(payment.token)}`;
  return html`<section class="form-payment-receipt" aria-labelledby="payment-heading"><h2 id="payment-heading">Payment ${pill(kind, label)}</h2>
    <dl class="confirm-facts"><dt>Amount</dt><dd>${payment.amount_text}</dd>${payment.description ? html`<dt>For</dt><dd>${payment.description}</dd>` : ''}<dt>Pay by</dt><dd>${fmtDateTime(payment.window_ends_at)}</dd></dl>
    ${['pending', 'failed'].includes(payment.status) ? html`<p>Your answers are saved. Your response is complete once your payment is confirmed.</p>
      <div class="actions"><button class="btn btn-primary" type="button" data-pay>Pay ${payment.amount_text}</button></div>
      <p class="hint">Keep this private link to pay or check later: <a href="${link}" data-external>payment status</a>.</p>` : ''}
    <div data-pay-status role="status"></div></section>`;
}

export function bindPaymentReceipt(root, result) {
  if (!result.payment) return;
  remember(result.slug, result.payment.token);
  $('[data-pay]', root)?.addEventListener('click', event => startCheckout(event.currentTarget, result.payment.token, $('[data-pay-status]', root)));
}

async function startCheckout(button, token, status) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const checkout = await api('POST', `/api/public/form-payments/${encodeURIComponent(token)}/checkout`);
    if (checkout.paid) { location.reload(); return; }
    mount(status, html`<p>Opening checkout…</p>`);
    location.assign(checkout.url);
  } catch (error) {
    mount(status, notice('bad', html`<p>${error.message}</p>`));
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/** /f/<slug>?payment=<token>: the return from checkout and the private status link. */
export async function paymentStatusPage(ctx, root, slug, token) {
  setTitle('Payment status · Forms by Schedora');
  mount(root, loading('Checking your payment with the payment provider…'));
  let tries = 0;
  const check = async () => {
    let result;
    try { result = await api('POST', `/api/public/form-payments/${encodeURIComponent(token)}/verify`); }
    catch (error) { return mount(root, html`<div class="public-form receipt">${notice('bad', html`<p>${error.message}</p>`)}<p><a class="btn" href="/f/${encodeURIComponent(slug)}">Back to the form</a></p></div>`); }
    if (!ctx.alive()) return;
    if (['paid', 'refunded', 'partially_refunded', 'expired'].includes(result.status)) forget(slug);
    const [kind, label] = STATE[result.status] || STATE.pending;
    const next = result.next;
    mount(root, html`<div class="public-form receipt" role="status"><h1 tabindex="-1">${result.status === 'paid' ? 'Payment confirmed' : 'Payment status'}</h1>
      <p>${pill(kind, label)}</p><p>${result.message}</p>
      <dl class="confirm-facts"><dt>Receipt</dt><dd>${result.reference}</dd><dt>Amount</dt><dd>${result.amount_text}</dd>${result.paid_at ? html`<dt>Paid</dt><dd>${fmtDateTime(result.paid_at)}</dd>` : html`<dt>Pay by</dt><dd>${fmtDateTime(result.window_ends_at)}</dd>`}</dl>
      ${result.can_pay ? html`<div class="actions"><button class="btn btn-primary" type="button" data-pay>${result.status === 'failed' ? 'Try payment again' : `Pay ${result.amount_text}`}</button><button class="btn" type="button" data-recheck>Check again</button></div>` : ''}
      ${next?.type === 'booking' && next.status === 'offered' ? html`<p>Next, choose a time for <strong>${next.title}</strong>.</p><p><a class="btn btn-primary" href="${next.url}">Choose a time</a></p>` : ''}
      ${next?.type === 'url' ? html`<p><a class="btn btn-primary" href="${next.url}" data-external rel="noopener">Continue</a></p>` : ''}${next?.type === 'message' ? html`<p>${next.message}</p>` : ''}
      <div data-pay-status role="status"></div></div>`);
    $('h1', root).focus();
    $('[data-pay]', root)?.addEventListener('click', event => startCheckout(event.currentTarget, token, $('[data-pay-status]', root)));
    $('[data-recheck]', root)?.addEventListener('click', () => { tries = 0; check(); });
    // Right after checkout the provider's confirmation can lag a few seconds: check a few more times.
    if (result.status === 'pending' && ctx.query.has('razorpay_payment_link_id') && tries++ < 6) setTimeout(() => ctx.alive() && check(), 3000);
  };
  await check();
}

/** /forms/pay/<token>: simulated checkout on servers without Razorpay (never production). */
export async function testCheckoutPage(ctx) {
  const token = ctx.params[0];
  setTitle('Test checkout · Forms by Schedora');
  let status;
  try { status = await api('GET', `/api/public/form-payments/${encodeURIComponent(token)}`); }
  catch (error) { return mount(ctx.main, html`<div class="container page narrow"><h1>This link is not valid</h1>${notice('bad', html`<p>${error.message}</p>`)}</div>`); }
  const back = `/f/${encodeURIComponent(status.form.slug)}?payment=${encodeURIComponent(token)}`;
  mount(ctx.main, html`<div class="container page narrow"><div class="card"><span class="tag">Test checkout</span><h1>${status.description}</h1>
    ${notice('warn', html`<p>Razorpay is not connected, so this page simulates checkout. No money moves.</p>`)}
    <dl class="confirm-facts"><dt>Amount</dt><dd>${status.amount_text}</dd><dt>Receipt</dt><dd>${status.reference}</dd><dt>To</dt><dd>${status.form.workspace_name}</dd></dl>
    ${status.can_pay ? html`<div class="actions"><button class="btn btn-primary" type="button" data-test-pay="pay">Simulate successful payment</button><button class="btn" type="button" data-test-pay="fail">Simulate a declined payment</button><a class="btn btn-link" href="${back}">Not now</a></div>`
      : html`<p>${status.message}</p><a class="btn" href="${back}">View payment status</a>`}</div></div>`);
  for (const button of ctx.main.querySelectorAll('[data-test-pay]')) button.addEventListener('click', async () => {
    try { await api('POST', `/api/public/form-payments/${encodeURIComponent(token)}/test-pay`, { action: button.dataset.testPay }); ctx.navigate(back, { replace: true }); }
    catch (error) { toast(error.message); }
  });
}

/** /messages/stop/<token>: the private withdrawal link sent in every WhatsApp receipt. */
export async function stopMessagesPage(ctx) {
  const token = ctx.params[0];
  setTitle('WhatsApp messages · Schedora');
  const render = (status, done = false) => mount(ctx.main, html`<div class="container page narrow"><div class="card"><h1>WhatsApp messages from ${status.workspace_name}</h1>
    ${status.withdrawn ? html`<p role="status">${done ? 'Done. ' : ''}${status.number_ending ? `The number ending ${status.number_ending}` : 'This number'} will not get further WhatsApp messages from ${status.workspace_name} through Schedora. Messages already delivered cannot be recalled.</p>`
      : html`<p>Stop future WhatsApp messages from ${status.workspace_name} to ${status.number_ending ? `the number ending ${status.number_ending}` : 'this number'}. Your form responses are not affected.</p><div class="actions"><button class="btn btn-primary" type="button" id="stop-messages">Stop WhatsApp messages</button></div>`}</div></div>`);
  let status;
  try { status = await api('GET', `/api/public/message-consent/${encodeURIComponent(token)}`); }
  catch (error) { return mount(ctx.main, html`<div class="container page narrow"><h1>This link is not valid</h1>${notice('bad', html`<p>${error.message}</p>`)}</div>`); }
  render(status);
  $('#stop-messages', ctx.main)?.addEventListener('click', async () => {
    try { render(await api('POST', `/api/public/message-consent/${encodeURIComponent(token)}/withdraw`), true); }
    catch (error) { toast(error.message); }
  });
}

/** Status line for the WhatsApp receipt on a respondent's receipt page. */
export const receiptLine = status => status ? html`<p class="hint" data-whatsapp-status>WhatsApp receipt: ${RECEIPT[status.status] || status.status}.</p>` : '';

// ---- Team: Responses ----------------------------------------------------------------------------

export function responsePaymentBadges(response) {
  const payment = response.payment;
  const receipt = response.whatsapp_receipt;
  return html`${payment ? html`<span class="response-payment">${pill(...(STATE[payment.status] || STATE.pending))} <span class="muted">${paymentAmountText(payment.amount_cents)}${payment.amount_refunded ? ` · ${paymentAmountText(payment.amount_refunded)} refunded` : ''}</span>
      ${['pending', 'failed', 'paid', 'partially_refunded', 'review'].includes(payment.status) ? html` <button class="btn btn-link btn-small" type="button" data-payment-refresh="${response.id}">Check payment</button>` : ''}
      ${payment.review_reason ? html`<span class="hint">${payment.review_reason}</span>` : ''}</span>` : ''}
    ${receipt ? html`<span class="response-receipt muted">WhatsApp receipt: ${RECEIPT[receipt.status] || receipt.status}</span>` : ''}`;
}

/** "Check payment": asks the server to read the payment (and refunds) from Razorpay now. */
export async function refreshResponsePayment(path, responseId, button) {
  button.disabled = true;
  try {
    const payment = await api('POST', `${path}/responses/${encodeURIComponent(responseId)}/payment/refresh`);
    toast(`Payment status: ${(STATE[payment.status] || [null, payment.status])[1]}.`);
    return payment;
  } catch (error) { toast(error.message); return null; }
  finally { button.disabled = false; }
}
