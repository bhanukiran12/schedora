import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';
import { buildTrail } from '../../frontend/js/enquiry-trail.mjs';

const HOUR = 3600000;
const taskFlow = (overrides = {}) => ({ name: 'Prepare', trigger_type: 'meet.booking.created', trigger_source: null, action_type: 'task',
  action_config: { title: 'Prepare for {{invitee.name}}', details: '', due_in_hours: 24, assign_to: 'host', ...overrides }, status: 'enabled' });

async function bookingWorkspace(env) {
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Owner');
  const base = `/api/workspaces/${ws.id}`;
  const type = await publishedEventType(owner, ws, { min_notice_min: 0 });
  const slots = (await owner.get(`${base}/event-types/${type.id}/slots`)).body.slots;
  const book = async (index, name = 'Ravi') => {
    const response = await env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name, email: `${name.toLowerCase()}@example.com`, timezone: 'UTC', start: slots[index] }, idem());
    assert.equal(response.status, 201);
    for (let pass = 0; pass < 3; pass++) await env.app.worker.tick();
  };
  return { owner, ws, user, base, book };
}

test('a Flow task gets its deadline and the booking host; the editor settings are validated', async () => {
  const env = await setup();
  try {
    const { owner, user, base, book } = await bookingWorkspace(env);
    for (const [config, field] of [[{ due_in_hours: 0 }, 'action_config.due_in_hours'], [{ due_in_hours: 721 }, 'action_config.due_in_hours'],
      [{ assign_to: 'member:not-a-member' }, 'action_config.assign_to'], [{ assign_to: 'everyone' }, 'action_config.assign_to']]) {
      const response = await owner.post(`${base}/flows`, taskFlow(config));
      assert.equal(response.status, 400, JSON.stringify(config));
      assert.equal(response.body.error.field, field);
    }
    const responseTrigger = await owner.post(`${base}/flows`, { ...taskFlow(), trigger_type: 'forms.response.created' });
    assert.equal(responseTrigger.status, 400, 'a response has no host');
    assert.equal(responseTrigger.body.error.field, 'action_config.assign_to');

    assert.equal((await owner.post(`${base}/flows`, taskFlow())).status, 201);
    const created = env.clock.now;
    await book(0);
    const [task] = (await owner.get(`${base}/tasks`)).body;
    assert.equal(task.due_at, created + 24 * HOUR);
    assert.equal(task.assignee_id, user.id);
    assert.equal(task.assignee_name, 'Owner');
    assert.equal((await owner.get(`${base}/enquiries`)).body.tasks[0].due_at, created + 24 * HOUR, 'the enquiry feed carries the deadline');

    const legacy = await owner.post(`${base}/flows`, { ...taskFlow(), name: 'No deadline', action_config: { title: 'Plain', details: '' } });
    assert.equal(legacy.status, 201);
    assert.deepEqual([legacy.body.action_config.due_in_hours, legacy.body.action_config.assign_to], [null, 'none'], 'older configurations keep no deadline and no assignee');
  } finally { await env.close(); }
});

test('assignees must be current members; leaving the workspace unassigns tasks and later runs', async () => {
  const env = await setup();
  try {
    const { owner, base, book } = await bookingWorkspace(env);
    const helperHttp = env.client();
    const helper = await signUp(helperHttp, 'Helper');
    await owner.post(`${base}/members`, { email: helper.email, role: 'member' });
    assert.equal((await owner.post(`${base}/flows`, taskFlow({ assign_to: `member:${helper.user.id}` }))).status, 201);
    await book(0, 'First');
    let [task] = (await owner.get(`${base}/tasks`)).body;
    assert.equal(task.assignee_id, helper.user.id);
    assert.deepEqual((await helperHttp.get(`${base}/tasks?assignee=me`)).body.map(item => item.id), [task.id]);
    assert.deepEqual((await owner.get(`${base}/tasks?assignee=me`)).body, []);

    await owner.del(`${base}/members/${helper.user.id}`);
    [task] = (await owner.get(`${base}/tasks`)).body;
    assert.equal(task.assignee_id, null, 'a removed member no longer holds tasks');
    await book(1, 'Second');
    assert.ok((await owner.get(`${base}/tasks`)).body.every(item => item.assignee_id === null), 'later runs are created unassigned');

    const outsider = env.client();
    const stranger = await signUp(outsider, 'Stranger');
    const patch = await owner.patch(`${base}/tasks/${task.id}`, { assignee_id: stranger.user.id });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.field, 'assignee_id');
    assert.equal((await outsider.patch(`/api/workspaces/${stranger.ws.id}/tasks/${task.id}`, { status: 'done' })).status, 404, 'tasks of another workspace are not found');
  } finally { await env.close(); }
});

test('task updates are partial: deadline, assignee and status change independently', async () => {
  const env = await setup();
  try {
    const { owner, user, base, book } = await bookingWorkspace(env);
    assert.equal((await owner.post(`${base}/flows`, taskFlow({ due_in_hours: null, assign_to: 'none' }))).status, 201);
    await book(0);
    const [task] = (await owner.get(`${base}/tasks`)).body;
    assert.deepEqual([task.due_at, task.assignee_id], [null, null]);
    const path = `${base}/tasks/${task.id}`;
    const due = env.clock.now + 2 * HOUR;
    assert.equal((await owner.patch(path, { due_at: due })).status, 204);
    assert.equal((await owner.patch(path, { assignee_id: user.id })).status, 204);
    let current = (await owner.get(`${base}/tasks`)).body[0];
    assert.deepEqual([current.due_at, current.assignee_id, current.status], [due, user.id, 'open'], 'each change kept the others');
    assert.equal((await owner.patch(path, { status: 'done' })).status, 204);
    current = (await owner.get(`${base}/tasks`)).body[0];
    assert.deepEqual([current.status, current.due_at, current.assignee_id], ['done', due, user.id]);
    const completed = current.completed_at;
    env.clock.now += HOUR;
    await owner.patch(path, { status: 'done' });
    assert.equal((await owner.get(`${base}/tasks`)).body[0].completed_at, completed, 'repeating "done" keeps the completion time');
    await owner.patch(path, { due_at: null, assignee_id: null, status: 'open' });
    current = (await owner.get(`${base}/tasks`)).body[0];
    assert.deepEqual([current.status, current.completed_at, current.due_at, current.assignee_id], ['open', null, null, null]);
    for (const body of [{}, { due_at: 'tomorrow' }, { due_at: -1 }, { status: 'later' }]) assert.equal((await owner.patch(path, body)).status, 400, JSON.stringify(body));
  } finally { await env.close(); }
});

test('open tasks list by deadline, soonest first, with undated ones after them', async () => {
  const env = await setup();
  try {
    const { owner, base, book } = await bookingWorkspace(env);
    assert.equal((await owner.post(`${base}/flows`, taskFlow({ due_in_hours: null, assign_to: 'none' }))).status, 201);
    for (let index = 0; index < 3; index++) { env.clock.now += 1000; await book(index, `Person${index}`); }
    const tasks = (await owner.get(`${base}/tasks`)).body;
    await owner.patch(`${base}/tasks/${tasks[2].id}`, { due_at: env.clock.now + 5 * HOUR });
    await owner.patch(`${base}/tasks/${tasks[0].id}`, { due_at: env.clock.now + HOUR });
    const ordered = (await owner.get(`${base}/tasks`)).body.map(task => task.id);
    assert.deepEqual(ordered, [tasks[0].id, tasks[2].id, tasks[1].id]);
  } finally { await env.close(); }
});

test('enquiry trail: a dated open task waits until its deadline, then is overdue; undated open tasks need attention', () => {
  const response = { id: 'aaaaaaaa-1111-2222-3333-444444444444', created_at: 1000, next_step: null };
  const run = { id: 'run-1', flow_name: 'Review', event_type: 'forms.response.created', subject_id: response.id, status: 'succeeded', attempts: 1, created_at: 2000, result: { task: 't1' } };
  const trail = (task, now) => buildTrail(response, { runs: [run], tasks: [{ id: 't1', title: 'Call back', status: 'open', ...task }], bookingsByReference: new Map(), runsAvailable: true, tasksAvailable: true, bookingsAvailable: true, now });
  const waiting = trail({ due_at: 10_000, assignee_name: 'Asha' }, 9_999);
  assert.equal(waiting.steps.at(-1).state, 'waiting');
  assert.equal(waiting.steps.at(-1).due, 10_000);
  assert.match(waiting.steps.at(-1).text, /Assigned to Asha/);
  assert.deepEqual(waiting.reasons, []);
  const overdue = trail({ due_at: 10_000 }, 10_000);
  assert.deepEqual(overdue.reasons, ['task_overdue']);
  assert.match(overdue.steps.at(-1).text, /Task overdue: Call back\. Not assigned\./);
  assert.deepEqual(trail({ due_at: null }, 10_000).reasons, ['task_open']);
  assert.deepEqual(trail({ due_at: 10_000 }, undefined).reasons, ['task_open'], 'without a clock a deadline is not assumed to be met');
  assert.equal(trail({ status: 'done', due_at: 5 }, 10_000).steps.at(-1).state, 'done');
});
