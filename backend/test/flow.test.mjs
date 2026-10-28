// Sprint 8: durable outbox, exactly-once side effects, retries, pause and visible failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, publishedEventType, setup, signUp } from './helpers.mjs';
import { dispatchEvent, dispatchOutbox, processDueRuns } from '../src/flow/service.mjs';

async function world(env) {
  const host = env.client();
  const { ws } = await signUp(host, 'Host');
  const type = await publishedEventType(host, ws);
  const base = `/api/public/meet/${ws.slug}/${type.slug}`;
  const slots = (await env.client().get(base + '/slots')).body.slots;
  const book = (index, email = `i${index}@example.com`) => env.client().post(base + '/bookings', { name: 'Ivy', email, timezone: 'UTC', start: slots[index] }, idem());
  return { host, ws, type, book };
}

test('one event produces one side effect despite duplicate delivery', async () => {
  const env = await setup();
  try {
    const { host, ws, type, book } = await world(env);
    const flow = (await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Prep', trigger_type: 'meet.booking.created', trigger_source: type.id, action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}}', details: 'Ref {{booking.reference}}' }, status: 'enabled' })).body;
    await book(0);
    const event = env.app.db.get('SELECT * FROM outbox');
    dispatchEvent(env.app, event);
    dispatchEvent(env.app, event); // duplicate delivery
    dispatchOutbox(env.app);
    await processDueRuns(env.app);
    await processDueRuns(env.app);
    await env.app.worker.tick();
    const runs = (await host.get(`/api/workspaces/${ws.id}/runs?flow=${flow.id}`)).body;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
    const tasks = (await host.get(`/api/workspaces/${ws.id}/tasks`)).body;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Prepare for Ivy');
    assert.match(tasks[0].details, /^Ref SCH-/);
  } finally { await env.close(); }
});

test('draft flows ignore events; paused flows hold them until resumed', async () => {
  const env = await setup();
  try {
    const { host, ws, book } = await world(env);
    const draft = (await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Draft', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Draft' } })).body;
    const paused = (await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Paused', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Held {{invitee.email}}' }, status: 'paused' })).body;
    await book(0);
    await env.app.worker.tick();
    const runs = (await host.get(`/api/workspaces/${ws.id}/runs`)).body;
    assert.equal(runs.filter(run => run.flow_id === draft.id).length, 0);
    assert.deepEqual(runs.filter(run => run.flow_id === paused.id).map(run => run.status), ['queued']);
    assert.equal((await host.get(`/api/workspaces/${ws.id}/tasks`)).body.length, 0);
    await host.patch(`/api/workspaces/${ws.id}/flows/${paused.id}`, { status: 'enabled' });
    await env.app.worker.tick();
    assert.equal((await host.get(`/api/workspaces/${ws.id}/tasks`)).body[0].title, 'Held i0@example.com');
  } finally { await env.close(); }
});

test('email action retries with backoff, fails visibly, and manual retry never duplicates', async () => {
  const env = await setup();
  try {
    const { host, ws, book } = await world(env);
    await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Thanks', trigger_type: 'meet.booking.created', action_type: 'email', action_config: { to: 'invitee', subject: 'Thanks {{invitee.name}}', body: 'See you at {{booking.start}}' }, status: 'enabled' });
    env.emailProvider.mode = 'transient';
    await book(0);
    await env.app.worker.tick();
    let [run] = (await host.get(`/api/workspaces/${ws.id}/runs`)).body;
    assert.equal(run.status, 'retrying');
    for (let attempt = 0; attempt < 8; attempt++) { env.clock.now += 3600000; await env.app.worker.tick(); }
    [run] = (await host.get(`/api/workspaces/${ws.id}/runs`)).body;
    assert.equal(run.status, 'failed');
    assert.ok(run.last_error);
    assert.equal(env.sent.filter(message => message.subject.startsWith('Thanks')).length, 0);

    env.emailProvider.mode = 'ok';
    assert.equal((await host.post(`/api/workspaces/${ws.id}/runs/${run.id}/retry`)).status, 204);
    await env.app.worker.tick();
    [run] = (await host.get(`/api/workspaces/${ws.id}/runs`)).body;
    assert.equal(run.status, 'succeeded');
    assert.equal((await host.post(`/api/workspaces/${ws.id}/runs/${run.id}/retry`)).status, 409, 'only failed runs can be retried');
    // Simulate a crash after sending: re-running the same run must not send again.
    env.app.db.run("UPDATE flow_runs SET status = 'queued', next_attempt_at = 0 WHERE id = ?", run.id);
    await env.app.worker.tick();
    const thanks = env.sent.filter(message => message.subject.startsWith('Thanks'));
    assert.equal(thanks.length, 1);
    assert.equal(thanks[0].subject, 'Thanks Ivy');
  } finally { await env.close(); }
});

test('form response trigger emails the respondent; missing recipient fails without retries', async () => {
  const env = await setup();
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Host');
    const form = (await host.post(`/api/workspaces/${ws.id}/forms`, { title: 'Contact' })).body;
    await host.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    const flow = (await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Reply', trigger_type: 'forms.response.created', trigger_source: form.id, action_type: 'email', action_config: { to: 'field:email', subject: 'Got it, {{answer.name}}', body: 'Topic: {{answer.topic}}' }, status: 'enabled' })).body;
    assert.equal((await host.patch(`/api/workspaces/${ws.id}/flows/${flow.id}`, { action_config: { to: 'invitee', subject: 'x', body: 'x' } })).status, 400, 'invitee recipient needs a booking trigger');
    const simulated = (await host.post(`/api/workspaces/${ws.id}/flows/${flow.id}/simulate`)).body;
    assert.equal(simulated.simulated, true);
    assert.equal(env.sent.length, 0, 'simulation sends nothing');

    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Mia', email: 'mia@example.com', topic: 'support' } });
    await env.app.worker.tick();
    const reply = env.sent.find(message => message.subject === 'Got it, Mia');
    assert.equal(reply.to, 'mia@example.com');
    assert.equal(reply.body, 'Topic: Support');

    await host.patch(`/api/workspaces/${ws.id}/flows/${flow.id}`, { action_config: { to: 'field:topic', subject: 'x', body: 'x' } });
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'No', email: 'no@example.com', topic: 'other' } });
    await env.app.worker.tick();
    const failed = (await host.get(`/api/workspaces/${ws.id}/runs?status=failed`)).body;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempts, 1);
    assert.match(failed[0].last_error, /recipient/);
  } finally { await env.close(); }
});

test('run email evidence survives provider changes, legacy records and a crash without exposing message data', async () => {
  const env = await setup();
  try {
    const { host, ws, book } = await world(env);
    const path = `/api/workspaces/${ws.id}/runs`;
    await host.post(`/api/workspaces/${ws.id}/flows`, { name: 'Evidence', trigger_type: 'meet.booking.created', action_type: 'email', action_config: { to: 'invitee', subject: 'Evidence only', body: 'Private body' }, status: 'enabled' });
    env.emailProvider.name = 'outbox';
    await book(0);
    await env.app.worker.tick();
    let [first] = (await host.get(path)).body;
    assert.deepEqual(first.email_delivery, { status: 'sent', transport: 'outbox', accepted_at: env.clock.now });
    const sent = env.sent.length;
    // A configuration change between a successful email hand-off and a crashed run's recovery
    // must preserve the original evidence and must not send again.
    env.emailProvider.name = 'http';
    env.app.db.run("UPDATE flow_runs SET status = 'queued', next_attempt_at = 0 WHERE id = ?", first.id);
    await env.app.worker.tick();
    [first] = (await host.get(path)).body;
    assert.equal(first.email_delivery.transport, 'outbox');
    assert.equal(env.sent.length, sent);
    env.clock.now += 1000;
    await book(1);
    await env.app.worker.tick();
    env.emailProvider.name = 'outbox';
    let runs = (await host.get(path)).body;
    assert.equal(runs.find(run => run.id !== first.id).email_delivery.transport, 'http');
    assert.equal(runs.find(run => run.id === first.id).email_delivery.transport, 'outbox');
    assert.ok(!JSON.stringify(runs).includes('Private body'));
    assert.ok(!JSON.stringify(runs).includes('provider_message_id'));
    // Migrated messages have no transport evidence. Never guess from today's configuration.
    env.app.db.run('UPDATE emails SET accepted_transport = NULL WHERE id = ?', first.result.email);
    runs = (await host.get(path)).body;
    assert.equal(runs.find(run => run.id === first.id).email_delivery.transport, null);
    const outsider = env.client();
    await signUp(outsider, 'Other');
    assert.equal((await outsider.get(path)).status, 404);
    assert.equal((await env.client().get(path)).status, 401);
  } finally { await env.close(); }
});
