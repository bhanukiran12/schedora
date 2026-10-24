import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../src/config.mjs';
import { meetReadiness, assertMeetProduction } from '../src/production.mjs';

const valid = () => loadConfig({
  NODE_ENV: 'production', RELEASE_MODE: 'production', BASE_URL: 'https://schedora.in',
  DATABASE_PATH: '/var/data/schedora.db', PERSISTENT_STORAGE_CONFIRMED: 'true', BACKUPS_CONFIRMED: 'true',
  EMAIL_PROVIDER: 'http', EMAIL_HTTP_URL: 'https://email.example/send', EMAIL_HTTP_TOKEN: 'private-token',
  EMAIL_DOMAIN_VERIFIED: 'true', OPERATOR_NAME: 'Test operator', OPERATOR_CONTACT: 'privacy@example.com',
  OPERATOR_JURISDICTION: 'Test jurisdiction', APP_ENCRYPTION_KEY: 'x'.repeat(44),
  PROVIDER_SMOKE_CONFIRMED: 'true', MONITORING_CONFIRMED: 'true', COMMERCIAL_BILLING_CONFIRMED: 'true',
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  BILLING_PROVIDER: 'external-adapter', BILLING_WEBHOOK_SECRET: 'test-webhook-secret'
});

test('evaluation defaults cannot pass the Meet production gate', () => {
  const config = loadConfig({});
  assert.equal(meetReadiness(config).ready, false);
  assert.throws(() => assertMeetProduction(config), /production release blocked/);
});

test('production gate requires every operational confirmation and safe settings', () => {
  const config = valid();
  assert.equal(meetReadiness(config).ready, true);
  for (const property of ['persistentStorageConfirmed','backupsConfirmed','emailDomainVerified','providerSmokeConfirmed','monitoringConfirmed','commercialBillingConfirmed']) {
    assert.equal(meetReadiness({ ...config, [property]: false }).ready, false, property);
  }
  for (const patch of [{ databasePath: ':memory:' }, { databasePath: './temporary.db' }, { emailHttpUrl: 'http://email.example' }, { allowTestPayments: true }, { encryptionKey: 'short' }, { billingMode: 'open' }, { billingProvider: 'test' }, { billingProvider: 'none' }, { google: {} }]) {
    assert.equal(meetReadiness({ ...config, ...patch }).ready, false);
  }
  assert.ok(!JSON.stringify(publicConfig(config)).includes('private-token'));
});

test('unknown email providers cannot silently fall back to local outbox', () => {
  assert.throws(() => loadConfig({ EMAIL_PROVIDER: 'typo' }), /EMAIL_PROVIDER/);
});
