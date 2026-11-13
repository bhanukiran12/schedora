import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { setup } from './helpers.mjs';

test('local development uses a registrable localhost domain for shared cookies', () => {
  const config = loadConfig({ NODE_ENV: 'development', PORT: '3002' });
  assert.equal(config.baseUrl, 'http://schedora.localhost:3002');
  assert.equal(config.cookieDomain, '.schedora.localhost');
});

test('legacy local product hosts redirect to the shared-cookie hostname and keep their port', async () => {
  const env = await setup({ config: { cookieDomain: '.schedora.localhost' } });
  try {
    const port = Number(new URL(env.base).port);
    const response = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/login?next=%2Fmeet', headers: { Host: `meet.localhost:${port}` } }, resolve).on('error', reject);
    });
    response.resume();
    assert.equal(response.statusCode, 307);
    assert.equal(response.headers.location, `http://meet.schedora.localhost:${port}/login?next=%2Fmeet`);
  } finally { await env.close(); }
});
