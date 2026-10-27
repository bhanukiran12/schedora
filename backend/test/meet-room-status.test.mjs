// Sprint task 4: after a disconnect the client names a cause only when the server confirms it.
// A participant can read their own status (scoped to their credential) and a coarse end cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from './helpers.mjs';
import { tokenFrom, videoSetup } from './video-helpers.mjs';

test('self status: removal reason and end cause are visible only to the person concerned', async () => {
  const env = await videoSetup();
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Status');
    const room = (await host.post(`/api/workspaces/${ws.id}/meet-video/rooms`, { title: 'Status check' })).body;
    const hostJoin = await host.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    const stored = env.room(room.public_id);
    await env.event('participant_joined', stored.room_name, { sid: 'PA_host', identity: hostJoin.body.identity });
    await env.tick();
    const tokenA = tokenFrom((await host.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 2 })).body.url);
    const tokenB = tokenFrom((await host.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 2 })).body.url);
    const guest = await env.client().post('/api/public/meet-video/join/' + tokenA, { display_name: 'Guest A' });
    assert.equal(guest.status, 200, JSON.stringify(guest.body));
    const view = (token, participant) => env.client().get(`/api/public/meet-video/join/${token}?participant=${participant}`).then(response => response.body);

    assert.deepEqual((await view(tokenA, guest.body.participant_id)).you, { status: 'admitted', removed_reason: null });
    assert.equal((await view(tokenB, guest.body.participant_id)).you, null, 'another link cannot read this participant');
    assert.equal((await host.get(`/api/meet-video/rooms/${room.public_id}?participant=${guest.body.participant_id}`)).body.you, null, 'nor can the host route, which matches by account');
    assert.deepEqual((await host.get(`/api/meet-video/rooms/${room.public_id}?participant=${hostJoin.body.participant_id}`)).body.you, { status: 'joined', removed_reason: null });
    assert.equal((await env.client().get(`/api/public/meet-video/join/${tokenA}`)).body.you, null, 'no participant, no status');

    // Host removal is confirmed with its reason; the removed guest cannot rejoin.
    await host.post(`/api/meet-video/rooms/${room.public_id}/participants/${guest.body.participant_id}/remove`);
    const removed = await view(tokenA, guest.body.participant_id);
    assert.deepEqual(removed.you, { status: 'removed', removed_reason: 'removed_by_host' });
    assert.equal(removed.state, 'revoked');
    assert.equal(removed.end_cause, null);

    // Ending for everyone: a coarse cause every participant may see, with no internal detail.
    assert.equal((await host.post(`/api/meet-video/rooms/${room.public_id}/end`)).status, 204);
    const ended = await view(tokenB, 'not-a-participant');
    // 'ending' until the provider confirms; the client treats ending and ended alike, before the link state.
    assert.ok(['ending', 'ended'].includes(ended.status), ended.status);
    assert.deepEqual([ended.end_cause, ended.you], ['host', null]);
    assert.equal(ended.end_reason, undefined, 'raw reasons stay host-only');
  } finally { await env.close(); }
});
