import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPostgres } from '../src/postgres.mjs';
import { postgresQuery } from '../src/postgres-sql.mjs';
import { loadConfig } from '../src/config.mjs';
import { setup, signUp, publishedEventType, idem } from './helpers.mjs';

test('PostgreSQL query parameters preserve quoted literals and translate supported SQL', () => {
  assert.equal(postgresQuery("SELECT '?' AS literal, ? AS value"), "SELECT '?' AS literal, $1 AS value");
  assert.equal(postgresQuery('SELECT ? IS NULL'), 'SELECT $1::text IS NULL');
  assert.equal(postgresQuery('SELECT ? IS NOT NULL'), 'SELECT $1::text IS NOT NULL');
  assert.match(postgresQuery('INSERT OR IGNORE INTO tasks(id) VALUES (?)'), /ON CONFLICT DO NOTHING$/);
});

test('PostgreSQL: legacy sent email survives the nullable transport upgrade and reconnect', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, async () => {
  const config = loadConfig();
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  let db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  try {
    db.run("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('legacy-ws', 'legacy-ws', 'Legacy workspace', 1)");
    db.run("INSERT INTO emails (id, workspace_id, idempotency_key, kind, to_address, subject, body, status, next_attempt_at, created_at, sent_at) VALUES ('legacy-email', 'legacy-ws', 'legacy-key', 'flow', 'legacy@example.com', 'Subject', 'Body', 'sent', 1, 1, 2)");
    db.exec('ALTER TABLE emails DROP COLUMN accepted_transport');
    db.run("DELETE FROM schema_migrations WHERE name = 'postgres_v6_email_transport'");
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT accepted_transport FROM emails WHERE id = 'legacy-email'").accepted_transport, null);
    assert.equal(db.get("SELECT body FROM emails WHERE id = 'legacy-email'").body, 'Body');
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v6_email_transport'").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM emails WHERE id = 'legacy-email'").count, 1);
  } finally { db.exec('DROP SCHEMA "' + schemaName + '" CASCADE'); db.close(); }
});

test('Supabase persists auth and bookings across reconnects; tenant and overlap checks hold', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, async () => {
  const config = loadConfig();
  assert.ok(config.databaseUrl, 'Set DATABASE_URL privately for this opt-in test.');
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  let db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  let env;
  try {
    env = await setup({ db });
    env.app.log = (level, message, fields) => { if (level === 'error') console.error(message, fields); };
    const owner = env.client();
    const { ws, email } = await signUp(owner, 'PgHost');
    const type = await publishedEventType(owner, ws);
    const base = '/api/public/meet/' + ws.slug + '/' + type.slug;
    const available = await env.client().get(base + '/slots');
    assert.equal(available.status, 200, JSON.stringify(available.body));
    const start = available.body.slots[0];
    const invitee = { name: 'Test guest', email: 'pg-test@example.test', timezone: 'UTC', start };
    const results = await Promise.all([env.client().post(base + '/bookings', invitee, idem()), env.client().post(base + '/bookings', invitee, idem())]);
    assert.deepEqual(results.map(result => result.status).sort(), [201,409], JSON.stringify(results.map(result => result.body)));
    const stranger = env.client(); await signUp(stranger, 'PgStranger');
    assert.equal((await stranger.get('/api/workspaces/' + ws.id + '/bookings')).status, 404);
    await env.close(); env = null; db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    env = await setup({ db });
    const login = env.client();
    assert.equal((await login.post('/api/auth/login', { email, password: 'a sufficiently long password' })).status, 200);
    const stored = await login.get('/api/workspaces/' + ws.id + '/bookings?scope=upcoming');
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    assert.equal(stored.body.length, 1);
    assert.throws(() => db.transaction(() => { db.run('UPDATE users SET name = ? WHERE email = ?', 'Rolled back', email); throw new Error('rollback'); }));
    assert.notEqual(db.get('SELECT name FROM users WHERE email = ?', email).name, 'Rolled back');
    db.transaction(() => {
      assert.throws(() => db.transaction(() => db.get('SELECT * FROM missing_test_table')));
      assert.equal(db.get('SELECT count(*) AS total FROM bookings').total, 1);
    });
  } finally {
    if (env) await env.close();
    db.exec('DROP SCHEMA "' + schemaName + '" CASCADE');
    db.close();
  }
});

test('PostgreSQL upgrade for Schedora Meet video creates every table once with portable SQL', async () => {
  const { openDatabase } = await import('../src/db.mjs');
  const { postgresUpgrade, VIDEO_TABLES } = await import('../src/postgres-sql.mjs');
  const template = openDatabase(':memory:');
  const tables = template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const indexes = template.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
  template.close();
  assert.ok(VIDEO_TABLES.every(name => tables.some(table => table.name === name)), 'every video table is in migration 005');
  const statements = postgresUpgrade(tables.filter(table => VIDEO_TABLES.includes(table.name)), indexes.filter(index => VIDEO_TABLES.includes(index.tbl_name)));
  assert.equal(statements.filter(sql => /^CREATE TABLE/.test(sql)).length, VIDEO_TABLES.length);
  assert.ok(statements.every(sql => !/\bINTEGER\b|COLLATE NOCASE|AUTOINCREMENT|users_email_lower/.test(sql)));
  assert.ok(statements.some(sql => /ALTER TABLE "credit_lots" ADD FOREIGN KEY \(workspace_id\) REFERENCES workspaces\(id\) ON DELETE CASCADE/.test(sql)));
});

test('PostgreSQL upgrade for Forms reliability adds columns idempotently and creates the handoff table', async () => {
  const { openDatabase } = await import('../src/db.mjs');
  const { postgresUpgrade, FORMS_V5_COLUMNS, FORMS_V5_TABLES } = await import('../src/postgres-sql.mjs');
  const template = openDatabase(':memory:');
  const tables = template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const indexes = template.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
  template.close();
  // New databases get the columns from the generated base schema; existing ones through IF NOT EXISTS.
  for (const [table, column] of [['forms', 'draft_revision'], ['form_versions', 'routing'], ['responses', 'request_hash']]) {
    assert.match(tables.find(item => item.name === table).sql, new RegExp(`\\b${column}\\b`));
    assert.ok(FORMS_V5_COLUMNS.some(sql => sql.includes(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`)));
  }
  assert.ok(FORMS_V5_COLUMNS.every(sql => !/\bINTEGER\b/.test(sql)));
  const statements = postgresUpgrade(tables.filter(table => FORMS_V5_TABLES.includes(table.name)), indexes.filter(index => FORMS_V5_TABLES.includes(index.tbl_name)));
  assert.equal(statements.filter(sql => /^CREATE TABLE/.test(sql)).length, 1);
  assert.ok(statements.every(sql => !/\bINTEGER\b|users_email_lower/.test(sql)));
  assert.ok(statements.some(sql => /ALTER TABLE "form_handoffs" ADD FOREIGN KEY \(response_id\) REFERENCES responses\(id\) ON DELETE CASCADE/.test(sql)));
});

test('PostgreSQL upgrade for monitoring creates only the alert table, with no INTEGER columns', async () => {
  const { openDatabase } = await import('../src/db.mjs');
  const { postgresUpgrade, MONITORING_TABLES } = await import('../src/postgres-sql.mjs');
  const template = openDatabase(':memory:');
  const tables = template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const indexes = template.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
  template.close();
  const statements = postgresUpgrade(tables.filter(table => MONITORING_TABLES.includes(table.name)), indexes.filter(index => MONITORING_TABLES.includes(index.tbl_name)));
  assert.deepEqual(statements.filter(sql => /^CREATE TABLE/.test(sql)).map(sql => sql.match(/^CREATE TABLE (\w+)/)[1]), ['monitor_alerts']);
  assert.ok(statements.every(sql => !/\bINTEGER\b|users_email_lower/.test(sql)));
});

test('PostgreSQL: video admissions, credit reservations and the ledger stay consistent under concurrency', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, async () => {
  const { reconcileWallet } = await import('../src/video/credits.mjs');
  const config = loadConfig();
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  const db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  let env;
  try {
    env = await setup({ db });
    env.app.config.video = { ...env.app.config.video, allowances: { evaluation: 50 }, guestPolicy: 'open', maxParticipants: 20 };
    const owner = env.client();
    const { ws } = await signUp(owner, 'PgVideo');
    const room = (await owner.post(`/api/workspaces/${ws.id}/meet-video/rooms`, {})).body;
    const link = await owner.post(`/api/meet-video/rooms/${room.public_id}/invites`, { seats: 15 });
    const token = link.body.url.split('/meet/join/')[1];
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => env.client().post('/api/public/meet-video/join/' + token, { display_name: 'G' + index })));
    assert.equal(results.filter(result => result.status === 200).length, 5);
    assert.deepEqual(reconcileWallet(env.app, ws.id), []);
    assert.throws(() => db.run('UPDATE credit_ledger SET units = 0'), /credit_ledger_immutable/);
  } finally {
    if (env) await env.close();
    db.exec('DROP SCHEMA "' + schemaName + '" CASCADE');
    db.close();
  }
});

test('PostgreSQL: Forms quota boundary and submission retries under concurrency', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, async () => {
  const { QUOTAS } = await import('../src/billing/plans.mjs');
  const config = loadConfig();
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  const db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  let env;
  try {
    env = await setup({ db, config: { billingMode: 'enforced' } });
    const owner = env.client();
    const { ws } = await signUp(owner, 'Owner');
    await owner.post(`/api/workspaces/${ws.id}/billing/test-events`, { action: 'checkout', plan: 'forms' });
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    const submit = id => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'P', email: 'p@example.com', topic: 'support' }, submission_id: id });
    assert.equal((await submit('pg-forms-seed-000001')).status, 201);
    db.run("UPDATE usage_counters SET count = ? WHERE metric = 'responses'", QUOTAS.responses.monthly - 3);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => submit(`pg-forms-burst-${String(index % 5).padStart(6, '0')}`)));
    assert.equal(new Set(results.filter(result => result.status === 201 || result.status === 200).map(result => result.body.id)).size, 3, 'three distinct responses, duplicates replayed');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM responses').count, 4);
    assert.equal(db.get("SELECT count FROM usage_counters WHERE metric = 'responses'").count, QUOTAS.responses.monthly);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM outbox').count, 4);
  } finally {
    if (env) await env.close();
    db.exec('DROP SCHEMA "' + schemaName + '" CASCADE');
    db.close();
  }
});
