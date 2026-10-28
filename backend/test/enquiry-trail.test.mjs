// Enquiry trail logic (frontend/js/enquiry-trail.mjs): states come only from linked records, and
// missing sources are reported as unknown rather than as "nothing happened".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingTrail, buildFeedEnquiries, buildTrail, responseTrailContext, OFFER_TTL_MS } from '../../frontend/js/enquiry-trail.mjs';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';

const row = (next_step = null) => ({ id: 'aaaaaaaa-1111-2222-3333-444444444444', created_at: 1000, form_version: 1, next_step });
const run = (overrides) => ({ id: 'run-' + Math.random(), flow_name: 'Review', flow_status: 'enabled', event_type: 'forms.response.created', subject_id: row().id, status: 'succeeded', attempts: 1, created_at: 2000, result: null, ...overrides });
const context = (overrides = {}) => ({ runs: [], tasks: [], bookingsByReference: new Map(), provider: 'outbox', runsAvailable: true, tasksAvailable: true, bookingsAvailable: true, ...overrides });
const titles = trail => trail.steps.map(step => `${step.state}:${step.title}`);

test('a response with no booking and no flows says so plainly, without inventing activity', () => {
  const trail = buildTrail(row(), context());
  assert.deepEqual(titles(trail), ['done:Response received', 'none:No booking step', 'none:No follow-up recorded']);
  assert.equal(trail.steps[0].reference, 'AAAAAAAA');
  assert.deepEqual(trail.attention, []);
});

test('booking states map to waiting, done or attention exactly as recorded', () => {
  assert.equal(buildTrail(row({ status: 'offered' }), context()).steps[1].state, 'waiting');
  const booked = buildTrail(row({ status: 'booked', reference: 'SCH-1', starts_at: 5000 }), context());
  assert.deepEqual([booked.steps[1].state, booked.steps[1].reference], ['done', 'SCH-1']);
  assert.deepEqual(buildTrail(row({ status: 'booking_canceled', reference: 'SCH-1' }), context()).attention, ['Booking canceled']);
  const unavailable = buildTrail(row({ status: 'unavailable', reason: 'meet_inactive' }), context());
  assert.match(unavailable.steps[1].text, /Meet was not active/);
  assert.deepEqual(unavailable.attention, ['Booking could not be offered']);
});

test('follow-ups from the response and from its booking are joined through real ids', () => {
  const booking = { id: 'booking-1', reference: 'SCH-9' };
  const runs = [
    run({ id: 'r1', result: { task: 't1' }, created_at: 3000 }),
    run({ id: 'r2', event_type: 'meet.booking.created', subject_id: 'booking-1', flow_name: 'Notify host', result: { email: 'e1' }, email_delivery: { status: 'sent', transport: 'outbox' }, created_at: 4000 }),
    run({ id: 'r3', subject_id: 'someone-else', flow_name: 'Unrelated' })
  ];
  const tasks = [{ id: 't1', title: 'Review enquiry', status: 'open' }];
  const trail = buildTrail(row({ status: 'booked', reference: 'SCH-9' }), context({ runs, tasks, bookingsByReference: new Map([['SCH-9', booking]]) }));
  assert.deepEqual(trail.steps.slice(2).map(step => [step.title, step.source, step.state]), [['Review', 'response', 'attention'], ['Notify host', 'booking', 'done']]);
  assert.match(trail.steps[2].text, /Task open: Review enquiry/);
  assert.match(trail.steps[3].text, /local outbox; not delivered/);
  assert.deepEqual(trail.attention, ['Open task (Review)']);
  // Completing the task clears the attention item.
  tasks[0].status = 'done';
  assert.deepEqual(buildTrail(row({ status: 'booked', reference: 'SCH-9' }), context({ runs, tasks, bookingsByReference: new Map([['SCH-9', booking]]) })).attention, []);
});

test('run outcomes: failure, retry, paused hold and provider email wording', () => {
  const failed = buildTrail(row(), context({ runs: [run({ status: 'failed', attempts: 3, last_error: 'No recipient email address' })] }));
  assert.deepEqual(failed.attention, ['Follow-up failed (Review)']);
  assert.match(failed.steps[2].text, /Failed after 3 attempts: No recipient email address/);
  assert.deepEqual(buildTrail(row(), context({ runs: [run({ status: 'retrying', last_error: 'timeout' })] })).attention, ['Follow-up retrying (Review)']);
  const held = buildTrail(row(), context({ runs: [run({ status: 'queued', flow_status: 'paused' })] }));
  assert.deepEqual([held.steps[2].state, held.steps[2].text], ['waiting', 'Held while the flow is paused.']);
  const provider = buildTrail(row(), context({ provider: 'outbox', runs: [run({ result: { email: 'e1' }, email_delivery: { status: 'sent', transport: 'http' } })] }));
  assert.match(provider.steps[2].text, /Accepted by the email provider; no delivery report yet\. Inbox delivery is not confirmed\./);
  assert.ok(!/delivered\./.test(provider.steps[2].text));
});

test('historic email outcomes cannot be rewritten by the current provider or assumed for legacy records', () => {
  const legacy = run({ result: { email: 'old-email' } });
  for (const provider of ['http', 'outbox']) {
    const step = buildTrail(row(), context({ provider, runs: [legacy] })).steps[2];
    assert.equal(step.state, 'unknown');
    assert.match(step.text, /sending method is not verified/);
    const recorded = run({ result: { email: 'e1' }, email_delivery: { status: 'sent', transport: 'outbox' } });
    assert.match(buildTrail(row(), context({ provider, runs: [recorded] })).steps[2].text, /local outbox; not delivered/);
  }
  for (const evidence of [{ status: 'queued', transport: 'http' }, { status: 'sent', transport: 'unrecognized' }]) {
    const step = buildTrail(row(), context({ runs: [run({ result: { email: 'e1' }, email_delivery: evidence })] })).steps[2];
    assert.equal(step.state, 'unknown');
    assert.ok(!step.text.includes('Accepted by the email provider'));
  }
});

test('sources that cannot be read are reported as unknown, never as "nothing happened"', () => {
  const noRuns = buildTrail(row(), context({ runsAvailable: false }));
  assert.deepEqual(titles(noRuns).at(-1), 'unknown:Follow-up status unavailable');
  const noTasks = buildTrail(row(), context({ tasksAvailable: false, runs: [run({ result: { task: 't1' } })] }));
  assert.equal(noTasks.steps[2].state, 'unknown');
  // A member who does not host the booking cannot see it, so its follow-ups are flagged as hidden.
  const hidden = buildTrail(row({ status: 'booked', reference: 'SCH-404' }), context());
  assert.deepEqual(hidden.notes, ['Follow-ups for this booking are not visible to your role.']);
});

// ---- Workspace-wide enquiries (slice 7) ----

test('a booking offer older than the 2-hour link is "expired, not booked"; without a clock nothing is assumed', () => {
  const offered = row({ status: 'offered' });
  assert.equal(buildTrail(offered, context({ now: 1000 + OFFER_TTL_MS - 1 })).steps[1].state, 'waiting');
  const expired = buildTrail(offered, context({ now: 1000 + OFFER_TTL_MS + 1 }));
  assert.deepEqual([expired.steps[1].state, expired.reasons], ['attention', ['offer_expired']]);
  assert.equal(buildTrail(offered, context()).steps[1].state, 'waiting');
});

test('direct bookings: canceled and open-task follow-ups need attention; unreadable runs are unknown, not done', () => {
  const booking = { id: 'b-1', reference: 'SCH-1', status: 'canceled', canceled_by: 'invitee', starts_at: 5000 };
  const canceled = buildBookingTrail(booking, context());
  assert.deepEqual(canceled.reasons, ['booking_canceled']);
  assert.match(canceled.steps[0].text, /Canceled by the invitee/);
  const withTask = buildBookingTrail({ ...booking, status: 'confirmed' }, context({ runs: [run({ event_type: 'meet.booking.created', subject_id: 'b-1', result: { task: 't-1' } })], tasks: [{ id: 't-1', title: 'Prepare', status: 'open' }] }));
  assert.deepEqual(withTask.reasons, ['task_open']);
  const blind = buildBookingTrail({ ...booking, status: 'confirmed' }, context({ runsAvailable: false }));
  assert.equal(blind.steps.at(-1).state, 'unknown');
});

test('feed enquiries keep server order data, hide follow-ups of unseen bookings and put attention first', () => {
  const page = {
    now: 10_000,
    items: [
      { kind: 'response', id: 'r3', at: 300, form_id: 'f1', form_title: 'Intake', title: 'Response R3', next_step: { status: 'offered', expires_at: 9_000 } },
      { kind: 'booking', id: 'bD', at: 250, booking: { id: 'bD', reference: 'SCH-D', status: 'confirmed', starts_at: 50_000, invitee_name: 'Divya', event_title: 'Intro call' } },
      { kind: 'response', id: 'r2', at: 200, form_id: 'f1', form_title: 'Intake', title: 'ravi@example.com', next_step: { status: 'offered', expires_at: 20_000 } },
      { kind: 'response', id: 'r1', at: 100, form_id: 'f1', form_title: 'Intake', title: 'Meera', next_step: { status: 'booked', reference: 'SCH-A', starts_at: 900, booking_id: 'bA', booking_visible: false } }
    ],
    runs: [run({ event_type: 'meet.booking.created', subject_id: 'bD', result: { task: 't1' } })],
    tasks: [{ id: 't1', title: 'Prepare', status: 'done' }]
  };
  const result = buildFeedEnquiries([page]);
  assert.deepEqual(result.enquiries.map(item => [item.origin, item.title, item.state]), [
    ['response', 'Response R3', 'attention'], ['response', 'ravi@example.com', 'waiting'], ['booking', 'Divya', 'done'], ['response', 'Meera', 'done']]);
  assert.deepEqual(result.reasons, { offer_expired: 1 }, 'expiry comes from the stored expires_at and the server clock, not the response age');
  assert.equal(result.enquiries.find(item => item.title === 'Divya').at, 250, 'direct bookings are ordered by when they were booked');
  assert.ok(result.enquiries.find(item => item.title === 'Meera').trail.notes.includes('Follow-ups for this booking are not visible to your role.'));
});

test('stored offer expiry wins over the response age in both directions', () => {
  const offered = expires_at => row({ status: 'offered', expires_at });
  assert.equal(buildTrail(offered(5000), context({ now: 4999 })).steps[1].state, 'waiting');
  assert.equal(buildTrail(offered(5000), context({ now: 5000 })).steps[1].reason, 'offer_expired');
  assert.equal(buildTrail(offered(1000 + 10 * OFFER_TTL_MS), context({ now: 1000 + OFFER_TTL_MS + 1 })).steps[1].state, 'waiting', 'a longer stored expiry is respected');
  assert.equal(buildTrail(row({ status: 'offered' }), context({ now: 1000 + OFFER_TTL_MS + 1 })).steps[1].reason, 'offer_expired', 'records without expires_at keep the age rule');
});

test('real local API: the enquiry feed links response → booking → task, expires offers on the server clock and scopes members', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}`;
    const consult = await publishedEventType(owner, ws, { title: 'Consultation', min_notice_min: 0 });
    const intake = { title: 'Intake', description: '', presentation: 'classic', submit_label: 'Send', fields: [
      { id: 'name', type: 'short_text', label: 'Your name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }] };
    const form = (await owner.post(`${base}/forms`, { definition: intake })).body;
    const routed = (await owner.raw('PUT', `${base}/forms/${form.id}/routing`, { routing: { rules: [{ condition: { field: 'name', op: 'answered' }, action: { type: 'event', event_type_id: consult.id } }] }, base_revision: form.revision })).body;
    await owner.post(`${base}/forms/${form.id}/publish`, { base_revision: routed.revision });
    await owner.post(`${base}/flows`, { name: 'Prepare', trigger_type: 'meet.booking.created', trigger_source: null, action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}}', details: '' }, status: 'enabled' });
    const slots = (await owner.get(`${base}/event-types/${consult.id}/slots`)).body.slots;
    const submit = (name, id) => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name, email: `${name.toLowerCase()}@example.com` }, submission_id: id });

    const meera = await submit('Meera', 'enquiry-trail-meera-0001');
    const handoff = new URL(meera.body.next.url, 'https://x').searchParams.get('handoff');
    env.clock.now += 1000;
    assert.equal((await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Meera', email: 'meera@example.com', timezone: 'UTC', start: slots[0], handoff }, idem())).status, 201);
    env.clock.now += 1000;
    await submit('Ravi', 'enquiry-trail-ravi-00001');
    env.clock.now += 1000;
    assert.equal((await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Divya', email: 'divya@example.com', timezone: 'UTC', start: slots[1] }, idem())).status, 201);
    for (let pass = 0; pass < 3; pass++) await env.app.worker.tick();

    const first = (await owner.get(`${base}/enquiries`)).body;
    const ravi = first.items.find(item => item.title === 'Ravi');
    assert.equal(ravi.next_step.status, 'offered');
    assert.equal(typeof ravi.next_step.expires_at, 'number', 'the stored expiry is returned');
    assert.equal(buildFeedEnquiries([first]).enquiries.find(item => item.title === 'Ravi').state, 'waiting');
    env.clock.now = ravi.next_step.expires_at;

    const page = (await owner.get(`${base}/enquiries`)).body;
    assert.equal(page.now, env.clock.now, 'the page carries the server clock');
    assert.deepEqual(page.items.map(item => [item.kind, item.title || item.booking.invitee_name]), [['booking', 'Divya'], ['response', 'Ravi'], ['response', 'Meera']], 'newest arrival first; the form booking is not listed again');
    assert.equal(page.next, null);
    for (const item of page.items) assert.ok(!('answers' in item), 'answers are not sent; only the respondent label');
    const result = buildFeedEnquiries([page]);
    const by = title => result.enquiries.find(item => item.title === title);
    assert.deepEqual(by('Meera').trail.reasons, ['task_open'], 'booking confirmed, preparation task still open');
    assert.deepEqual(by('Ravi').trail.reasons, ['offer_expired']);
    assert.deepEqual([by('Divya').origin, by('Divya').trail.reasons], ['booking', ['task_open']]);
    assert.equal(result.counts.attention, 3);

    const memberHttp = env.client();
    const member = await signUp(memberHttp, 'Member');
    await owner.post(`${base}/members`, { email: member.email, role: 'member' });
    const seen = (await memberHttp.get(`${base}/enquiries`)).body;
    assert.ok(!seen.items.some(item => item.kind === 'booking'), 'a member does not see bookings they do not host');
    assert.ok(!seen.runs.some(item => item.event_type === 'meet.booking.created'), 'nor their follow-up runs');
    assert.ok(buildFeedEnquiries([seen]).enquiries.find(item => item.title === 'Meera').trail.notes.includes('Follow-ups for this booking are not visible to your role.'));
    const ownerInbox = (await owner.get(`${base}/forms/${form.id}/responses`)).body;
    assert.ok(ownerInbox.followups.runs.some(item => item.event_type === 'meet.booking.created'));
    const memberInbox = (await memberHttp.get(`${base}/forms/${form.id}/responses`)).body;
    assert.ok(!memberInbox.followups.runs.some(item => item.event_type === 'meet.booking.created'));
    const hiddenBooking = memberInbox.responses.find(item => item.next_step?.reference);
    assert.ok(buildTrail(hiddenBooking, responseTrailContext([memberInbox])).notes.includes('Follow-ups for this booking are not visible to your role.'));
    assert.equal((await env.client().get(`${base}/forms/${form.id}/responses`)).status, 401);
    assert.equal((await env.client().get(`${base}/enquiries`)).status, 401);
    const outsider = env.client();
    await signUp(outsider, 'Outsider');
    assert.equal((await outsider.get(`${base}/enquiries`)).status, 404);
  } finally { await env.close(); }
});

test('the feed pages through every enquiry exactly once, including arrival-time ties, without per-form caps', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const base = `/api/workspaces/${ws.id}`;
    const intake = { title: 'Intake', description: '', presentation: 'classic', submit_label: 'Send', fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: true }] };
    // 25 forms × 3 stored responses: more forms than the old 20-form window, and two responses per
    // instant. Rows are written directly (public submission is rate-limited per client).
    for (let f = 0; f < 25; f++) {
      const form = (await owner.post(`${base}/forms`, { definition: { ...intake, title: `Form ${f}` } })).body;
      assert.equal((await owner.post(`${base}/forms/${form.id}/publish`, { base_revision: form.revision })).status, 200);
      for (let r = 0; r < 3; r++) {
        if (r !== 1) env.clock.now += 1000;
        env.app.db.run('INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
          `00000000-0000-4000-8000-${String(f * 3 + r).padStart(12, '0')}`, ws.id, form.id, JSON.stringify({ name: `P${f}-${r}` }), `feed-${f}-${r}`, env.clock.now);
      }
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = (await owner.get(`${base}/enquiries?limit=7${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`)).body;
      assert.ok(page.items.length <= 7);
      for (let i = 1; i < page.items.length; i++) assert.ok(page.items[i - 1].at >= page.items[i].at, 'newest first');
      seen.push(...page.items.map(item => item.title));
      cursor = page.next;
      pages++;
    } while (cursor && pages < 50);
    assert.equal(seen.length, 75);
    assert.equal(new Set(seen).size, 75, 'no duplicates or gaps across pages');
    assert.equal((await owner.get(`${base}/enquiries?before=not-a-cursor`)).status, 400);
  } finally { await env.close(); }
});


test('per-form paging keeps tied arrivals and old follow-ups beyond the workspace run/task cap', async () => {
  const env = await setup();
  try {
    const owner = env.client(); const { ws } = await signUp(owner, 'History');
    const base = `/api/workspaces/${ws.id}`;
    const form = (await owner.post(`${base}/forms`, { definition: { title: 'History', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }] } })).body;
    await owner.post(`${base}/forms/${form.id}/publish`, { base_revision: form.revision });
    const flow = (await owner.post(`${base}/flows`, { name: 'Review', trigger_type: 'forms.response.created', trigger_source: form.id, action_type: 'task', action_config: { title: 'Review', details: '' }, status: 'enabled' })).body;
    const ids = [];
    for (let i = 0; i < 61; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; ids.push(id);
      env.app.db.run('INSERT INTO responses (id, workspace_id, form_id, form_version, answers, idempotency_key, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', id, ws.id, form.id, JSON.stringify({ name: `Person ${i}` }), `history-${i}`, env.clock.now);
    }
    // The oldest response's failed run/task predates 210 unrelated workspace runs/tasks.
    for (let i = 0; i < 211; i++) {
      env.app.db.run("INSERT INTO flow_runs (id, workspace_id, flow_id, event_id, event_type, subject_id, status, attempts, next_attempt_at, result, created_at, updated_at) VALUES (?, ?, ?, ?, 'forms.response.created', ?, 'succeeded', 1, ?, ?, ?, ?)",
        `history-run-${i}`, ws.id, flow.id, `history-event-${i}`, i ? `unrelated-${i}` : ids[0], env.clock.now + i, JSON.stringify({ task: `history-task-${i}` }), env.clock.now + i, env.clock.now + i);
      env.app.db.run("INSERT INTO tasks (id, workspace_id, source_run_id, title, details, status, created_at) VALUES (?, ?, ?, 'Review history', '', 'open', ?)", `history-task-${i}`, ws.id, `history-run-${i}`, env.clock.now + i);
    }
    const pages = []; let cursor; const seen = [];
    do {
      const result = await owner.get(`${base}/forms/${form.id}/responses?limit=7${cursor ? '&before=' + encodeURIComponent(cursor) : ''}`);
      assert.equal(result.status, 200); pages.push(result.body); seen.push(...result.body.responses.map(row => row.id)); cursor = result.body.next;
    } while (cursor && pages.length < 20);
    assert.equal(seen.length, 61); assert.equal(new Set(seen).size, 61);
    const ctx = responseTrailContext(pages);
    assert.equal(ctx.runs.length, 1, 'unrelated workspace subjects are excluded');
    assert.equal(ctx.tasks.length, 1);
    assert.deepEqual(buildTrail(pages.at(-1).responses.at(-1), ctx).reasons, ['task_open']);
    assert.equal((await owner.get(`${base}/forms/${form.id}/responses?before=bad`)).status, 400);
    const outsider = env.client(); await signUp(outsider, 'Other');
    assert.equal((await outsider.get(`${base}/forms/${form.id}/responses`)).status, 404);
    assert.equal((await owner.get(`${base}/forms/${form.id}/responses?before=${env.clock.now}`)).body.responses.length, 0, 'legacy timestamp remains exclusive');
  } finally { await env.close(); }
});

test('per-form context deduplicates repeated booking follow-ups and treats missing API evidence as unavailable', () => {
  const page = { followups: { runs: [run({ id: 'same-run' })], tasks: [{ id: 'same-task' }], bookings: [{ id: 'same-booking', reference: 'SCH-1' }], now: 100 } };
  const ctx = responseTrailContext([page, page]);
  assert.equal(ctx.runs.length, 1); assert.equal(ctx.tasks.length, 1); assert.equal(ctx.bookingsByReference.size, 1);
  assert.equal(responseTrailContext([{}]).runsAvailable, false);
});
