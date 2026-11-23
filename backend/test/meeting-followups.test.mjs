import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliverDueEmails } from '../src/platform/email.mjs';
import { createRateLimiter } from '../src/http.mjs';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';

const TRANSCRIPT = `Host: Thanks for joining. We agreed the pilot starts on 3 November.
Priya: I will send the signed proposal by Friday.
Host: Great, and I will share the onboarding checklist tomorrow morning.`;

function fakeAi(app, result) {
  const calls = [];
  app.anthropic = { beta: { messages: { create: async request => {
    calls.push(request);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(typeof result === 'function' ? result() : result) }], usage: { input_tokens: 900, output_tokens: 300 } };
  } } } };
  return calls;
}
const draft = {
  subject: 'Next steps for the pilot',
  body: 'Hi Priya,\n\nThanks for today. The pilot starts on 3 November. You will send the signed proposal by Friday, and I will share the onboarding checklist tomorrow.',
  tasks: [
    { title: 'Share the onboarding checklist', owner: 'Host', due: 'Tomorrow morning', quote: 'I will share the onboarding checklist tomorrow morning' },
    { title: 'Send the invoice', owner: 'Host', due: 'Monday', quote: 'I will send the invoice on Monday' }
  ],
  sources: [{ quote: 'We agreed the pilot starts on 3 November', supports: 'Pilot start date' }, { quote: 'The price is ₹50,000', supports: 'Price' }]
};

async function fixture() {
  const env = await setup();
  const owner = env.client();
  const { ws } = await signUp(owner, 'Follow-up host');
  const event = await publishedEventType(owner, ws, { timezone: 'UTC' });
  const slots = (await env.client().get(`/api/public/meet/${ws.slug}/${event.slug}/slots`)).body.slots;
  const booked = (await env.client().post(`/api/public/meet/${ws.slug}/${event.slug}/bookings`, { name: 'Priya', email: 'priya@example.com', timezone: 'UTC', start: slots[0], guests: ['ops@example.com'] }, idem())).body;
  const transcript = (await owner.post(`/api/workspaces/${ws.id}/transcripts`, { title: 'Pilot kickoff', content: TRANSCRIPT, booking_reference: booked.booking.reference })).body;
  return { ...env, owner, ws, transcript, base: `/api/workspaces/${ws.id}` };
}

test('drafts keep only quotes found in the transcript, measure usage, retry safely and send nothing on their own', async () => {
  const env = await fixture();
  try {
    const path = `${env.base}/transcripts/${env.transcript.id}/followups`;
    assert.equal((await env.owner.post(path, { request_id: randomUUID() })).status, 503, 'unavailable without an AI provider');
    const calls = fakeAi(env.app, draft);
    const request = { request_id: randomUUID() };
    const created = await env.owner.post(path, request);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const followup = created.body;
    assert.equal(followup.status, 'draft');
    assert.deepEqual(followup.tasks.map(task => task.title), ['Share the onboarding checklist'], 'an invented task is removed');
    assert.deepEqual(followup.sources.map(source => source.supports), ['Pilot start date'], 'an invented quote is removed');
    assert.equal(followup.removed_unsupported, 2);
    assert.deepEqual(followup.recipients.sort(), ['ops@example.com', 'priya@example.com'], 'attendees are suggested, not sent to');
    assert.deepEqual(followup.usage, { input_tokens: 900, output_tokens: 300 });
    assert.match(calls[0].messages[0].content, /Pilot kickoff/);
    assert.equal((await env.owner.post(path, request)).body.id, followup.id, 'the same request returns the same draft');
    assert.equal(calls.length, 1);
    await deliverDueEmails(env.app);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM emails WHERE kind = 'meeting_followup'").n, 0);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM tasks WHERE source_run_id LIKE 'followup:%'").n, 0);
    const listed = (await env.owner.get(path)).body;
    assert.equal(listed.followups.length, 1);
    assert.equal(listed.usage.used, 1);
  } finally { await env.close(); }
});

test('sending needs explicit review of the latest revision, then emails and tasks are created exactly once', async () => {
  const env = await fixture();
  try {
    fakeAi(env.app, draft);
    const followup = (await env.owner.post(`${env.base}/transcripts/${env.transcript.id}/followups`, { request_id: randomUUID() })).body;
    const at = `${env.base}/followups/${followup.id}`;
    assert.equal((await env.owner.post(at + '/send', { revision: 0, send_email: true })).body.error.code, 'review_required');
    const edited = await env.owner.patch(at, { revision: 0, subject: 'Pilot: next steps', body: followup.body + '\n\nBest, Host', recipients: ['priya@example.com'], tasks: [{ ...followup.tasks[0], title: 'Send onboarding checklist to Priya' }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.revision, 1);
    assert.equal(edited.body.edited, true);
    assert.equal((await env.owner.patch(at, { revision: 0, subject: 'stale' })).status, 409, 'a stale tab cannot overwrite');
    assert.equal((await env.owner.patch(at, { revision: 1, tasks: [{ title: 'Invented', quote: 'not in transcript' }] })).status, 400, 'tasks keep their transcript source');
    assert.equal((await env.owner.patch(at, { revision: 1, recipients: ['not-an-email'] })).status, 400);
    assert.equal((await env.owner.post(at + '/send', { revision: 0, confirm: true, send_email: true })).status, 409, 'must review the latest revision');

    const sent = await env.owner.post(at + '/send', { revision: 1, confirm: true, send_email: true, create_tasks: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, 'sent');
    assert.equal(sent.body.sent_emails, 1);
    assert.equal(sent.body.created_tasks, 1);
    const again = await env.owner.post(at + '/send', { revision: 1, confirm: true, send_email: true, create_tasks: true });
    assert.equal(again.body.replay, true);
    const emails = env.app.db.all("SELECT to_address, subject, body FROM emails WHERE kind = 'meeting_followup'");
    assert.deepEqual(emails.map(row => row.to_address), ['priya@example.com']);
    assert.equal(emails[0].subject, 'Pilot: next steps', 'the reviewed text is what is sent');
    assert.match(emails[0].body, /Best, Host$/);
    const task = env.app.db.get("SELECT title, details FROM tasks WHERE source_run_id LIKE 'followup:%'");
    assert.equal(task.title, 'Send onboarding checklist to Priya');
    assert.match(task.details, /I will share the onboarding checklist tomorrow morning/);
    assert.equal((await env.owner.patch(at, { revision: 1, subject: 'after' })).status, 409, 'sent drafts are closed');
  } finally { await env.close(); }
});

test('follow-ups respect workspace scope, authorship, unreadable AI output and the daily budget', async () => {
  const env = await fixture();
  try {
    fakeAi(env.app, { subject: 'x', body: '', tasks: [], sources: [] });
    const path = `${env.base}/transcripts/${env.transcript.id}/followups`;
    assert.equal((await env.owner.post(path, { request_id: randomUUID() })).status, 502);
    assert.equal(env.app.db.get("SELECT status FROM meeting_followups").status, 'failed');
    const other = env.client();
    const { ws: otherWs } = await signUp(other, 'Other');
    assert.equal((await other.post(`/api/workspaces/${otherWs.id}/transcripts/${env.transcript.id}/followups`, { request_id: randomUUID() })).status, 404);
    assert.equal((await other.post(path, { request_id: randomUUID() })).status, 404);
    fakeAi(env.app, draft);
    // The per-minute request limiter is separate; reset it so this exercises the daily budget (the failed draft counts).
    env.app.rateLimit = createRateLimiter();
    for (let index = 1; index < 20; index++) assert.equal((await env.owner.post(path, { request_id: randomUUID() })).status, 201);
    env.app.rateLimit = createRateLimiter();
    const over = await env.owner.post(path, { request_id: randomUUID() });
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, 'ai_daily_limit');
    const one = (await env.owner.get(path)).body.followups[0];
    assert.equal((await other.post(`${env.base}/followups/${one.id}/send`, { revision: 0, confirm: true, send_email: true })).status, 404);
    assert.equal((await env.owner.del(`${env.base}/followups/${one.id}`)).status, 204);
  } finally { await env.close(); }
});
