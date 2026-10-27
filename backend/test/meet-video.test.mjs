import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUp, publishedEventType, idem } from './helpers.mjs';
import { videoSetup, claims, tokenFrom } from './video-helpers.mjs';
import { reconcileWallet } from '../src/video/credits.mjs';

const MIN = 60000;

async function hostWithRoom(env, name = 'Vid') {
  const host = env.client();
  const account = await signUp(host, name);
  const created = await host.post(`/api/workspaces/${account.ws.id}/meet-video/rooms`, { title: 'Team sync' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { host, ...account, room: created.body };
}

test('instant meetings: scoped no-store tokens, host-only controls, cross-workspace denial and forged fields', async () => {
  const env = await videoSetup();
  try {
    const { host, ws, user, room } = await hostWithRoom(env);
    assert.equal(room.role, 'host');
    // Forged role, identity, room name and billing owner in the body are ignored.
    const join = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Asha', role: 'admin', identity: 'forged', room: 'other-room', workspace_id: 'x', canPublishData: true });
    assert.equal(join.status, 200, JSON.stringify(join.body));
    assert.match(join.headers.get('cache-control'), /no-store/);
    const stored = env.room(room.public_id);
    const grant = claims(join.body.token);
    assert.equal(grant.video.room, stored.room_name);
    assert.notEqual(grant.sub, 'forged');
    assert.equal(join.body.role, 'host');
    for (const privileged of ['roomAdmin', 'roomList', 'roomCreate']) assert.equal(grant.video[privileged], false);
    assert.equal(grant.video.canPublishData, false);
    assert.ok(grant.exp - Math.floor(Date.now() / 1000) <= env.app.config.video.tokenTtlSeconds);
    assert.ok(stored.provisioned_at, 'provider room created on first admission');
    // Duplicate tab: same member identity, no second participant row or second reservation.
    const again = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Asha' });
    assert.equal(again.body.identity, join.body.identity);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM video_participants WHERE room_id = ?', stored.id).c, 1);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM credit_reservations WHERE room_id = ?', stored.id).c, 1);

    // Another workspace cannot see, join, end or invite into this room.
    const stranger = env.client(); await signUp(stranger, 'Stranger');
    for (const [method, path] of [['GET', ''], ['POST', '/join'], ['POST', '/end'], ['POST', '/invites']]) {
      const result = await stranger.raw(method, `/api/meet-video/rooms/${room.public_id}${path}`, method === 'POST' ? {} : undefined);
      assert.equal(result.status, 404, `${method} ${path}`);
    }
    assert.equal((await stranger.get(`/api/workspaces/${ws.id}/meet-video/rooms`)).status, 404);

    // A plain member joins an instant room as a participant and cannot end it or invite guests.
    const member = env.client(); const memberAccount = await signUp(member, 'Member');
    assert.equal((await host.post(`/api/workspaces/${ws.id}/members`, { email: memberAccount.email, role: 'member' })).status, 201);
    await member.get('/api/me');
    const memberJoin = await member.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Member' });
    assert.equal(memberJoin.status, 200, JSON.stringify(memberJoin.body));
    assert.equal(memberJoin.body.role, 'participant');
    assert.equal((await member.post(`/api/meet-video/rooms/${room.public_id}/end`)).status, 403);
    assert.equal((await member.post(`/api/meet-video/rooms/${room.public_id}/invites`, {})).status, 403);
    // API keys cannot mint browser tokens.
    const key = await host.post(`/api/workspaces/${ws.id}/api-keys`, { name: 'k' });
    const viaKey = await env.client().raw('POST', `/api/meet-video/rooms/${room.public_id}/join`, {}, { Authorization: 'Bearer ' + key.body.token });
    assert.equal(viaKey.status, 403);

    // Host ends for everyone: admissions stop, provider room deletion is durable.
    assert.equal((await host.post(`/api/meet-video/rooms/${room.public_id}/end`)).status, 204);
    assert.equal((await member.post(`/api/meet-video/rooms/${room.public_id}/join`, {})).body.error.code, 'meeting_ended');
    await env.tick();
    assert.ok(env.fake.calls.includes('deleteRoom'));
    assert.equal(env.room(room.public_id).status, 'ended');
    // A replayed token reconnecting after the end is removed and the room deleted again.
    env.fake.calls.length = 0;
    await env.event('participant_joined', stored.room_name, { sid: 'PA_late', identity: join.body.identity });
    await env.tick();
    assert.ok(env.fake.calls.includes('removeParticipant') && env.fake.calls.includes('deleteRoom'), env.fake.calls.join());
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
    void user;
  } finally { await env.close(); }
});

test('guest links: no personal data, host-first admission, seats, resume, removal and webhook verification', async () => {
  const env = await videoSetup();
  try {
    const { host, room, ws } = await hostWithRoom(env);
    const link = await host.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 2 });
    assert.equal(link.status, 201);
    const token = tokenFrom(link.body.url);
    assert.ok(!env.app.db.get('SELECT 1 FROM video_invites WHERE token_hash = ?', token), 'secret is never stored');
    const guest = env.client();
    const view = await guest.get('/api/public/meet-video/join/' + token);
    assert.equal(view.status, 200);
    assert.equal(view.body.public_id, undefined);
    assert.equal(view.body.participants, undefined);
    assert.equal(JSON.stringify(view.body).includes('@'), false, 'no email addresses');
    assert.equal((await guest.get('/api/public/meet-video/join/' + token.slice(0, -2) + 'xx')).status, 404);

    // Guests wait until a host has actually connected (provider-verified, not just admitted).
    const early = await guest.post('/api/public/meet-video/join/' + token, { display_name: 'Guest' });
    assert.equal(early.body.error.code, 'waiting_for_host');
    const hostJoin = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    const stored = env.room(room.public_id);
    assert.equal((await env.event('participant_joined', stored.room_name, { sid: 'PA_host', identity: hostJoin.body.identity })).status, 200);
    await env.tick();
    const first = await guest.post('/api/public/meet-video/join/' + token, { display_name: 'Guest one', role: 'host' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.role, 'participant');
    assert.match(first.body.identity, /^g-/);
    // Same tab resuming its seat does not consume another seat.
    const resumed = await guest.post('/api/public/meet-video/join/' + token, { display_name: 'Guest one', resume: first.body.participant_id });
    assert.equal(resumed.body.participant_id, first.body.participant_id);
    const second = await env.client().post('/api/public/meet-video/join/' + token, { display_name: 'Guest two' });
    assert.equal(second.status, 200);
    const third = await env.client().post('/api/public/meet-video/join/' + token, { display_name: 'Guest three' });
    assert.equal(third.body.error.code, 'room_full');

    // Removing a guest revokes the link at the provider and in the application.
    assert.equal((await host.post(`/api/meet-video/rooms/${room.public_id}/participants/${second.body.participant_id}/remove`)).status, 204);
    await env.tick();
    assert.ok(env.fake.calls.includes('removeParticipant'));
    assert.equal((await env.client().post('/api/public/meet-video/join/' + token, { display_name: 'Again' })).body.error.code, 'link_revoked');

    // Webhooks: bad signature rejected and nothing stored; duplicates ignored.
    const bad = await env.client().raw('POST', '/api/meet-video/webhooks/fake-local', JSON.stringify({ id: 'x', event: 'room_started', createdAt: '1' }), { Authorization: 'Fake ' + '0'.repeat(64) });
    assert.equal(bad.status, 401);
    const replay = await env.event('participant_joined', stored.room_name, { sid: 'PA_host', identity: hostJoin.body.identity }, env.clock.now, 'evt-same');
    const replay2 = await env.event('participant_joined', stored.room_name, { sid: 'PA_host', identity: hostJoin.body.identity }, env.clock.now, 'evt-same');
    assert.equal(replay.body.result, 'accepted');
    assert.equal(replay2.body.result, 'duplicate');
    // Unsupported participant kinds (bots, SIP, egress) are removed, never admitted.
    env.fake.calls.length = 0;
    await env.event('participant_joined', stored.room_name, { sid: 'PA_bot', identity: 'agent-1', kind: 'AGENT' });
    await env.tick();
    assert.ok(env.fake.calls.includes('removeParticipant'));
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
  } finally { await env.close(); }
});

test('booking integration: per-attendee links, shared group room, cancel/reschedule invalidation, paid bookings', async () => {
  const env = await videoSetup({ video: { guestPolicy: 'open' } });
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Booker');
    const type = await publishedEventType(host, ws, { kind: 'group', seats: 3, locations: [{ type: 'schedora_meet' }] });
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const slot = (await env.client().get(base + '/slots')).body.slots[0];
    const book = (name, extra = {}) => env.client().post(base + '/bookings', { name, email: `${name.toLowerCase()}@example.test`, timezone: 'UTC', start: slot, ...extra }, idem());
    const a = await book('Ana', { guests: ['friend@example.test'] });
    const b = await book('Ben');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM video_rooms').c, 1, 'one room per meeting occurrence');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM video_invites').c, 2, 'one credential per booking');
    assert.equal(env.fake.calls.length, 0, 'no provider resources until someone joins');
    const joinA = a.body.booking.video.join_url;
    const joinB = b.body.booking.video.join_url;
    assert.ok(joinA && joinB && joinA !== joinB);
    assert.ok(!joinA.includes(a.body.manage_token), 'attendance link is not the management token');
    // The attendance link cannot manage the booking, and the management token is not a meeting link.
    assert.equal((await env.client().get('/api/public/bookings/' + tokenFrom(joinA))).status, 404);
    assert.equal((await env.client().get('/api/public/meet-video/join/' + a.body.manage_token)).status, 404);
    const room = env.app.db.get('SELECT * FROM video_rooms');
    assert.equal(room.seats, undefined);
    assert.equal(env.app.db.get('SELECT seats FROM video_invites WHERE booking_id = ?', a.body.booking.id).seats, 2, 'invitee plus guest');
    // Confirmation, guest and host emails carry the right links.
    await env.app.worker.tick();
    const mail = env.sent;
    const invitee = mail.find(message => message.to === 'ana@example.test');
    const guestMail = mail.find(message => message.to === 'friend@example.test');
    const hostMail = mail.find(message => message.subject.startsWith('New appointment'));
    assert.ok(invitee.body.includes(joinA) && guestMail.body.includes(joinA));
    assert.ok(hostMail.body.includes('/meet/room/' + room.public_id) && !hostMail.body.includes('/meet/join/'));
    const hostView = await host.get(`/api/workspaces/${ws.id}/bookings`);
    assert.ok(hostView.body[0].video_room_url.endsWith('/meet/room/' + room.public_id));

    // Joining opens only shortly before the start.
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinA), { display_name: 'Ana' })).body.error.code, 'too_early');
    env.clock.now = Date.parse(slot) - 5 * MIN;
    const benFirst = await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinB), { display_name: 'Ben' });
    assert.equal(benFirst.status, 200);
    // A one-seat link cannot be used by a second browser at the same time.
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinB), { display_name: 'Other' })).body.error.code, 'room_full');
    env.clock.now = Date.parse(slot) - 60 * MIN;

    // Canceling one attendee revokes only that link; the shared room continues.
    assert.equal((await env.client().post(`/api/public/bookings/${a.body.manage_token}/cancel`, {})).status, 200);
    env.clock.now = Date.parse(slot) - 5 * MIN;
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinA), { display_name: 'Ana' })).body.error.code, 'booking_canceled');
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinB), { display_name: 'Ben', resume: benFirst.body.participant_id })).status, 200);
    assert.notEqual(env.app.db.get('SELECT status FROM video_rooms WHERE id = ?', room.id).status, 'canceled');
    // Whole-group cancellation cancels the room and removes admitted guests at the provider.
    await host.post(`/api/workspaces/${ws.id}/bookings/${b.body.booking.id}/cancel`, { whole_meeting: true });
    assert.equal(env.app.db.get('SELECT status FROM video_rooms WHERE id = ?', room.id).status, 'canceled');
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(joinB), { display_name: 'Ben' })).body.error.code, 'booking_canceled');
    await env.tick();
    assert.ok(env.fake.calls.includes('deleteRoom') || env.fake.calls.includes('removeParticipant'));
  } finally { await env.close(); }
});

test('booking integration: rescheduling replaces the link; paid bookings get a link only after payment; disabled video keeps scheduling working', async () => {
  const env = await videoSetup({ video: { guestPolicy: 'open' } });
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Resched');
    const type = await publishedEventType(host, ws, { locations: [{ type: 'schedora_meet' }] });
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const slots = (await env.client().get(base + '/slots')).body.slots;
    const booked = await env.client().post(base + '/bookings', { name: 'Ria', email: 'ria@example.test', timezone: 'UTC', start: slots[0] }, idem());
    const oldLink = booked.body.booking.video.join_url;
    const moved = await env.client().post(`/api/public/bookings/${booked.body.manage_token}/reschedule`, { start: slots[3] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const newLink = moved.body.booking.video.join_url;
    assert.ok(newLink && newLink !== oldLink);
    env.clock.now = Date.parse(slots[3]) - 5 * MIN;
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(oldLink), { display_name: 'Ria' })).body.error.code, 'booking_rescheduled');
    assert.equal((await env.client().post('/api/public/meet-video/join/' + tokenFrom(newLink), { display_name: 'Ria' })).status, 200);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS c FROM video_rooms WHERE status = 'canceled'").c, 1);

    const paid = await publishedEventType(host, ws, { title: 'Paid call', slug: 'paid-call', price_cents: 50000, currency: 'inr', locations: [{ type: 'schedora_meet' }] });
    const paidBase = `/api/public/meet/${ws.slug}/${paid.slug}`;
    env.clock.now = Date.parse(slots[0]) - 3 * 86400000;
    const paidSlot = (await env.client().get(paidBase + '/slots')).body.slots.at(-1);
    const pending = await env.client().post(paidBase + '/bookings', { name: 'Pay', email: 'pay@example.test', timezone: 'UTC', start: paidSlot }, idem());
    assert.equal(pending.body.booking.status, 'pending');
    assert.equal(pending.body.booking.video, null);
    assert.ok(!env.app.db.get('SELECT 1 FROM video_invites WHERE booking_id = ?', pending.body.booking.id));
    await env.client().post(`/api/public/bookings/${pending.body.manage_token}/test-pay`);
    const confirmed = await env.client().get(`/api/public/bookings/${pending.body.manage_token}`);
    assert.ok(confirmed.body.booking.video.join_url);
  } finally { await env.close(); }

  // LiveKit disabled: native-video event types still accept bookings; joining explains unavailability.
  const off = await videoSetup({ video: { enabled: false } });
  try {
    const host = off.client();
    const { ws } = await signUp(host, 'Off');
    const type = await publishedEventType(host, ws, { locations: [{ type: 'schedora_meet' }] });
    const base = `/api/public/meet/${ws.slug}/${type.slug}`;
    const slot = (await off.client().get(base + '/slots')).body.slots[0];
    const booked = await off.client().post(base + '/bookings', { name: 'Zed', email: 'zed@example.test', timezone: 'UTC', start: slot }, idem());
    assert.equal(booked.status, 201);
    assert.equal(booked.body.booking.video, null, 'no join link is offered while video is off');
    const { bookingJoinUrl } = await import('../src/video/rooms.mjs');
    off.clock.now = Date.parse(slot);
    const join = await off.client().post('/api/public/meet-video/join/' + tokenFrom(bookingJoinUrl(off.app, booked.body.booking.id)), { display_name: 'Zed' });
    assert.equal(join.status, 503);
    assert.equal(join.body.error.code, 'video_unavailable');
    assert.equal((await host.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).status, 503);
  } finally { await off.close(); }
});

test('metering: provider timestamps, duplicates, out-of-order, reconnect overlap, missing leave and reconciliation', async () => {
  const env = await videoSetup({ video: { guestPolicy: 'open' } });
  try {
    const { host, room, ws } = await hostWithRoom(env);
    const join = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    const stored = env.room(room.public_id);
    const t0 = env.clock.now;
    const identity = join.body.identity;
    // Joined for 120s on one connection, reconnected with an overlapping second session for 60s more.
    await env.event('participant_joined', stored.room_name, { sid: 'PA_1', identity, joinedAtMs: t0 }, t0);
    await env.event('participant_joined', stored.room_name, { sid: 'PA_1', identity, joinedAtMs: t0 }, t0); // duplicate (new id)
    await env.event('participant_joined', stored.room_name, { sid: 'PA_2', identity, joinedAtMs: t0 + 100000 }, t0 + 100000);
    // Out of order: the first session's leave arrives after the second session's join, and late.
    await env.event('participant_left', stored.room_name, { sid: 'PA_1', identity, joinedAtMs: t0 }, t0 + 120000);
    await env.event('participant_left', stored.room_name, { sid: 'PA_2', identity, joinedAtMs: t0 + 100000 }, t0 + 160000);
    env.clock.now = t0 + 170000;
    await env.tick();
    // Before the window ends plus the finalization delay nothing is settled.
    assert.equal(env.app.db.get("SELECT COUNT(*) AS c FROM credit_reservations WHERE status = 'settled'").c, 0);
    env.clock.now = t0 + 11 * MIN;
    await env.tick();
    const usage = env.app.db.get('SELECT * FROM video_usage_records WHERE units_charged > 0');
    assert.equal(usage.units_charged, 160, 'union of connected time, reconnect overlap counted once');
    // Replaying everything changes nothing.
    await env.event('participant_left', stored.room_name, { sid: 'PA_2', identity, joinedAtMs: t0 + 100000 }, t0 + 160000);
    await env.tick();
    assert.equal(env.app.db.get('SELECT CAST(SUM(units_charged) AS BIGINT) AS u FROM video_usage_records').u, 160);

    // Missing leave event: reconciliation closes the session at the last provider-confirmed time.
    const again = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    const t1 = env.clock.now;
    env.fake.connect(stored.room_name, again.body.identity, { sid: 'PA_3', joinedAtMs: t1 });
    await env.tick(); // reconciliation sees the participant (join webhook was lost) and opens the session
    env.clock.now = t1 + 90000;
    await env.tick(); // still present: last seen updated
    env.fake.disconnect(stored.room_name, again.body.identity);
    env.clock.now = t1 + 200000;
    await env.tick(); // gone without a leave event: closed at last confirmed presence (t1 + 90s)
    const interval = env.app.db.get("SELECT * FROM video_usage_intervals WHERE provider_sid = 'PA_3'");
    assert.equal(interval.left_at - interval.joined_at, 90000);
    assert.equal(interval.close_source, 'reconcile');
    env.clock.now = t1 + 20 * MIN;
    await env.tick();
    assert.equal(env.app.db.get('SELECT CAST(SUM(units_charged) AS BIGINT) AS u FROM video_usage_records').u, 250);
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
  } finally { await env.close(); }
});

test('worker restart: persisted events are processed later; provider failures retry durably', async () => {
  const env = await videoSetup();
  try {
    const { host, room } = await hostWithRoom(env);
    const join = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, {});
    const stored = env.room(room.public_id);
    await env.event('participant_joined', stored.room_name, { sid: 'PA_1', identity: join.body.identity });
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM video_provider_events WHERE processed_at IS NULL').c, 1, 'acknowledged only after being stored');
    env.fake.failures.set('deleteRoom', 2);
    await host.post(`/api/meet-video/rooms/${room.public_id}/end`);
    await env.tick();
    assert.equal(env.app.db.get('SELECT COUNT(*) AS c FROM video_provider_events WHERE processed_at IS NULL').c, 0);
    assert.equal(env.app.db.get("SELECT status FROM video_provider_ops WHERE op = 'delete_room'").status, 'pending');
    assert.equal(env.room(room.public_id).status, 'ending');
    for (let i = 0; i < 3; i++) { env.clock.now += 10 * MIN; await env.tick(); }
    assert.equal(env.app.db.get("SELECT status FROM video_provider_ops WHERE op = 'delete_room'").status, 'done');
    assert.equal(env.room(room.public_id).status, 'ended');
    // Provider unavailable at admission: clean failure, credits returned.
    const second = await host.post(`/api/workspaces/${(await host.get('/api/me')).body.workspaces[0].id}/meet-video/rooms`, { title: 'Second' });
    env.fake.down = true;
    const failed = await host.post(`/api/meet-video/rooms/${second.body.public_id}/join`, {});
    assert.equal(failed.status, 503);
    assert.equal(env.app.db.get("SELECT COUNT(*) AS c FROM credit_reservations r JOIN video_rooms v ON v.id = r.room_id WHERE v.public_id = ? AND r.status = 'held'", second.body.public_id).c, 0);
  } finally { await env.close(); }
});

test('security headers: camera, microphone and provider endpoints only on meeting pages', async () => {
  const env = await videoSetup();
  try {
    const page = await env.client().get('/meet/room/' + 'a'.repeat(22));
    assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy'), /media-src 'self' blob: mediastream:/);
    const other = await env.client().get('/meet');
    assert.match(other.headers.get('permissions-policy'), /camera=\(\)/);
    assert.doesNotMatch(other.headers.get('content-security-policy'), /media-src|livekit/);
    const asset = await env.client().get('/vendor/livekit-client.esm.mjs');
    assert.equal(asset.status, 200);
  } finally { await env.close(); }
});

test('split deployment: Vercel meeting headers match the backend for LiveKit Cloud; provider URLs are validated', async () => {
  const { readFileSync } = await import('node:fs');
  const { loadConfig } = await import('../src/config.mjs');
  const { meetingCsp, MEETING_PERMISSIONS } = await import('../src/video/config.mjs');
  const vercel = JSON.parse(readFileSync(new URL('../../frontend/vercel.json', import.meta.url), 'utf8'));
  const base = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  const gates = { APP_ENCRYPTION_KEY: 'k'.repeat(40), MEET_VIDEO_WEBHOOK_CONFIRMED: 'true', MEET_VIDEO_SMOKE_CONFIRMED: 'true', MONITORING_CONFIRMED: 'true' };
  const cloud = loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', LIVEKIT_URL: 'wss://schedora-test.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 's'.repeat(40), ...gates });
  assert.equal(cloud.video.enabled, true);
  // Without the operator confirmations, production keeps video off and says why.
  const ungated = loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', LIVEKIT_URL: 'wss://schedora-test.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 's'.repeat(40) });
  assert.equal(ungated.video.enabled, false);
  assert.equal(ungated.video.blocked.length, 4);
  const rule = vercel.headers.find(item => item.source === '/meet/(room|join)/(.*)');
  const header = key => rule.headers.find(item => item.key === key).value;
  const expected = meetingCsp(cloud, base).replace(' https://schedora-test.livekit.cloud wss://schedora-test.livekit.cloud', '');
  assert.equal(header('Content-Security-Policy'), expected);
  assert.equal(header('Permissions-Policy'), MEETING_PERMISSIONS);
  assert.equal(header('Referrer-Policy'), 'no-referrer');
  assert.ok(vercel.headers.find(item => item.source === '/((?!meet/room/|meet/join/).*)').headers.some(item => item.key === 'Permissions-Policy' && item.value.startsWith('camera=()')));
  // Secrets never reach the public configuration.
  const { publicConfig } = await import('../src/config.mjs');
  assert.doesNotMatch(JSON.stringify(publicConfig(cloud)), /APIkey|ssss|livekit\.cloud/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', LIVEKIT_URL: 'ws://example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's'.repeat(40) }), /wss/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', LIVEKIT_URL: 'wss://evil.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's'.repeat(40) }), /livekit\.cloud/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'fake' }), /development/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PACKS: JSON.stringify([{ id: 'small', name: 'x', credits: 1, amount_minor: 100, currency: 'INR', fixture: true }]) }), /fixture/);
  const selfHosted = loadConfig({ NODE_ENV: 'production', MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', LIVEKIT_HOSTING: 'self_hosted', MEET_VIDEO_DEPLOYMENT: 'aws-mumbai', LIVEKIT_URL: 'wss://rtc.schedora.in', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's'.repeat(40), ...gates });
  assert.match(selfHosted.video.blocked.join(), /SELF_HOSTED_REVIEWED/, 'self-hosting needs its own review');
  assert.equal(selfHosted.video.deployment, 'aws-mumbai');
  assert.doesNotMatch(meetingCsp(selfHosted, base), /livekit\.cloud/);
  // Production defaults: video off, no allowances, no packs.
  const plain = loadConfig({ NODE_ENV: 'production' });
  assert.equal(plain.video.enabled, false);
  assert.deepEqual(plain.video.allowances, {});
  assert.deepEqual(plain.video.packs, []);
});
