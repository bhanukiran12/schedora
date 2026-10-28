import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, START } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { CHECKS, runMonitoring, sendTestAlert } from '../src/platform/monitoring.mjs';

const HOUR = 3600000;
const WEBHOOK = 'https://hooks.example.test/schedora';

// Captures alert webhook calls; `fail` makes the next calls return 500.
function fakeWebhook(env) {
  const calls = [];
  const hook = { calls, fail: false };
  env.app.fetchProvider = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: !hook.fail, status: hook.fail ? 500 : 200 };
  };
  return hook;
}

function workspace(env, id = 'ws-monitor') {
  env.app.db.run('INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)', id, id, 'Private Client Studio', START);
  return id;
}

function failedEmail(env, ws, id = 'email-1') {
  env.app.db.run(`INSERT INTO emails (id, workspace_id, idempotency_key, kind, to_address, subject, body, status, attempts, next_attempt_at, last_error, created_at)
    VALUES (?, ?, ?, 'flow', 'client@private.example', 'Secret subject', 'Secret body', 'failed', 6, ?, 'mailbox rejected', ?)`, id, ws, 'key-' + id, env.clock.now, env.clock.now);
}

test('a failing email fires one alert with codes and counts only, reminds after 6 hours and resolves once', async () => {
  const env = await setup({ config: { alerts: { webhookUrl: WEBHOOK, email: '' } } });
  try {
    const hook = fakeWebhook(env);
    const ws = workspace(env);
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 0, 'nothing to report on a healthy system');
    failedEmail(env, ws);
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 1);
    const [call] = hook.calls;
    assert.equal(call.url, WEBHOOK);
    assert.deepEqual(call.body.alerts, [{ code: 'email_failed', state: 'firing', value: 1 }]);
    assert.equal(call.body.test, false);
    assert.match(call.body.text, /FIRING email_failed/);
    for (const secret of ['client@private.example', 'Secret subject', 'Secret body', 'Private Client Studio', 'mailbox rejected']) assert.ok(!JSON.stringify(call.body).includes(secret), secret);
    const health = await env.client().get('/api/health');
    assert.deepEqual(health.body.alerts, { channels: ['webhook'], firing: ['email_failed'] });

    env.clock.now += HOUR;
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 1, 'no repeat while still firing within the reminder window');
    env.clock.now += 5 * HOUR + 1;
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 2, 'reminder after 6 hours');
    assert.equal(hook.calls[1].body.alerts[0].state, 'firing');

    // The failure ages out of the 24-hour window: one resolved notice, then silence.
    env.clock.now = START + 25 * HOUR;
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 3);
    assert.deepEqual(hook.calls[2].body.alerts, [{ code: 'email_failed', state: 'resolved', value: 1 }]);
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 3);
    assert.deepEqual((await env.client().get('/api/health')).body.alerts.firing, []);
  } finally { await env.close(); }
});

test('an undelivered alert stays pending and is retried; a condition that clears unseen sends nothing', async () => {
  const logs = [];
  const env = await setup({ config: { alerts: { webhookUrl: WEBHOOK, email: '' } } });
  try {
    env.app.log = (level, message, fields) => logs.push({ level, message, ...fields });
    const hook = fakeWebhook(env);
    const ws = workspace(env);
    failedEmail(env, ws);
    hook.fail = true;
    const first = await runMonitoring(env.app);
    assert.deepEqual(first.results, { webhook: 'failed' });
    assert.ok(logs.some(entry => entry.message === 'alert_delivery_failed' && entry.channel === 'webhook'));
    assert.ok(logs.some(entry => entry.message === 'alert_firing' && entry.code === 'email_failed'));
    hook.fail = false;
    env.clock.now += 60000;
    await runMonitoring(env.app);
    assert.equal(hook.calls.length, 2, 'retried on the next pass');
    assert.equal(hook.calls[1].body.alerts[0].code, 'email_failed');

    // Without any reachable channel a condition fires and clears; nothing was ever delivered,
    // so no "resolved" message is owed.
    failedEmail(env, ws, 'email-2');
    env.app.db.run("DELETE FROM emails WHERE id = 'email-1'");
    hook.fail = true;
    env.app.db.run(`INSERT INTO flows (id, workspace_id, name, trigger_type, action_type, action_config, status, created_at, updated_at) VALUES ('flow-x', ?, 'F', 'forms.response.created', 'task', '{}', 'enabled', ?, ?)`, ws, env.clock.now, env.clock.now);
    env.app.db.run(`INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, next_attempt_at, created_at, updated_at) VALUES ('run-x', ?, 'flow-x', 'ev', 'forms.response.created', 's', 'queued', ?, ?, ?)`, ws, env.clock.now, env.clock.now, env.clock.now);
    env.clock.now += 16 * 60000;
    await runMonitoring(env.app);
    assert.deepEqual((await env.client().get('/api/health')).body.alerts.firing, ['email_failed', 'flow_overdue']);
    env.app.db.run("UPDATE flow_runs SET status = 'succeeded' WHERE id = 'run-x'");
    hook.fail = false;
    const calls = hook.calls.length;
    env.clock.now += 60000;
    await runMonitoring(env.app);
    assert.deepEqual(hook.calls.slice(calls).flatMap(call => call.body.alerts).map(alert => alert.code + ':' + alert.state), [], 'flow_overdue cleared unseen and email_failed was already delivered');
  } finally { await env.close(); }
});

test('paused flows hold runs without raising flow_overdue; enabled overdue runs and stuck events do', async () => {
  const env = await setup();
  try {
    const ws = workspace(env);
    const now = env.clock.now;
    for (const [id, status] of [['paused-flow', 'paused'], ['live-flow', 'enabled']]) {
      env.app.db.run(`INSERT INTO flows (id, workspace_id, name, trigger_type, action_type, action_config, status, created_at, updated_at) VALUES (?, ?, 'F', 'forms.response.created', 'task', '{}', ?, ?, ?)`, id, ws, status, now, now);
    }
    env.app.db.run(`INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, next_attempt_at, created_at, updated_at) VALUES ('held', ?, 'paused-flow', 'e1', 'forms.response.created', 's', 'queued', ?, ?, ?)`, ws, now, now, now);
    const check = code => CHECKS.find(item => item.code === code).value(env.app, {});
    env.clock.now += 16 * 60000;
    assert.equal(check('flow_overdue'), 0, 'held on purpose');
    env.app.db.run(`INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, next_attempt_at, created_at, updated_at) VALUES ('late', ?, 'live-flow', 'e2', 'forms.response.created', 's', 'retrying', ?, ?, ?)`, ws, now, now, now);
    assert.equal(check('flow_overdue'), 1);
    env.app.db.run("INSERT INTO outbox (id, workspace_id, type, subject_id, source_id, created_at) VALUES ('ev-1', ?, 'forms.response.created', 's', 'src', ?)", ws, now);
    assert.equal(check('events_overdue'), 1);
    env.app.db.run("UPDATE outbox SET dispatched_at = ? WHERE id = 'ev-1'", env.clock.now);
    assert.equal(check('events_overdue'), 0);
  } finally { await env.close(); }
});

test('video failure, settlement, unfunded usage and budget checks fire only on real counts', () => {
  const value = (code, video, app = {}) => CHECKS.find(item => item.code === code).value(app, video);
  const healthy = { failed_ops: 0, stuck_ops: 0, overdue_settlements: 0, unfunded_units_24h: 0 };
  for (const code of ['video_ops_failed', 'video_ops_stuck', 'video_settlement_overdue', 'video_unfunded_usage']) assert.equal(value(code, healthy), 0, code);
  assert.equal(value('video_ops_failed', { ...healthy, failed_ops: 2 }), 2);
  assert.equal(value('video_ops_stuck', { ...healthy, stuck_ops: 1 }), 1);
  assert.equal(value('video_settlement_overdue', { ...healthy, overdue_settlements: 3 }), 3);
  // PostgreSQL aggregates can arrive as strings; values are numbers either way.
  assert.equal(value('video_unfunded_usage', { ...healthy, unfunded_units_24h: '40' }), 40);
  const capped = { config: { video: { maxGlobalParticipants: 200 } } };
  assert.equal(value('video_capacity', { connected_participants: 159 }, capped), 0);
  assert.equal(value('video_capacity', { connected_participants: '160' }, capped), 80);
  const budgetApp = (micros, budget) => ({
    now: () => START, config: { video: { monthlyCostBudgetMicros: budget, costPerParticipantMinuteMicros: 0 } },
    db: { get: sql => sql.includes('estimated_cost_micros') ? { micros } : { units: 0 } }
  });
  assert.equal(value('video_budget', {}, budgetApp(5000, 0)), 0, 'no budget configured');
  assert.equal(value('video_budget', {}, budgetApp(790, 1000)), 0);
  assert.equal(value('video_budget', {}, budgetApp(800, 1000)), 80);
  assert.equal(value('video_budget', {}, budgetApp(1200, 1000)), 120);
});

test('a failed worker pass raises worker_error through the worker itself', async () => {
  const env = await setup();
  try {
    const original = env.app.db.all.bind(env.app.db);
    let broken = true;
    // Break one worker step only; monitoring's own queries keep working.
    env.app.db.all = (sql, ...params) => { if (broken && /FROM outbox/.test(sql) && !/COUNT/.test(sql)) throw new Error('simulated outage'); return original(sql, ...params); };
    await env.app.worker.tick();
    assert.equal(env.app.worker.state.lastError, 'simulated outage');
    assert.deepEqual((await env.client().get('/api/health')).body.alerts.firing, ['worker_error']);
    broken = false;
    env.clock.now += 60000;
    await env.app.worker.tick();
    assert.equal(env.app.worker.state.lastError, null);
    assert.deepEqual((await env.client().get('/api/health')).body.alerts.firing, []);
    const health = (await env.client().get('/api/health')).body;
    assert.equal(health.worker.stale, false);
  } finally { await env.close(); }
});

test('the test alert reaches every channel, is labelled as a test and changes no alert state', async () => {
  const env = await setup({ config: { alerts: { webhookUrl: WEBHOOK, email: 'operator@example.com' } } });
  try {
    const hook = fakeWebhook(env);
    env.app.emailProvider.name = 'http';
    const results = await sendTestAlert(env.app);
    assert.deepEqual(results, { webhook: 'sent', email: 'sent' });
    assert.equal(hook.calls[0].body.test, true);
    assert.match(hook.calls[0].body.text, /^\[TEST\]/);
    assert.deepEqual(hook.calls[0].body.alerts, []);
    assert.equal(env.sent.length, 1);
    assert.equal(env.sent[0].to, 'operator@example.com');
    assert.match(env.sent[0].subject, /^\[TEST\] Schedora alert check/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM monitor_alerts').count, 0);
    // The outbox provider would only record the message locally, so email is not an alert channel then.
    env.app.emailProvider.name = 'outbox';
    assert.deepEqual(await sendTestAlert(env.app), { webhook: 'sent' });
  } finally { await env.close(); }
});

test('alert channel configuration is validated; production webhooks need HTTPS', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ALERT_WEBHOOK_URL: 'http://hooks.example.test/x' }), /ALERT_WEBHOOK_URL must use HTTPS/);
  assert.throws(() => loadConfig({ ALERT_WEBHOOK_URL: 'not a url' }), /ALERT_WEBHOOK_URL must be a URL/);
  assert.throws(() => loadConfig({ ALERT_EMAIL: 'a@example.com, b@example.com' }), /ALERT_EMAIL must be one email address/);
  assert.equal(loadConfig({ ALERT_WEBHOOK_URL: 'http://127.0.0.1:9/x' }).alerts.webhookUrl, 'http://127.0.0.1:9/x', 'plain HTTP only outside production');
});
