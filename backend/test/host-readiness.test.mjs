import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarEvidence, CALENDAR_STALE_MS } from '../src/shared/meet-readiness-policy.mjs';
import { setup, signUp, publishedEventType, START, idem } from './helpers.mjs';
import { computeAvailability, loadEventType } from '../src/meet/bookings.mjs';
import { hostEvidenceSignature } from '../src/shared/meet-readiness-policy.mjs';
import { hostReadinessView, matchingHostEvidence } from '../../frontend/js/host-readiness-view.mjs';

test('host conflict evidence distinguishes fresh, missing, future, failed and partial checks', () => {
  const active = { status: 'active', last_success_at: START - 1000 };
  for (const [rows, state, coverage] of [
    [[], 'not_connected', 'none'], [[active], 'checked_recently', 'current'],
    [[{ ...active, last_success_at: START - CALENDAR_STALE_MS }], 'checked_recently', 'current'],
    [[{ ...active, last_success_at: START - CALENDAR_STALE_MS - 1 }], 'not_verified', 'unknown'],
    [[{ ...active, last_success_at: null, last_synced_at: START }], 'not_verified', 'unknown'],
    [[{ ...active, last_success_at: START + 1 }], 'not_verified', 'unknown'],
    [[{ ...active, status: 'pending' }], 'waiting', 'unknown'],
    [[{ ...active, status: 'error' }], 'failed', 'unknown'],
    [[{ ...active, status: 'revoked' }], 'revoked', 'none'],
    [[active, { ...active, status: 'error' }], 'partial', 'unknown'],
    [[active, { ...active, last_success_at: null }], 'not_verified', 'unknown'],
    [[{ status: 'legacy' }], 'not_verified', 'unknown']
  ]) assert.deepEqual(calendarEvidence(rows, START), { state, coverage });
});

test('host view rejects stale settings, escapes host names and keeps restricted evidence hidden', () => {
  const type = { id: 'event', updated_at: START, kind: 'collective', use_host_schedules: true, hosts: [{ user_id: 'self' }, { user_id: 'peer' }], locations: [{ type: 'zoom' }] };
  const source = { ok: true, value: { event_type_id: type.id, event_updated_at: START, event_signature: hostEvidenceSignature(type), scope: 'self_only', hosts: [
    { user_id: 'self', name: '<img src=x onerror=alert(1)>', visibility: 'summary', calendar: { state: 'failed' }, schedule_source: 'event_fallback', meeting_links: [{ provider: 'zoom', connection: 'connected', creation: 'not_verified' }] },
    { user_id: 'peer', name: 'Ravi', visibility: 'restricted', calendar: { state: 'PRIVATE_SENTINEL' }, meeting_links: [{ provider: 'PRIVATE_SENTINEL' }] }
  ] } };
  assert.equal(matchingHostEvidence(source, type), true);
  const view = String(hostReadinessView(source, type, 'self'));
  assert.ok(view.includes('&lt;img')); assert.ok(!view.includes('<img'));
  assert.ok(!view.includes('PRIVATE_SENTINEL'));
  assert.match(view, /only this host and workspace admins/);
  assert.match(view, /Uses the event schedule as a fallback/);
  assert.match(view, /Connected; meeting-link creation has not been verified/);
  assert.equal((view.match(/Manage your calendars and apps/g) || []).length, 1);
  for (const changed of [{ ...type, id: 'elsewhere' }, { ...type, updated_at: START + 1 }, { ...type, locations: [{ type: 'google_meet' }] }, { ...type, use_host_schedules: false }]) {
    assert.equal(matchingHostEvidence(source, changed), false);
    assert.match(String(hostReadinessView(source, changed, 'self')), /saved event changed during the check/);
  }
  assert.match(String(hostReadinessView({ ok: false }, type, 'self')), /server summary could not be loaded/);
});

test('host readiness is event/workspace/role scoped and exports no calendar or provider secrets', async () => {
  const env = await setup();
  try {
    const owner = env.client(), member = env.client(), admin = env.client(), outsider = env.client();
    const { ws, user: host } = await signUp(owner, 'Owner');
    const { user: cohost, ws: otherWs } = await signUp(member, 'Cohost');
    const { user: administrator } = await signUp(admin, 'Admin');
    await signUp(outsider, 'Outsider');
    for (const [user, role] of [[cohost, 'member'], [administrator, 'admin']]) env.app.db.run('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', ws.id, user.id, role, START);
    const type = await publishedEventType(owner, ws, { kind: 'collective', use_host_schedules: true, hosts: [{ user_id: host.id }, { user_id: cohost.id }], locations: [{ type: 'google_meet' }, { type: 'zoom' }, { type: 'teams' }] });
    const path = `/api/workspaces/${ws.id}/event-types/${type.id}/host-readiness`;
    const secret = 'PRIVATE_SENTINEL_DO_NOT_EXPORT';
    env.app.db.run('INSERT INTO calendar_connections (id, workspace_id, user_id, provider, feed_url, label, status, last_success_at, last_synced_at, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'calendar-private', ws.id, cohost.id, 'ics', 'https://example.com/' + secret, secret, 'error', START - 1000, START, secret, START);
    env.app.db.run('INSERT INTO user_schedules (workspace_id, user_id, timezone, rules, overrides, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ws.id, cohost.id, 'Asia/Kolkata', '[]', '[]', START);
    for (const [provider, status] of [['google', 'active'], ['zoom', 'revoked'], ['microsoft', 'error']]) env.app.db.run('INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', provider, ws.id, cohost.id, provider, secret, secret, status, secret, START, START);
    // Same person connected in another workspace cannot supply this event's evidence.
    env.app.db.run('INSERT INTO integrations (id, workspace_id, user_id, provider, credentials, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'foreign', otherWs.id, host.id, 'google', secret, 'active', START, START);
    const before = JSON.stringify(env.app.db.all('SELECT * FROM calendar_connections'));
    const full = await owner.get(path);
    assert.equal(full.status, 200); assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(full.body).sort(), ['checked_at', 'event_signature', 'event_type_id', 'event_updated_at', 'hosts', 'scope']);
    assert.equal(full.body.scope, 'all_hosts');
    const own = full.body.hosts.find(row => row.user_id === host.id), peer = full.body.hosts.find(row => row.user_id === cohost.id);
    assert.equal(own.schedule_source, 'event_fallback'); assert.equal(peer.schedule_source, 'personal');
    assert.deepEqual(peer.calendar, { state: 'failed', coverage: 'unknown' });
    assert.deepEqual(peer.meeting_links.map(row => [row.connection, row.creation]), [['connected', 'not_verified'], ['revoked', 'not_verified'], ['failed', 'not_verified']]);
    assert.equal(own.meeting_links[0].connection, 'not_connected');
    assert.ok(!JSON.stringify(full.body).includes(secret));
    for (const row of full.body.hosts) assert.deepEqual(Object.keys(row).sort(), ['calendar', 'meeting_links', 'name', 'schedule_source', 'user_id', 'visibility']);
    assert.equal((await admin.get(path)).body.scope, 'all_hosts', 'nonhost admin may read coarse evidence');
    let limited = (await member.get(path)).body;
    assert.equal(limited.scope, 'self_only');
    assert.deepEqual(limited.hosts.find(row => row.user_id === host.id), { user_id: host.id, name: host.name, visibility: 'restricted', calendar: null, meeting_links: null, schedule_source: null });
    env.app.db.run("UPDATE memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?", ws.id, administrator.id);
    assert.equal((await admin.get(path)).status, 404, 'demoted nonhost loses event access');
    assert.equal((await outsider.get(path)).status, 404);
    assert.equal((await env.client().get(path)).status, 401);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/event-types/not-this-event/host-readiness`)).status, 404);
    assert.equal((await member.get(`/api/workspaces/${otherWs.id}/event-types/${type.id}/host-readiness`)).status, 404);
    const key = (await owner.post(`/api/workspaces/${ws.id}/api-keys`, { name: 'readiness scope test' })).body;
    assert.equal((await env.client().get(path, { Authorization: 'Bearer ' + key.token })).status, 403);
    env.app.db.run('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', ws.id, cohost.id);
    assert.equal((await member.get(path)).status, 404, 'removed member loses access immediately');
    const removed = (await owner.get(path)).body.hosts.find(row => row.user_id === cohost.id);
    assert.deepEqual([removed.visibility, removed.calendar, removed.meeting_links, removed.schedule_source], ['unavailable', null, null, null], 'admins cannot see setup left behind by a former member');
    assert.equal(JSON.stringify(env.app.db.all('SELECT * FROM calendar_connections')), before, 'reading never syncs or modifies calendar evidence');
    assert.equal(env.sent.length, 0);
    await owner.post('/api/auth/logout');
    assert.equal((await owner.get(path)).status, 401);
  } finally { await env.close(); }
});

test('removed members cannot receive new or overridden bookings; round robin retains active hosts', async () => {
  const env = await setup();
  try {
    const owner = env.client(), peer = env.client(), guest = env.client();
    const { ws, user } = await signUp(owner, 'MembershipOwner');
    const teammate = await signUp(peer, 'RemovedHost');
    env.app.db.run("INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'member',?)", ws.id, teammate.user.id, START);
    const types = [];
    for (const kind of ['one_on_one', 'group', 'collective', 'round_robin']) types.push(await publishedEventType(owner, ws, { title: kind, kind, seats: kind === 'group' ? 3 : 1, hosts: ['collective', 'round_robin'].includes(kind) ? [{ user_id: user.id }, { user_id: teammate.user.id }] : [{ user_id: teammate.user.id }] }));
    const input = { name: 'Invitee', email: 'invitee@example.com', timezone: 'Asia/Kolkata' };
    const first = [...computeAvailability(env.app, loadEventType(env.app, types[0].id)).slots.keys()][0];
    const previous = await guest.post(`/api/public/meet/${ws.slug}/${types[0].slug}/bookings`, { ...input, start: new Date(first).toISOString() }, idem());
    assert.equal(previous.status, 201);
    const group = types[1];
    const groupStart = [...computeAvailability(env.app, loadEventType(env.app, group.id)).slots.keys()][0];
    assert.equal((await guest.post(`/api/public/meet/${ws.slug}/${group.slug}/bookings`, { ...input, start: new Date(groupStart).toISOString() }, idem())).status, 201);
    assert.equal((await owner.del(`/api/workspaces/${ws.id}/members/${teammate.user.id}`)).status, 204);
    const before = env.app.db.get('SELECT COUNT(*) AS count FROM bookings').count;
    for (const type of types.slice(0, 3)) {
      assert.equal(computeAvailability(env.app, loadEventType(env.app, type.id)).slots.size, 0, type.kind);
      assert.equal((await guest.post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { ...input, start: new Date(first).toISOString() }, idem())).status, 409);
      assert.equal((await owner.post(`/api/workspaces/${ws.id}/bookings`, { ...input, event_type_id: type.id, start: new Date(first).toISOString(), override: true }, idem())).status, 409, 'override cannot restore a removed host');
    }
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM bookings').count, before, 'failed attempts create no booking');
    assert.equal((await owner.patch(`/api/workspaces/${ws.id}/event-types/${group.id}`, { hosts: [{ user_id: user.id }] })).status, 200);
    assert.equal(computeAvailability(env.app, loadEventType(env.app, group.id)).slots.has(groupStart), false, 'reassigned group cannot offer seats in the former host meeting');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/bookings`, { ...input, event_type_id: group.id, start: new Date(groupStart).toISOString(), override: true }, idem())).status, 409, 'override cannot join the former host group meeting');
    const rr = types[3];
    const slots = computeAvailability(env.app, loadEventType(env.app, rr.id)).slots;
    assert.ok(slots.size > 0);
    assert.ok([...slots.values()].every(hosts => hosts.length === 1 && hosts[0] === user.id));
    const start = new Date([...slots.keys()][0]).toISOString();
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/bookings`, { ...input, event_type_id: rr.id, start, override: true, host_id: teammate.user.id }, idem())).status, 409);
    assert.equal((await guest.post(`/api/public/meet/${ws.slug}/${rr.slug}/bookings`, { ...input, start }, idem())).status, 201);
    assert.equal(env.app.db.get('SELECT status FROM bookings WHERE id = ?', previous.body.booking.id).status, 'confirmed', 'removal does not silently cancel existing bookings');
  } finally { await env.close(); }
});
