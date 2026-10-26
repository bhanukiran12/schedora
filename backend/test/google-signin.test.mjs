import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setup, signUp } from './helpers.mjs';
import { decryptJson } from '../src/platform/crypto.mjs';
import { safeGoogleNext, startGoogleLogin } from '../src/platform/google-signin.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'google-test-key', alg: 'RS256', use: 'sig' };
async function fixture() {
  const env = await setup({ config: { google: { clientId: 'google-client', clientSecret: 'test-server-secret' } } });
  let flow; let overrides = {}; let tokenCalls = 0; let tokenForm;
  env.app.fetchProvider = async (url, init = {}) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls++; tokenForm = new URLSearchParams(init.body);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'google-client', sub: 'google-subject-1', name: 'Google User', email: 'google-user@gmail.com', email_verified: true, iat: env.clock.now / 1000, exp: env.clock.now / 1000 + 300, nonce: flow.nonce, ...overrides })).toString('base64url');
      return Response.json({ id_token: `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`, access_token: 'unused-access-token' });
    }
    throw new Error('Unexpected external request');
  };
  async function start({ session = '', link = false, csrf = '' } = {}) {
    const response = await fetch(env.base + (link ? '/api/auth/google/link' : '/api/auth/google/start?next=/forms'), { method: link ? 'POST' : 'GET', redirect: 'manual', headers: { ...(session ? { Cookie: session } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('schedora_google_login='))?.split(';')[0];
    assert.ok(cookie, await response.clone().text());
    flow = decryptJson(env.app.config, decodeURIComponent(cookie.split('=').slice(1).join('=')));
    const url = new URL(link ? (await response.json()).url : response.headers.get('location'));
    return { cookie, url, flow, session };
  }
  const finish = (started, query = '') => fetch(`${env.base}/api/auth/google/callback?code=code&state=${started.flow.state}${query}`, { redirect: 'manual', headers: { Cookie: [started.cookie, started.session].filter(Boolean).join('; ') } });
  return { ...env, start, finish, override(value) { overrides = value; }, get tokenCalls() { return tokenCalls; }, get tokenForm() { return tokenForm; } };
}

test('Google sign-in uses least privilege, PKCE, verified identity and a fresh session; callback cannot replay', async () => {
  const env = await fixture();
  try {
    const started = await env.start();
    assert.equal(started.url.searchParams.get('scope'), 'openid email profile');
    assert.equal(started.url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!started.url.searchParams.has('client_secret'));
    const finished = await env.finish(started);
    assert.equal(finished.headers.get('location'), '/forms');
    assert.equal(env.tokenForm.get('code_verifier'), started.flow.verifier);
    const cookie = finished.headers.getSetCookie().find(value => value.startsWith('schedora_session=')).split(';')[0];
    const me = await (await fetch(env.base + '/api/me', { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.email, 'google-user@gmail.com');
    assert.equal(me.workspaces.length, 1);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM integrations').n, 0, 'sign-in does not connect a calendar');
    assert.match((await env.finish(started)).headers.get('location'), /already/);
    assert.equal(env.tokenCalls, 1);
    // Stable subject resolves the same account even if Google changes its email.
    const again = await env.start(); env.override({ email: 'changed@gmail.com' });
    assert.equal((await env.finish(again)).headers.get('location'), '/forms');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM users').n, 1);
  } finally { await env.close(); }
});

test('Google refuses missing cookie, wrong state, expired flows, denial and invalid identity claims', async () => {
  const env = await fixture();
  try {
    const started = await env.start();
    assert.match((await fetch(env.base + '/api/auth/google/callback?code=x&state=' + started.flow.state, { redirect: 'manual' })).headers.get('location'), /expired/);
    assert.match((await fetch(env.base + '/api/auth/google/callback?code=x&state=wrong', { redirect: 'manual', headers: { Cookie: started.cookie } })).headers.get('location'), /expired/);
    for (const claims of [{ aud: 'attacker' }, { nonce: 'wrong' }, { iss: 'https://attacker.invalid' }, { exp: env.clock.now / 1000 - 1 }, { email_verified: false }, { azp: 'other-app' }, { sub: '' }, { iat: env.clock.now / 1000 + 500 }]) {
      const attempt = await env.start(); env.override(claims);
      assert.match((await env.finish(attempt)).headers.get('location'), /could%20not%20verify/);
    }
    env.override({}); const denied = await env.start();
    assert.match((await env.finish(denied, '&error=access_denied')).headers.get('location'), /canceled/);
    const expired = await env.start(); env.clock.now += 600001;
    assert.match((await env.finish(expired)).headers.get('location'), /expired/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
  } finally { await env.close(); }
});

test('existing password users must link Google while authenticated; linking requires CSRF and same verified email', async () => {
  const env = await fixture();
  try {
    const host = env.client(); const account = await signUp(host, 'Existing');
    env.override({ email: account.email });
    assert.match((await env.finish(await env.start())).headers.get('location'), /already%20exists/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM auth_identities').n, 0);
    const login = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.email, password: 'a sufficiently long password' }) });
    const session = login.headers.getSetCookie()[0].split(';')[0]; const me = await login.json();
    assert.equal((await fetch(env.base + '/api/auth/google/link', { method: 'POST', headers: { Cookie: session } })).status, 403);
    const mismatched = await env.start({ link: true, session, csrf: me.csrf_token }); env.override({ email: 'different@gmail.com' });
    assert.match((await env.finish(mismatched)).headers.get('location'), /same%20email/);
    const linked = await env.start({ link: true, session, csrf: me.csrf_token }); env.override({ email: account.email });
    assert.equal((await env.finish(linked)).headers.get('location'), '/account?google=connected');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM users').n, 1);
    assert.equal(env.app.db.get('SELECT user_id FROM auth_identities').user_id, account.user.id);
    assert.equal((await env.finish(await env.start())).headers.get('location'), '/forms');
  } finally { await env.close(); }
});

test('Google next URLs stay on supported app routes', () => {
  for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', '/api/auth/google/start', '/meet\r\nLocation: evil']) assert.equal(safeGoogleNext(value), '/meet');
  assert.equal(safeGoogleNext('/forms?tab=responses'), '/forms?tab=responses');
});

test('Google-only accounts can delete through fresh identity verification; other identities cannot delete them', async () => {
  const env = await fixture();
  try {
    const first = await env.finish(await env.start());
    const session = first.headers.getSetCookie().find(value => value.startsWith('schedora_session=')).split(';')[0];
    const me = await (await fetch(env.base + '/api/me', { headers: { Cookie: session } })).json();
    const attempt = async confirm => fetch(env.base + '/api/auth/google/delete-account', { method: 'POST', headers: { Cookie: session, 'X-CSRF-Token': me.csrf_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) });
    assert.equal((await attempt('wrong')).status, 400);
    const start = await attempt('DELETE');
    assert.equal(start.status, 200);
    // A verified but unrelated Google identity cannot authorize destruction.
    const wrong = startGoogleLogin(env.app, { userId: me.user.id, action: 'delete' });
    const wrongCookie = wrong.cookie.split(';')[0]; const wrongFlow = decryptJson(env.app.config, decodeURIComponent(wrongCookie.split('=').slice(1).join('=')));
    env.override({ sub: 'other-google-account', nonce: wrongFlow.nonce });
    assert.match((await env.finish({ cookie: wrongCookie, flow: wrongFlow, session })).headers.get('location'), /already%20linked/);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM users').n, 1);
    const right = startGoogleLogin(env.app, { userId: me.user.id, action: 'delete' });
    const cookie = right.cookie.split(';')[0]; const flow = decryptJson(env.app.config, decodeURIComponent(cookie.split('=').slice(1).join('=')));
    env.override({ nonce: flow.nonce });
    assert.equal((await env.finish({ cookie, flow, session })).headers.get('location'), '/account?deleted=1');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM auth_identities').n, 0);
  } finally { await env.close(); }
});
