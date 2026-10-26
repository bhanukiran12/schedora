import { randomUUID } from 'node:crypto';
import { setup } from './helpers.mjs';
import { loadVideoConfig } from '../src/video/config.mjs';

// Boots the app with the fake video provider and test-friendly timing.
export async function videoSetup({ video = {}, config = {} } = {}) {
  const env = await setup({ config: { video: { ...loadVideoConfig({}, false), finalizeDelaySeconds: 30, ...video }, ...config } });
  env.fake = env.app.video.providers.get('fake-local');
  env.room = publicId => env.app.db.get('SELECT * FROM video_rooms WHERE public_id = ?', publicId);
  // Sends a signed provider webhook (protojson-style body, timestamps in seconds as strings).
  env.event = async (type, roomName, participant, atMs = env.clock.now, id = randomUUID()) => {
    const body = { id, event: type, createdAt: String(Math.floor(atMs / 1000)), room: { name: roomName, sid: 'RM_test' } };
    if (participant) body.participant = { sid: participant.sid, identity: participant.identity, joinedAtMs: String(participant.joinedAtMs ?? atMs), ...(participant.kind ? { kind: participant.kind } : {}) };
    // Keep the fake provider's presence consistent with the events, as the real provider would be.
    if (type === 'participant_joined' && participant) env.fake.connect(roomName, participant.identity, { sid: participant.sid, joinedAtMs: participant.joinedAtMs ?? atMs, kind: (participant.kind || 'standard').toLowerCase() });
    if (['participant_left', 'participant_connection_aborted'].includes(type) && participant && env.fake.rooms.get(roomName)?.participants.get(participant.identity)?.sid === participant.sid) env.fake.disconnect(roomName, participant.identity);
    const { raw, authorization } = env.fake.sign(body);
    return env.client().raw('POST', '/api/meet-video/webhooks/fake-local', raw, { Authorization: authorization });
  };
  env.tick = async () => { const { videoTick } = await import('../src/video/rooms.mjs'); env.app.video.lastReconcileAt = 0; await videoTick(env.app); };
  return env;
}

export const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
export const tokenFrom = url => url.split('/meet/join/')[1];
