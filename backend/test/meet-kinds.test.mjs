// Meeting kinds, limits, one-off links, questions, locations, workflows, book-on-behalf and polls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, setup, signUp } from './helpers.mjs';

const MON9 = '2026-10-26T09:00:00.000Z';
const MON10 = '2026-10-26T10:00:00.000Z';

async function team(env, size = 3) {
  const owner = env.client();
  const { ws, user } = await signUp(owner, 'Owner');
  const members = [{ http: owner, user }];
  for (let index = 1; index < size; index++) {
    const http = env.client();
    const signed = await signUp(http, 'Member' + index);
    await owner.post(`/api/workspaces/${ws.id}/members`, { email: signed.email, role: 'member' });
    members.push({ http, user: signed.user, email: signed.email });
  }
  return { owner, ws, members };
}
const create = async (http, ws, body) => {
  const response = await http.post(`/api/workspaces/${ws.id}/event-types`, { timezone: 'UTC', published: true, min_notice_min: 0, duration_min: 60, ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
};
const book = (env, ws, type, start, extra = {}) => env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: 'Ivy', email: `ivy${Math.random().toString(36).slice(2, 8)}@example.com`, timezone: 'UTC', start, ...extra }, idem());
const slots = async (env, ws, type) => (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body;

test('group events fill seats in one meeting, then the time disappears', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const type = await create(owner, ws, { title: 'Workshop', kind: 'group', seats: 2 });
    assert.equal((await slots(env, ws, type)).seats_left[MON9], 2);
    const first = await book(env, ws, type, MON9);
    const second = await book(env, ws, type, MON9);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const meetings = env.app.db.all('SELECT meeting_id FROM bookings');
    assert.equal(new Set(meetings.map(row => row.meeting_id)).size, 1, 'both attendees share one meeting');
    assert.ok(!(await slots(env, ws, type)).slots.includes(MON9), 'full meeting no longer offered');
    assert.equal((await book(env, ws, type, MON9)).body.error.code, 'slot_unavailable');
    // One attendee cancels: the seat reopens and the meeting stays.
    await env.client().post(`/api/public/bookings/${first.body.manage_token}/cancel`, {});
    assert.equal((await slots(env, ws, type)).seats_left[MON9], 1);
    assert.equal(env.app.db.get("SELECT status FROM meetings").status, 'active');
  } finally { await env.close(); }
});

test('collective events need every host free and block all of them', async () => {
  const env = await setup();
  try {
    const { owner, ws, members } = await team(env, 2);
    const [a, b] = members.map(member => member.user.id);
    const solo = await create(members[1].http, ws, { title: 'B solo' });
    await book(env, ws, solo, MON9);
    const panel = await create(owner, ws, { title: 'Panel', kind: 'collective', hosts: [{ user_id: a }, { user_id: b }] });
    const available = (await slots(env, ws, panel)).slots;
    assert.ok(!available.includes(MON9), 'host B busy at 09:00');
    assert.ok(available.includes(MON10));
    assert.equal((await book(env, ws, panel, MON10)).status, 201);
    const hosts = env.app.db.all("SELECT host_id FROM meeting_hosts h JOIN meetings m ON m.id = h.meeting_id WHERE m.starts_at = ? AND h.active = 1", Date.parse(MON10)).map(row => row.host_id).sort();
    assert.deepEqual(hosts, [a, b].sort());
    // Host A's own event type now loses 10:00 too.
    const aSolo = await create(owner, ws, { title: 'A solo' });
    assert.ok(!(await slots(env, ws, aSolo)).slots.includes(MON10));
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/event-types`, { title: 'X', timezone: 'UTC', kind: 'collective', hosts: [{ user_id: a }] })).body.error.field, 'hosts');
    assert.equal((await members[1].http.post(`/api/workspaces/${ws.id}/event-types`, { title: 'X', timezone: 'UTC', kind: 'collective', hosts: [{ user_id: a }, { user_id: b }] })).status, 403, 'members cannot create team events for others');
  } finally { await env.close(); }
});

test('round robin assigns by priority, balances load, and routes known leads to their owner', async () => {
  const env = await setup();
  try {
    const { owner, ws, members } = await team(env, 3);
    const [a, b, c] = members.map(member => member.user.id);
    const rr = await create(owner, ws, { title: 'Sales demo', kind: 'round_robin', hosts: [{ user_id: a, priority: 1 }, { user_id: b, priority: 3 }, { user_id: c, priority: 3 }] });
    const host = id => env.app.db.get('SELECT host_id FROM bookings WHERE id = ?', id).host_id;
    const first = (await book(env, ws, rr, MON9)).body.booking;
    const second = (await book(env, ws, rr, MON9)).body.booking;
    assert.deepEqual([host(first.id), host(second.id)].sort(), [b, c].sort(), 'high-priority hosts first, one each');
    const third = (await book(env, ws, rr, MON9)).body.booking;
    assert.equal(host(third.id), a, 'lower priority host takes the slot when others are busy');
    assert.equal((await book(env, ws, rr, MON9)).body.error.code, 'slot_unavailable', 'nobody left at 09:00');

    // Known lead: an existing contact owned by A goes to A at 10:00.
    await owner.post(`/api/workspaces/${ws.id}/contacts`, { email: 'lead@example.com', name: 'Lead' });
    const contact = (await owner.get(`/api/workspaces/${ws.id}/contacts?q=lead`)).body[0];
    await owner.patch(`/api/workspaces/${ws.id}/contacts/${contact.id}`, { owner_id: a });
    const lead = (await book(env, ws, rr, MON10, { email: 'lead@example.com' })).body.booking;
    assert.equal(host(lead.id), a);

    // Equal distribution ignores priority and balances by count.
    await owner.patch(`/api/workspaces/${ws.id}/event-types/${rr.id}`, { rr_strategy: 'equal' });
    const next = (await book(env, ws, rr, '2026-10-26T11:00:00.000Z')).body.booking;
    assert.notEqual(host(next.id), a, 'A already has two meetings');
  } finally { await env.close(); }
});

test('daily limits, date ranges and personal working hours', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const limited = await create(owner, ws, { title: 'Limited', max_per_day: 1, start_date: '2026-10-27', end_date: '2026-10-28' });
    let available = (await slots(env, ws, limited)).slots;
    assert.ok(available.every(slot => slot.startsWith('2026-10-27') || slot.startsWith('2026-10-28')), 'date range respected');
    await book(env, ws, limited, '2026-10-27T09:00:00.000Z');
    available = (await slots(env, ws, limited)).slots;
    assert.ok(!available.some(slot => slot.startsWith('2026-10-27')), 'daily limit reached');
    assert.ok(available.some(slot => slot.startsWith('2026-10-28')));

    const team2 = await create(owner, ws, { title: 'Team hours', kind: 'round_robin', use_host_schedules: true });
    await owner.raw('PUT', `/api/workspaces/${ws.id}/schedule`, { timezone: 'UTC', rules: [{ weekday: 1, start_min: 780, end_min: 840 }] });
    assert.deepEqual((await slots(env, ws, team2)).slots.filter(slot => slot.startsWith('2026-10-26')), ['2026-10-26T13:00:00.000Z']);
  } finally { await env.close(); }
});

test('one-off links: specific times, single use, expiry', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const oneOff = await create(owner, ws, { title: 'Contract review', one_off: true, single_use: true, offered_slots: ['2026-10-29T15:00:00Z', '2026-10-30T16:00:00Z'], expires_at: '2026-11-15T00:00:00Z' });
    assert.ok(oneOff.secret && oneOff.slug.startsWith('contract-review-'));
    assert.deepEqual((await slots(env, ws, oneOff)).slots, ['2026-10-29T15:00:00.000Z', '2026-10-30T16:00:00.000Z']);
    assert.ok(!(await env.client().get(`/api/public/meet/${ws.slug}`)).body.event_types.some(type => type.slug === oneOff.slug), 'hidden from the public page');
    const booked = await book(env, ws, oneOff, '2026-10-30T16:00:00.000Z');
    assert.equal(booked.status, 201);
    assert.equal((await env.client().get(`/api/public/meet/${ws.slug}/${oneOff.slug}`)).status, 404, 'single-use link closes after booking');
    assert.equal((await env.client().get('/api/public/bookings/' + booked.body.manage_token)).body.can_change, true, 'the booked invitee can still reschedule');
    const expiring = await create(owner, ws, { title: 'Soon', one_off: true, expires_at: '2026-10-25T00:00:00Z' });
    env.clock.now = Date.parse('2026-10-25T01:00:00Z');
    assert.equal((await env.client().get(`/api/public/meet/${ws.slug}/${expiring.slug}`)).status, 404);
  } finally { await env.close(); }
});

test('questions, locations, guests and conditional SMS/email workflows', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const type = await create(owner, ws, {
      title: 'Consultation',
      questions: [
        { id: 'company', type: 'short_text', label: 'Company', required: true },
        { id: 'budget', type: 'single_choice', label: 'Budget', required: true, options: [{ id: 'small', label: 'Under 1 lakh' }, { id: 'large', label: 'Over 1 lakh' }] },
        { id: 'mobile', type: 'phone', label: 'Mobile', required: false }
      ],
      locations: [{ type: 'video', value: 'https://meet.example.com/room' }, { type: 'phone_host_calls' }, { type: 'in_person', value: '12 MG Road, Bengaluru' }]
    });
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Bad', timezone: 'UTC', locations: [{ type: 'video', value: 'http://insecure' }] })).body.error.field, 'locations.0.value');
    await owner.post(`/api/workspaces/${ws.id}/workflows`, { name: 'SMS reminder', event_type_id: type.id, trigger_type: 'before_start', offset_min: 60, channel: 'sms', recipient: 'invitee', body: 'Reminder: {{event.title}} at {{booking.start}}' });
    await owner.post(`/api/workspaces/${ws.id}/workflows`, { name: 'Big deal follow-up', event_type_id: type.id, trigger_type: 'after_end', offset_min: 30, channel: 'email', recipient: 'invitee',
      subject: 'Thanks {{invitee.name}}', body: 'Next steps for {{answer.company}}', condition: { question: 'budget', op: 'equals', value: 'large' } });
    await owner.post(`/api/workspaces/${ws.id}/workflows`, { name: 'Cancel note', trigger_type: 'canceled', channel: 'email', recipient: 'host', subject: 'Lost {{invitee.name}}', body: 'Canceled.' });

    const missing = await book(env, ws, type, MON9, { location_index: 0, answers: { budget: 'large' } });
    assert.deepEqual(Object.keys(missing.body.error.errors), ['company']);
    assert.equal((await book(env, ws, type, MON9, { location_index: 1, answers: { company: 'Acme', budget: 'small' } })).body.error.field, 'phone', 'host-calls location needs a phone');
    const ok = await book(env, ws, type, MON9, { location_index: 1, phone: '+91 98765 43210', guests: ['guest@example.com'], answers: { company: 'Acme', budget: 'large' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.booking.location.display, 'Phone call: the host will call you');

    const messages = env.app.db.all('SELECT kind, channel, to_address, subject, body, status, next_attempt_at FROM emails ORDER BY created_at');
    assert.ok(messages.some(message => message.kind === 'guest_confirmation' && message.to_address === 'guest@example.com'));
    const sms = messages.find(message => message.channel === 'sms');
    assert.equal(sms.to_address, '+91 98765 43210');
    assert.equal(sms.next_attempt_at, Date.parse(MON9) - 3600000);
    const followUp = messages.find(message => message.subject.startsWith('Thanks'));
    assert.equal(followUp.body, 'Next steps for Acme');
    assert.equal(followUp.next_attempt_at, Date.parse(MON9) + 90 * 60000);
    assert.match(messages.find(message => message.kind === 'host_notification').body, /Budget: Over 1 lakh/);

    const small = await book(env, ws, type, MON10, { location_index: 0, answers: { company: 'Tiny', budget: 'small' } });
    assert.ok(!env.app.db.all("SELECT body FROM emails WHERE kind = 'workflow'").some(row => row.body === 'Next steps for Tiny'), 'condition not met, no follow-up');

    await env.client().post(`/api/public/bookings/${ok.body.manage_token}/cancel`, {});
    const after = env.app.db.all("SELECT subject, status, channel FROM emails WHERE related_id = ?", ok.body.booking.id);
    assert.equal(after.find(row => row.channel === 'sms').status, 'canceled', 'scheduled SMS withdrawn');
    assert.ok(after.some(row => row.subject === 'Lost Ivy'), 'canceled workflow ran');
    await env.app.worker.tick();
    assert.ok(small);
  } finally { await env.close(); }
});

test('hosts book on behalf of invitees, optionally outside working hours', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const type = await create(owner, ws, { title: 'Call' });
    const saturday = '2026-10-31T09:00:00.000Z';
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/bookings`, { event_type_id: type.id, name: 'Raj', email: 'raj@example.com', timezone: 'UTC', start: saturday })).body.error.code, 'slot_unavailable');
    const booked = await owner.post(`/api/workspaces/${ws.id}/bookings`, { event_type_id: type.id, name: 'Raj', email: 'raj@example.com', timezone: 'UTC', start: saturday, override: true });
    assert.equal(booked.status, 201);
    assert.match(booked.body.manage_url, /\/meet\/manage\//);
    assert.equal(env.app.db.get('SELECT source FROM bookings').source, 'host');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/bookings`, { event_type_id: type.id, name: 'Sam', email: 'sam@example.com', timezone: 'UTC', start: saturday, override: true })).body.error.code, 'slot_unavailable', 'override never double-books');
  } finally { await env.close(); }
});

test('meeting polls: vote without an account, host confirms, everyone is booked', async () => {
  const env = await setup();
  try {
    const { owner, ws } = await team(env, 1);
    const poll = (await owner.post(`/api/workspaces/${ws.id}/polls`, { title: 'Quarterly sync', duration_min: 45, timezone: 'Asia/Kolkata', options: [MON9, MON10, '2026-10-27T09:00:00Z'] })).body;
    const voter = env.client();
    await voter.post(`/api/public/polls/${poll.slug}/votes`, { name: 'Asha K', email: 'asha@example.com', option_ids: [poll.options[0].id, poll.options[1].id] });
    await voter.post(`/api/public/polls/${poll.slug}/votes`, { name: 'Ben', email: 'ben@example.com', option_ids: [poll.options[1].id] });
    const publicView = (await voter.get(`/api/public/polls/${poll.slug}`)).body;
    assert.deepEqual(publicView.options.map(option => option.votes), [1, 2, 0]);
    assert.ok(!JSON.stringify(publicView).includes('ben@example.com'), 'voters do not see emails');
    const confirmed = (await owner.post(`/api/workspaces/${ws.id}/polls/${poll.id}/confirm`, { option_id: poll.options[1].id })).body;
    assert.equal(confirmed.status, 'booked', JSON.stringify(confirmed));
    const bookings = env.app.db.all("SELECT invitee_email, starts_at, ends_at, meeting_id FROM bookings WHERE status = 'confirmed' ORDER BY invitee_email");
    assert.deepEqual(bookings.map(row => row.invitee_email), ['asha@example.com', 'ben@example.com']);
    assert.equal(bookings[0].ends_at - bookings[0].starts_at, 45 * 60000);
    assert.equal(bookings[0].meeting_id, bookings[1].meeting_id);
    assert.equal((await voter.post(`/api/public/polls/${poll.slug}/votes`, { name: 'Late', email: 'late@example.com', option_ids: [poll.options[0].id] })).body.error.code, 'poll_closed');
  } finally { await env.close(); }
});
