// Flow v1 scheduled triggers: chosen time zones, daylight-saving boundaries and the next-runs preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduleRuns, scanTimedTriggers, scheduleSlot } from '../src/flow/engine.mjs';
import { flowProblems, describeFlow } from '../src/shared/flow-logic.mjs';
import { setup, signUp } from './helpers.mjs';

const MINUTE = 60000;
const at = iso => Date.parse(iso);
const iso = ms => new Date(ms).toISOString();

test('daily schedules follow the local clock across both New York daylight-saving changes', () => {
  const config = { every: 'day', time: '09:00', timezone: 'America/New_York' };
  // 8 March 2026: clocks go forward (EST −5 → EDT −4). 09:00 local moves from 14:00Z to 13:00Z.
  assert.deepEqual(nextScheduleRuns(config, at('2026-03-07T15:00:00Z')).map(iso), ['2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z', '2026-03-10T13:00:00.000Z']);
  // 1 November 2026: clocks go back. 09:00 local moves from 13:00Z to 14:00Z.
  assert.deepEqual(nextScheduleRuns(config, at('2026-10-31T14:00:00Z')).map(iso), ['2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  assert.equal(iso(scheduleSlot(config, at('2026-11-01T13:59:00Z'))), '2026-10-31T13:00:00.000Z');
  assert.equal(iso(scheduleSlot(config, at('2026-11-01T14:00:00Z'))), '2026-11-01T14:00:00.000Z');
});

test('a time skipped when clocks go forward runs once at the first time that exists; a repeated time runs once', () => {
  const skipped = { every: 'day', time: '02:30', timezone: 'America/New_York' };
  // 02:30 does not exist on 8 March 2026; it runs at 03:00 EDT (07:00Z), and normally the other days.
  assert.deepEqual(nextScheduleRuns(skipped, at('2026-03-07T08:00:00Z')).map(iso), ['2026-03-08T07:00:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
  const repeated = { every: 'day', time: '01:30', timezone: 'America/New_York' };
  // 01:30 happens twice on 1 November 2026 (05:30Z EDT and 06:30Z EST); only the first is a slot.
  const runs = nextScheduleRuns(repeated, at('2026-10-31T12:00:00Z'), 3).map(iso);
  assert.deepEqual(runs, ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
  assert.equal(iso(scheduleSlot(repeated, at('2026-11-01T06:45:00Z'))), '2026-11-01T05:30:00.000Z');
});

test('weekly and hourly schedules use the chosen zone, including half-hour offsets', () => {
  const weekly = { every: 'week', time: '09:00', weekday: 1, timezone: 'Asia/Kolkata' };
  // Monday 09:00 IST is 03:30Z. 23 November 2026 is a Monday.
  assert.deepEqual(nextScheduleRuns(weekly, at('2026-11-23T04:00:00Z')).map(iso), ['2026-11-30T03:30:00.000Z', '2026-12-07T03:30:00.000Z', '2026-12-14T03:30:00.000Z']);
  const hourly = { every: 'hour', time: '00:00', timezone: 'Asia/Kolkata' };
  // On the hour in India is half past in UTC.
  assert.deepEqual(nextScheduleRuns(hourly, at('2026-11-23T10:10:00Z')).map(iso), ['2026-11-23T10:30:00.000Z', '2026-11-23T11:30:00.000Z', '2026-11-23T12:30:00.000Z']);
  // Hourly in a DST zone keeps one run per real hour through the fall-back repeat.
  const ny = nextScheduleRuns({ every: 'hour', time: '00:15', timezone: 'America/New_York' }, at('2026-11-01T05:00:00Z'), 3).map(iso);
  assert.deepEqual(ny, ['2026-11-01T05:15:00.000Z', '2026-11-01T06:15:00.000Z', '2026-11-01T07:15:00.000Z']);
  // Without a zone, older workflows keep running in UTC.
  assert.equal(iso(nextScheduleRuns({ every: 'day', time: '09:00' }, at('2026-11-23T10:00:00Z'), 1)[0]), '2026-11-24T09:00:00.000Z');
});

test('schedule validation and description name the time zone', () => {
  const steps = [{ id: 'a', type: 'action', action: 'create_task', config: { title: 'Review' } }];
  assert.ok(flowProblems({ trigger: { type: 'schedule', config: { every: 'day', time: '09:00', timezone: 'Mars/Olympus' } }, steps }).includes('Choose a valid time zone for the schedule.'));
  assert.deepEqual(flowProblems({ trigger: { type: 'schedule', config: { every: 'day', time: '09:00', timezone: 'Asia/Kolkata' } }, steps }), []);
  assert.match(describeFlow({ trigger: { type: 'schedule', config: { every: 'week', weekday: 1, time: '09:00', timezone: 'Asia/Kolkata' } }, steps }), /^When every Monday at 09:00 \(Asia\/Kolkata\), create a task/);
});

test('the engine starts one run per local slot across a daylight-saving change, and the preview matches', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Schedule owner');
    const base = `/api/workspaces/${ws.id}`;
    env.clock.now = at('2026-03-06T20:00:00Z');
    const created = await owner.post(base + '/flow/workflows', { name: 'Morning review', definition: { trigger: { type: 'schedule', config: { every: 'day', time: '09:00', timezone: 'America/New_York' } }, steps: [{ id: 'a', type: 'action', action: 'create_task', config: { title: 'Review' } }] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const preview = await owner.get(`${base}/flow/schedule-preview?every=day&time=09:00&timezone=America%2FNew_York`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.runs.map(iso), ['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
    assert.equal((await owner.get(`${base}/flow/schedule-preview?every=day&time=09:00&timezone=Nowhere%2FZone`)).status, 400);
    await owner.post(`${base}/flow/workflows/${created.body.id}/publish`, { revision: created.body.draft_revision });
    await owner.post(`${base}/flow/workflows/${created.body.id}/status`, { status: 'enabled' });
    const runs = () => env.app.db.all('SELECT event_id FROM flow_runs WHERE flow_id = ? ORDER BY created_at', created.body.id).map(row => row.event_id);
    // Walk the clock in 20-minute steps for three days; each local 09:00 starts exactly one run.
    for (let now = env.clock.now; now <= at('2026-03-09T20:00:00Z'); now += 20 * MINUTE) { env.clock.now = now; scanTimedTriggers(env.app, { force: true }); }
    assert.deepEqual(runs(), ['schedule:' + at('2026-03-07T14:00:00Z'), 'schedule:' + at('2026-03-08T13:00:00Z'), 'schedule:' + at('2026-03-09T13:00:00Z')]);
    // A worker that was down for a day starts only the latest missed slot, not a backlog.
    env.clock.now = at('2026-03-11T20:00:00Z');
    scanTimedTriggers(env.app, { force: true });
    assert.equal(runs().length, 4);
    assert.equal(runs()[3], 'schedule:' + at('2026-03-11T13:00:00Z'));
  } finally { await env.close(); }
});
