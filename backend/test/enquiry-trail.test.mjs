// Enquiry trail logic (frontend/js/enquiry-trail.mjs): states come only from linked records, and
// missing sources are reported as unknown rather than as "nothing happened".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrail } from '../../frontend/js/enquiry-trail.mjs';

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
