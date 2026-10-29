import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../src/config.mjs';
import { videoSetup, tokenFrom } from './video-helpers.mjs';
import { signUp } from './helpers.mjs';
import { checkLiveKitPilot } from '../scripts/check-livekit-pilot.mjs';

test('production validation pilot requires monitoring/webhook and one workspace; general video stays gated and limits cannot be raised', () => {
  const env = { NODE_ENV: 'production', MEET_VIDEO_ENABLED: 'false', MEET_VIDEO_PROVIDER: 'livekit',
    LIVEKIT_URL: 'wss://pilot.livekit.cloud', LIVEKIT_API_KEY: 'fixture', LIVEKIT_API_SECRET: 's'.repeat(40), APP_ENCRYPTION_KEY: 'e'.repeat(40),
    MEET_VIDEO_PILOT_ENABLED: 'true', MEET_VIDEO_PILOT_WORKSPACES: '["00000000-0000-4000-8000-000000000001"]',
    MEET_VIDEO_WEBHOOK_CONFIRMED: 'true', MONITORING_CONFIRMED: 'true', MEET_VIDEO_MAX_PARTICIPANTS: '100', MEET_VIDEO_MAX_ROOM_MINUTES: '1440' };
  const config = loadConfig(env);
  assert.equal(config.video.pilot.enabled, true);
  assert.equal(config.video.enabled, false);
  assert.equal(publicConfig(config).video.enabled, false, 'public product availability is not promoted by pilot configuration');
  assert.equal(config.video.maxParticipants, 2); assert.equal(config.video.maxGlobalParticipants, 2);
  assert.equal(config.video.maxRoomMinutes, 15); assert.equal(config.video.maxConcurrentRooms, 1);
  assert.equal(loadConfig({ ...env, MONITORING_CONFIRMED: '' }).video.pilot.enabled, false);
  assert.equal(loadConfig({ ...env, MEET_VIDEO_WEBHOOK_CONFIRMED: '' }).video.pilot.enabled, false);
  assert.throws(() => loadConfig({ ...env, MEET_VIDEO_PILOT_WORKSPACES: '["*","another"]' }), /workspace UUID/);
  assert.throws(() => loadConfig({ ...env, MEET_VIDEO_ENABLED: 'true' }), /either.*pilot.*general/);
});

test('provider pilot check touches only its new empty room, cleans up after failures and never pretends to verify media', async () => {
  const config = { video: { enabled: false, pilot: { enabled: true }, deployment: 'cloud', deployments: [{ id: 'cloud', provider: 'livekit', hosting: 'cloud' }] } };
  const calls = []; let roomName, failList = false;
  const client = {
    async createRoom(room) { roomName = room.name; assert.match(roomName, /^schedora-pilot-check-/); assert.equal(room.maxParticipants, 2); calls.push('create'); },
    async listRooms(names) { assert.deepEqual(names, [roomName]); if (failList) throw new Error('private provider payload'); return [{ name: roomName }]; },
    async listParticipants(name) { assert.equal(name, roomName); return []; },
    async deleteRoom(name) { assert.equal(name, roomName); calls.push('delete'); }
  };
  const result = await checkLiveKitPilot(config, () => client);
  assert.equal(result.passed, true); assert.deepEqual(calls, ['create', 'delete']);
  assert.match(result.scope, /media.*not verified/);
  failList = true;
  const failure = await checkLiveKitPilot(config, () => client);
  assert.equal(failure.passed, false); assert.equal(failure.cleaned, true);
  assert.ok(!JSON.stringify(failure).includes('private provider'));
  config.video.pilot.enabled = false;
  assert.equal((await checkLiveKitPilot(config, () => { throw new Error('Must not contact provider'); })).passed, false);
});

test('only the selected workspace can start/admit pilot rooms and receive pilot credits; removing it revokes admission', async () => {
  const env = await videoSetup({ video: { enabled: false, allowances: {}, maxParticipants: 2, maxGlobalParticipants: 2, maxRoomMinutes: 15,
    pilot: { enabled: true, workspaceIds: [], monthlyCredits: 60 } } });
  try {
    const owner = env.client(), outsider = env.client();
    const { ws } = await signUp(owner, 'PilotOwner');
    const { ws: other } = await signUp(outsider, 'OtherOwner');
    env.app.config.video.pilot.workspaceIds = [ws.id];
    const mine = (await owner.get('/api/me')).body.workspaces.find(w => w.id === ws.id);
    assert.equal(mine.video.enabled, true); assert.equal(mine.video.pilot, true);
    const theirs = (await outsider.get('/api/me')).body.workspaces.find(w => w.id === other.id);
    assert.equal(theirs.video.enabled, false); assert.equal(theirs.video.pilot, false);
    assert.equal((await outsider.post(`/api/workspaces/${other.id}/meet-video/rooms`, { title: 'Denied' })).status, 503);
    assert.equal((await outsider.get(`/api/workspaces/${other.id}/meet-video/wallet`)).body.wallet.spendable.credits, 0);
    const wallet = (await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet`)).body.wallet;
    assert.equal(wallet.spendable.credits, 60);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/meet-video/wallet`)).body.wallet.spendable.credits, 60, 'refresh never tops up the same monthly lot twice');
    const room = await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, { title: 'Pilot', max_participants: 100 });
    assert.equal(room.status, 201);
    assert.equal(room.body.video.available, true); assert.equal(room.body.video.pilot, true);
    const stored = env.room(room.body.public_id);
    assert.equal(stored.max_ends_at - stored.starts_at, 15 * 60000);
    assert.equal(stored.max_participants, 2);
    const joined = await owner.post(`/api/meet-video/rooms/${room.body.public_id}/join`, { display_name: 'Pilot host' });
    assert.equal(joined.status, 200);
    await env.event('participant_joined', stored.room_name, { identity: joined.body.identity, sid: 'PA_pilot' });
    await env.tick();
    const invitation = await owner.post(`/api/meet-video/rooms/${room.body.public_id}/invites`, { seats: 1 });
    assert.equal(invitation.status, 201);
    const token = tokenFrom(invitation.body.url);
    const guest = await env.client().post(`/api/public/meet-video/join/${token}`, { display_name: 'Pilot guest' });
    assert.equal(guest.status, 200, JSON.stringify(guest.body));
    env.app.db.run("UPDATE video_rooms SET kind = 'scheduled' WHERE id = ?", stored.id);
    assert.equal((await owner.post(`/api/meet-video/rooms/${room.body.public_id}/join`, {})).body.error.code, 'pilot_instant_only');
    assert.equal((await owner.get(`/api/meet-video/rooms/${room.body.public_id}`)).body.video.available, false);
    env.app.db.run("UPDATE video_rooms SET kind = 'instant' WHERE id = ?", stored.id);
    env.app.db.run('UPDATE video_rooms SET max_participants = 10 WHERE id = ?', stored.id);
    assert.equal((await owner.post(`/api/meet-video/rooms/${room.body.public_id}/join`, {})).body.error.code, 'pilot_instant_only');
    env.app.db.run('UPDATE video_rooms SET max_participants = 2 WHERE id = ?', stored.id);
    env.app.config.video.pilot.workspaceIds = [];
    assert.equal((await owner.post(`/api/meet-video/rooms/${room.body.public_id}/join`, { camera: false, microphone: false })).status, 503);
    assert.equal((await env.client().post(`/api/public/meet-video/join/${token}`, { display_name: 'No longer admitted' })).status, 503);
    assert.equal((await owner.get('/api/config')).body.video.enabled, false);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM credit_recharge_orders').count, 0);
  } finally { await env.close(); }
});
