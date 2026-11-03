// The two sales and client journeys in docs/MVS_SALES_CLIENT_MEETINGS.md, end to end on local
// records, with only supported pieces: a template draft, Forms routing to a booking offer, a
// session offer in a Schedora meeting room, and a Flow task (forms.response.created → task).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUp, publishedEventType } from './helpers.mjs';
import { videoSetup, tokenFrom } from './video-helpers.mjs';
import { FORM_TEMPLATES } from '../../frontend/js/forms-templates.mjs';

const template = id => structuredClone(FORM_TEMPLATES.find(item => item.id === id).definition);
const runWorker = async env => { for (let pass = 0; pass < 3; pass++) await env.app.worker.tick(); };

test('A. Sales discovery: template form → booking offer → accepted response → assigned preparation task', async () => {
  const env = await videoSetup();
  try {
    const owner = env.client();
    const { ws, user } = await signUp(owner, 'Sales');
    const base = `/api/workspaces/${ws.id}`;
    const call = await publishedEventType(owner, ws, { title: 'Discovery call' });
    const form = (await owner.post(`${base}/forms`, { definition: template('sales-discovery') })).body;
    assert.equal(form.published_version, null, 'a template creates an unpublished draft');
    // Ready buyers are offered the discovery call; everyone else gets a message.
    const routing = { rules: [{ condition: { field: 'timing', op: 'equals', value: 'month' }, action: { type: 'event', event_type_id: call.id } }], fallback: { type: 'message', message: 'Thanks. We will reply by email within two working days.' } };
    assert.equal((await owner.raw('PUT', `${base}/forms/${form.id}/routing`, { routing })).status, 200);
    assert.equal((await owner.post(`${base}/forms/${form.id}/publish`, {})).status, 200);
    const flow = await owner.post(`${base}/flows`, { name: 'Prepare discovery', trigger_type: 'forms.response.created', trigger_source: form.id, action_type: 'task',
      action_config: { title: 'Prepare discovery call with {{answer.name}}', details: 'Goal: {{answer.goal}}\nTiming: {{answer.timing}}\nResponse {{response.id}}', due_in_hours: 24, assign_to: `member:${user.id}` }, status: 'enabled' });
    assert.equal(flow.status, 201, JSON.stringify(flow.body));

    const buyer = env.client();
    const ready = await buyer.post(`/api/public/forms/${form.slug}/responses`, { submission_id: 'sales-ready-0000001', answers: { name: 'Meera', email: 'meera@example.com', goal: 'Cut no-shows for demos', timing: 'month' } });
    assert.equal(ready.status, 201, JSON.stringify(ready.body));
    assert.deepEqual([ready.body.next.type, ready.body.next.status, ready.body.next.title], ['booking', 'offered', 'Discovery call'], 'the buyer is offered a time, not booked');
    const exploring = await buyer.post(`/api/public/forms/${form.slug}/responses`, { submission_id: 'sales-later-0000001', answers: { name: 'Arun', email: 'arun@example.com', goal: 'Compare tools', timing: 'exploring' } });
    assert.deepEqual([exploring.body.next.type, exploring.body.next.message], ['message', 'Thanks. We will reply by email within two working days.']);

    await runWorker(env);
    const tasks = (await owner.get(`${base}/tasks?status=open`)).body;
    const prep = tasks.find(task => task.title === 'Prepare discovery call with Meera');
    assert.ok(prep, 'a preparation task exists for the accepted response');
    assert.equal(prep.assignee_id, user.id);
    assert.equal(prep.due_at, env.clock.now + 24 * 3600000);
    assert.match(prep.details, /Goal: Cut no-shows for demos/);
    assert.match(prep.details, new RegExp(`Response ${ready.body.id}`));
    assert.equal(tasks.filter(task => task.title.startsWith('Prepare discovery call')).length, 2, 'one task per accepted response, never per attempt');
  } finally { await env.close(); }
});

test('B. Client kickoff: brief before → meeting with a session offer → supplementary answers → assigned next action', async () => {
  const env = await videoSetup();
  try {
    const owner = env.client();
    const { ws, user } = await signUp(owner, 'Agency');
    const base = `/api/workspaces/${ws.id}`;
    const brief = (await owner.post(`${base}/forms`, { definition: template('client-onboarding') })).body;
    await owner.post(`${base}/forms/${brief.id}/publish`, {});
    const followUp = (await owner.post(`${base}/forms`, { definition: template('proposal-questions') })).body;
    await owner.post(`${base}/forms/${followUp.id}/publish`, {});
    await owner.post(`${base}/flows`, { name: 'Kickoff next action', trigger_type: 'forms.response.created', trigger_source: followUp.id, action_type: 'task',
      action_config: { title: 'Answer {{answer.name}}’s proposal questions', details: '{{answer.questions}}', due_in_hours: 48, assign_to: `member:${user.id}` }, status: 'enabled' });

    // Before the meeting: the client sends the brief from the ordinary public link.
    const client = env.client();
    const sent = await client.post(`/api/public/forms/${brief.slug}/responses`, { submission_id: 'kickoff-brief-00001', answers: { name: 'Lena', email: 'lena@example.com', contact_pref: 'video', goals: 'Relaunch the website' } });
    assert.equal(sent.status, 201);

    // The meeting: the host attaches the supplementary form; the client, joining late, answers it in the room.
    const room = (await owner.post(`${base}/meet-video/rooms`, { title: 'Kickoff with Lena' })).body;
    const hostJoin = await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    await env.event('participant_joined', env.room(room.public_id).room_name, { sid: 'PA_host', identity: hostJoin.body.identity });
    await env.tick();
    const session = `/api/meet-video/rooms/${room.public_id}/session`;
    assert.equal((await owner.post(`${session}/offer`, { form_id: followUp.id, mode: 'auto' })).status, 200);
    await owner.post(`${session}/note`, { body: 'We will agree owners and dates before we finish.' });
    const token = tokenFrom((await owner.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 2 })).body.url);
    const seat = (await client.post(`/api/public/meet-video/join/${token}`, { display_name: 'Lena' })).body.participant_id;
    const view = (await client.get(`/api/public/meet-video/join/${token}/session?participant=${seat}`)).body;
    assert.equal(view.note.body, 'We will agree owners and dates before we finish.');
    const answered = await client.post(`/api/public/forms/${followUp.slug}/responses`, { submission_id: 'kickoff-followup-01', session_ticket: view.offer.ticket, answers: { name: 'Lena', email: 'lena@example.com', questions: 'Can phase two start in April?' } });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));

    await runWorker(env);
    const task = (await owner.get(`${base}/tasks?status=open`)).body.find(item => item.title === 'Answer Lena’s proposal questions');
    assert.ok(task, 'the meeting answer produced the assigned next action');
    assert.deepEqual([task.assignee_id, task.details, task.due_at], [user.id, 'Can phase two start in April?', env.clock.now + 48 * 3600000]);
    const evidence = (await owner.get(session)).body.offer.evidence;
    assert.deepEqual(evidence.attendees.find(row => row.name === 'Lena').status, 'submitted');
    // Both answers are ordinary responses of their forms; the meeting kept status only.
    assert.equal((await owner.get(`${base}/forms/${brief.id}/responses`)).body.responses.length, 1);
    assert.equal((await owner.get(`${base}/forms/${followUp.id}/responses`)).body.responses.length, 1);
    assert.equal(JSON.stringify(evidence).includes('phase two'), false);
  } finally { await env.close(); }
});
