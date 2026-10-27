import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openPostgres } from '../src/postgres.mjs';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('PostgreSQL tests need DATABASE_URL. Load your private environment file before running this command.');
  process.exit(1);
}

const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
let database;
try {
  database = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  database.get('SELECT 1 AS ready');
  database.exec('DROP SCHEMA "' + schemaName + '" CASCADE');
} catch (error) {
  console.error(`PostgreSQL preflight failed (${error.code || 'connection_or_migration_error'}). Tests were not started. Check credentials, connectivity and migration permissions privately before retrying.`);
  process.exitCode = 1;
} finally {
  database?.close();
}

if (!process.exitCode) {
  const files = process.argv.slice(2);
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...(files.length ? files : ['test/forms-reliability.test.mjs', 'test/postgres.test.mjs'])], {
    stdio: 'inherit', env: { ...process.env, RUN_POSTGRES_TESTS: 'true' }
  });
  process.exitCode = result.status ?? 1;
}
