// Sprints 3–5: publishing, conflict-safe booking, idempotency, email delivery, cancel/reschedule and calendar busy sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { idem, publishedEventType, setup, signUp } from './helpers.mjs';
import { parseBusy } from '../src/meet/ics.mjs';
import { validateFeedUrl } from '../src/meet/calendar.mjs';

async function bookable(env, overrides) {
  const host = env.client();
  const { ws } = await signUp(host, 'Host');
  const type = await publishedEventType(host, ws, overrides);
  const base = `/api/public/meet/${ws.slug}/${type.slug}`;
  const slots = (await env.client().get(base + '/slots')).body.slots;
  return { host, ws, type, base, slots };
}
const invitee = (start, extra) => ({ name: 'Ravi', email: 'Ravi@Example.com', timezone: 'Europe/London', start, ...extra });

test('only published event types are bookable and slots match the stored schedule', async () => {
  const env = await setup();
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Host');
    const draft = (await host.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Draft', timezone: 'Asia/Kolkata' })).body;
    assert.equal(draft.published, false);
    assert.equal((await env.client().get(`/api/public/meet/${ws.slug}/draft/slots`)).status, 404);
    assert.equal((await env.client().post(`/api/public/meet/${ws.slug}/draft/bookings`, invitee('2026-10-26T03:30:00.000Z'), idem())).status, 404);

    assert.equal((await host.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Bad', timezone: 'Mars/Base' })).body.error.field, 'timezone');
    assert.equal((await host.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Bad', timezone: 'UTC', rules: [{ weekday: 1, start_min: 540, end_min: 600 }, { weekday: 1, start_min: 570, end_min: 660 }] })).body.error.field, 'rules');

    const updated = (await host.patch(`/api/workspaces/${ws.id}/event-types/${draft.id}`, { published: true, min_notice_min: 0, rules: [{ weekday: 1, start_min: 540, end_min: 660 }], overrides: [{ date: '2026-11-02', unavailable: true }] })).body;
    assert.equal(updated.published, true);
    const { slots } = (await env.client().get(`/api/public/meet/${ws.slug}/draft/slots`)).body;
    // Mondays 09:00–11:00 Kolkata (03:30–05:30 UTC), 30-minute slots, 2 November blocked.
    assert.deepEqual(slots.slice(0, 4), ['2026-10-26T03:30:00.000Z', '2026-10-26T04:00:00.000Z', '2026-10-26T04:30:00.000Z', '2026-10-26T05:00:00.000Z']);
    assert.ok(!slots.some(slot => slot.startsWith('2026-11-02')));
    assert.ok(slots.some(slot => slot.startsWith('2026-11-09')));
  } finally { await env.close(); }
});

test('concurrent requests for one slot cannot both succeed; the loser gets fresh options', async () => {
  const env = await setup();
  try {
    const { base, slots, host, ws } = await bookable(env);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => env.client().post(base + '/bookings', invitee(slots[0], { email: `p${index}@example.com` }), idem())));
    assert.equal(results.filter(result => result.status === 201).length, 1);
    const conflicts = results.filter(result => result.status === 409);
    assert.equal(conflicts.length, 7);
    assert.equal(conflicts[0].body.error.code, 'slot_unavailable');
    assert.ok(!conflicts[0].body.error.slots.includes(slots[0]), 'refreshed slots exclude the taken time');
    const upcoming = (await host.get(`/api/workspaces/${ws.id}/bookings?scope=upcoming`)).body;
    assert.equal(upcoming.length, 1);
    // Overlapping slot from a different event type of the same host is also blocked.
    const other = await publishedEventType(host, ws, { title: 'Longer', duration_min: 60, slot_interval_min: 30 });
    const overlap = await env.client().post(`/api/public/meet/${ws.slug}/${other.slug}/bookings`, invitee(slots[0]), idem());
    assert.equal(overlap.status, 409);
  } finally { await env.close(); }
});

test('the database itself rejects overlapping confirmed bookings', async () => {
  const env = await setup();
  try {
    const { base, slots, type } = await bookable(env);
    const created = (await env.client().post(base + '/bookings', invitee(slots[0]), idem())).body.booking;
    const row = env.app.db.get('SELECT * FROM bookings WHERE id = ?', created.id);
    // A second meeting for the same host overlapping by 10 minutes, written directly to the database.
    const meetingId = randomUUID();
    env.app.db.run("INSERT INTO meetings (id, workspace_id, event_type_id, starts_at, ends_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', 0)",
      meetingId, row.workspace_id, type.id, row.starts_at + 600000, row.ends_at + 600000);
    assert.throws(() => env.app.db.run('INSERT INTO meeting_hosts (meeting_id, host_id, starts_at, ends_at, block_start, block_end, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
      meetingId, row.host_id, row.starts_at + 600000, row.ends_at + 600000, row.starts_at + 600000, row.ends_at + 600000), /booking_overlap/);
    // Reactivating a canceled overlapping host row is rejected too.
    env.app.db.run('INSERT INTO meeting_hosts (meeting_id, host_id, starts_at, ends_at, block_start, block_end, active) VALUES (?, ?, ?, ?, ?, ?, 0)',
      meetingId, row.host_id, row.starts_at + 600000, row.ends_at + 600000, row.starts_at + 600000, row.ends_at + 600000);
    assert.throws(() => env.app.db.run('UPDATE meeting_hosts SET active = 1 WHERE meeting_id = ?', meetingId), /booking_overlap/);
  } finally { await env.close(); }
});

test('idempotent retries return the same booking; reused keys with other data are refused', async () => {
  const env = await setup();
  try {
    const { base, slots } = await bookable(env);
    const key = idem();
    const first = await env.client().post(base + '/bookings', invitee(slots[2]), key);
    const retry = await env.client().post(base + '/bookings', invitee(slots[2]), key);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replay, true);
    assert.equal(retry.body.booking.id, first.body.booking.id);
    assert.equal(retry.body.manage_token, null, 'capability token is only returned once');
    assert.equal((await env.client().post(base + '/bookings', invitee(slots[3]), key)).body.error.code, 'idempotency_conflict');
    assert.equal((await env.client().post(base + '/bookings', invitee(slots[3]))).body.error.code, 'idempotency_key_required');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM bookings').count, 1);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS count FROM emails WHERE kind = 'confirmation'").count, 1);
  } finally { await env.close(); }
});

test('server revalidates invitee input and never trusts browser availability', async () => {
  const env = await setup();
  try {
    const { base, slots } = await bookable(env);
    const post = body => env.client().post(base + '/bookings', body, idem());
    assert.equal((await post(invitee(slots[0], { email: 'not-an-email' }))).body.error.field, 'email');
    assert.equal((await post(invitee(slots[0], { name: '   ' }))).body.error.field, 'name');
    assert.equal((await post(invitee(slots[0], { timezone: 'Nowhere/Zone' }))).body.error.field, 'timezone');
    assert.equal((await post(invitee('2026-10-26T03:31:00.000Z'))).body.error.code, 'slot_unavailable', 'off-grid time');
    assert.equal((await post(invitee('2026-10-25T03:30:00.000Z'))).body.error.code, 'slot_unavailable', 'Sunday is outside weekly hours');
    assert.equal((await post(invitee('2026-10-24T05:00:00.000Z'))).body.error.code, 'slot_unavailable', 'past time');
    assert.equal((await post(invitee(slots[0], { website: 'spam' }))).status, 400, 'honeypot');
  } finally { await env.close(); }
});

test('confirmation and timezone: one UTC instant shown in the invitee zone', async () => {
  const env = await setup();
  try {
    const { base, slots } = await bookable(env);
    const response = await env.client().post(base + '/bookings', invitee(slots[0], { timezone: 'America/New_York' }), idem());
    const { booking } = response.body;
    assert.equal(booking.starts_at, slots[0]);
    assert.equal(booking.invitee_email, 'ravi@example.com');
    assert.match(booking.reference, /^SCH-[A-Z2-9]{6}$/);
    assert.equal(booking.email.status, 'queued', 'email status is reported separately from the booking');
    await env.app.worker.tick();
    const confirmation = env.sent.find(message => message.subject.startsWith('Confirmed'));
    assert.match(confirmation.body, /Sunday, 25 October 2026 at 23:30 \(America\/New_York\)/);
    assert.match(confirmation.body, /http:\/\/localhost:3000\/meet\/manage\/[A-Za-z0-9_-]{40,}/);
    assert.match(confirmation.ics, /DTSTART:20261026T033000Z/);
    assert.ok(env.sent.some(message => message.subject.startsWith('New appointment')), 'host notified');
    const ics = await env.client().get(`/api/public/bookings/${response.body.manage_token}/ics`);
    assert.match(ics.headers.get('content-type'), /text\/calendar/);
    assert.match(ics.body, /BEGIN:VEVENT[\s\S]*DTEND:20261026T040000Z/);
  } finally { await env.close(); }
});

test('email failure never undoes the booking and retries never resend or rebook', async () => {
  const env = await setup();
  try {
    const { base, slots, host, ws } = await bookable(env);
    env.emailProvider.mode = 'transient';
    const { booking } = (await env.client().post(base + '/bookings', invitee(slots[0]), idem())).body;
    await env.app.worker.tick();
    let emails = (await host.get(`/api/workspaces/${ws.id}/emails`)).body;
    assert.ok(emails.filter(email => email.kind === 'confirmation').every(email => email.status === 'queued' && /unavailable/.test(email.last_error)));
    assert.equal((await host.get(`/api/workspaces/${ws.id}/bookings?scope=upcoming`)).body[0].status, 'confirmed');

    env.emailProvider.mode = 'ok';
    env.clock.now += 31000;
    await env.app.worker.tick();
    env.clock.now += 120000;
    await env.app.worker.tick();
    emails = (await host.get(`/api/workspaces/${ws.id}/emails`)).body;
    assert.equal(emails.find(email => email.kind === 'confirmation').status, 'sent');
    assert.equal(env.sent.filter(message => message.subject.startsWith('Confirmed')).length, 1);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM bookings WHERE id = ?', booking.id).count, 1);

    env.emailProvider.mode = 'permanent';
    const second = (await env.client().post(base + '/bookings', invitee(slots[3], { email: 'bounce@example.com' }), idem())).body.booking;
    await env.app.worker.tick();
    const status = (await env.client().get(`/api/workspaces/${ws.id}/bookings?scope=upcoming`)).status;
    assert.equal(status, 401);
    const hostView = (await host.get(`/api/workspaces/${ws.id}/bookings?scope=upcoming`)).body.find(item => item.id === second.id);
    assert.equal(hostView.status, 'confirmed');
    assert.equal(hostView.email.status, 'failed');
  } finally { await env.close(); }
});

test('invitee cancels and reschedules with a scoped, expiring capability', async () => {
  const env = await setup();
  try {
    const { base, slots, host, ws } = await bookable(env);
    const created = (await env.client().post(base + '/bookings', invitee(slots[0]), idem())).body;
    const token = created.manage_token;
    assert.equal((await env.client().get('/api/public/bookings/' + 'x'.repeat(43))).status, 404);
    const view = (await env.client().get('/api/public/bookings/' + token)).body;
    assert.equal(view.can_change, true);

    // Someone else takes the target slot: reschedule fails and the original stays intact.
    await env.client().post(base + '/bookings', invitee(slots[5], { email: 'other@example.com' }), idem());
    const blocked = await env.client().post(`/api/public/bookings/${token}/reschedule`, { start: slots[5] });
    assert.equal(blocked.body.error.code, 'slot_unavailable');
    assert.ok(Array.isArray(blocked.body.error.slots));
    assert.equal((await env.client().get('/api/public/bookings/' + token)).body.booking.status, 'confirmed');

    // Reschedule into a slot overlapping its own current time works (old interval released atomically).
    const moved = await env.client().post(`/api/public/bookings/${token}/reschedule`, { start: slots[1] });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.booking.starts_at, slots[1]);
    const old = (await env.client().get('/api/public/bookings/' + token)).body;
    assert.equal(old.booking.status, 'canceled');
    assert.equal(old.booking.rescheduled, true);
    assert.equal((await env.client().post(`/api/public/bookings/${token}/cancel`, {})).body.error.code, 'already_rescheduled');
    const upcoming = (await host.get(`/api/workspaces/${ws.id}/bookings?scope=upcoming`)).body;
    assert.deepEqual(upcoming.map(item => item.starts_at).sort(), [Date.parse(slots[1]), Date.parse(slots[5])].sort());
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE kind = 'reminder' AND related_id = ?", created.booking.id).status, 'canceled', 'old reminder withdrawn');
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE kind = 'reminder' AND related_id = ?", moved.body.booking.id).status, 'scheduled', 'new reminder scheduled');

    const newToken = moved.body.manage_token;
    assert.equal((await env.client().post(`/api/public/bookings/${newToken}/cancel`, { reason: 'Conflict' })).body.booking.status, 'canceled');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/bookings?scope=canceled`)).body.length, 2);
    await env.app.worker.tick();
    assert.ok(env.sent.some(message => message.subject.startsWith('Canceled') && /CANCEL/.test(message.ics || '')));

    // Links expire when the appointment starts.
    const third = (await env.client().post(base + '/bookings', invitee(slots[8], { email: 'late@example.com' }), idem())).body;
    env.clock.now = Date.parse(slots[8]) + 1000;
    const expired = await env.client().post(`/api/public/bookings/${third.manage_token}/cancel`, {});
    assert.equal(expired.status, 410);
    assert.equal((await env.client().get('/api/public/bookings/' + third.manage_token)).body.expired, true);
  } finally { await env.close(); }
});

test('reminders are scheduled, sent when due, and withdrawn on cancellation', async () => {
  const env = await setup();
  try {
    const { base, slots, host, ws } = await bookable(env, { reminder_min: 60 });
    const late = slots.find(slot => Date.parse(slot) > env.clock.now + 3 * 86400000);
    const kept = (await env.client().post(base + '/bookings', invitee(late), idem())).body.booking;
    const later = slots.find(slot => Date.parse(slot) > Date.parse(late) + 3600000);
    const canceled = (await env.client().post(base + '/bookings', invitee(later, { email: 'c@example.com' }), idem())).body.booking;
    assert.equal((await host.post(`/api/workspaces/${ws.id}/bookings/${canceled.id}/cancel`, { reason: 'Host away' })).status, 204);
    await env.app.worker.tick();
    assert.equal(env.sent.filter(message => message.subject.startsWith('Reminder')).length, 0);
    env.clock.now = Date.parse(late) - 3600000 + 1000;
    await env.app.worker.tick();
    const reminders = env.sent.filter(message => message.subject.startsWith('Reminder'));
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].to, 'ravi@example.com');
    assert.equal(env.app.db.get("SELECT status FROM emails WHERE related_id = ? AND kind = 'reminder'", canceled.id).status, 'canceled');
    assert.ok(kept);
  } finally { await env.close(); }
});

test('calendar feed busy times suppress slots; revoked access is surfaced', async () => {
  const env = await setup();
  try {
    const { host, ws, base, slots } = await bookable(env);
    const url = 'https://calendar.example.com/private/basic.ics';
    const busyStart = slots[0].replace(/[-:]|\.000/g, '');
    env.feeds.set(url, `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${busyStart}\r\nDURATION:PT1H\r\nSUMMARY:Private\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    const connected = (await host.post(`/api/workspaces/${ws.id}/calendar`, { feed_url: url })).body.connection;
    assert.equal(connected.status, 'active');
    assert.equal(connected.busy_count, 1);
    const after = (await env.client().get(base + '/slots')).body.slots;
    assert.ok(!after.includes(slots[0]) && !after.includes(slots[1]), 'busy hour removed');
    assert.equal((await env.client().post(base + '/bookings', invitee(slots[0]), idem())).body.error.code, 'slot_unavailable');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM busy_blocks').count, 1);
    assert.ok(!JSON.stringify(env.app.db.all('SELECT * FROM busy_blocks')).includes('Private'), 'event details are not stored');

    env.feeds.set(url, Object.assign(new Error('Calendar access was revoked (HTTP 404).'), { revoked: true }));
    const revoked = (await host.post(`/api/workspaces/${ws.id}/calendar/sync`)).body.connection;
    assert.equal(revoked.status, 'revoked');
    assert.match(revoked.last_error, /revoked/);
    assert.equal(revoked.busy_count, 0);

    assert.equal((await host.post(`/api/workspaces/${ws.id}/calendar`, { feed_url: 'http://insecure.example.com/x.ics' })).body.error.field, 'feed_url');
    assert.equal(validateFeedUrl('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
  } finally { await env.close(); }
});

test('ICS parsing: time zones, all-day, recurrence, exclusions, cancelled and free events', () => {
  const feed = [
    'BEGIN:VCALENDAR', 'X-WR-TIMEZONE:America/New_York',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T093000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', 'EXDATE;TZID=America/New_York:20261104T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261112T150000Z', 'DTEND:20261112T160000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261113T150000Z', 'DTEND:20261113T160000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261114T150000Z', 'DTEND:20261114T160', ' 000Z', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const busy = parseBusy(feed, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 31) }).map(period => [new Date(period.starts_at).toISOString(), new Date(period.ends_at).toISOString()]);
  assert.deepEqual(busy, [
    ['2026-11-02T14:00:00.000Z', '2026-11-02T14:30:00.000Z'],
    ['2026-11-09T14:00:00.000Z', '2026-11-09T14:30:00.000Z'],
    ['2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z'],
    ['2026-11-11T14:00:00.000Z', '2026-11-11T14:30:00.000Z'],
    ['2026-11-14T15:00:00.000Z', '2026-11-14T16:00:00.000Z']
  ]);
});
