// Flow v1 engine: versions, durable steps, waits, approvals, retries, recovery, isolation and usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { flowProblems } from '../src/shared/flow-logic.mjs';
import { processFlowRuns } from '../src/flow/engine.mjs';
import { dispatchOutbox } from '../src/flow/service.mjs';
import { setup, signUp } from './helpers.mjs';

const MINUTE = 60000;
const enquiry = { title: 'Enquiry', presentation: 'classic', mode: 'lead_qualification', lead_scoring: { warm: 20, hot: 50 }, fields: [
  { id: 'name', type: 'short_text', label: 'Name', required: true },
  { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'timing', type: 'single_choice', label: 'When?', required: true, options: [{ id: 'now', label: 'Now', lead_points: 60 }, { id: 'later', label: 'Later', lead_points: 5 }] }
] };

async function fixture(options = {}) {
  const env = await setup(options);
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Flow owner');
  const base = `/api/workspaces/${ws.id}`;
  const form = (await owner.post(base + '/forms', { definition: enquiry })).body;
  await owner.post(`${base}/forms/${form.id}/publish`);
  const hooks = [];
  env.app.assertPublicHost = async url => { if (/internal|127\.0\.0\.1|10\./.test(url)) throw new Error('private'); };
  env.app.fetchWebhook = async (url, init) => { const handler = hooks.shift(); if (!handler) return new Response('ok', { status: 200 }); return handler(url, init); };
  const flow = async (definition, name = 'Test workflow') => {
    const created = await owner.post(base + '/flow/workflows', { name, definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const published = await owner.post(`${base}/flow/workflows/${created.body.id}/publish`, { revision: created.body.draft_revision });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const on = await owner.post(`${base}/flow/workflows/${created.body.id}/status`, { status: 'enabled' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return on.body;
  };
  const respond = (answers, id = randomUUID()) => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers, submission_id: id.replace(/-/g, '').slice(0, 24) });
  const tick = async () => { await env.app.worker.tick(); };
  const runs = flowId => env.app.db.all('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY created_at', flowId);
  const steps = runId => Object.fromEntries(env.app.db.all('SELECT step_id, status, error, attempts FROM flow_run_steps WHERE run_id = ?', runId).map(row => [row.step_id, row]));
  const usage = () => Number(env.app.db.get("SELECT COALESCE(SUM(count), 0) AS n FROM usage_counters WHERE workspace_id = ? AND metric = 'flow_runs'", ws.id).n);
  return { ...env, owner, ws, user, base, form, flow, respond, tick, runs, steps, hooks, usage };
}

const trigger = form => ({ type: 'forms.response.created', source: form.id });
const email = (id, subject = 'Hello {{contact.name}}') => ({ id, type: 'action', action: 'send_email', config: { to: 'contact', subject, body: 'Body for {{contact.name}}' } });
const task = (id, title = 'Call {{contact.name}}') => ({ id, type: 'action', action: 'create_task', config: { title, assign_to: 'none' } });

test('definitions are validated: branches, rules, AI review and step ids', () => {
  const base = { trigger: { type: 'forms.response.created' }, steps: [{ id: 'a', type: 'action', action: 'create_task', config: { title: 'x' } }] };
  assert.deepEqual(flowProblems(base), []);
  const branch = paths => ({ ...base, steps: [{ id: 'b', type: 'branch', paths }] });
  const path = (id, rules, steps = []) => ({ id, label: id, match: 'all', rules, steps });
  const rule = [{ field: 'lead.band', op: 'equals', value: 'Hot' }];
  assert.match(flowProblems(branch([path('one', rule)])).join(' '), /2 or 3 paths/);
  assert.match(flowProblems(branch([path('a', rule), path('b', rule), path('c', rule), path('d', [])])).join(' '), /2 or 3 paths/);
  assert.match(flowProblems(branch([path('a', []), path('b', rule)])).join(' '), /only the last path can be “Otherwise”/);
  assert.match(flowProblems(branch([path('a', rule, [{ id: 'x', type: 'branch', paths: [] }]), path('b', [])])).join(' '), /cannot contain another set of paths/);
  assert.match(flowProblems({ ...base, steps: [{ id: 'c', type: 'condition', match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: '' }] }, base.steps[0]] }).join(' '), /enter a value/);
  assert.match(flowProblems({ ...base, steps: [{ id: 'd', type: 'action', action: 'ai_draft', config: { instruction: 'Write' } }, { id: 'e', type: 'action', action: 'send_email', config: { to: 'contact', subject: 's', body: '{{steps.d.text}}' } }] }).join(' '), /Add an approval step/);
  assert.deepEqual(flowProblems({ ...base, steps: [{ id: 'd', type: 'action', action: 'ai_draft', config: { instruction: 'Write' } }, { id: 'r', type: 'approval', approver: 'admins', expires_hours: 24, title: 'Review' }, { id: 'e', type: 'action', action: 'send_email', config: { to: 'contact', subject: 's', body: '{{steps.d.text}}' } }] }), []);
  assert.match(flowProblems({ ...base, steps: [base.steps[0], base.steps[0]] }).join(' '), /share an id/);
});

test('one execution counts once however many steps; duplicates, simulations and tests are free', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [
      { id: 'hot', type: 'condition', match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: 'Hot' }] }, email('mail'), task('call')
    ] });
    await env.respond({ name: 'Priya', email: 'priya@example.com', timing: 'now' });
    env.clock.now += 1000;
    await env.respond({ name: 'Ravi', email: 'ravi@example.com', timing: 'later' });
    await env.tick();
    const runs = env.runs(flow.id);
    assert.equal(runs.length, 2);
    const byStatus = Object.fromEntries(runs.map(run => [run.status, run]));
    assert.equal(byStatus.succeeded.version, 1);
    assert.match(byStatus.skipped.reason, /Only-if rule not met/);
    assert.equal(env.sent.filter(message => message.subject === 'Hello Priya').length, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Call Priya'").n, 1);
    assert.equal(env.usage(), 2, 'two executions, three steps each, count twice');
    // A redelivered event changes nothing.
    env.app.db.run('UPDATE outbox SET dispatched_at = NULL');
    dispatchOutbox(env.app);
    await env.tick();
    assert.equal(env.runs(flow.id).length, 2);
    assert.equal(env.usage(), 2);
    // Simulation and "send test to me" never count.
    const priya = env.app.db.get("SELECT id FROM responses WHERE answers LIKE '%Priya%'").id;
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${flow.id}/test`, {})).body.outcome, 'skipped', 'the latest record (Ravi) stops at the rule');
    const simulated = await env.owner.post(`${env.base}/flow/workflows/${flow.id}/test`, { record_id: priya });
    assert.equal(simulated.status, 200, JSON.stringify(simulated.body));
    assert.equal(simulated.body.counted, false);
    assert.equal(simulated.body.steps.find(step => step.id === 'mail').preview.to, 'p***@example.com', 'samples are masked');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${flow.id}/test-send`, { step_id: 'mail' })).status, 400, 'needs confirmation');
    const sent = await env.owner.post(`${env.base}/flow/workflows/${flow.id}/test-send`, { step_id: 'mail', confirm: true, destination: 'someone-else@example.com' });
    assert.equal(sent.body.status, 'accepted');
    assert.equal(env.sent.at(-1).to, (await env.owner.get('/api/me')).body.user.email, 'tests go only to the author');
    assert.equal(env.usage(), 2);
  } finally { await env.close(); }
});

test('runs finish on the version they started with; republishing never rewrites active runs', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [{ id: 'pause', type: 'wait', mode: 'duration', minutes: 60 }, email('mail', 'Version one')] });
    await env.respond({ name: 'Asha', email: 'asha@example.com', timing: 'now' });
    await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'waiting');
    const current = (await env.owner.get(`${env.base}/flow/workflows/${flow.id}`)).body;
    const saved = await env.owner.raw('PUT', `${env.base}/flow/workflows/${flow.id}/draft`, { revision: current.draft_revision, definition: { trigger: trigger(env.form), steps: [{ id: 'pause', type: 'wait', mode: 'duration', minutes: 60 }, email('mail', 'Version two')] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.unpublished_changes, true);
    assert.equal((await env.owner.raw('PUT', `${env.base}/flow/workflows/${flow.id}/draft`, { revision: current.draft_revision, name: 'Stale' })).status, 409, 'stale tabs cannot overwrite');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${flow.id}/publish`, { revision: saved.body.draft_revision })).body.published_version, 2);
    await env.respond({ name: 'Bina', email: 'bina@example.com', timing: 'now' });
    await env.tick();
    env.clock.now += 61 * MINUTE;
    await env.tick();
    const subjects = env.sent.map(message => message.subject);
    assert.ok(subjects.includes('Version one'), 'the earlier run used version 1');
    assert.ok(subjects.includes('Version two'), 'the later run used version 2');
    assert.deepEqual(env.runs(flow.id).map(run => run.version), [1, 2]);
  } finally { await env.close(); }
});

test('timers survive a restart: a waiting run resumes in a new process from the same database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedora-flow-'));
  const db = openDatabase(join(dir, 'flow.db'));
  try {
    const first = await fixture({ db });
    const flow = await first.flow({ trigger: trigger(first.form), steps: [{ id: 'later', type: 'wait', mode: 'duration', minutes: 1440 }, task('after')] });
    await first.respond({ name: 'Kiran', email: 'kiran@example.com', timing: 'now' });
    await first.tick();
    assert.equal(first.runs(flow.id)[0].status, 'waiting');
    const resumeAt = first.runs(flow.id)[0].next_attempt_at;
    await first.close();
    const second = await setup({ db });
    try {
      second.clock.now = resumeAt - 1000;
      await second.app.worker.tick();
      assert.equal(second.app.db.get('SELECT status FROM flow_runs WHERE flow_id = ?', flow.id).status, 'waiting', 'not before its time');
      second.clock.now = resumeAt + 1;
      await second.app.worker.tick();
      assert.equal(second.app.db.get('SELECT status FROM flow_runs WHERE flow_id = ?', flow.id).status, 'succeeded');
      assert.equal(second.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Call {{contact.name}}' OR title = 'Call Kiran'").n, 1);
    } finally { await second.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent workers execute each step once; a crash mid-call leaves an uncertain step for a person to decide', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [task('first'), { id: 'hook', type: 'action', action: 'webhook', config: { url: 'https://hooks.example.com/in', include: 'minimal' } }, email('mail')] });
    await env.respond({ name: 'Meera', email: 'meera@example.com', timing: 'now' });
    dispatchOutbox(env.app);
    // Two workers race for the same due run: only one claim wins.
    const [a, b] = await Promise.all([processFlowRuns(env.app, { owner: 'worker-a' }), processFlowRuns(env.app, { owner: 'worker-b' })]);
    assert.equal(a + b, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE source_run_id LIKE 'flow:%'").n, 1);
    assert.equal(env.runs(flow.id)[0].status, 'succeeded');

    // Simulate a worker that died during the webhook call on a second run.
    await env.respond({ name: 'Nila', email: 'nila@example.com', timing: 'now' });
    dispatchOutbox(env.app);
    const run = env.runs(flow.id)[1];
    env.app.db.run("UPDATE flow_runs SET status = 'running', lease_owner = 'dead', lease_until = ? WHERE id = ?", env.clock.now - 1, run.id);
    env.app.db.run("INSERT INTO flow_run_steps (run_id, step_id, step_type, status, attempts, started_at) VALUES (?, 'first', 'create_task', 'succeeded', 1, ?), (?, 'hook', 'webhook', 'running', 1, ?)", run.id, env.clock.now, run.id, env.clock.now);
    await processFlowRuns(env.app, { owner: 'worker-c' });
    let current = env.app.db.get('SELECT * FROM flow_runs WHERE id = ?', run.id);
    assert.equal(current.status, 'failed');
    assert.match(current.reason, /may or may not have happened/);
    assert.equal(env.steps(run.id).hook.status, 'uncertain');
    assert.equal(env.sent.filter(message => message.subject === 'Hello Nila').length, 0, 'nothing after the uncertain step ran');
    const preview = (await env.owner.get(`${env.base}/flow/runs/${run.id}/retry`)).body;
    assert.deepEqual(preview.already_done, ['Create a task: “Call [Contact name]”'], 'fields read as names, never tokens');
    assert.equal(preview.uncertain.length, 1);
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${run.id}/retry`, {})).status, 409, 'a person decides first');
    const retried = await env.owner.post(`${env.base}/flow/runs/${run.id}/retry`, { uncertain: 'done' });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    await env.tick();
    current = env.app.db.get('SELECT * FROM flow_runs WHERE id = ?', run.id);
    assert.equal(current.status, 'succeeded');
    assert.equal(env.hooks.length, 0);
    assert.equal(env.sent.filter(message => message.subject === 'Hello Nila').length, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE source_run_id = ?", `flow:${run.id}:first`).n, 0, 'the recorded task step was not repeated');
    assert.equal(env.usage(), 2, 'retries are free');
  } finally { await env.close(); }
});

test('partial success: a later transient failure retries without repeating the email; an unanswered call is uncertain', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [email('mail'), { id: 'hook', type: 'action', action: 'webhook', config: { url: 'https://hooks.example.com/in' } }] });
    env.hooks.push(() => new Response('busy', { status: 503 }));
    await env.respond({ name: 'Omar', email: 'omar@example.com', timing: 'now' });
    await env.tick();
    let run = env.runs(flow.id)[0];
    assert.equal(run.status, 'retrying');
    assert.equal(env.steps(run.id).mail.status, 'succeeded');
    env.hooks.push(async () => { throw new Error('socket hang up'); });
    env.clock.now = run.next_attempt_at + 1;
    await env.tick();
    run = env.runs(flow.id)[0];
    assert.equal(run.status, 'failed');
    assert.equal(env.steps(run.id).hook.status, 'uncertain');
    assert.equal(env.sent.filter(message => message.subject === 'Hello Omar').length, 1);
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${run.id}/retry`, { uncertain: 'resend' })).status, 200);
    let idempotency;
    env.hooks.push((url, init) => { idempotency = init.headers['Idempotency-Key']; assert.match(init.headers['Schedora-Signature'], /^t=\d+,v1=[a-f0-9]{64}$/); return new Response('ok', { status: 200 }); });
    await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'succeeded');
    assert.equal(idempotency, `flow:${run.id}:hook`, 'the resend carries the same idempotency key');
    assert.equal(env.sent.filter(message => message.subject === 'Hello Omar').length, 1);
  } finally { await env.close(); }
});

test('wait for a booking matches the same person; timeouts win cleanly; pause holds and cancel ends runs', async () => {
  const env = await fixture();
  try {
    const event = (await env.owner.post(env.base + '/event-types', { title: 'Call', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
    const flow = await env.flow({ trigger: trigger(env.form), steps: [
      { id: 'booked', type: 'wait_for', event: 'meet.booking.created', timeout_minutes: 1440 },
      { id: 'which', type: 'branch', paths: [
        { id: 'yes', label: 'Booked', match: 'all', rules: [{ field: 'steps.booked.happened', op: 'equals', value: 'yes' }], steps: [task('booked-task', 'Booked {{contact.name}}')] },
        { id: 'no', label: 'Not booked', rules: [], steps: [task('chase', 'Chase {{contact.name}}')] }
      ] }
    ] });
    await env.respond({ name: 'Zara', email: 'zara@example.com', timing: 'now' });
    env.clock.now += 1000;
    await env.respond({ name: 'Yusuf', email: 'yusuf@example.com', timing: 'now' });
    await env.tick();
    assert.deepEqual(env.runs(flow.id).map(run => run.status), ['waiting', 'waiting']);
    const book = async who => {
      const slots = (await env.client().get(`/api/public/meet/${env.ws.slug}/${event.slug}/slots`)).body.slots;
      return env.client().post(`/api/public/meet/${env.ws.slug}/${event.slug}/bookings`, { name: who, email: `${who.toLowerCase()}@example.com`, timezone: 'UTC', start: slots[0] }, { 'Idempotency-Key': randomUUID() });
    };
    // Someone else booking does not satisfy Zara's wait.
    await book('Stranger');
    await env.tick();
    assert.deepEqual(env.runs(flow.id).map(run => run.status), ['waiting', 'waiting']);
    await book('Zara');
    await env.tick();
    const runFor = name => env.app.db.get('SELECT r.* FROM flow_runs r JOIN responses s ON s.id = r.subject_id WHERE r.flow_id = ? AND s.answers LIKE ?', flow.id, '%' + name + '%');
    const [zara, yusuf] = [runFor('Zara'), runFor('Yusuf')];
    assert.equal(env.app.db.get('SELECT status FROM flow_runs WHERE id = ?', zara.id).status, 'succeeded');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Booked Zara'").n, 1);
    // Pause: the timeout passes while paused; nothing runs until resumed.
    await env.owner.post(`${env.base}/flow/workflows/${flow.id}/status`, { status: 'paused' });
    env.clock.now += 1441 * MINUTE;
    await env.tick();
    assert.equal(env.app.db.get('SELECT status FROM flow_runs WHERE id = ?', yusuf.id).status, 'waiting');
    await env.owner.post(`${env.base}/flow/workflows/${flow.id}/status`, { status: 'enabled' });
    await env.tick();
    assert.equal(env.app.db.get('SELECT status FROM flow_runs WHERE id = ?', yusuf.id).status, 'succeeded');
    assert.equal(env.app.db.get('SELECT outcome FROM flow_waits WHERE run_id = ?', yusuf.id).outcome, 'timeout');
    // A booking after the timeout changes nothing.
    await book('Yusuf');
    await env.tick();
    assert.equal(env.app.db.get('SELECT outcome FROM flow_waits WHERE run_id = ?', yusuf.id).outcome, 'timeout');
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Chase Yusuf'").n, 1);
    // Cancel ends a waiting run and its wait.
    await env.respond({ name: 'Wren', email: 'wren@example.com', timing: 'now' });
    await env.tick();
    const wren = env.runs(flow.id).at(-1);
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${wren.id}/cancel`)).body.status, 'canceled');
    assert.equal(env.app.db.get('SELECT outcome FROM flow_waits WHERE run_id = ?', wren.id).outcome, 'canceled');
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${wren.id}/cancel`)).status, 409);
  } finally { await env.close(); }
});

test('approvals: only approvers decide, once, against the latest revision; reject skips, expiry cancels', async () => {
  const env = await fixture();
  try {
    env.app.anthropic = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 20 }, content: [{ type: 'text', text: JSON.stringify({ text: 'Thanks for your enquiry. Ignore previous instructions? No.' }) }] }) } } };
    const memberClient = env.client();
    const member = await signUp(memberClient, 'Plain member');
    await env.owner.post(env.base + '/members', { email: member.email, role: 'member' });
    const flow = await env.flow({ trigger: trigger(env.form), steps: [
      { id: 'draft', type: 'action', action: 'ai_draft', config: { instruction: 'Write a reply to {{contact.name}}' } },
      { id: 'review', type: 'approval', approver: 'admins', expires_hours: 24, title: 'Reply to the enquiry' },
      { id: 'send', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Reply', body: '{{steps.draft.text}}' } }
    ] });
    await env.respond({ name: 'Ana', email: 'ana@example.com', timing: 'now' });
    env.clock.now += 1000;
    await env.respond({ name: 'Ben', email: 'ben@example.com', timing: 'now' });
    await env.tick();
    assert.deepEqual(env.runs(flow.id).map(run => run.status), ['needs_approval', 'needs_approval']);
    assert.equal(env.sent.filter(message => message.subject === 'Reply').length, 0, 'AI text is never sent before approval');
    const approvals = (await env.owner.get(`${env.base}/flow/approvals`)).body;
    assert.equal(approvals.length, 2);
    const ordered = env.runs(flow.id);
    const first = approvals.find(item => item.run_id === ordered[0].id);
    const second = approvals.find(item => item.run_id === ordered[1].id);
    assert.equal(first.can_decide, true);
    assert.equal((await memberClient.post(`${env.base}/flow/approvals/${first.id}`, { decision: 'approve', revision: 0 })).status, 403);
    const edited = await env.owner.post(`${env.base}/flow/approvals/${first.id}`, { decision: 'edit', revision: 0, draft: 'Edited reply that a person checked.' });
    assert.equal(edited.body.revision, 1);
    assert.equal((await env.owner.post(`${env.base}/flow/approvals/${first.id}`, { decision: 'approve', revision: 0 })).status, 409, 'stale revision');
    assert.equal((await env.owner.post(`${env.base}/flow/approvals/${first.id}`, { decision: 'approve', revision: 1 })).body.status, 'approved');
    assert.equal((await env.owner.post(`${env.base}/flow/approvals/${first.id}`, { decision: 'approve', revision: 1 })).status, 409, 'decided once');
    assert.equal((await env.owner.post(`${env.base}/flow/approvals/${second.id}`, { decision: 'reject', revision: 0, note: 'Not now' })).body.status, 'rejected');
    await env.tick();
    const [a, b] = env.runs(flow.id);
    assert.equal(a.status, 'succeeded');
    assert.equal(env.sent.find(message => message.subject === 'Reply').body, 'Edited reply that a person checked.', 'the approved text is sent');
    assert.equal(b.status, 'skipped');
    assert.match(b.reason, /Not approved: Not now/);
    const usage = JSON.parse(env.app.db.get("SELECT output FROM flow_run_steps WHERE run_id = ? AND step_id = 'draft'", a.id).output).usage;
    assert.deepEqual(usage, { input_tokens: 30, output_tokens: 20 });
    // Expiry.
    await env.respond({ name: 'Cy', email: 'cy@example.com', timing: 'now' });
    await env.tick();
    env.clock.now += 25 * 60 * MINUTE;
    await env.tick();
    const expired = env.runs(flow.id).at(-1);
    assert.equal(expired.status, 'canceled');
    assert.match(expired.reason, /expired/);
  } finally { await env.close(); }
});

test('other workspaces cannot read or act on workflows, runs or approvals; timelines are redacted', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [email('mail')] });
    await env.respond({ name: 'Dev', email: 'dev.person@example.com', timing: 'now' });
    await env.tick();
    const run = env.runs(flow.id)[0];
    const timeline = (await env.owner.get(`${env.base}/flow/runs/${run.id}`)).body;
    assert.equal(timeline.steps[0].status, 'succeeded');
    assert.equal(timeline.steps[0].output.to, 'd***@example.com');
    assert.equal(timeline.steps[0].delivery.accepted, true);
    assert.ok(!JSON.stringify(timeline).includes('dev.person@example.com'));
    const intruder = env.client();
    const { ws: other } = await signUp(intruder, 'Intruder');
    for (const path of [`/flow/workflows/${flow.id}`, `/flow/runs/${run.id}`, `/flow/runs/${run.id}/retry`]) {
      assert.equal((await intruder.get(`/api/workspaces/${other.id}${path}`)).status, 404, path);
      assert.equal((await intruder.get(`${env.base}${path}`)).status, 404, 'not a member: ' + path);
    }
    assert.equal((await intruder.post(`/api/workspaces/${other.id}/flow/runs/${run.id}/cancel`)).status, 404);
  } finally { await env.close(); }
});

test('three failures in a row alert once and can pause the workflow automatically', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [{ id: 'hook', type: 'action', action: 'webhook', config: { url: 'https://hooks.example.com/in' } }] });
    const current = (await env.owner.get(`${env.base}/flow/workflows/${flow.id}`)).body;
    await env.owner.raw('PUT', `${env.base}/flow/workflows/${flow.id}/draft`, { revision: current.draft_revision, auto_pause: true });
    for (let index = 0; index < 3; index++) {
      env.hooks.push(() => new Response('no', { status: 410 }));
      await env.respond({ name: 'Fail' + index, email: `fail${index}@example.com`, timing: 'now' });
      await env.tick();
    }
    const after = (await env.owner.get(`${env.base}/flow/workflows/${flow.id}`)).body;
    assert.equal(after.failing, true);
    assert.equal(after.status, 'paused');
    assert.equal(env.sent.filter(message => /Workflow failing/.test(message.subject)).length, 1);
    const bulk = await env.owner.post(`${env.base}/flow/workflows/${flow.id}/retry-failed`, {});
    assert.equal(bulk.body.retried, 3);
  } finally { await env.close(); }
});

test('turning on needs a published version and tested connections; simulation stays available', async () => {
  const env = await fixture({ config: { production: false } });
  try {
    const created = (await env.owner.post(env.base + '/flow/workflows', { name: 'Slack ping', definition: { trigger: trigger(env.form), steps: [{ id: 'ping', type: 'action', action: 'slack', config: { text: 'New enquiry from {{contact.name}}' } }] } })).body;
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${created.id}/status`, { status: 'enabled' })).status, 409, 'publish first');
    await env.owner.post(`${env.base}/flow/workflows/${created.id}/publish`, { revision: created.draft_revision });
    const blocked = await env.owner.post(`${env.base}/flow/workflows/${created.id}/status`, { status: 'enabled' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /Slack is not configured/);
    assert.equal((await env.owner.get(env.base + '/flow/integrations')).body.slack.state, 'not_configured');
    assert.equal((await env.owner.raw('PUT', env.base + '/flow/integrations/slack', { webhook_url: 'https://evil.example.com/hook' })).status, 400);
    assert.equal((await env.owner.raw('PUT', env.base + '/flow/integrations/slack', { webhook_url: 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop', channel: '#leads' })).body.state, 'connected');
    assert.match((await env.owner.post(`${env.base}/flow/workflows/${created.id}/status`, { status: 'enabled' })).body.error.message, /not tested yet/);
    const tested = await env.owner.post(`${env.base}/flow/workflows/${created.id}/test-send`, { step_id: 'ping', confirm: true });
    assert.equal(tested.body.status, 'accepted');
    assert.equal((await env.owner.get(env.base + '/flow/integrations')).body.slack.state, 'tested');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${created.id}/status`, { status: 'enabled' })).status, 200);
  } finally { await env.close(); }
});

test('messages respect consent, approved templates and phone formats; webhooks refuse private hosts', async () => {
  const env = await fixture({ config: { whatsappProvider: 'twilio', twilioAccountSid: 'AC' + 'a'.repeat(32), twilioAuthToken: 'token', twilioWhatsappFrom: 'whatsapp:+14155552671', twilioWhatsappContentSid: 'HX' + 'b'.repeat(32), twilioWhatsappReceiptContentSid: 'HX' + 'c'.repeat(32), twilioWhatsappFlowTemplates: { lead_followup: { sid: 'HX' + 'd'.repeat(32), variables: ['Name', 'Link'] } } } });
  try {
    const whatsapp = [];
    env.app.whatsappProvider = { name: 'twilio', async send(message) { whatsapp.push(message); return { id: 'SM' + String(whatsapp.length).padStart(32, '0') }; } };
    const form = (await env.owner.post(env.base + '/forms', { definition: { title: 'Opt in', presentation: 'classic', receipts: { whatsapp: { phone_field: 'phone' } }, fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }, { id: 'phone', type: 'phone', label: 'Phone' }] } })).body;
    await env.owner.post(`${env.base}/forms/${form.id}/publish`);
    // WhatsApp needs a tested connection before the workflow can go live.
    const draft = (await env.owner.post(env.base + '/flow/workflows', { name: 'WA', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'wa', type: 'action', action: 'send_whatsapp', config: { to: 'contact', template: 'lead_followup', variables: ['{{contact.name}}', 'https://example.com'] } }, { id: 'done', type: 'action', action: 'create_task', config: { title: 'After WA {{contact.name}}' } }] } })).body;
    await env.owner.post(`${env.base}/flow/workflows/${draft.id}/publish`, { revision: draft.draft_revision });
    assert.match((await env.owner.post(`${env.base}/flow/workflows/${draft.id}/status`, { status: 'enabled' })).body.error.message, /not tested yet/);
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${draft.id}/test-send`, { step_id: 'wa', confirm: true, destination: '98765' })).status, 400, 'a country code is required');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${draft.id}/test-send`, { step_id: 'wa', confirm: true, destination: '+91 98765 43210' })).body.status, 'accepted');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${draft.id}/status`, { status: 'enabled' })).status, 200);
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'NoConsent', email: 'nc@example.com', phone: '+919876543210' }, submission_id: 'wa-no-consent-0001' });
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Consented', email: 'yes@example.com', phone: '+919812345678' }, whatsapp_receipt: true, submission_id: 'wa-consent-00000001' });
    await env.tick();
    const runs = env.runs(draft.id);
    assert.deepEqual(runs.map(run => run.status), ['succeeded', 'succeeded']);
    assert.equal(env.steps(runs[0].id).wa.status, 'skipped');
    assert.match(env.steps(runs[0].id).wa.error, /not agreed to WhatsApp/);
    const flowMessages = whatsapp.filter(message => JSON.parse(message.body).template === 'flow:lead_followup');
    assert.equal(flowMessages.length, 2, 'the test plus the consented contact');
    assert.deepEqual(JSON.parse(flowMessages[1].body).variables, { 1: 'Consented', 2: 'https://example.com' });
    // Webhook steps must point at public https addresses.
    const hook = (await env.owner.post(env.base + '/flow/workflows', { name: 'Hook', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'h', type: 'action', action: 'webhook', config: { url: 'https://10.0.0.5/internal' } }] } })).body;
    const refused = await env.owner.post(`${env.base}/flow/workflows/${hook.id}/publish`, { revision: hook.draft_revision });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /public https/);
  } finally { await env.close(); }
});

test('an email interrupted mid-send is never resent automatically; a person chooses resend or done', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: trigger(env.form), steps: [email('mail', 'Interrupted {{contact.name}}')] });
    const realSend = env.emailProvider.send;
    // The first worker's provider call never returns: the process is as good as dead.
    env.emailProvider.send = () => new Promise(() => {});
    await env.respond({ name: 'Ola', email: 'ola@example.com', timing: 'now' });
    dispatchOutbox(env.app);
    void processFlowRuns(env.app, { owner: 'worker-dead' });
    await new Promise(resolve => setImmediate(resolve));
    const run = env.runs(flow.id)[0];
    assert.equal(run.status, 'running');
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE idempotency_key = ?", `flow:${run.id}:mail`).status, 'sending');
    env.emailProvider.send = realSend;
    // Leases and email claims expire; the restarted worker and the email queue run several times.
    env.clock.now += 5 * 60000;
    for (let index = 0; index < 3; index++) await env.tick();
    assert.equal(env.steps(run.id).mail.status, 'uncertain');
    assert.equal(env.runs(flow.id)[0].status, 'failed');
    assert.equal(env.sent.filter(message => message.subject === 'Interrupted Ola').length, 0, 'the email queue does not resend it on its own');
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${run.id}/retry`, { uncertain: 'resend' })).status, 200);
    for (let index = 0; index < 2; index++) await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'succeeded');
    assert.equal(env.sent.filter(message => message.subject === 'Interrupted Ola').length, 1, 'resend sends exactly one copy');

    // "Treat as done" closes the interrupted message without sending it.
    env.emailProvider.send = () => new Promise(() => {});
    await env.respond({ name: 'Pia', email: 'pia@example.com', timing: 'now' });
    dispatchOutbox(env.app);
    void processFlowRuns(env.app, { owner: 'worker-dead-2' });
    await new Promise(resolve => setImmediate(resolve));
    env.emailProvider.send = realSend;
    env.clock.now += 5 * 60000;
    for (let index = 0; index < 2; index++) await env.tick();
    const second = env.runs(flow.id)[1];
    assert.equal((await env.owner.post(`${env.base}/flow/runs/${second.id}/retry`, { uncertain: 'done' })).status, 200);
    for (let index = 0; index < 2; index++) await env.tick();
    assert.equal(env.runs(flow.id)[1].status, 'succeeded');
    assert.equal(env.sent.filter(message => message.subject === 'Interrupted Pia').length, 0);
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE idempotency_key = ?", `flow:${second.id}:mail`).status, 'canceled');
  } finally { await env.close(); }
});
