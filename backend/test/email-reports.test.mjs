import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { setup, signUp, START } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { deliverEmail, queueEmail } from '../src/platform/email.mjs';
import { runMonitoring } from '../src/platform/monitoring.mjs';
import { applyRetention } from '../src/worker.mjs';
import { buildTrail } from '../../frontend/js/enquiry-trail.mjs';
import { deliveryEvidence } from '../../frontend/js/email-evidence.mjs';

const SECRET = 'whsec_' + randomBytes(24).toString('base64');
let eventCounter = 0;

// Signs like the provider (Svix): HMAC-SHA256 of "id.timestamp.body" with the decoded secret.
function signed(payload, { secret = SECRET, at = START, id = 'msg_evt_' + (++eventCounter), version = 'v1' } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(at / 1000));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { body, headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `${version},${signature}` } };
}

const event = (type, emailId, createdAt = START) => ({ type, created_at: new Date(createdAt).toISOString(), data: { email_id: emailId, to: ['client@private.example'], subject: 'Private subject' } });

async function post(env, { body, headers }) {
  const response = await fetch(env.base + '/api/email/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { status: response.status, body: await response.json() };
}

// One message accepted by the (fake) HTTP provider; returns its row.
async function acceptedEmail(env, ws, key = 'k1') {
  env.emailProvider.name = 'http';
  const id = queueEmail(env.app, { workspaceId: ws, key, kind: 'confirmation', to: 'client@private.example', subject: 'Private subject', body: 'Private body' });
  assert.equal(await deliverEmail(env.app, id), 'sent');
  return env.app.db.get('SELECT * FROM emails WHERE id = ?', id);
}

test('without a signing secret the delivery-report endpoint does not exist', async () => {
  const env = await setup();
  try {
    assert.equal((await post(env, signed(event('email.delivered', 'x')))).status, 404);
  } finally { await env.close(); }
});

test('signed reports are verified, deduplicated and recorded against the accepted message only', async () => {
  const logs = [];
  const env = await setup({ config: { emailWebhookSecret: SECRET } });
  try {
    env.app.log = (level, message, fields) => logs.push(JSON.stringify({ level, message, ...fields }));
    const host = env.client();
    const { ws } = await signUp(host);
    const email = await acceptedEmail(env, ws.id);
    assert.equal(email.accepted_transport, 'http');

    // Rejected: wrong secret, stale or future timestamp, unknown signature version, missing headers.
    const other = 'whsec_' + randomBytes(24).toString('base64');
    for (const attempt of [signed(event('email.delivered', email.provider_message_id), { secret: other }),
      signed(event('email.delivered', email.provider_message_id), { at: START - 6 * 60000 }),
      signed(event('email.delivered', email.provider_message_id), { at: START + 6 * 60000 }),
      signed(event('email.delivered', email.provider_message_id), { version: 'v2' }),
      { body: JSON.stringify(event('email.delivered', email.provider_message_id)), headers: {} }]) {
      assert.equal((await post(env, attempt)).status, 401);
    }
    assert.equal(env.app.db.get('SELECT delivery_status FROM emails WHERE id = ?', email.id).delivery_status, null, 'nothing recorded from rejected requests');

    // A rotated secret: the header may carry several signatures; one valid v1 is enough.
    const good = signed(event('email.delivered', email.provider_message_id));
    good.headers['svix-signature'] = 'v1,' + randomBytes(32).toString('base64') + ' ' + good.headers['svix-signature'];
    assert.deepEqual((await post(env, good)).body, { result: 'recorded' });
    assert.deepEqual((await post(env, good)).body, { result: 'duplicate' }, 'provider retries reuse the id');
    const listed = (await host.get(`/api/workspaces/${ws.id}/emails`)).body.find(row => row.id === email.id);
    assert.equal(listed.delivery_status, 'delivered');
    assert.equal(listed.accepted_transport, 'http');

    assert.deepEqual((await post(env, signed(event('email.opened', email.provider_message_id)))).body, { result: 'ignored' }, 'opens are not tracked');
    assert.deepEqual((await post(env, signed(event('email.delivered', 'not-ours')))).body, { result: 'unknown_message' });
    // Correctly signed but not JSON.
    const timestamp = String(Math.floor(START / 1000));
    const signature = createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`malformed.${timestamp}.{`).digest('base64');
    assert.equal((await post(env, { body: '{', headers: { 'svix-id': 'malformed', 'svix-timestamp': timestamp, 'svix-signature': 'v1,' + signature } })).status, 400);

    // Nothing personal is kept or logged from the payload.
    const stored = env.app.db.all('SELECT * FROM email_provider_events');
    assert.ok(stored.every(row => Object.keys(row).sort().join() === 'event_key,received_at,type'));
    assert.ok(!logs.join('\n').includes('client@private.example'));
    assert.ok(!logs.join('\n').includes('Private subject'));
  } finally { await env.close(); }
});

test('a report never downgrades a more definite one, and only messages the HTTP provider accepted match', async () => {
  const env = await setup({ config: { emailWebhookSecret: SECRET } });
  try {
    const { ws } = await signUp(env.client());
    const email = await acceptedEmail(env, ws.id);
    const status = () => env.app.db.get('SELECT delivery_status FROM emails WHERE id = ?', email.id).delivery_status;
    await post(env, signed(event('email.delivered', email.provider_message_id, START)));
    await post(env, signed(event('email.delivery_delayed', email.provider_message_id, START + 1000)));
    assert.equal(status(), 'delivered', 'a late delay report cannot undo delivery');
    await post(env, signed(event('email.complained', email.provider_message_id, START + 2000)));
    assert.equal(status(), 'complained');
    await post(env, signed(event('email.delivered', email.provider_message_id, START + 3000)));
    assert.equal(status(), 'complained');

    const bounced = await acceptedEmail(env, ws.id, 'k2');
    await post(env, signed(event('email.delivery_delayed', bounced.provider_message_id, START)));
    assert.equal(env.app.db.get('SELECT delivery_status FROM emails WHERE id = ?', bounced.id).delivery_status, 'delayed');
    await post(env, signed(event('email.bounced', bounced.provider_message_id, START + 1000)));
    assert.equal(env.app.db.get('SELECT delivery_status FROM emails WHERE id = ?', bounced.id).delivery_status, 'bounced');

    // A message recorded only in the local outbox can never gain a provider report.
    env.emailProvider.name = 'outbox';
    const local = queueEmail(env.app, { workspaceId: ws.id, key: 'k3', kind: 'confirmation', to: 'a@example.com', subject: 's', body: 'b' });
    await deliverEmail(env.app, local);
    const localRow = env.app.db.get('SELECT * FROM emails WHERE id = ?', local);
    assert.deepEqual((await post(env, signed(event('email.delivered', localRow.provider_message_id)))).body, { result: 'unknown_message' });
  } finally { await env.close(); }
});

test('undelivered reports raise an operator alert and an enquiry attention reason; event keys expire', async () => {
  const env = await setup({ config: { emailWebhookSecret: SECRET } });
  try {
    const { ws } = await signUp(env.client());
    const email = await acceptedEmail(env, ws.id);
    await post(env, signed(event('email.bounced', email.provider_message_id)));
    await runMonitoring(env.app);
    assert.ok((await env.client().get('/api/health')).body.alerts.firing.includes('email_undelivered'));
    env.clock.now += 31 * 86400000;
    applyRetention(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM email_provider_events').count, 0);
  } finally { await env.close(); }
});

test('wording separates local outbox, provider acceptance, mail-server delivery and problems', () => {
  assert.match(deliveryEvidence({ status: 'sent', transport: 'outbox', report: 'delivered' }).text, /local outbox; not delivered/, 'an outbox message ignores any report');
  assert.match(deliveryEvidence({ status: 'sent', transport: 'http', report: null }).text, /Accepted by the email provider; no delivery report yet/);
  const delivered = deliveryEvidence({ status: 'sent', transport: 'http', report: 'delivered' });
  assert.match(delivered.text, /recipient's mail server .*Inbox placement is not tracked/);
  assert.equal(delivered.problem, false);
  for (const report of ['bounced', 'complained', 'provider_failed', 'suppressed']) assert.equal(deliveryEvidence({ status: 'sent', transport: 'http', report }).problem, true, report);
  assert.equal(deliveryEvidence({ status: 'sent', transport: 'http', report: 'delayed' }).problem, false);
  assert.equal(deliveryEvidence({ status: 'sent', transport: null, report: 'delivered' }).verified, false, 'legacy rows stay unverified');

  const row = { id: 'resp-1', form_id: 'f1', created_at: 1000, next_step: null };
  const context = { runs: [{ id: 'r1', flow_name: 'Thank you', event_type: 'forms.response.created', subject_id: 'resp-1', status: 'succeeded', attempts: 1, result: { email: 'e1' }, email_delivery: { status: 'sent', transport: 'http', report: 'bounced' }, created_at: 2000 }],
    tasks: [], bookingsByReference: new Map(), runsAvailable: true, tasksAvailable: true, bookingsAvailable: true };
  const trail = buildTrail(row, context);
  assert.deepEqual(trail.reasons, ['email_undelivered']);
  assert.match(trail.steps.at(-1).text, /Bounced/);
});

test('the delivery-report secret must be a provider signing secret', () => {
  assert.throws(() => loadConfig({ EMAIL_WEBHOOK_SECRET: 'plain-secret' }), /EMAIL_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig({ EMAIL_WEBHOOK_SECRET: 'whsec_c2hvcnQ=' }), /EMAIL_WEBHOOK_SECRET/, 'too short');
  assert.equal(loadConfig({ EMAIL_WEBHOOK_SECRET: SECRET }).emailWebhookSecret, SECRET);
});
