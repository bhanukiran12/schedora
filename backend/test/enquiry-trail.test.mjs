// Enquiry trail logic (frontend/js/enquiry-trail.mjs): states come only from linked records, and
// missing sources are reported as unknown rather than as "nothing happened".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingTrail, buildEnquiries, buildTrail, OFFER_TTL_MS } from '../../frontend/js/enquiry-trail.mjs';
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
    run({ id: 'r2', event_type: 'meet.booking.created', subject_id: 'booking-1', flow_name: 'Notify host', result: { email: 'e1' }, created_at: 4000 }),
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
  const provider = buildTrail(row(), context({ provider: 'resend', runs: [run({ result: { email: 'e1' } })] }));
  assert.match(provider.steps[2].text, /Accepted by the email provider; inbox delivery is not tracked/);
  assert.ok(!/delivered\./.test(provider.steps[2].text));
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

test('buildEnquiries joins products without duplicates, names people from their answers and puts attention first', () => {
  const definition = { fields: [{ id: 'full_name', type: 'short_text', label: 'Your name' }, { id: 'mail', type: 'email', label: 'Email' }] };
  const responses = [
    { id: 'r1aaaaaa-0000-0000-0000-000000000000', created_at: 100, form_version: 1, answers: { full_name: 'Meera' }, next_step: { status: 'booked', reference: 'SCH-A', starts_at: 900 } },
    { id: 'r2bbbbbb-0000-0000-0000-000000000000', created_at: 200, form_version: 1, answers: { mail: 'ravi@example.com' }, next_step: null },
    { id: 'r3cccccc-0000-0000-0000-000000000000', created_at: 300, form_version: 1, answers: {}, next_step: { status: 'offered' } }
  ];
  const bookings = [
    { id: 'bA', reference: 'SCH-A', status: 'confirmed', starts_at: 900, invitee_name: 'Meera', event_title: 'Consult' },
    { id: 'bOld', reference: 'SCH-OLD', status: 'canceled', rescheduled_to: 'bA', starts_at: 800, invitee_name: 'Meera', event_title: 'Consult' },
    { id: 'bD', reference: 'SCH-D', status: 'confirmed', starts_at: 950, invitee_name: 'Divya', event_title: 'Intro call' }
  ];
  const result = buildEnquiries({ forms: [{ form: { id: 'f1', draft: { title: 'Intake', fields: [] } }, versions: { 1: definition }, responses }], bookings: [...bookings, bookings[2]],
    context: context({ bookingsByReference: new Map(bookings.map(item => [item.reference, item])), now: 300 + OFFER_TTL_MS + 1 }) });
  assert.deepEqual(result.enquiries.map(item => [item.origin, item.title, item.state]), [
    ['response', 'Response R3CCCCCC', 'attention'], ['booking', 'Divya', 'done'], ['response', 'ravi@example.com', 'done'], ['response', 'Meera', 'done']]);
  assert.deepEqual(result.reasons, { offer_expired: 1 });
  assert.deepEqual(result.counts, { all: 4, attention: 1, waiting: 0, unknown: 0 });
  assert.deepEqual(result.enquiries.find(item => item.title === 'Meera').booking, { reference: 'SCH-A', event: 'Consult' }, 'the form booking is not listed again as a direct booking');
});

test('real local API: response → booking → follow-up task, an expired offer and a direct booking, from the endpoints the page uses', async () => {
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
    assert.equal((await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Meera', email: 'meera@example.com', timezone: 'UTC', start: slots[0], handoff }, idem())).status, 201);
    await submit('Ravi', 'enquiry-trail-ravi-00001');
    assert.equal((await env.client().post(`/api/public/meet/${ws.slug}/${consult.slug}/bookings`, { name: 'Divya', email: 'divya@example.com', timezone: 'UTC', start: slots[1] }, idem())).status, 201);
    for (let pass = 0; pass < 3; pass++) await env.app.worker.tick();
    env.clock.now += OFFER_TTL_MS + 60000;

    const load = async http => {
      const [forms, runs, tasks, ...scopes] = await Promise.all([`${base}/forms`, `${base}/runs`, `${base}/tasks`, ...['upcoming', 'past', 'canceled'].map(scope => `${base}/bookings?scope=${scope}`)].map(path => http.get(path)));
      const bookingsByReference = new Map(scopes.filter(scope => scope.status === 200).flatMap(scope => scope.body).map(booking => [booking.reference, booking]));
      const responses = await Promise.all(forms.body.map(item => http.get(`${base}/forms/${item.id}/responses?limit=50`)));
      return buildEnquiries({ forms: responses.map(response => response.body), bookings: [...bookingsByReference.values()],
        context: { runs: runs.status === 200 ? runs.body : [], runsAvailable: runs.status === 200, tasks: tasks.status === 200 ? tasks.body : [], tasksAvailable: tasks.status === 200,
          bookingsByReference, bookingsAvailable: scopes.every(scope => scope.status === 200), provider: 'outbox', now: env.clock.now } });
    };
    const result = await load(owner);
    const by = title => result.enquiries.find(item => item.title === title);
    assert.deepEqual(result.enquiries.map(item => item.title).sort(), ['Divya', 'Meera', 'Ravi']);
    assert.equal(by('Meera').origin, 'response');
    assert.ok(by('Meera').booking?.reference, 'linked to its booking');
    assert.deepEqual(by('Meera').trail.reasons, ['task_open'], 'booking confirmed, preparation task still open');
    assert.deepEqual(by('Ravi').trail.reasons, ['offer_expired']);
    assert.deepEqual([by('Divya').origin, by('Divya').trail.reasons], ['booking', ['task_open']]);
    assert.equal(result.counts.attention, 3);

    const memberHttp = env.client();
    const member = await signUp(memberHttp, 'Member');
    await owner.post(`${base}/members`, { email: member.email, role: 'member' });
    const seen = await load(memberHttp);
    assert.ok(!seen.enquiries.some(item => item.origin === 'booking'), 'a member does not see bookings they do not host');
    assert.ok(seen.enquiries.find(item => item.title === 'Meera').trail.notes.includes('Follow-ups for this booking are not visible to your role.'));
  } finally { await env.close(); }
});
