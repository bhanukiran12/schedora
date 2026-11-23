import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { e164Phone } from '../src/shared/forms-logic.mjs';
import { createWhatsappProvider } from '../src/platform/twilio.mjs';
import { deliverDueEmails } from '../src/platform/email.mjs';
import { setup, signUp } from './helpers.mjs';

const config = {
  whatsappProvider: 'twilio', twilioAccountSid: 'AC' + 'a'.repeat(32), twilioAuthToken: 'test-token', twilioWhatsappFrom: 'whatsapp:+14155552671',
  twilioWhatsappContentSid: 'HX' + 'b'.repeat(32), twilioWhatsappReceiptContentSid: 'HX' + 'c'.repeat(32),
  twilioStatusCallback: 'https://forms.example.com/api/messaging/twilio/status', twilioInboundUrl: 'https://forms.example.com/api/messaging/twilio/inbound'
};
const definition = (extra = {}) => ({ title: 'Course enquiry', presentation: 'classic', fields: [
  { id: 'name', type: 'short_text', label: 'Name', required: true },
  { id: 'phone', type: 'phone', label: 'WhatsApp number' }
], receipts: { whatsapp: { phone_field: 'phone' } }, ...extra });

async function fixture(options = {}) {
  const env = await setup({ config: options.config ?? config });
  const sent = [];
  env.app.whatsappProvider = { name: 'twilio', async send(message) { sent.push(message); return { id: 'SM' + String(sent.length).padStart(32, '0') }; } };
  const owner = env.client();
  const { ws } = await signUp(owner, 'Receipts');
  const forms = `/api/workspaces/${ws.id}/forms`;
  const publish = async extra => {
    const created = (await owner.post(forms, { definition: definition(extra) })).body;
    const published = await owner.post(`${forms}/${created.id}/publish`);
    return { created, published, path: `${forms}/${created.id}`, publicPath: '/api/public/forms/' + created.slug };
  };
  return { ...env, owner, ws, sent, publish };
}
const consents = env => env.app.db.all('SELECT * FROM form_message_consents ORDER BY consented_at');

test('phone numbers are normalised to international format or rejected', () => {
  assert.equal(e164Phone('+91 98765-43210'), '+919876543210');
  assert.equal(e164Phone('0091 (98765) 43210'), '+919876543210');
  assert.equal(e164Phone('98765 43210'), null, 'a country code is required');
  assert.equal(e164Phone('+0 123'), null);
});

test('WhatsApp receipts stay unavailable and unpublishable until the receipt template is configured', async () => {
  const env = await fixture({ config: { ...config, twilioWhatsappReceiptContentSid: '' } });
  try {
    assert.equal((await env.owner.get(`/api/workspaces/${env.ws.id}/forms-payment-readiness`)).body.whatsapp_receipts.available, false);
    const { published } = await env.publish();
    assert.equal(published.status, 400);
    assert.match(published.body.error.message, /not connected/);
  } finally { await env.close(); }
});

test('only an explicit opt-in to a valid number queues one receipt, with delivery evidence from signed reports', async () => {
  const env = await fixture();
  try {
    const { published, path, publicPath } = await env.publish();
    assert.equal(published.status, 200, JSON.stringify(published.body));
    // No opt-in: nothing recorded or sent, even with a valid number.
    const silent = await env.client().post(publicPath + '/responses', { answers: { name: 'Ravi', phone: '+91 98765 43210' }, submission_id: 'receipt-none-00001' });
    assert.equal(silent.status, 201);
    assert.equal(silent.body.whatsapp_receipt, undefined);
    // Opted in, but no country code: recorded as not sent.
    const local = await env.client().post(publicPath + '/responses', { answers: { name: 'Ravi', phone: '98765 43210' }, whatsapp_receipt: true, submission_id: 'receipt-local-00001' });
    assert.equal(local.body.whatsapp_receipt.status, 'invalid_number');

    const body = { answers: { name: 'Meera', phone: '+91 91234 56789' }, whatsapp_receipt: true, submission_id: 'receipt-good-000001' };
    const first = await env.client().post(publicPath + '/responses', body);
    assert.equal(first.body.whatsapp_receipt.status, 'queued');
    assert.equal((await env.client().post(publicPath + '/responses', body)).status, 200);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel = 'whatsapp'").n, 1, 'a retried submission never sends twice');
    const consent = consents(env).find(row => row.response_id === first.body.id);
    assert.equal(consent.phone, '+919123456789');
    assert.match(consent.consent_text, /WhatsApp/);

    await deliverDueEmails(env.app);
    assert.equal(env.sent.length, 1);
    const message = JSON.parse(env.sent[0].body);
    assert.equal(message.template, 'form_receipt');
    assert.equal(message.variables[1], 'Meera');
    assert.equal(message.variables[2], 'Course enquiry');
    assert.equal(message.variables[3], first.body.reference);
    assert.match(message.variables[4], /\/messages\/stop\/[A-Za-z0-9_-]{32}$/);
    let row = (await env.owner.get(path + '/responses')).body.responses.find(item => item.id === first.body.id);
    assert.equal(row.whatsapp_receipt.status, 'accepted', 'provider accepted is not the same as delivered');

    const report = { AccountSid: config.twilioAccountSid, MessageSid: 'SM' + '1'.padStart(32, '0'), MessageStatus: 'delivered' };
    const signature = twilio.getExpectedTwilioSignature(config.twilioAuthToken, config.twilioStatusCallback, report);
    assert.equal((await env.client().raw('POST', '/api/messaging/twilio/status', new URLSearchParams(report).toString(), { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature })).body.result, 'recorded');
    row = (await env.owner.get(path + '/responses')).body.responses.find(item => item.id === first.body.id);
    assert.equal(row.whatsapp_receipt.status, 'delivered');

    // The same number submitting again within two minutes does not get a second message.
    const again = await env.client().post(publicPath + '/responses', { ...body, submission_id: 'receipt-good-000002' });
    assert.equal(again.body.whatsapp_receipt.status, 'duplicate');
  } finally { await env.close(); }
});

test('the private stop link and STOP replies withdraw future WhatsApp messages, including queued booking reminders', async () => {
  const env = await fixture();
  try {
    const { publicPath } = await env.publish();
    const first = await env.client().post(publicPath + '/responses', { answers: { name: 'Meera', phone: '+919123456789' }, whatsapp_receipt: true, submission_id: 'receipt-stop-000001' });
    await deliverDueEmails(env.app);
    const link = JSON.parse(env.sent[0].body).variables[4];
    const token = link.split('/').at(-1);
    assert.equal((await env.client().get('/api/public/message-consent/' + token)).body.withdrawn, false);
    // A queued reminder for the same number in this workspace is canceled by the withdrawal.
    env.app.db.run("INSERT INTO emails (id, workspace_id, idempotency_key, kind, to_address, subject, body, status, next_attempt_at, created_at, channel) VALUES ('wa-later', ?, 'wa-later', 'workflow', '+919123456789', '', '{}', 'scheduled', ?, ?, 'whatsapp')", env.ws.id, env.clock.now + 3600000, env.clock.now);
    const withdrawn = await env.client().post(`/api/public/message-consent/${token}/withdraw`);
    assert.equal(withdrawn.body.withdrawn, true);
    assert.equal(withdrawn.body.number_ending, '6789');
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE id = 'wa-later'").status, 'canceled');
    env.clock.now += 5 * 60000;
    const later = await env.client().post(publicPath + '/responses', { answers: { name: 'Meera', phone: '+919123456789' }, whatsapp_receipt: true, submission_id: 'receipt-stop-000002' });
    assert.equal(later.body.whatsapp_receipt.status, 'opted_out');
    assert.ok(first.body.id);

    // STOP reply to the shared sender: signed, then applies across workspaces.
    const reply = { AccountSid: config.twilioAccountSid, From: 'whatsapp:+918888877777', Body: ' stop ' };
    const post = (body, signature) => env.client().raw('POST', '/api/messaging/twilio/inbound', new URLSearchParams(body).toString(), { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature });
    assert.equal((await post(reply, 'forged')).status, 401);
    const accepted = await post(reply, twilio.getExpectedTwilioSignature(config.twilioAuthToken, config.twilioInboundUrl, reply));
    assert.equal(accepted.status, 200);
    assert.match(accepted.body, /<Response><\/Response>/);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM messaging_opt_outs WHERE workspace_id IS NULL AND phone = '+918888877777'").n, 1);
    env.app.db.run("INSERT INTO emails (id, workspace_id, idempotency_key, kind, to_address, subject, body, status, next_attempt_at, created_at, channel) VALUES ('wa-other', ?, 'wa-other', 'workflow', '+918888877777', '', '{}', 'queued', ?, ?, 'whatsapp')", env.ws.id, env.clock.now, env.clock.now);
    const before = env.sent.length;
    await deliverDueEmails(env.app);
    assert.equal(env.sent.length, before, 'nothing is sent to a number that replied STOP');
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE id = 'wa-other'").status, 'canceled');
  } finally { await env.close(); }
});

test('a paid form sends its receipt only after the payment is confirmed', async () => {
  const env = await fixture();
  try {
    const { publicPath } = await env.publish({ payment: { amount_cents: 20000, currency: 'INR' } });
    const submitted = (await env.client().post(publicPath + '/responses', { answers: { name: 'Meera', phone: '+919123456789' }, whatsapp_receipt: true, submission_id: 'receipt-paid-000001' })).body;
    assert.equal(submitted.whatsapp_receipt.status, 'waiting_for_payment');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel = 'whatsapp'").n, 0);
    const pay = `/api/public/form-payments/${submitted.payment.token}`;
    await env.client().post(pay + '/checkout');
    await env.client().post(pay + '/test-pay', { action: 'pay' });
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel = 'whatsapp'").n, 1);
  } finally { await env.close(); }
});

test('the provider uses the receipt template for receipts and keeps the booking template for reminders', async () => {
  const calls = [];
  const provider = createWhatsappProvider(config, async (url, init) => { calls.push(new URLSearchParams(init.body)); return { ok: true, json: async () => ({ sid: 'SM' + 'f'.repeat(32) }) }; });
  const variables = { 1: 'Meera', 2: 'Course enquiry', 3: 'ABCD1234', 4: 'https://forms.example.com/messages/stop/x' };
  await provider.send({ to: '+919123456789', body: JSON.stringify({ template: 'form_receipt', variables }) });
  await provider.send({ to: '+919123456789', body: JSON.stringify(variables) });
  assert.equal(calls[0].get('ContentSid'), config.twilioWhatsappReceiptContentSid);
  assert.equal(calls[1].get('ContentSid'), config.twilioWhatsappContentSid);
  const noReceipt = createWhatsappProvider({ ...config, twilioWhatsappReceiptContentSid: '' }, async () => { throw new Error('must not call'); });
  await assert.rejects(() => noReceipt.send({ to: '+919123456789', body: JSON.stringify({ template: 'form_receipt', variables }) }), /No approved WhatsApp template/);
});
