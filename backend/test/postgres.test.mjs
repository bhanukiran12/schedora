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
