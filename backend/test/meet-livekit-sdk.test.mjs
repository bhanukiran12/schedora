import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { createLiveKitProvider } from '../src/video/provider.mjs';

const deployment = () => ({
  id: 'sdk-contract-test', hosting: 'cloud', apiKey: 'sdk-contract-key', apiSecret: randomBytes(32).toString('hex'),
  endpoints: { ws: 'wss://sdk-contract.livekit.cloud', http: 'https://sdk-contract.livekit.cloud' }
});

async function signedEvent(settings, raw, { secret = settings.apiSecret, key = settings.apiKey, ttl = 120 } = {}) {
  const token = new AccessToken(key, secret, { ttl });
  token.sha256 = createHash('sha256').update(raw).digest('base64');
  return token.toJwt();
}

test('LiveKit SDK signs scoped participant tokens and rejects signature tampering', async () => {
  const settings = deployment();
  const provider = createLiveKitProvider(settings);
  const verifier = new TokenVerifier(settings.apiKey, settings.apiSecret);
  const before = Math.floor(Date.now() / 1000);
  const token = await provider.issueToken({ room: 'private-room', identity: 'participant-one', name: 'Test participant', ttlSeconds: 120 });
  const payload = await verifier.verify(token);
  assert.equal(payload.sub, 'participant-one');
  assert.equal(payload.video.room, 'private-room');
  assert.equal(payload.video.roomJoin, true);
  assert.equal(payload.video.canSubscribe, true);
  assert.equal(payload.video.canPublish, true);
  assert.ok(payload.exp >= before + 120 && payload.exp <= Math.floor(Date.now() / 1000) + 120);
  assert.deepEqual([...payload.video.canPublishSources].sort(), ['camera', 'microphone', 'screen_share', 'screen_share_audio'].sort());
  for (const privilege of ['roomAdmin', 'roomList', 'roomCreate', 'roomRecord', 'canPublishData', 'canUpdateOwnMetadata']) assert.equal(payload.video[privilege], false);
  const segments = token.split('.');
  segments[1] = Buffer.from(JSON.stringify({ ...payload, video: { ...payload.video, roomAdmin: true } })).toString('base64url');
  await assert.rejects(verifier.verify(segments.join('.')));
  await assert.rejects(new TokenVerifier(settings.apiKey, randomBytes(32).toString('hex')).verify(token));
  const observer = await verifier.verify(await provider.issueToken({ room: 'private-room', identity: 'observer', ttlSeconds: 120, canPublish: false }));
  assert.equal(observer.video.canPublish, false);
  assert.deepEqual(observer.video.canPublishSources, []);
});

test('LiveKit SDK verifies the exact webhook body and rejects altered bodies, keys and expired JWTs', async () => {
  const settings = deployment();
  const provider = createLiveKitProvider(settings);
  const eventAt = Math.floor(Date.now() / 1000);
  const body = {
    id: 'EV_sdk_contract', event: 'participant_joined', createdAt: String(eventAt),
    room: { name: 'private-room', sid: 'RM_sdk_contract' },
    participant: { identity: 'participant-one', sid: 'PA_sdk_contract', joinedAt: String(eventAt), kind: 'STANDARD' }
  };
  const raw = JSON.stringify(body);
  const authorization = await signedEvent(settings, raw);
  const normalized = await provider.verifyWebhook(raw, authorization);
  assert.equal(normalized.id, body.id);
  assert.equal(normalized.createdAtMs, eventAt * 1000);
  assert.deepEqual(normalized.participant, { identity: 'participant-one', sid: 'PA_sdk_contract', joinedAtMs: eventAt * 1000, kind: 'standard' });
  const unauthorized = error => error.status === 401;
  await assert.rejects(provider.verifyWebhook(raw + ' ', authorization), unauthorized);
  await assert.rejects(provider.verifyWebhook(JSON.stringify({ ...body, room: { name: 'another-room' } }), authorization), unauthorized);
  await assert.rejects(provider.verifyWebhook(raw, ''), unauthorized);
  await assert.rejects(provider.verifyWebhook(raw, await signedEvent(settings, raw, { secret: randomBytes(32).toString('hex') })), unauthorized);
  await assert.rejects(provider.verifyWebhook(raw, await signedEvent(settings, raw, { key: 'another-project-key' })), unauthorized);
  await assert.rejects(provider.verifyWebhook(raw, await signedEvent(settings, raw, { ttl: -120 })), unauthorized);
});

test('LiveKit SDK adapter preserves hosting capability differences and rejects unusable signed events', async () => {
  const settings = deployment();
  const cloud = createLiveKitProvider(settings);
  const selfHosted = createLiveKitProvider({ ...settings, hosting: 'self_hosted' });
  assert.equal(cloud.capabilities.removeRevokesToken, true);
  assert.equal(selfHosted.capabilities.removeRevokesToken, false);
  assert.equal(selfHosted.capabilities.serverRefreshesTokens, true);
  for (const event of [
    { event: 'room_finished', createdAt: String(Math.floor(Date.now() / 1000)) },
    { id: 'EV_invalid', event: 'room_finished', createdAt: '0' }
  ]) {
    const raw = JSON.stringify(event);
    await assert.rejects(cloud.verifyWebhook(raw, await signedEvent(settings, raw)), error => error.status === 400);
  }
});
