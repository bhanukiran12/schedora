// One-shot private-network copy. ECS injects all credentials at runtime. Nothing
// initializes the source application, and source SQL runs in read-only snapshots.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';
import { snapshotDatabase, compareSnapshots } from './database-compare.mjs';

process.umask(0o077);
const env = process.env;
const needed = name => { if (!env[name]) throw new Error(`Missing ${name}`); return env[name]; };
const source = new URL(needed('SOURCE_DATABASE_URL'));
const owner = new URL('postgresql://placeholder/');
owner.hostname = needed('TARGET_DATABASE_HOST');
owner.port = env.TARGET_DATABASE_PORT || '5432';
owner.pathname = '/' + (env.TARGET_DATABASE_NAME || 'schedora');
owner.username = needed('TARGET_OWNER_USER');
owner.password = needed('TARGET_OWNER_PASSWORD');
const app = new URL(owner);
app.username = needed('TARGET_APP_USER');
app.password = needed('TARGET_APP_PASSWORD');
const fixture = env.MIGRATION_LOCAL_FIXTURE === 'yes';
if (fixture && !['pgfixture', 'localhost', '127.0.0.1'].includes(owner.hostname)) throw new Error('Fixture host refused');
if (!fixture && !owner.hostname.endsWith('.ap-south-1.rds.amazonaws.com')) throw new Error('Target is not Mumbai RDS');
if (source.host === owner.host && source.pathname === owner.pathname) throw new Error('Source and target are identical');
const ca = (url, explicit) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.href, DATABASE_CA_CERT: explicit || '' }).databaseCa;
const sourceCa = ca(source, env.SOURCE_DATABASE_CA_CERT);
const targetCa = ca(owner, env.TARGET_DATABASE_CA_CERT);
const dir = join('/tmp', 'schedora-transfer-' + randomBytes(6).toString('hex'));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const clientFor = (url, certificate) => {
  const clean = new URL(url);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) clean.searchParams.delete(key);
  return new pg.Client({ connectionString: clean.href,
    ssl: { rejectUnauthorized: true, ...(certificate ? { ca: certificate } : {}) }, connectionTimeoutMillis: 15000 });
};
function toolEnvironment(url, certificate, side) {
  const certFile = join(dir, side + '-ca.pem');
  if (certificate) writeFileSync(certFile, certificate);
  return { ...env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: certificate ? certFile : 'system', PGCONNECT_TIMEOUT: '15' };
}
const run = (command, args, settings) => execFileSync(command, args,
  { env: settings, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 4 * 1024 * 1024 });

try {
  if (env.MIGRATION_WRITERS_PAUSED !== 'yes') throw new Error('Writer pause must be explicitly confirmed');
  const before = await snapshotDatabase(source.href, sourceCa);
  const target = clientFor(owner, targetCa);
  await target.connect();
  try {
    const existing = await target.query("SELECT to_regnamespace('schedora') IS NOT NULL AS present");
    if (existing.rows[0].present) throw new Error('Refusing to overwrite an existing target schema');
    if (decodeURIComponent(app.username) !== 'schedora_app') throw new Error('Unexpected application role');
    const role = identifier(decodeURIComponent(app.username));
    const found = await target.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [decodeURIComponent(app.username)]);
    await target.query(`${found.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(decodeURIComponent(app.password))}`);
    await target.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${identifier(decodeURIComponent(owner.pathname.slice(1)))} TO ${role}`);
  } finally { await target.end(); }
  const dump = join(dir, 'schedora.dump');
  run('pg_dump', ['--schema=schedora', '--format=custom', '--no-owner', '--no-privileges', '--file=' + dump], toolEnvironment(source, sourceCa, 'source'));
  run('pg_restore', ['--dbname=' + decodeURIComponent(app.pathname.slice(1)), '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', dump], toolEnvironment(app, targetCa, 'target'));
  const after = await snapshotDatabase(source.href, sourceCa);
  const restored = await snapshotDatabase(app.href, targetCa);
  const sourceStable = compareSnapshots(before, after);
  const targetMatches = compareSnapshots(before, restored);
  if (!sourceStable.verified || !targetMatches.verified) {
    console.log(JSON.stringify({ verified: false, sourceStable, targetMatches }));
    throw new Error('Comparison failed: do not cut over');
  }
  // Publish only the new credential, without reading or rewriting AppBeta. The
  // existing app encryption key stays referenced from its existing secret.
  if (env.PUBLISH_TARGET_SECRET === 'yes') {
    if (fixture) throw new Error('Fixtures cannot publish AWS secrets');
    const secretFile = join(dir, 'application-secret.json');
    writeFileSync(secretFile, JSON.stringify({ username: decodeURIComponent(app.username),
      password: decodeURIComponent(app.password), url: app.href }));
    run('aws', ['secretsmanager', 'put-secret-value', '--region', 'ap-south-1',
      '--secret-id', needed('TARGET_APP_SECRET_ARN'), '--secret-string', 'file://' + secretFile,
      '--no-cli-pager'], env);
    rmSync(secretFile);
  }
  console.log(JSON.stringify({ verified: true, source_unchanged: true, ...targetMatches,
    credential_published: env.PUBLISH_TARGET_SECRET === 'yes' }));
} catch (error) {
  // Never print child-process errors: they may contain SQL or record values.
  console.error(JSON.stringify({ verified: false, error: String(error.code || 'transfer_failed') }));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
