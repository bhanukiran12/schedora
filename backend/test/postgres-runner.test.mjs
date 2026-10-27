import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/test-postgres.mjs', import.meta.url));

test('PostgreSQL runner stops before launching tests when credentials are absent or invalid', () => {
  for (const databaseUrl of ['', 'https://invalid.example.test']) {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, RUN_POSTGRES_TESTS: 'false' }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '', 'the test suite must not launch');
    assert.match(result.stderr, /need DATABASE_URL|preflight failed/);
    assert.ok(!result.stderr.includes('invalid.example.test'), 'connection details are not printed');
  }
});
