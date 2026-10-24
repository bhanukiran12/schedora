import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStartupConfig } from '../../frontend/js/connection.mjs';

test('startup recovers from transient errors but does not retry authorization errors', async () => {
  let attempts = 0;
  const config = await loadStartupConfig(async () => {
    if (++attempts < 3) throw Object.assign(new Error('Starting'), { status: 503 });
    return { productDomain: 'schedora.in' };
  }, async () => {});
  assert.equal(config.productDomain, 'schedora.in');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(loadStartupConfig(async () => { attempts++; throw Object.assign(new Error('Denied'), { status: 403 }); }, async () => {}));
  assert.equal(attempts, 1);
});

test('startup retries are bounded and reject non-JSON fallback data', async () => {
  let attempts = 0;
  await assert.rejects(loadStartupConfig(async () => { attempts++; return null; }, async () => {}));
  assert.equal(attempts, 3);
});
