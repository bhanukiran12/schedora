import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signUp } from './helpers.mjs';

test('delivery checks use the saved provider, restrict recipients, and deduplicate requests', async () => {
  const env = await setup({ config: { emailProvider: 'http', emailHttpUrl: 'https://email.example/send', emailHttpToken: 'fake-test-token' } });
  try {
    const http = env.client();
    const { ws, email } = await signUp(http, 'Owner');
    const path = `/api/workspaces/${ws.id}/emails/test`;
    assert.equal((await env.client().post(path, { target: 'account' })).status, 401);
    assert.equal((await http.post(path, { target: 'arbitrary@example.com' })).status, 400);
    assert.equal((await http.post(path, { target: 'google' })).body.error.code, 'not_connected');
    const first = await http.post(path, { target: 'account', to: 'unrelated@example.com' });
    assert.equal(first.body.status, 'sent');
    assert.equal(first.body.to, email);
    await http.post(path, { target: 'account' });
    assert.equal(env.sent.length, 1);
    assert.equal(env.sent[0].to, email);
    const user = (await http.get('/api/me')).body.user;
    env.app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES ('test-google', ?, ?, 'google', 'owner@gmail.com', '{}', 'active', ?, ?)", ws.id, user.id, env.clock.now, env.clock.now);
    const google = await http.post(path, { target: 'google' });
    assert.equal(google.body.to, 'owner@gmail.com');
    assert.equal(env.sent.length, 2);
    const member = env.client();
    const other = await signUp(member, 'Member');
    await http.post(`/api/workspaces/${ws.id}/members`, { email: other.email, role: 'member' });
    assert.equal((await member.post(path, { target: 'account' })).status, 403);
  } finally { await env.close(); }
});

test('outbox is never represented as a real delivery check', async () => {
  const env = await setup();
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Owner');
    const result = await http.post(`/api/workspaces/${ws.id}/emails/test`, { target: 'account' });
    assert.equal(result.status, 409);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});

test('provider rejection is visible as a failed check', async () => {
  const env = await setup({ config: { emailProvider: 'http', emailHttpUrl: 'https://email.example/send', emailHttpToken: 'fake-test-token' } });
  try {
    const http = env.client();
    const { ws } = await signUp(http, 'Owner');
    env.emailProvider.mode = 'permanent';
    const result = await http.post(`/api/workspaces/${ws.id}/emails/test`, { target: 'account' });
    assert.equal(result.body.status, 'failed');
    assert.match(result.body.error, /mailbox rejected/);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});
