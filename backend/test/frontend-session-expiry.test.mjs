import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, session } from '../../frontend/js/core.mjs';

test('a stale signed-in session notifies the app on protected API 401', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalUser = session.user;
  const events = [];
  try {
    session.user = { id: 'stale-session' };
    globalThis.window = { dispatchEvent: event => events.push(event.type) };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });

    await assert.rejects(api('GET', '/api/workspaces/test/event-types'), error => error.status === 401 && error.code === 'unauthenticated');
    assert.deepEqual(events, ['schedora:session-expired']);
  } finally {
    session.user = originalUser;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('invalid password 401 does not trigger stale-session handling', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalUser = session.user;
  const events = [];
  try {
    session.user = null;
    globalThis.window = { dispatchEvent: event => events.push(event.type) };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });

    await assert.rejects(api('POST', '/api/auth/login', {}), error => error.status === 401 && error.code === 'invalid_credentials');
    assert.deepEqual(events, []);
  } finally {
    session.user = originalUser;
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
