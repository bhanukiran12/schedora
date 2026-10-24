import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, demoSlots, loadDemo, makeDemo, simulateWorkflow, validateHours } from '../../frontend/js/demo-store.mjs';

test('corrupt or incomplete local preview storage falls back to safe sample data', () => {
  for (const value of ['invalid JSON', '{"version":1}', 'null']) assert.equal(loadDemo({ getItem: () => value }).profile.workspace, 'Northstar Studio');
  assert.equal(loadDemo({ getItem() { throw new Error('blocked'); } }).version, 1);
});
test('preview availability excludes weekends and overlapping appointments including buffers', () => {
  const data = makeDemo(); const event = data.events[0];
  assert.deepEqual(demoSlots(data, event, '2026-10-24'), []);
  const slots = demoSlots(data, event, '2026-10-26');
  assert.ok(slots.includes('09:00'));
  for (const busy of ['09:30', '10:00', '10:30', '11:30', '12:00', '14:00']) assert.ok(!slots.includes(busy), busy);
  assert.ok(demoSlots(data, event, '2026-10-26', 'sample-maya').includes('10:00'));
  data.bookings[0].status = 'canceled';
  assert.ok(demoSlots(data, event, '2026-10-26').includes('10:00'));
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
