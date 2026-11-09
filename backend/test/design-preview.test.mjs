import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, demoDay, demoSlots, loadDemo, makeDemo, nextWorkingDays, refreshSamples, simulateWorkflow, upcomingBookings, validateHours } from '../../frontend/js/demo-store.mjs';

const FRIDAY = new Date('2026-10-23T09:00:00'); // the next working day is Monday 26 October

test('corrupt or incomplete local preview storage falls back to safe sample data', () => {
  for (const value of ['invalid JSON', '{"version":1}', 'null']) assert.equal(loadDemo({ getItem: () => value }).profile.workspace, 'Northstar Studio');
  assert.equal(loadDemo({ getItem() { throw new Error('blocked'); } }).version, 1);
});
test('preview availability excludes weekends and overlapping appointments including buffers', () => {
  const data = makeDemo(FRIDAY); const event = data.events[0];
  assert.deepEqual(demoSlots(data, event, '2026-10-24'), []);
  const slots = demoSlots(data, event, '2026-10-26');
  assert.ok(slots.includes('09:00'));
  for (const busy of ['09:30', '10:00', '10:30', '11:30', '12:00', '14:00']) assert.ok(!slots.includes(busy), busy);
  assert.ok(demoSlots(data, event, '2026-10-26', 'sample-maya').includes('10:00'));
  data.bookings[0].status = 'canceled';
  assert.ok(demoSlots(data, event, '2026-10-26').includes('10:00'));
});
test('sample dates are relative: bookings on the next working day, responses recent, never "upcoming" in the past', () => {
  assert.deepEqual(nextWorkingDays(FRIDAY, 2), ['2026-10-26', '2026-10-27']);
  const today = new Date('2026-11-09T18:00:00');
  const data = makeDemo(today);
  assert.ok(data.bookings.every(booking => booking.date === '2026-11-10' && booking.sample));
  assert.ok(data.responses.every(response => new Date(response.received) < today && today - new Date(response.received) < 3 * 86400000));
  assert.equal(upcomingBookings(data.bookings, today).length, 3);
  assert.match(demoDay('2026-11-10'), /^Tue,? 10 Nov$/);
  // A demo saved weeks ago: the samples move forward, the visitor's own past booking stays where it was
  // and is no longer listed as upcoming.
  const saved = makeDemo(FRIDAY);
  saved.bookings.push({ id: 'mine', name: 'Visitor', email: 'v@example.com', event: 'discovery', date: '2026-10-27', time: '09:00', status: 'confirmed' });
  const refreshed = refreshSamples(structuredClone(saved), today);
  assert.deepEqual(refreshed.bookings.filter(booking => booking.sample).map(booking => booking.date), ['2026-11-10', '2026-11-10', '2026-11-10']);
  assert.equal(refreshed.bookings.find(booking => booking.id === 'mine').date, '2026-10-27');
  assert.deepEqual(upcomingBookings(refreshed.bookings, today).map(booking => booking.id), ['sample-maya', 'sample-daniel', 'sample-priya']);
  assert.equal(loadDemo({ getItem: () => JSON.stringify(saved) }, today).bookings[0].date, '2026-11-10');
});
test('invalid availability ranges are rejected', () => {
  assert.equal(validateHours([{ enabled: true, start: '17:00', end: '09:00' }]), false);
  assert.equal(validateHours([{ enabled: true, start: '09:00', end: '09:00' }]), false);
  assert.equal(validateHours(makeDemo().hours), true);
});
test('workflow simulations report missing recipients and create local tasks without sending', () => {
  const data = makeDemo();
  const failed = simulateWorkflow(data, data.workflows[0], { name: 'Demo' });
  assert.equal(failed.status, 'failed');
  const email = simulateWorkflow(data, data.workflows[0], { email: 'sample@example.com' });
  assert.match(email.detail, /nothing sent/);
  simulateWorkflow(data, data.workflows[1], { name: 'Demo' });
  assert.equal(data.tasks.length, 1);
});
test('response CSV escapes quotes and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('hello "there"'), '"hello ""there"""');
  for (const value of ['=SUM(A1:A2)', '+123', '-2', '@cmd', '\t=1']) assert.ok(csvCell(value).startsWith('"\''));
});
