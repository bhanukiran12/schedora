// Flow v1 triggers: sheets (edits, undo/redo, automation), no-show, edits, payments, timers, webhooks, AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { scanTimedTriggers } from '../src/flow/engine.mjs';
import { setup, signUp } from './helpers.mjs';

const MINUTE = 60000;
async function fixture(options) {
  const env = await setup(options);
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Trigger owner');
  const base = `/api/workspaces/${ws.id}`;
  const flow = async (definition, name = 'Workflow') => {
    const created = await owner.post(base + '/flow/workflows', { name, definition });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const published = await owner.post(`${base}/flow/workflows/${created.body.id}/publish`, { revision: created.body.draft_revision });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const on = await owner.post(`${base}/flow/workflows/${created.body.id}/status`, { status: 'enabled' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return on.body;
  };
  const runs = flowId => env.app.db.all('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY created_at', flowId);
  const tick = () => env.app.worker.tick();
  return { ...env, owner, ws, user, base, flow, runs, tick };
}
const task = (id, title) => ({ id, type: 'action', action: 'create_task', config: { title } });

async function workbook(env) {
  const book = (await env.owner.post(env.base + '/workbooks', { title: 'Students' })).body;
  const sheet = (await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0];
  const change = (ops, origin) => env.owner.post(`${env.base}/workbooks/${book.id}/changes`, { ops, ...(origin ? { origin } : {}) });
  const head = await change([{ op: 'cell', sheet: sheet.id, cell: 'A1', from: null, to: 'Name' }, { op: 'cell', sheet: sheet.id, cell: 'B1', from: null, to: 'Email' }, { op: 'cell', sheet: sheet.id, cell: 'C1', from: null, to: 'Status' }, { op: 'cell', sheet: sheet.id, cell: 'D1', from: null, to: 'Welcome sent' }]);
  assert.equal(head.status, 200, JSON.stringify(head.body));
  return { book, sheet, change };
}

test('sheet triggers: user edits start runs; undo, redo and automation writes never do; canonical tabs stay read-only', async () => {
  const env = await fixture();
  try {
    const { book, sheet, change } = await workbook(env);
    const added = await env.flow({ trigger: { type: 'sheets.row.added', source: book.id, config: { sheet: sheet.id } }, steps: [task('added', 'New row {{row.name}}')] });
    const enrolled = await env.flow({ trigger: { type: 'sheets.cell.changed', source: book.id, config: { sheet: sheet.id, column: 'Status', value: 'Enrolled' } }, steps: [
      task('welcome', 'Welcome {{row.name}}'),
      { id: 'mark', type: 'action', action: 'sheet_row', config: { workbook: book.id, sheet: sheet.id, mode: 'update', match_column: 'Email', match_value: '{{row.email}}', values: { Status: 'Enrolled', 'Welcome sent': 'Yes' } } }
    ] });
    await change([{ op: 'cell', sheet: sheet.id, cell: 'A2', from: null, to: 'Asha' }, { op: 'cell', sheet: sheet.id, cell: 'B2', from: null, to: 'asha@example.com' }]);
    await env.tick();
    assert.equal(env.runs(added.id).length, 1, 'one run for the new row');
    await change([{ op: 'cell', sheet: sheet.id, cell: 'C2', from: null, to: 'Enrolled' }]);
    await env.tick();
    assert.equal(env.runs(enrolled.id).length, 1);
    assert.equal(env.runs(enrolled.id)[0].status, 'succeeded', JSON.stringify(env.runs(enrolled.id)[0]));
    const after = (await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0].cells;
    assert.equal(after.D2, 'Yes', 'the automation wrote the row');
    // Undo puts the old value back, redo restores Enrolled: neither starts a second run.
    await change([{ op: 'cell', sheet: sheet.id, cell: 'C2', from: 'Enrolled', to: null, origin: 'undo' }]);
    await change([{ op: 'cell', sheet: sheet.id, cell: 'C2', from: null, to: 'Enrolled', origin: 'redo' }]);
    await env.tick();
    assert.equal(env.runs(enrolled.id).length, 1, 'undo and redo do not run it again');
    // The automation's own write (Status, Welcome sent) never retriggers either workflow.
    assert.equal(env.runs(added.id).length, 1);
    const origins = env.app.db.all("SELECT origin FROM outbox WHERE type LIKE 'sheets.%'").map(row => row.origin);
    assert.ok(origins.includes('undo') && origins.includes('redo') && origins.includes('automation') && origins.includes('user'), JSON.stringify([...new Set(origins)]));
    // A workflow cannot write to a canonical tab: only editable sheets can be chosen.
    const form = (await env.owner.post(env.base + '/forms', { definition: { title: 'F', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] } })).body;
    const bad = (await env.owner.post(env.base + '/flow/workflows', { name: 'Bad', definition: { trigger: { type: 'forms.response.created', source: form.id }, steps: [{ id: 'x', type: 'action', action: 'sheet_row', config: { workbook: form.id, sheet: 'responses', mode: 'add', values: { Name: 'x' } } }] } })).body;
    const refused = await env.owner.post(`${env.base}/flow/workflows/${bad.id}/publish`, { revision: bad.draft_revision });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /read-only/);
    // "Run Flow on this row" starts one run per request id.
    const manual = await env.flow({ trigger: { type: 'sheets.row.manual', source: book.id, config: { sheet: sheet.id } }, steps: [task('manual', 'Manual {{row.name}}')] });
    const request = { flow_id: manual.id, sheet: sheet.id, row: 2, request_id: randomUUID() };
    assert.equal((await env.owner.post(`${env.base}/workbooks/${book.id}/run-flow`, request)).body.duplicate, false);
    assert.equal((await env.owner.post(`${env.base}/workbooks/${book.id}/run-flow`, request)).body.duplicate, true);
    await env.tick();
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Manual Asha'").n, 1);
    assert.equal((await env.owner.get(`${env.base}/workbooks/${book.id}/row-flows`)).body.length, 1);
  } finally { await env.close(); }
});

test('no-show, response edits and verified payments each start one run; payment receipts are not duplicated', async () => {
  const env = await fixture();
  try {
    const event = (await env.owner.post(env.base + '/event-types', { title: 'Intro', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
    const noShow = await env.flow({ trigger: { type: 'meet.booking.no_show', source: event.id }, steps: [task('chase', 'Rebook {{contact.name}}')] });
    const slots = (await env.client().get(`/api/public/meet/${env.ws.slug}/${event.slug}/slots`)).body.slots;
    const booked = (await env.client().post(`/api/public/meet/${env.ws.slug}/${event.slug}/bookings`, { name: 'Gia', email: 'gia@example.com', timezone: 'UTC', start: slots[0] }, { 'Idempotency-Key': randomUUID() })).body;
    env.clock.now = Date.parse(booked.booking.ends_at) + MINUTE;
    const mark = status => env.owner.raw('POST', `${env.base}/bookings/${booked.booking.id}/attendance`, { status });
    assert.equal((await mark('no_show')).status, 200);
    await mark('attended'); await mark('no_show');
    await env.tick();
    assert.equal(env.runs(noShow.id).length, 1, 'setting no-show again does not run twice');

    const form = (await env.owner.post(env.base + '/forms', { definition: { title: 'Workshop', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }, { id: 'phone', type: 'phone', label: 'Phone' }], payment: { amount_cents: 50000, currency: 'INR' } } })).body;
    await env.owner.post(`${env.base}/forms/${form.id}/publish`);
    const completed = await env.flow({ trigger: { type: 'forms.response.created', source: form.id }, steps: [task('done', 'Completed {{contact.name}}')] });
    const paid = await env.flow({ trigger: { type: 'payments.captured', source: form.id }, steps: [task('paid', 'Paid {{contact.name}} {{payment.amount}}')] });
    const submitted = (await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Hari', email: 'hari@example.com' }, submission_id: 'paid-flow-submission-1' })).body;
    await env.tick();
    assert.equal(env.runs(completed.id).length, 0, 'a paid response is not complete before payment');
    const pay = `/api/public/form-payments/${submitted.payment.token}`;
    await env.client().post(pay + '/checkout');
    await env.client().post(pay + '/test-pay', { action: 'pay' });
    await env.client().post(pay + '/verify');
    await env.tick();
    assert.equal(env.runs(completed.id).length, 1);
    assert.equal(env.runs(paid.id).length, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Paid Hari 500.00'").n, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payments.captured'").n, 1);
  } finally { await env.close(); }
});

test('response edits start a run per saved edit', async () => {
  const env = await fixture();
  try {
    const form = (await env.owner.post(env.base + '/forms', { definition: { title: 'Editable', presentation: 'classic', responses: { allow_edit: true }, fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }] } })).body;
    await env.owner.post(`${env.base}/forms/${form.id}/publish`);
    const edited = await env.flow({ trigger: { type: 'forms.response.edited', source: form.id }, steps: [task('edit', 'Edited {{answer.name}}')] });
    const key = randomBytes(32).toString('hex');
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Before' }, submission_id: 'edit-flow-submission-1', edit_key_hash: createHash('sha256').update(key).digest('hex') });
    const saved = await env.client().patch(`/api/public/forms/${form.slug}/response-edit`, { key, revision: 0, answers: { name: 'After' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await env.tick();
    assert.equal(env.runs(edited.id).length, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Edited After'").n, 1);
  } finally { await env.close(); }
});

test('before-meeting and scheduled triggers fire once per booking or slot, never for the past', async () => {
  const env = await fixture();
  try {
    const event = (await env.owner.post(env.base + '/event-types', { title: 'Demo', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
    const slots = (await env.client().get(`/api/public/meet/${env.ws.slug}/${event.slug}/slots`)).body.slots;
    const booked = (await env.client().post(`/api/public/meet/${env.ws.slug}/${event.slug}/bookings`, { name: 'Ivy', email: 'ivy@example.com', timezone: 'UTC', start: slots[3] }, { 'Idempotency-Key': randomUUID() })).body;
    const reminder = await env.flow({ trigger: { type: 'meet.booking.before_start', source: event.id, config: { minutes: 60 } }, steps: [task('remind', 'Remind {{contact.name}}')] });
    const start = Date.parse(booked.booking.starts_at);
    env.clock.now = start - 61 * MINUTE;
    scanTimedTriggers(env.app, { force: true });
    assert.equal(env.runs(reminder.id).length, 0);
    env.clock.now = start - 59 * MINUTE;
    scanTimedTriggers(env.app, { force: true }); scanTimedTriggers(env.app, { force: true });
    assert.equal(env.runs(reminder.id).length, 1);
    const daily = await env.flow({ trigger: { type: 'schedule', config: { every: 'day', time: '09:00', timezone: 'UTC' } }, steps: [task('daily', 'Daily review')] });
    const day = Math.floor(env.clock.now / 86400000) * 86400000;
    env.clock.now = day + 86400000 + 9 * 60 * MINUTE + MINUTE;
    scanTimedTriggers(env.app, { force: true }); scanTimedTriggers(env.app, { force: true });
    assert.equal(env.runs(daily.id).length, 1);
    env.clock.now += 86400000;
    scanTimedTriggers(env.app, { force: true });
    assert.equal(env.runs(daily.id).length, 2);
  } finally { await env.close(); }
});

test('incoming webhooks need a valid signature, a fresh delivery id and a bounded JSON object', async () => {
  const env = await fixture();
  try {
    const flow = await env.flow({ trigger: { type: 'webhook.incoming' }, steps: [task('hook', 'Lead {{webhook.name}} ({{contact.email}})')] });
    const { url, secret } = (await env.owner.post(`${env.base}/flow/workflows/${flow.id}/webhook`)).body;
    const path = new URL(url).pathname;
    const send = (body, { delivery = randomUUID(), at = Math.floor(env.clock.now / 1000), key = secret, depth } = {}) => {
      const raw = JSON.stringify(body);
      const signature = createHmac('sha256', key).update(`${at}.${raw}`).digest('hex');
      return env.client().raw('POST', path, raw, { 'Content-Type': 'application/json', 'Schedora-Signature': `t=${at},v1=${signature}`, 'Schedora-Delivery': delivery, ...(depth ? { 'X-Schedora-Depth': String(depth) } : {}) });
    };
    assert.equal((await send({ name: 'Lee' }, { key: 'wrong' })).status, 401);
    assert.equal((await send({ name: 'Lee' }, { at: Math.floor(env.clock.now / 1000) - 600 })).status, 401, 'old signatures are refused');
    const first = await send({ name: 'Lee', email: 'lee@example.com', nested: { ignored: true } }, { delivery: 'delivery-1' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal((await send({ name: 'Lee' }, { delivery: 'delivery-1' })).body.status, 'duplicate', 'replays are ignored');
    assert.equal((await send({ name: 'Loop' }, { depth: 3 })).body.status, 'ignored', 'automation chains are capped');
    assert.equal((await env.client().raw('POST', path, 'x'.repeat(70 * 1024), { 'Content-Type': 'application/json' })).status, 413);
    await env.tick();
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Lead Lee (lee@example.com)'").n, 1);
    assert.equal(env.runs(flow.id).length, 1);
  } finally { await env.close(); }
});

test('“Describe your automation” creates a validated, unpublished, inactive draft and never publishes', async () => {
  const env = await fixture();
  try {
    const path = env.base + '/flow/describe';
    assert.equal((await env.owner.post(path, { description: 'When someone books, create a prep task', request_id: randomUUID() })).status, 503);
    let reply = { name: 'Prep tasks', trigger: { type: 'meet.booking.created' }, steps: [{ id: 'prep', type: 'action', action: 'create_task', config: { title: 'Prepare for {{contact.name}}', assign_to: 'host', extra: 'dropped' } }] };
    env.app.anthropic = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 120 }, content: [{ type: 'text', text: JSON.stringify(reply) }] }) } } };
    const request = { description: 'When someone books, create a prep task for the host', request_id: randomUUID() };
    const created = await env.owner.post(path, request);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.state, 'draft');
    assert.equal(created.body.published_version, null);
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.definition.steps[0].config.extra, undefined);
    assert.equal((await env.owner.post(path, request)).body.id, created.body.id, 'retrying returns the same draft');
    reply = { name: 'Unsafe', trigger: { type: 'forms.response.created' }, steps: [{ id: 'a', type: 'action', action: 'ai_draft', config: { instruction: 'x' } }, { id: 'b', type: 'action', action: 'send_email', config: { to: 'contact', subject: 's', body: '{{steps.a.text}}' } }] };
    assert.equal((await env.owner.post(path, { ...request, request_id: randomUUID() })).status, 502, 'AI text without approval is refused');
    reply = { trigger: { type: 'teleport' }, steps: [] };
    assert.equal((await env.owner.post(path, { ...request, request_id: randomUUID() })).status, 502);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM flows WHERE status <> 'draft' OR published_version IS NOT NULL").n, 0);
  } finally { await env.close(); }
});

test('a canceled booking stops its waiting and approval runs; workflows started by the cancellation still run', async () => {
  const env = await fixture();
  try {
    const event = (await env.owner.post(env.base + '/event-types', { title: 'Consult', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
    const slots = (await env.client().get(`/api/public/meet/${env.ws.slug}/${event.slug}/slots`)).body.slots;
    const book = (name, start) => env.client().post(`/api/public/meet/${env.ws.slug}/${event.slug}/bookings`, { name, email: `${name.toLowerCase()}@example.com`, timezone: 'UTC', start }, { 'Idempotency-Key': randomUUID() });
    const later = await env.flow({ trigger: { type: 'meet.booking.created', source: event.id }, steps: [{ id: 'w', type: 'wait', mode: 'duration', minutes: 1440 }, { id: 'm', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Follow up {{contact.name}}', body: 'Hi' } }] });
    const approve = await env.flow({ trigger: { type: 'meet.booking.created', source: event.id }, steps: [{ id: 'a', type: 'approval', approver: 'admins', expires_hours: 48, title: 'Prep {{contact.name}}' }, task('t', 'After approval')] });
    const rebook = await env.flow({ trigger: { type: 'meet.booking.canceled', source: event.id }, steps: [task('r', 'Offer a new time to {{contact.name}}')] });
    const kept = (await book('Keep', slots[2])).body.booking;
    const gone = (await book('Gone', slots[3])).body.booking;
    await env.tick(); await env.tick();
    const runOf = (flowId, bookingId) => env.app.db.get('SELECT * FROM flow_runs WHERE flow_id = ? AND subject_id = ?', flowId, bookingId);
    assert.equal(runOf(later.id, gone.id).status, 'waiting');
    assert.equal(runOf(approve.id, gone.id).status, 'needs_approval');
    const canceled = await env.owner.post(`${env.base}/bookings/${gone.id}/cancel`, {});
    assert.ok([200, 204].includes(canceled.status), JSON.stringify(canceled.body));
    await env.tick(); await env.tick();
    for (const flowId of [later.id, approve.id]) {
      const run = runOf(flowId, gone.id);
      assert.equal(run.status, 'canceled');
      assert.equal(run.reason, 'The booking was canceled.');
    }
    assert.equal(env.app.db.get("SELECT status FROM flow_approvals WHERE run_id = ?", runOf(approve.id, gone.id).id).status, 'canceled');
    assert.equal(runOf(rebook.id, gone.id).status, 'succeeded', 'the cancellation workflow itself runs');
    env.clock.now += 1441 * MINUTE;
    await env.tick(); await env.tick();
    assert.equal(env.sent.filter(message => message.subject === 'Follow up Gone').length, 0, 'no follow-up for a canceled meeting');
    assert.equal(env.sent.filter(message => message.subject === 'Follow up Keep').length, 1, 'other bookings are unaffected');
    assert.equal(runOf(approve.id, kept.id).status, 'needs_approval');
  } finally { await env.close(); }
});

test('Flow AI cost guards are configurable and empty or invalid settings keep the defaults', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const read = value => { const config = loadConfig({ NODE_ENV: 'test', FLOW_AI_DESCRIBE_DAILY: value, FLOW_AI_INPUT_CHARS: value }); return [config.flowAiDescribeDaily, config.flowAiInputChars]; };
  assert.deepEqual(read(undefined), [10, 8000]);
  assert.deepEqual(read(''), [10, 8000]);
  assert.deepEqual(read('abc'), [10, 8000]);
  assert.deepEqual(read('0'), [0, 8000], '0 turns "Describe your automation" off');
  assert.deepEqual(read('25'), [25, 1000], 'input is at least 1,000 characters');
  assert.deepEqual(read('99999'), [1000, 50000], 'both are capped');
  const env = await fixture({ config: { flowAiDescribeDaily: 3 } });
  try { assert.equal((await env.owner.get(env.base + '/flow/usage')).body.describe.limit, 3); } finally { await env.close(); }
});

test('FLOW_V1_ACTIVATION=held keeps step workflows buildable and publishable but never on; the legacy API cannot bypass it', async () => {
  const { loadConfig, publicConfig } = await import('../src/config.mjs');
  const read = value => loadConfig({ NODE_ENV: 'test', FLOW_V1_ACTIVATION: value }).flowV1Activation;
  assert.deepEqual([undefined, '', 'on', ' ON '].map(read), ['on', 'on', 'on', 'on']);
  assert.deepEqual(['held', 'off', 'yes'].map(read), ['held', 'held', 'held'], 'anything else holds');
  assert.equal(publicConfig(loadConfig({ NODE_ENV: 'test', FLOW_V1_ACTIVATION: 'held' })).flowActivationHeld, true);
  assert.equal(publicConfig(loadConfig({ NODE_ENV: 'test' })).flowActivationHeld, undefined);
  const env = await fixture({ config: { flowV1Activation: 'held' } });
  try {
    const created = await env.owner.post(env.base + '/flow/workflows', { name: 'Held', definition: { trigger: { type: 'meet.booking.created' }, steps: [task('t', 'Prepare')] } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const check = await env.owner.post(`${env.base}/flow/workflows/${id}/publish-check`, {});
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.ok(check.body.activation.some(problem => /held/.test(problem)), 'the builder lists the hold before turning on');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${id}/publish`, { revision: created.body.draft_revision })).status, 200, 'publishing still works');
    const on = await env.owner.post(`${env.base}/flow/workflows/${id}/status`, { status: 'enabled' });
    assert.equal(on.status, 409);
    assert.equal(on.body.error.code, 'activation_held');
    const legacy = await env.owner.patch(`${env.base}/flows/${id}`, { status: 'enabled' });
    assert.equal(legacy.status, 409, 'the single-action API refuses step workflows');
    assert.equal(legacy.body.error.code, 'use_flow_builder');
    assert.equal(env.app.db.get('SELECT status FROM flows WHERE id = ?', id).status, 'draft');
    assert.equal((await env.owner.post(`${env.base}/flow/workflows/${id}/status`, { status: 'draft' })).status, 200, 'turning off is never held');
    const classic = await env.owner.post(`${env.base}/flows`, { name: 'Classic', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Classic' }, status: 'enabled' });
    assert.equal(classic.status, 201, 'classic workflows are not affected');
  } finally { await env.close(); }
});
