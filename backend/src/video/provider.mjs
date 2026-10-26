import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';

// Server-side meeting provider boundary. Every implementation exposes:
//   capabilities                          explicit feature/enforcement differences
//   createRoom({ name, maxParticipants, emptyTimeoutSeconds, departureTimeoutSeconds })
//   issueToken({ room, identity, name, ttlSeconds, canPublish })   → browser JWT (join-only grants)
//   listParticipants(room)                → [{ sid, identity, joinedAtMs, kind }] or null if no room
//   removeParticipant(room, identity)
//   deleteRoom(room)
//   verifyWebhook(rawBody, authorization) → normalized event (throws when not authentic)
// LiveKit Cloud and self-hosted LiveKit share this code; only configuration and capabilities differ.

// Browsers may publish exactly these sources. Never room admin, listing, creation or recording.
const SOURCES = [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
const KINDS = { 0: 'standard', 1: 'ingress', 2: 'egress', 3: 'sip', 4: 'agent', STANDARD: 'standard', INGRESS: 'ingress', EGRESS: 'egress', SIP: 'sip', AGENT: 'agent' };

export const ROOM_SETTINGS = { emptyTimeoutSeconds: 300, departureTimeoutSeconds: 20 };

const toMs = (seconds, ms) => {
  const precise = Number(ms ?? 0);
  if (Number.isFinite(precise) && precise > 0) return precise;
  const coarse = Number(seconds ?? 0);
  return Number.isFinite(coarse) && coarse > 0 ? coarse * 1000 : null;
};
const participantOf = info => info && ({
  sid: String(info.sid || ''), identity: String(info.identity || ''),
  joinedAtMs: toMs(info.joinedAt ?? info.joined_at, info.joinedAtMs ?? info.joined_at_ms),
  kind: KINDS[info.kind ?? 0] || 'unknown'
});

// Webhook JSON (protojson) → { id, type, createdAtMs, room, participant }.
export function normalizeEvent(body) {
  if (!body || typeof body !== 'object' || typeof body.event !== 'string') throw Object.assign(new Error('Invalid provider event.'), { status: 400 });
  const createdAtMs = toMs(body.createdAt ?? body.created_at, null);
  if (!body.id || !createdAtMs) throw Object.assign(new Error('Provider event has no id or timestamp.'), { status: 400 });
  return {
    id: String(body.id), type: body.event, createdAtMs,
    room: body.room ? { name: String(body.room.name || ''), sid: String(body.room.sid || '') } : null,
    participant: participantOf(body.participant)
  };
}

export function createLiveKitProvider(deployment) {
  const cloud = deployment.hosting === 'cloud';
  // Server API calls go only to the configured origin; Cloud may fail over to its own regional origins.
  const service = new RoomServiceClient(deployment.endpoints.http, deployment.apiKey, deployment.apiSecret, { requestTimeout: 10, failover: cloud });
  const receiver = new WebhookReceiver(deployment.apiKey, deployment.apiSecret);
  return {
    name: 'livekit', deployment: deployment.id, hosting: deployment.hosting, clientUrl: deployment.endpoints.ws,
    capabilities: {
      screenShare: true, recording: false, transcription: false, telephony: false, streaming: false,
      // LiveKit Cloud revokes the participant's token on RemoveParticipant (10-minute cutoff).
      // Self-hosted servers document no such revocation: a still-valid token can rejoin.
      removeRevokesToken: cloud,
      // Rooms are auto-created when a token holder joins unless the server disables auto_create.
      autoCreatesRooms: true,
      serverRefreshesTokens: true
    },
    async createRoom({ name, maxParticipants }) {
      await service.createRoom({ name, maxParticipants, emptyTimeout: ROOM_SETTINGS.emptyTimeoutSeconds, departureTimeout: ROOM_SETTINGS.departureTimeoutSeconds, metadata: '' });
    },
    async issueToken({ room, identity, name, ttlSeconds, canPublish = true }) {
      const token = new AccessToken(deployment.apiKey, deployment.apiSecret, { identity, name, ttl: ttlSeconds });
      token.addGrant({ roomJoin: true, room, canSubscribe: true, canPublish, canPublishSources: canPublish ? SOURCES : [], canPublishData: false, canUpdateOwnMetadata: false, hidden: false, recorder: false, roomAdmin: false, roomList: false, roomCreate: false, roomRecord: false });
      return token.toJwt();
    },
    async listParticipants(room) {
      try { return (await service.listParticipants(room)).map(participantOf); }
      catch (error) { if (/not.?found|does not exist/i.test(error.message) || error.status === 404) return null; throw error; }
    },
    async removeParticipant(room, identity) {
      try { await service.removeParticipant(room, identity); }
      catch (error) { if (!(/not.?found|does not exist/i.test(error.message) || error.status === 404)) throw error; }
    },
    async deleteRoom(room) {
      try { await service.deleteRoom(room); }
      catch (error) { if (!(/not.?found|does not exist/i.test(error.message) || error.status === 404)) throw error; }
    },
    async verifyWebhook(raw, authorization) {
      if (!authorization) throw Object.assign(new Error('Missing webhook authorization.'), { status: 401 });
      try { await receiver.receive(raw, authorization); } // verifies the JWT and the SHA-256 of this exact raw body
      catch { throw Object.assign(new Error('Webhook signature is invalid.'), { status: 401 }); }
      return normalizeEvent(JSON.parse(raw));
    }
  };
}

// In-memory provider for development and tests. Webhooks are signed with HMAC-SHA256 of the raw body.
export function createFakeProvider(deployment) {
  const rooms = new Map();
  const calls = [];
  const fake = {
    name: 'fake', deployment: deployment.id, hosting: 'fake', clientUrl: deployment.endpoints.ws,
    capabilities: { screenShare: true, recording: false, transcription: false, telephony: false, streaming: false, removeRevokesToken: false, autoCreatesRooms: true, serverRefreshesTokens: true },
    rooms, calls, failures: new Map(), down: false,
    check(op) {
      calls.push(op);
      if (fake.down) throw Object.assign(new Error('fake provider unavailable'), { status: 503 });
      const remaining = fake.failures.get(op);
      if (remaining) { fake.failures.set(op, remaining - 1); throw Object.assign(new Error(`fake ${op} failure`), { status: 503 }); }
    },
    async createRoom({ name, maxParticipants }) { fake.check('createRoom'); if (!rooms.has(name)) rooms.set(name, { maxParticipants, participants: new Map() }); },
    async issueToken({ room, identity, name, ttlSeconds, canPublish = true }) {
      fake.check('issueToken');
      const claims = { sub: identity, name, exp: Math.floor(Date.now() / 1000) + ttlSeconds, video: { roomJoin: true, room, canSubscribe: true, canPublish, canPublishSources: canPublish ? ['camera', 'microphone', 'screen_share', 'screen_share_audio'] : [], canPublishData: false, canUpdateOwnMetadata: false, roomAdmin: false, roomList: false, roomCreate: false } };
      return 'fake.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.unsigned';
    },
    async listParticipants(room) { fake.check('listParticipants'); const entry = rooms.get(room); return entry ? [...entry.participants.values()] : null; },
    async removeParticipant(room, identity) { fake.check('removeParticipant'); rooms.get(room)?.participants.delete(identity); },
    async deleteRoom(room) { fake.check('deleteRoom'); rooms.delete(room); },
    async verifyWebhook(raw, authorization) {
      const expected = createHmac('sha256', deployment.apiSecret).update(raw).digest();
      const supplied = /^Fake ([a-f0-9]{64})$/.exec(authorization || '')?.[1];
      if (!supplied || !timingSafeEqual(expected, Buffer.from(supplied, 'hex'))) throw Object.assign(new Error('Webhook signature is invalid.'), { status: 401 });
      return normalizeEvent(JSON.parse(raw));
    },
    // Test helpers: simulate presence and produce signed webhook payloads.
    connect(room, identity, { sid = 'PA_' + randomUUID().slice(0, 12), joinedAtMs, kind = 'standard' } = {}) {
      if (!rooms.has(room)) rooms.set(room, { maxParticipants: 0, participants: new Map() });
      const participant = { sid, identity, joinedAtMs, kind };
      rooms.get(room).participants.set(identity, participant);
      return participant;
    },
    disconnect(room, identity) { rooms.get(room)?.participants.delete(identity); },
    sign(body) {
      const raw = JSON.stringify(body);
      return { raw, authorization: 'Fake ' + createHmac('sha256', deployment.apiSecret).update(raw).digest('hex') };
    }
  };
  return fake;
}

// Provider instances keyed by deployment id. A room always uses the deployment stored on it.
export function createProviders(config, overrides = {}) {
  const providers = new Map();
  for (const deployment of config.video.deployments) {
    providers.set(deployment.id, overrides[deployment.id] || (deployment.provider === 'livekit' ? createLiveKitProvider(deployment) : createFakeProvider(deployment)));
  }
  return providers;
}
