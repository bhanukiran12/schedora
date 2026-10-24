// OAuth calendars and video links (Google, Microsoft, Zoom), OIDC single sign-on and the MCP server.
// Providers are simulated at the HTTP level with the request/response shapes of their public APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { idem, setup, signUp } from './helpers.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const MON9 = '2026-10-26T09:00:00.000Z';

function fakeGoogle(env) {
  const calls = [];
  const state = { events: new Map(), refreshFails: false, busyError: false };
  env.app.fetchProvider = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? String(init.body) : '' });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'refresh_token' && state.refreshFails) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'ya29.' + calls.length, refresh_token: 'refresh-1', expires_in: 3600 });
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json({ email: 'host@gmail.com' });
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      const range = JSON.parse(init.body);
      assert.ok(Date.parse(range.timeMax) - Date.parse(range.timeMin) <= 30 * 86400000, 'busy checks use bounded date windows');
      const busy = [{ start: '2026-10-26T10:00:00Z', end: '2026-10-26T11:00:00Z' },
        ...[...state.events.values()].map(event => ({ start: event.start.dateTime, end: event.end.dateTime }))];
      return json({ calendars: { primary: state.busyError ? { errors: [{ reason: 'notFound' }] } : { busy } } });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events') && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = 'evt' + (state.events.size + 1);
      state.events.set(id, body);
      return json({ id, hangoutLink: body.conferenceData ? 'https://meet.google.com/abc-defg-hij' : undefined });
    }
    if (url.includes('/events/') && init.method === 'DELETE') { state.events.delete(url.split('/events/')[1].split('?')[0]); return new Response(null, { status: 204 }); }
    return json({ error: 'unexpected ' + url }, 500);
  };
  return { calls, state };
}

test('Google: OAuth connect, busy times, calendar events with Meet links, cleanup on cancel', async () => {
  const env = await setup({ config: { google: { clientId: 'gid', clientSecret: 'gsecret' } } });
  try {
    const google = fakeGoogle(env);
    const host = env.client();
    const { ws, user } = await signUp(host, 'Host');
    const start = (await host.get(`/api/workspaces/${ws.id}/integrations/google/start`)).body;
    const authorize = new URL(start.url);
    assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(authorize.searchParams.get('access_type'), 'offline');
    const state = authorize.searchParams.get('state');

    // Another signed-in person cannot complete someone else's flow; a forged state is rejected.
    const intruder = env.client();
    await signUp(intruder, 'Intruder');
    const manual = (path, cookie) => fetch(env.base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
    const hijack = await manual(`/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`, await sessionCookie(env, intruder));
    assert.equal(hijack.status, 302);
    assert.match(hijack.headers.get('location'), /error=Sign%20in%20as%20the%20person/);
    const forged = await manual(`/api/oauth/google/callback?code=c&state=${encodeURIComponent(state.slice(0, -3) + 'abc')}`, await sessionCookie(env, host));
    assert.match(forged.headers.get('location'), /error=This%20connection%20link%20is%20invalid/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM integrations').count, 0);

    const done = await fetch(`${env.base}/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: await sessionCookie(env, host) }, redirect: 'manual' });
    assert.equal(done.headers.get('location'), '/meet?tab=calendar&connected=google');
    const integration = env.app.db.get("SELECT * FROM integrations WHERE provider = 'google'");
    assert.equal(integration.account, 'host@gmail.com');
    assert.ok(!integration.credentials.includes('ya29'), 'tokens encrypted');

    await env.app.worker.tick();
    const calendars = (await host.get(`/api/workspaces/${ws.id}/calendar`)).body.connections;
    assert.equal(calendars[0].provider, 'google');
    assert.equal(calendars[0].busy_count, 1);
    const checks = google.calls.filter(call => call.url.endsWith('/freeBusy')).map(call => JSON.parse(call.body));
    assert.equal(checks.length, 5);
    for (let index = 1; index < checks.length; index++) assert.equal(checks[index].timeMin, checks[index - 1].timeMax);
    const type = (await host.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Video call', timezone: 'UTC', published: true, min_notice_min: 0, duration_min: 60, locations: [{ type: 'google_meet' }] })).body;
    const slots = (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body.slots;
    assert.ok(!slots.includes('2026-10-26T10:00:00.000Z'), 'Google busy time removed');

    const booked = (await env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: 'Ivy', email: 'ivy@example.com', timezone: 'UTC', start: MON9 }, idem())).body;
    await env.app.worker.tick();
    const [eventId, event] = [...google.state.events][0];
    assert.equal(event.attendees[0].email, 'ivy@example.com');
    assert.equal(event.start.dateTime, MON9);
    assert.match(google.calls.find(call => call.method === 'POST' && call.url.includes('/events')).url, /conferenceDataVersion=1/);
    const confirmation = env.sent.find(message => message.subject.startsWith('Confirmed'));
    assert.match(confirmation.body, /Location: https:\/\/meet\.google\.com\/abc-defg-hij/);
    assert.equal((await env.client().get('/api/public/bookings/' + booked.manage_token)).body.booking.location.display, 'https://meet.google.com/abc-defg-hij');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/calendar`)).body.connections[0].busy_count, 2, 'creating the Google event refreshes busy times immediately');

    await env.client().post(`/api/public/bookings/${booked.manage_token}/cancel`, {});
    await env.app.worker.tick();
    assert.ok(!google.state.events.has(eventId), 'calendar event removed after cancellation');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/calendar`)).body.connections[0].busy_count, 1, 'cancellation removes the cached appointment block without waiting 15 minutes');
    const freed = (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body.slots;
    assert.ok(freed.includes(MON9), 'the canceled slot is bookable again after the worker pass');

    google.state.busyError = true;
    await host.post(`/api/workspaces/${ws.id}/calendar/sync`);
    const failedCheck = (await host.get(`/api/workspaces/${ws.id}/calendar`)).body.connections[0];
    assert.equal(failedCheck.status, 'error');
    assert.equal(failedCheck.busy_count, 1, 'failed calendar results preserve the last successful busy periods');
    google.state.busyError = false;

    // Expired token + rejected refresh: integration and calendar are marked revoked.
    google.state.refreshFails = true;
    env.clock.now += 2 * 3600000;
    await host.post(`/api/workspaces/${ws.id}/calendar/sync`);
    assert.equal(env.app.db.get("SELECT status FROM integrations WHERE provider = 'google'").status, 'revoked');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/calendar`)).body.connections[0].status, 'revoked');
    assert.ok(user);
  } finally { await env.close(); }
});

async function sessionCookie(env, http) {
  // Re-sign-in to obtain the raw cookie for a manual fetch.
  const email = (await http.get('/api/me')).body.user.email;
  const response = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a sufficiently long password' }) });
  return response.headers.get('set-cookie').split(';')[0];
}

test('integrations that are not configured say so', async () => {
  const env = await setup();
  try {
    const host = env.client();
    const { ws } = await signUp(host, 'Host');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/integrations/zoom/start`)).body.error.code, 'integration_not_configured');
    assert.equal((await host.get(`/api/workspaces/${ws.id}/integrations/myspace/start`)).status, 404);
  } finally { await env.close(); }
});

test('OIDC single sign-on: signed ID token, domain checks, enforced SSO', async () => {
  const env = await setup();
  try {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    const issuer = 'https://idp.example.com';
    let claims;
    const idToken = payload => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.${rsaSign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
    };
    let tokenForm;
    env.app.fetchProvider = async (url, init = {}) => {
      if (url === `${issuer}/.well-known/openid-configuration`) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (url === `${issuer}/jwks`) return json({ keys: [jwk] });
      if (url === `${issuer}/token`) { tokenForm = new URLSearchParams(String(init.body)); return json({ id_token: idToken(claims()), access_token: 'x' }); }
      return json({}, 404);
    };
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const saved = await owner.raw('PUT', `/api/workspaces/${ws.id}/sso`, { issuer, client_id: 'schedora-app', client_secret: 'idp-secret', email_domain: 'acme.com', enforced: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.redirect_uri, 'http://localhost:3000/api/auth/sso/callback');
    assert.ok(!JSON.stringify(saved.body).includes('idp-secret'));

    const flow = async () => {
      const start = await fetch(`${env.base}/api/auth/sso/start?email=jo@acme.com`, { redirect: 'manual' });
      const authorize = new URL(start.headers.get('location'));
      const cookie = start.headers.get('set-cookie').split(';')[0];
      return { authorize, cookie, nonce: authorize.searchParams.get('nonce'), state: authorize.searchParams.get('state') };
    };
    let session = await flow();
    assert.equal(session.authorize.searchParams.get('code_challenge_method'), 'S256');
    claims = () => ({ iss: issuer, aud: 'schedora-app', sub: 'u1', email: 'jo@acme.com', email_verified: true, name: 'Jo Acme', nonce: session.nonce, exp: Math.floor(env.clock.now / 1000) + 300, iat: Math.floor(env.clock.now / 1000) });
    const callback = await fetch(`${env.base}/api/auth/sso/callback?code=abc&state=${session.state}`, { headers: { Cookie: session.cookie }, redirect: 'manual' });
    assert.equal(callback.headers.get('location'), '/meet');
    assert.ok(tokenForm.get('code_verifier'), 'PKCE verifier sent to the token endpoint');
    const sessionCookie = callback.headers.getSetCookie().find(cookie => cookie.startsWith('schedora_session=')).split(';')[0];
    const me = await (await fetch(env.base + '/api/me', { headers: { Cookie: sessionCookie } })).json();
    assert.equal(me.user.email, 'jo@acme.com');
    assert.equal(me.workspaces[0].id, ws.id);
    assert.equal(me.workspaces[0].role, 'member');

    // Wrong nonce (replayed token) and other domains are refused.
    session = await flow();
    const realClaims = claims;
    claims = () => ({ ...realClaims(), nonce: 'other' });
    assert.match((await fetch(`${env.base}/api/auth/sso/callback?code=abc&state=${session.state}`, { headers: { Cookie: session.cookie }, redirect: 'manual' })).headers.get('location'), /nonce/);
    session = await flow();
    claims = () => ({ ...realClaims(), nonce: session.nonce, email: 'eve@evil.com' });
    assert.match((await fetch(`${env.base}/api/auth/sso/callback?code=abc&state=${session.state}`, { headers: { Cookie: session.cookie }, redirect: 'manual' })).headers.get('location'), /acme\.com/);
    // Without the flow cookie the callback is rejected.
    assert.match((await fetch(`${env.base}/api/auth/sso/callback?code=abc&state=${session.state}`, { redirect: 'manual' })).headers.get('location'), /expired/);

    // Enforced SSO blocks password sign-in for the domain.
    const pw = env.client();
    await pw.post('/api/auth/signup', { name: 'Al', email: 'al@acme.com', password: 'a sufficiently long password' });
    assert.equal((await env.client().post('/api/auth/login', { email: 'al@acme.com', password: 'a sufficiently long password' })).body.error.code, 'sso_required');
  } finally { await env.close(); }
});

test('MCP server: tools for availability, booking, meetings and contacts', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    const type = (await owner.post(`/api/workspaces/${ws.id}/event-types`, { title: 'Intro', timezone: 'UTC', published: true, min_notice_min: 0, duration_min: 30 })).body;
    const key = (await owner.post(`/api/workspaces/${ws.id}/api-keys`, { name: 'Claude' })).body.token;
    const rpc = async (body, auth = key) => {
      const response = await fetch(env.base + '/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, body: response.status === 202 ? null : await response.json() };
    };
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null)).status, 401);
    const init = (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).body;
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools.map(tool => tool.name);
    assert.ok(tools.includes('book_meeting') && tools.includes('get_available_times'));
    const call = async (name, args) => JSON.parse((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).body.result.content[0].text);
    assert.equal((await call('list_event_types', {}))[0].id, type.id);
    const times = await call('get_available_times', { event_type_id: type.id, days: 3 });
    assert.equal(times.slots[0], '2026-10-26T09:00:00.000Z');
    const booked = await call('book_meeting', { event_type_id: type.id, start: times.slots[0], name: 'Ravi', email: 'ravi@example.com', timezone: 'Asia/Kolkata' });
    assert.equal(booked.status, 'confirmed');
    assert.equal((await call('list_meetings', { scope: 'upcoming' }))[0].invitee.email, 'ravi@example.com');
    assert.equal((await call('find_contacts', { query: 'ravi' }))[0].email, 'ravi@example.com');
    const failed = (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'book_meeting', arguments: { event_type_id: type.id, start: times.slots[0], name: 'X', email: 'x@example.com', timezone: 'UTC' } } })).body.result;
    assert.equal(failed.isError, true, 'double booking reported as a tool error');
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'nope' })).body.error.code, -32601);
  } finally { await env.close(); }
});
