import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const cookies = response => response.headers.getSetCookie?.() || response.headers.get('set-cookie')?.split(', ') || [];

test('one secure session authenticates every product and logout revokes it everywhere', async () => {
  const env = await setup({ config: { production: true, trustProxy: true, cookieDomain: '.schedora.in', baseUrl: 'https://schedora.in' } });
  try {
    const owner = env.client();
    // HTTPS is terminated at the trusted production proxy.
    const signup = await owner.post('/api/auth/signup', { name: 'Shared account', email: 'shared@example.com', password: 'a sufficiently long password' }, { 'X-Forwarded-Proto': 'https' });
    assert.equal(signup.status, 201);
    const header = signup.headers.get('set-cookie');
    assert.match(header, /Domain=\.schedora\.in/);
    const signupCookies = cookies(signup);
    assert.equal(signupCookies.length, 2);
    assert.match(signupCookies[0], /Domain=\.schedora\.in/);
    assert.match(signupCookies[1], /Max-Age=0/);
    assert.doesNotMatch(signupCookies[1], /Domain=/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    const cookie = header.split(';')[0];
    const duplicateCookieResponse = await fetch(env.base + '/api/me', { headers: { Host: 'meet.schedora.in', Cookie: `schedora_session=revoked-local-session; ${cookie}`, 'X-Forwarded-Proto': 'https' } });
    assert.equal((await duplicateCookieResponse.json()).user.id, signup.body.user.id, 'a revoked duplicate cookie must not override the active shared session');
    for (const host of ['schedora.in', 'meet.schedora.in', 'forms.schedora.in', 'flow.schedora.in']) {
      const response = await fetch(env.base + '/api/me', { headers: { Host: host, Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
      assert.equal((await response.json()).user.id, signup.body.user.id, host);
    }
    const logout = await owner.post('/api/auth/logout', {}, { Origin: 'https://forms.schedora.in', 'X-Forwarded-Proto': 'https' });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Domain=\.schedora\.in/);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const logoutCookies = cookies(logout);
    assert.equal(logoutCookies.length, 2);
    assert.doesNotMatch(logoutCookies[1], /Domain=/);
    for (const host of ['schedora.in', 'meet.schedora.in', 'forms.schedora.in', 'flow.schedora.in']) {
      const response = await fetch(env.base + '/api/me', { headers: { Host: host, Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
      assert.equal((await response.json()).user, null, host);
      assert.match(response.headers.get('set-cookie'), /Domain=\.schedora\.in/);
      assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
      const clearedCookies = cookies(response);
      assert.equal(clearedCookies.length, 2);
      assert.doesNotMatch(clearedCookies[1], /Domain=/);
    }
  } finally { await env.close(); }
});
