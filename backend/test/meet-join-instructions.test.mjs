// Sprint task 3: create → book → join instructions. Join timing comes from the room's enforced window,
// pages and emails agree, and no instruction offers access the server would refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, publishedEventType, signUp } from './helpers.mjs';
import { tokenFrom, videoSetup } from './video-helpers.mjs';
import { canonicalZone, zoneLabel } from '../src/time.mjs';

const MIN = 60 * 1000;

test('zone labels: friendly names, offsets for the appointment date, aliases treated as one zone', () => {
  const winter = Date.UTC(2026, 0, 15, 10);
  const summer = Date.UTC(2026, 6, 15, 10);
  assert.equal(zoneLabel('Asia/Kolkata', summer), 'India Standard Time (UTC+05:30)');
  assert.equal(zoneLabel('Asia/Calcutta', summer), zoneLabel('Asia/Kolkata', summer), 'legacy alias');
  assert.equal(canonicalZone('Asia/Calcutta'), 'Asia/Kolkata');
  assert.equal(zoneLabel('Europe/London', winter), 'Greenwich Mean Time (UTC+00:00)');
  assert.equal(zoneLabel('Europe/London', summer), 'British Summer Time (UTC+01:00)');
  // 1 November 2026 is the US daylight-saving change: the label follows the appointment instant.
  assert.equal(zoneLabel('America/New_York', Date.UTC(2026, 10, 1, 4)), 'Eastern Daylight Time (UTC-04:00)');
  assert.equal(zoneLabel('America/New_York', Date.UTC(2026, 10, 1, 7)), 'Eastern Standard Time (UTC-05:00)');
  assert.equal(zoneLabel('UTC', summer), 'Coordinated Universal Time (UTC+00:00)');
});

test('video booking: exact join-opening time from the room policy, same link and time on the page and in the email', async () => {
  const env = await videoSetup({ video: { joinEarlyMinutes: 15 } });
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Joiner');
    const type = await publishedEventType(host, ws, { locations: [{ type: 'schedora_meet' }] });
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const slots = (await env.client().get(base + '/slots')).body.slots;
    const booked = await env.client().post(base + '/bookings', { name: 'Ana', email: 'ana@example.test', timezone: 'Asia/Calcutta', start: slots[0] }, idem());
    assert.equal(booked.status, 201);
    const { video } = booked.body.booking;
    assert.equal(Date.parse(video.opens_at), Date.parse(slots[0]) - 15 * MIN, 'opening time is the configured early-join policy, not a guess');
    assert.ok(Date.parse(video.closes_at) > Date.parse(slots[0]));
    const room = env.app.db.get('SELECT join_opens_at FROM video_rooms');
    assert.equal(Date.parse(video.opens_at), room.join_opens_at, 'and it is what admission enforces');

    const email = env.app.db.get("SELECT body FROM emails WHERE kind = 'confirmation' ORDER BY created_at DESC LIMIT 1").body;
    assert.ok(email.includes(video.join_url), 'the email carries the same personal link');
    assert.match(email, /Starts: .*India Standard Time \(UTC\+05:30\)/, 'alias stored by the browser still gets the friendly label');
    assert.match(email, /The link opens .*India Standard Time \(UTC\+05:30\), before the start time above\./);
    assert.ok(!/a few minutes/.test(email));
    assert.ok(!email.includes('/meet/room/'), 'no host link in the invitee email');
    const hostEmail = env.app.db.get("SELECT body FROM emails WHERE kind = 'host_notification'").body;
    assert.ok(hostEmail.includes('/meet/room/') && !hostEmail.includes(video.join_url), 'hosts get their own link, not the attendee link');

    // Early access: the link exists, but the server refuses admission until the stated time.
    const early = await env.client().post('/api/public/meet-video/join/' + tokenFrom(video.join_url), { display_name: 'Ana' });
    assert.deepEqual([early.status, early.body.error.code], [409, 'too_early']);
    assert.equal(early.body.error.opens_at, Date.parse(video.opens_at));
    env.clock.now = Date.parse(video.opens_at);
    const atOpening = await env.client().post('/api/public/meet-video/join/' + tokenFrom(video.join_url), { display_name: 'Ana' });
    assert.equal(atOpening.body.error?.code, 'waiting_for_host', 'from the stated time only the host-first rule applies, as the instructions say');
    assert.equal(video.waits_for_host, true);
    assert.match(email, /If you arrive before the host, the join page waits/);

    // Rescheduling: the page shows only the new link and window; the old link is refused.
    env.clock.now = Date.parse(slots[0]) - 60 * MIN;
    const token = booked.body.manage_token;
    const moved = (await env.client().post(`/api/public/bookings/${token}/reschedule`, { start: slots[4] })).body.booking;
    assert.equal(Date.parse(moved.video.opens_at), Date.parse(slots[4]) - 15 * MIN);
    assert.notEqual(moved.video.join_url, video.join_url);
    assert.equal((await env.client().get('/api/public/bookings/' + token)).body.booking.video, null, 'the old booking offers no join details');
    const rescheduledEmail = env.app.db.get("SELECT body FROM emails WHERE kind = 'confirmation' ORDER BY created_at DESC, rowid DESC LIMIT 1").body;
    assert.ok(rescheduledEmail.includes(moved.video.join_url) && !rescheduledEmail.includes(video.join_url));

    // Cancellation: no join details, and the link is refused.
    const second = await env.client().post(base + '/bookings', { name: 'Bo', email: 'bo@example.test', timezone: 'Europe/London', start: slots[8] }, idem());
    const link = second.body.booking.video.join_url;
    assert.match(env.app.db.get("SELECT body FROM emails WHERE kind = 'confirmation' AND to_address = 'bo@example.test'")?.body || '', /(Greenwich Mean Time|British Summer Time) \(UTC\+0[01]:00\)/);
    await env.client().post(`/api/public/bookings/${second.body.manage_token}/cancel`, { reason: 'No longer needed' });
    assert.equal((await env.client().get('/api/public/bookings/' + second.body.manage_token)).body.booking.video, null);
    env.clock.now = Date.parse(slots[8]);
    assert.notEqual((await env.client().post('/api/public/meet-video/join/' + tokenFrom(link), { display_name: 'Bo' })).status, 200);
  } finally { await env.close(); }
});

test('video off: a Schedora Meet booking shows no join link while the server would refuse it', async () => {
  const env = await videoSetup();
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Paused');
    const type = await publishedEventType(host, ws, { locations: [{ type: 'schedora_meet' }] });
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const slots = (await env.client().get(base + '/slots')).body.slots;
    const booked = await env.client().post(base + '/bookings', { name: 'Cy', email: 'cy@example.test', timezone: 'UTC', start: slots[0] }, idem());
    assert.ok(booked.body.booking.video.join_url);
    env.app.config.video.enabled = false;
    const view = (await env.client().get('/api/public/bookings/' + booked.body.manage_token)).body.booking;
    assert.deepEqual([view.status, view.location.type, view.video], ['confirmed', 'schedora_meet', null]);
  } finally { await env.close(); }
});
