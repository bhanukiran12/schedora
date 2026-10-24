// Sprint 2: identity, sessions, CSRF, roles and tenant isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem, publishedEventType, setup, signUp } from './helpers.mjs';

test('sign up, sign in, session and CSRF', async () => {
  const env = await setup();
  try {
    const http = env.client();
    const { email, ws } = await signUp(http, 'Asha');
    assert.equal(ws.role, 'owner');
    assert.equal((await http.get('/api/me')).body.user.email, email);

    const anonymous = env.client();
    assert.equal((await anonymous.get(`/api/workspaces/${ws.id}/event-types`)).status, 401);
    assert.equal((await anonymous.post('/api/auth/login', { email, password: 'wrong password!!' })).status, 401);
    assert.equal((await anonymous.post('/api/auth/signup', { name: 'X', email, password: 'another long password' })).status, 409);
    assert.equal((await anonymous.post('/api/auth/signup', { name: 'X', email: 'short@example.com', password: 'short' })).body.error.field, 'password');
    const login = await anonymous.post('/api/auth/login', { email, password: 'a sufficiently long password' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

    // Mutations need the session's CSRF token and a same-site origin.
    http.forgetCsrf();
    assert.equal((await http.post(`/api/workspaces/${ws.id}/forms`, {})).body.error.code, 'csrf');
    const fresh = env.client();
    await fresh.post('/api/auth/login', { email, password: 'a sufficiently long password' });
    assert.equal((await fresh.post(`/api/workspaces/${ws.id}/forms`, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fresh.post(`/api/workspaces/${ws.id}/forms`, {}, { Origin: 'https://forms.schedora.in' })).status, 201);
    assert.equal((await fresh.raw('POST', `/api/workspaces/${ws.id}/forms`, 'title=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);

    assert.equal((await fresh.post('/api/auth/logout')).status, 204);
    assert.equal((await fresh.get('/api/me')).body.user, null);
  } finally { await env.close(); }
});

test('two workspaces cannot reach each other through the API', async () => {
  const env = await setup();
  try {
    const alice = env.client();
    const bob = env.client();
    const a = await signUp(alice, 'Alice');
    const b = await signUp(bob, 'Bob');
    const eventType = await publishedEventType(alice, a.ws);
    const form = (await alice.post(`/api/workspaces/${a.ws.id}/forms`, { title: 'Private' })).body;
    await alice.post(`/api/workspaces/${a.ws.id}/forms/${form.id}/publish`);
    const flow = (await alice.post(`/api/workspaces/${a.ws.id}/flows`, { name: 'F', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'T' } })).body;
    const slots = (await env.client().get(`/api/public/meet/${a.ws.slug}/${eventType.slug}/slots`)).body.slots;
    const booking = (await env.client().post(`/api/public/meet/${a.ws.slug}/${eventType.slug}/bookings`, { name: 'I', email: 'i@example.com', timezone: 'UTC', start: slots[0] }, idem())).body.booking;

    // Bob uses Alice's workspace id directly: every private resource is hidden.
    const foreign = [
      ['GET', `/api/workspaces/${a.ws.id}`], ['GET', `/api/workspaces/${a.ws.id}/members`], ['GET', `/api/workspaces/${a.ws.id}/event-types`],
      ['GET', `/api/workspaces/${a.ws.id}/event-types/${eventType.id}`], ['PATCH', `/api/workspaces/${a.ws.id}/event-types/${eventType.id}`],
      ['GET', `/api/workspaces/${a.ws.id}/bookings`], ['POST', `/api/workspaces/${a.ws.id}/bookings/${booking.id}/cancel`],
      ['GET', `/api/workspaces/${a.ws.id}/forms/${form.id}`], ['GET', `/api/workspaces/${a.ws.id}/forms/${form.id}/responses`], ['GET', `/api/workspaces/${a.ws.id}/forms/${form.id}/responses.csv`],
      ['GET', `/api/workspaces/${a.ws.id}/flows`], ['PATCH', `/api/workspaces/${a.ws.id}/flows/${flow.id}`], ['GET', `/api/workspaces/${a.ws.id}/runs`],
      ['GET', `/api/workspaces/${a.ws.id}/tasks`], ['GET', `/api/workspaces/${a.ws.id}/emails`], ['GET', `/api/workspaces/${a.ws.id}/billing`],
      ['POST', `/api/workspaces/${a.ws.id}/billing/test-events`], ['DELETE', `/api/workspaces/${a.ws.id}`]
    ];
    for (const [method, path] of foreign) {
      const response = await bob.raw(method, path, method === 'GET' ? undefined : {});
      assert.equal(response.status, 404, `${method} ${path} → ${response.status}`);
    }
    // Bob's own workspace path with Alice's resource ids also finds nothing.
    assert.equal((await bob.get(`/api/workspaces/${b.ws.id}/event-types/${eventType.id}`)).status, 404);
    assert.equal((await bob.get(`/api/workspaces/${b.ws.id}/forms/${form.id}/responses`)).status, 404);
    assert.equal((await bob.post(`/api/workspaces/${b.ws.id}/bookings/${booking.id}/cancel`, {})).status, 404);
    assert.equal((await bob.patch(`/api/workspaces/${b.ws.id}/flows/${flow.id}`, { status: 'enabled' })).status, 404);
    assert.equal((await bob.post(`/api/workspaces/${b.ws.id}/flows`, { name: 'x', trigger_type: 'forms.response.created', trigger_source: form.id, action_type: 'task', action_config: { title: 'x' } })).status, 400, 'cannot subscribe to another workspace\'s form');
    assert.deepEqual((await bob.get(`/api/workspaces/${b.ws.id}/bookings`)).body, []);
  } finally { await env.close(); }
});

test('roles: members manage their own scheduling; admins and owners control the workspace', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const member = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const m = await signUp(member, 'Member');
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/members`, { email: 'nobody@example.com' })).status, 404);
    assert.equal((await owner.post(`/api/workspaces/${ws.id}/members`, { email: m.email, role: 'member' })).status, 201);
    const ownerType = await publishedEventType(owner, ws, { title: 'Owner call' });
    const memberType = await publishedEventType(member, ws, { title: 'Member call' });
    const visible = (await member.get(`/api/workspaces/${ws.id}/event-types`)).body.map(type => type.title);
    assert.deepEqual(visible, ['Member call'], 'members only see their own event types');
    assert.equal((await member.get(`/api/workspaces/${ws.id}/event-types/${ownerType.id}`)).status, 404);
    assert.equal((await owner.get(`/api/workspaces/${ws.id}/event-types/${memberType.id}`)).status, 200, 'admins see all');
    assert.equal((await member.patch(`/api/workspaces/${ws.id}/event-types/${memberType.id}`, { host_id: (await owner.get('/api/me')).body.user.id })).status, 403);
    assert.equal((await member.get(`/api/workspaces/${ws.id}/billing`)).status, 403);
    assert.equal((await member.post(`/api/workspaces/${ws.id}/flows`, { name: 'x', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'x' } })).status, 403);
    assert.equal((await member.patch(`/api/workspaces/${ws.id}`, { name: 'Renamed' })).status, 403);
    assert.equal((await member.post(`/api/workspaces/${ws.id}/members`, { email: 'x@example.com' })).status, 403);
    const ownerId = (await owner.get('/api/me')).body.user.id;
    assert.equal((await owner.del(`/api/workspaces/${ws.id}/members/${ownerId}`)).body.error.code, 'owner_required', 'last owner cannot leave');
    assert.equal((await member.del(`/api/workspaces/${ws.id}/members/${m.user.id}`)).status, 204, 'members may leave');
    assert.equal((await member.get(`/api/workspaces/${ws.id}`)).status, 404);
  } finally { await env.close(); }
});

test('account deletion removes solely-owned workspaces', async () => {
  const env = await setup();
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Leaver');
    await publishedEventType(http, ws);
    assert.equal((await http.del('/api/me', { password: 'wrong' })).status, 401);
    assert.equal((await http.del('/api/me', { password: 'a sufficiently long password' })).status, 204);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?', ws.id).count, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM event_types').count, 0);
  } finally { await env.close(); }
});
