import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureContext } from 'node:tls';
import { loadConfig } from '../src/config.mjs';

const config = values => loadConfig({ NODE_ENV: 'test', ...values });

test('Mumbai RDS uses the bundled AWS certificate chain with explicit CA override preserved', () => {
  const ca = config({ DATABASE_URL: 'postgres://example:example@schedora.abcdef.ap-south-1.rds.amazonaws.com:5432/schedora' }).databaseCa;
  assert.match(ca, /BEGIN CERTIFICATE/);
  assert.doesNotThrow(() => createSecureContext({ ca }));
  assert.equal(config({ DATABASE_URL: 'postgres://example:example@schedora.abcdef.ap-south-1.rds.amazonaws.com/schedora', DATABASE_CA_CERT: 'explicit-certificate' }).databaseCa, 'explicit-certificate');
});

test('database CA selection matches the actual hostname and preserves Supabase and local configurations', () => {
  const supabase = config({ DATABASE_URL: 'postgres://example:example@aws-0-ap-south-1.pooler.supabase.com/postgres' }).databaseCa;
  assert.match(supabase, /BEGIN CERTIFICATE/);
  assert.doesNotThrow(() => createSecureContext({ ca: supabase }));
  for (const DATABASE_URL of ['', 'invalid', 'postgres://localhost/local', 'postgres://user.pooler.supabase.com:example@unrelated.example/db', 'postgres://user:example@schedora.ap-south-1.rds.amazonaws.com.evil.example/db']) {
    assert.equal(config({ DATABASE_URL }).databaseCa, '');
  }
});
