import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('one secure session authenticates every product and logout revokes it everywhere', async () => {
  const env = await setup({ config: { production: true, trustProxy: true, cookieDomain: '.schedora.in', baseUrl: 'https://schedora.in' } });
  try {
    const owner = env.client();
    // HTTPS is terminated at the trusted production proxy.
    const signup = await owner.post('/api/auth/signup', { name: 'Shared account', email: 'shared@example.com', password: 'a sufficiently long password' }, { 'X-Forwarded-Proto': 'https' });
    assert.equal(signup.status, 201);
    const header = signup.headers.get('set-cookie');
    assert.match(header, /Domain=\.schedora\.in/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    const cookie = header.split(';')[0];
    for (const host of ['schedora.in', 'meet.schedora.in', 'forms.schedora.in', 'flow.schedora.in']) {
      const response = await fetch(env.base + '/api/me', { headers: { Host: host, Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
      assert.equal((await response.json()).user.id, signup.body.user.id, host);
    }
    const logout = await owner.post('/api/auth/logout', {}, { Origin: 'https://forms.schedora.in', 'X-Forwarded-Proto': 'https' });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Domain=\.schedora\.in/);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    for (const host of ['schedora.in', 'meet.schedora.in', 'forms.schedora.in', 'flow.schedora.in']) {
      const response = await fetch(env.base + '/api/me', { headers: { Host: host, Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
      assert.equal((await response.json()).user, null, host);
    }
  } finally { await env.close(); }
});
