import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from './helpers.mjs';
import { videoSetup } from './video-helpers.mjs';

test('hosts see limits, a credit estimate and recovery steps that match what admission enforces', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 100 } } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Guidance host');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, { title: 'Quick call' })).body;
    const view = (await owner.get(`/api/meet-video/rooms/${room.public_id}`)).body;
    const { guidance } = view;
    assert.equal(guidance.status, 'enough');
    assert.equal(guidance.limits.max_participants, env.app.config.video.maxParticipants);
    assert.equal(guidance.credits.per_participant_minute, 0.2);
    assert.equal(guidance.credits.available, 100, 'owners can read the balance');
    assert.equal(guidance.credits.can_recharge, true);
    assert.equal(guidance.credits.first_join, Math.ceil(env.app.config.video.blockSeconds / 300));
    assert.match(guidance.on_exhaustion, /removed from the call/);
    assert.ok(guidance.recovery.some(step => /does not create a replacement meeting link/.test(step)));
    assert.equal(view.host_url.includes(room.public_id), true, 'the room link is unchanged');
    // Guests never see the host's budget.
    const invite = (await owner.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 1 })).body;
    const guestView = (await env.client().get('/api/public/meet-video/join/' + invite.url.split('/meet/join/')[1])).body;
    assert.equal(guestView.guidance, undefined);
    // An extra invited seat raises the estimate.
    const after = (await owner.get(`/api/meet-video/rooms/${room.public_id}`)).body.guidance;
    assert.equal(after.limits.invited_seats, 1);
  } finally { await env.close(); }
});

test('with no spendable credits the guidance says the call cannot start, matching the join refusal', async () => {
  const env = await videoSetup({ video: { allowances: { evaluation: 0 } } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Empty wallet');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, { title: 'No credits' })).body;
    const { guidance } = (await owner.get(`/api/meet-video/rooms/${room.public_id}`)).body;
    assert.equal(guidance.status, 'cannot_start');
    assert.equal(guidance.credits.available, 0);
    const join = await owner.post(`/api/meet-video/rooms/${room.public_id}/join`, { display_name: 'Host' });
    assert.equal(join.status, 402);
    assert.equal(join.body.error.code, 'insufficient_credits');
  } finally { await env.close(); }
});
