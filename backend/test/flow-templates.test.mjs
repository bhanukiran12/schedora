// The eight Flow v1 job templates, end to end with fake providers and a controllable clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scanTimedTriggers } from '../src/flow/engine.mjs';
import { setup, signUp } from './helpers.mjs';

const MINUTE = 60000;
async function fixture() {
  const env = await setup();
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Template owner');
  const base = `/api/workspaces/${ws.id}`;
  const event = (await owner.post(base + '/event-types', { title: 'Consultation', timezone: 'UTC', published: true, min_notice_min: 0 })).body;
  const publishForm = async definition => { const form = (await owner.post(base + '/forms', { definition })).body; await owner.post(`${base}/forms/${form.id}/publish`); return form; };
  const fromTemplate = async (template, bindings) => {
    const created = await owner.post(base + '/flow/workflows', { template, bindings });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.state, 'draft', 'templates start as inactive drafts');
    assert.equal(created.body.published_version, null);
    const published = await owner.post(`${base}/flow/workflows/${created.body.id}/publish`, { revision: created.body.draft_revision });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const on = await owner.post(`${base}/flow/workflows/${created.body.id}/status`, { status: 'enabled' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    return on.body;
  };
  const book = async (name, extra = {}, slot = 0) => {
    const slots = (await env.client().get(`/api/public/meet/${ws.slug}/${event.slug}/slots`)).body.slots;
    const result = await env.client().post(`/api/public/meet/${ws.slug}/${event.slug}/bookings`, { name, email: `${name.toLowerCase()}@example.com`, timezone: 'UTC', start: slots[slot], ...extra }, { 'Idempotency-Key': randomUUID() });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.booking;
  };
  const runs = flowId => env.app.db.all('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY created_at', flowId);
  const tick = () => env.app.worker.tick();
  const tasks = like => env.app.db.all('SELECT * FROM tasks WHERE title LIKE ?', like);
  return { ...env, owner, ws, user, base, event, publishForm, fromTemplate, book, runs, tick, tasks };
}
const leadForm = { title: 'Enquiry', presentation: 'classic', mode: 'lead_qualification', lead_scoring: { warm: 20, hot: 50 }, fields: [
  { id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'timing', type: 'single_choice', label: 'When would you start?', required: true, options: [{ id: 'now', label: 'This month', lead_points: 60 }, { id: 'later', label: 'Later', lead_points: 5 }] }
] };

test('the template catalog lists eight jobs, each an editable draft definition', async () => {
  const env = await fixture();
  try {
    const { templates, jobs } = (await env.owner.get(env.base + '/flow/templates')).body;
    assert.deepEqual(templates.map(item => item.id), ['speed_to_lead', 'reminders_no_show', 'meeting_prep', 'after_meeting', 'routing', 'sheets_status', 'payment_received', 'feedback']);
    assert.ok(templates.every(item => jobs[item.job] && item.summary && item.definition.steps.length));
    const unbound = (await env.owner.post(env.base + '/flow/workflows', { template: 'speed_to_lead' })).body;
    const check = (await env.owner.post(`${env.base}/flow/workflows/${unbound.id}/publish-check`)).body;
    assert.equal(check.can_publish, false, 'missing bindings are explained, never guessed');
    assert.ok(check.problems.some(problem => /booking page/.test(problem)));
  } finally { await env.close(); }
});

test('1 Speed-to-lead: booking link at once; a call task only for people who did not book within a day', async () => {
  const env = await fixture();
  try {
    const form = await env.publishForm(leadForm);
    const flow = await env.fromTemplate('speed_to_lead', { form: form.id, event_type: env.event.id });
    for (const name of ['Ada', 'Bo']) await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name, email: `${name.toLowerCase()}@example.com`, timing: 'now' }, submission_id: `speed-${name}-submission` });
    await env.tick();
    assert.equal(env.sent.filter(message => /choose a time/.test(message.subject)).length, 2);
    assert.match(env.sent.find(message => message.to === 'ada@example.com').body, /\/meet\/.+\?name=Ada&email=ada%40example.com/);
    await env.book('Ada');
    await env.tick();
    env.clock.now += 1441 * MINUTE;
    await env.tick();
    assert.deepEqual(env.runs(flow.id).map(run => run.status), ['succeeded', 'succeeded']);
    assert.equal(env.tasks('Call %').length, 1);
    assert.equal(env.tasks('Call Bo%').length, 1);
  } finally { await env.close(); }
});

test('2 Reminders and no-show recovery: reminder before; rebooking link and host task only after a no-show', async () => {
  const env = await fixture();
  try {
    const flow = await env.fromTemplate('reminders_no_show', { event_type: env.event.id });
    const booking = await env.book('Cara', {}, 3);
    const start = Date.parse(booking.starts_at);
    env.clock.now = start - 59 * MINUTE;
    scanTimedTriggers(env.app, { force: true });
    await env.tick();
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE kind = 'flow' AND subject LIKE 'Reminder:%'").n, 1, 'one Flow reminder (Meet keeps its own reminder schedule)');
    env.clock.now = Date.parse(booking.ends_at) + MINUTE;
    assert.equal((await env.owner.post(`${env.base}/bookings/${booking.id}/attendance`, { status: 'no_show' })).status, 200);
    env.clock.now = start - 59 * MINUTE + 1501 * MINUTE;
    await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'succeeded');
    assert.equal(env.sent.filter(message => /missed you/.test(message.subject)).length, 1);
    assert.equal(env.tasks('Follow up on no-show: Cara').length, 1);
    assert.equal(env.tasks('Follow up on no-show: Cara')[0].assignee_id, env.user.id, 'assigned to the host');
  } finally { await env.close(); }
});

test('3 Meeting preparation: the host gets a task with the form answers and private lead score', async () => {
  const env = await fixture();
  try {
    const form = await env.publishForm(leadForm);
    await env.owner.raw('PUT', `${env.base}/forms/${form.id}/routing`, { routing: { rules: [], fallback: { type: 'event', event_type_id: env.event.id } } });
    await env.owner.post(`${env.base}/forms/${form.id}/publish`);
    await env.fromTemplate('meeting_prep', { event_type: env.event.id });
    const accepted = (await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Dev', email: 'dev@example.com', timing: 'now' }, submission_id: 'prep-dev-submission-1' })).body;
    const handoff = new URL(accepted.next.url, 'https://x').searchParams.get('handoff');
    await env.book('Dev', { handoff });
    await env.tick();
    const [task] = env.tasks('Prepare for Dev%');
    assert.ok(task, 'prep task created');
    assert.equal(task.assignee_id, env.user.id);
    assert.match(task.details, /Lead priority: Hot \(60 points\)/);
    assert.match(task.details, /When would you start\?: This month/);
  } finally { await env.close(); }
});

test('4 After-meeting follow-up: grounded AI draft, host approval, then the email and the next task', async () => {
  const env = await fixture();
  try {
    let prompt = '';
    env.app.anthropic = { beta: { messages: { create: async request => { prompt = request.messages[0].content; return { stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify({ text: 'Thanks for today. As agreed, the pilot starts Monday.' }) }] }; } } } };
    const flow = await env.fromTemplate('after_meeting', { event_type: env.event.id });
    const booking = await env.book('Eli', {}, 1);
    const transcript = await env.owner.post(env.base + '/transcripts', { title: 'Eli call', content: 'Host: We agreed the pilot starts Monday. Eli: Great, thanks.', booking_reference: booking.reference });
    env.app.db.run("INSERT INTO recaps (id, workspace_id, transcript_id, summary, decisions, action_items, follow_up, created_at) VALUES (?, ?, ?, 'The pilot starts Monday.', '[]', '[]', '{}', ?)", randomUUID(), env.ws.id, transcript.body.id, env.clock.now);
    env.clock.now = Date.parse(booking.ends_at) + MINUTE;
    scanTimedTriggers(env.app, { force: true });
    await env.tick();
    assert.match(prompt, /The pilot starts Monday/, 'the draft is grounded in the meeting recap');
    assert.match(prompt, /<record>/);
    assert.equal(env.runs(flow.id)[0].status, 'needs_approval');
    assert.equal(env.sent.filter(message => /Following up/.test(message.subject)).length, 0);
    const [approval] = (await env.owner.get(env.base + '/flow/approvals')).body;
    assert.equal(approval.draft, 'Thanks for today. As agreed, the pilot starts Monday.');
    await env.owner.post(`${env.base}/flow/approvals/${approval.id}`, { decision: 'approve', revision: 0 });
    await env.tick();
    assert.equal(env.sent.find(message => /Following up/.test(message.subject)).body, 'Thanks for today. As agreed, the pilot starts Monday.');
    assert.equal(env.tasks('Next step with Eli').length, 1);
  } finally { await env.close(); }
});

test('5 Routing and ownership: Hot leads are assigned in turn and the owner is emailed', async () => {
  const env = await fixture();
  try {
    const colleague = env.client();
    const second = await signUp(colleague, 'Second owner');
    await env.owner.post(env.base + '/members', { email: second.email, role: 'member' });
    const form = await env.publishForm(leadForm);
    const flow = await env.fromTemplate('routing', { form: form.id, members: [env.user.id, second.user.id] });
    for (const [name, timing] of [['Fay', 'now'], ['Gus', 'now'], ['Hal', 'later'], ['Ivo', 'now']]) await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name, email: `${name.toLowerCase()}@example.com`, timing }, submission_id: `route-${name}-submission` });
    await env.tick();
    const owners = Object.fromEntries(env.app.db.all("SELECT email, owner_id FROM contacts WHERE email IN ('fay@example.com','gus@example.com','ivo@example.com')").map(row => [row.email, row.owner_id]));
    assert.notEqual(owners['fay@example.com'], owners['gus@example.com'], 'turns alternate');
    assert.equal(owners['ivo@example.com'], owners['fay@example.com']);
    assert.equal(env.runs(flow.id).filter(run => run.status === 'skipped').length, 1, 'the Warm lead stops at the rule');
    assert.equal(env.sent.filter(message => /New hot lead/.test(message.subject)).length, 3);
    assert.ok(env.sent.some(message => /New hot lead/.test(message.subject) && message.to === second.email));
  } finally { await env.close(); }
});

test('6 Status change in Sheets: Enrolled sends the welcome and onboarding form, then marks the row once', async () => {
  const env = await fixture();
  try {
    const onboarding = await env.publishForm({ title: 'Onboarding', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] });
    const book = (await env.owner.post(env.base + '/workbooks', { title: 'Students' })).body;
    const sheet = (await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0];
    const change = ops => env.owner.post(`${env.base}/workbooks/${book.id}/changes`, { ops });
    const cell = (address, to, from = null) => ({ op: 'cell', sheet: sheet.id, cell: address, from, to });
    await change([cell('A1', 'Name'), cell('B1', 'Email'), cell('C1', 'Status'), cell('D1', 'Welcome sent'), cell('A2', 'Jo'), cell('B2', 'jo@example.com'), cell('C2', 'Applied')]);
    await env.fromTemplate('sheets_status', { workbook: book.id, sheet: sheet.id, onboarding_form: onboarding.id });
    await change([cell('C2', 'Enrolled', 'Applied')]);
    await env.tick();
    assert.equal(env.sent.filter(message => message.to === 'jo@example.com').length, 2);
    assert.ok(env.sent.some(message => message.to === 'jo@example.com' && message.body.includes(`/f/${onboarding.slug}`)));
    assert.equal((await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0].cells.D2, 'Yes');
    await env.tick();
    assert.equal(env.sent.filter(message => message.to === 'jo@example.com').length, 2, 'the automation’s own write does not retrigger');
  } finally { await env.close(); }
});

test('7 Payment received: verified payment marks the row Paid and emails once; the receipt is not duplicated', async () => {
  const env = await fixture();
  try {
    const form = await env.publishForm({ title: 'Course fee', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }], payment: { amount_cents: 120000, currency: 'INR' } });
    const book = (await env.owner.post(env.base + '/workbooks', { title: 'Payments' })).body;
    const sheet = (await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0];
    await env.owner.post(`${env.base}/workbooks/${book.id}/changes`, { ops: ['Email', 'Name', 'Status', 'Amount'].map((header, index) => ({ op: 'cell', sheet: sheet.id, cell: 'ABCD'[index] + '1', from: null, to: header })) });
    const flow = await env.fromTemplate('payment_received', { form: form.id, workbook: book.id, sheet: sheet.id });
    const submitted = (await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Kai', email: 'kai@example.com' }, submission_id: 'payment-kai-submission' })).body;
    await env.tick();
    assert.equal(env.runs(flow.id).length, 0, 'nothing before the payment is verified');
    const pay = `/api/public/form-payments/${submitted.payment.token}`;
    await env.client().post(pay + '/checkout');
    await env.client().post(pay + '/test-pay', { action: 'pay' });
    await env.client().post(pay + '/verify');
    await env.tick();
    await env.tick();
    const cells = (await env.owner.get(`${env.base}/workbooks/${book.id}`)).body.sheets[0].cells;
    assert.deepEqual([cells.A2, cells.B2, cells.C2, cells.D2], ['kai@example.com', 'Kai', 'Paid', '1200.00']);
    assert.equal(env.sent.filter(message => /Payment received/.test(message.subject)).length, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE channel = 'whatsapp'").n, 0, 'no second receipt channel');
    assert.equal(env.runs(flow.id).length, 1);
  } finally { await env.close(); }
});

test('8 Feedback loop: the form goes out two days after; a low rating gives the manager a task', async () => {
  const env = await fixture();
  try {
    const manager = env.client();
    const boss = await signUp(manager, 'Manager');
    await env.owner.post(env.base + '/members', { email: boss.email, role: 'member' });
    const feedback = await env.publishForm({ title: 'Feedback', presentation: 'classic', fields: [{ id: 'email', type: 'email', label: 'Email', required: true }, { id: 'rating', type: 'scale', label: 'Rating', required: true, scale: { min: 1, max: 5 } }] });
    const flow = await env.fromTemplate('feedback', { event_type: env.event.id, feedback_form: feedback.id, manager: boss.user.id });
    const booking = await env.book('Lia', {}, 1);
    env.clock.now = Date.parse(booking.ends_at) + 2881 * MINUTE;
    scanTimedTriggers(env.app, { force: true });
    await env.tick();
    assert.ok(env.sent.some(message => message.to === 'lia@example.com' && message.body.includes(`/f/${feedback.slug}`)));
    assert.equal(env.runs(flow.id)[0].status, 'waiting');
    // Someone else's feedback does not count as Lia's.
    await env.client().post(`/api/public/forms/${feedback.slug}/responses`, { answers: { email: 'other@example.com', rating: '1' }, submission_id: 'feedback-other-0001' });
    await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'waiting');
    const liaResponse = await env.client().post(`/api/public/forms/${feedback.slug}/responses`, { answers: { email: 'lia@example.com', rating: '2' }, submission_id: 'feedback-lia-00001' });
    assert.equal(liaResponse.status, 201, JSON.stringify(liaResponse.body));
    await env.tick();
    assert.equal(env.runs(flow.id)[0].status, 'succeeded');
    const [task] = env.tasks('Low feedback from Lia');
    assert.equal(task.assignee_id, boss.user.id);
    assert.match(task.details, /Rating: 2/);
  } finally { await env.close(); }
});
