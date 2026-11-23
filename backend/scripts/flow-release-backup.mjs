// Logical backup of the schedora schema with verified recovery (release package §4, step 2).
//
//   node --env-file=<env with DATABASE_URL> scripts/flow-release-backup.mjs <output-directory> [--live]
//
// 1. pg_dump (PostgreSQL 17 client in Docker) of schema "schedora", custom format, TLS verify-full.
// 2. pg_restore --list must read the archive.
// 3. The archive is restored into a disposable local container (127.0.0.1 only), and every table's row
//    count is compared with the source, read in a READ ONLY transaction. The container is removed afterwards.
// The source connection string is passed to Docker through the environment, never on a command line, and is
// never printed. Non-local sources need --live. Keep the dump in protected storage: it holds customer data.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';

const directory = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : null;
if (!directory) throw new Error('Usage: flow-release-backup.mjs <output-directory> [--live]');
const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
const source = new URL(config.databaseUrl);
const local = ['127.0.0.1', 'localhost', '::1'].includes(source.hostname);
if (!local && !process.argv.includes('--live')) throw new Error('Refusing a non-local database without --live.');
const IMAGE = 'postgres:17';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(directory, { recursive: true });
const dumpName = `schedora-${stamp}.dump`;
const work = join(directory, `.work-${stamp}`);
mkdirSync(work, { recursive: true });
const docker = (args, options = {}) => execFileSync('docker', args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], ...options });

async function counts(url, ca, schema = 'schedora') {
  const parsed = new URL(url);
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(name);
  const client = new pg.Client({ connectionString: parsed.href, ssl: ca === false ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, application_name: 'schedora-release-backup', connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = {};
    for (const { tablename } of (await client.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).rows) {
      result[tablename] = Number((await client.query(`SELECT COUNT(*) AS n FROM "${schema}"."${tablename}"`)).rows[0].n);
    }
    return result;
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}

const report = { started_at: new Date().toISOString(), dump: dumpName, image: IMAGE, source: local ? 'local' : 'live' };
const restoreName = 'schedora-backup-verify-' + randomBytes(4).toString('hex');
try {
  // 1. Dump. Docker reaches a local source through host.docker.internal.
  const url = new URL(source.href);
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(name);
  if (local) url.hostname = 'host.docker.internal';
  const caFile = join(work, 'ca.crt');
  const args = ['run', '--rm', '-e', 'PGURL', '-v', `${work}:/work`, IMAGE, 'sh', '-c'];
  let dumpUrl;
  if (config.databaseCa) {
    writeFileSync(caFile, config.databaseCa);
    url.searchParams.set('sslmode', local ? 'verify-ca' : 'verify-full');
    url.searchParams.set('sslrootcert', '/work/ca.crt');
  } else if (!local) url.searchParams.set('sslmode', 'verify-full'), url.searchParams.set('sslrootcert', 'system');
  dumpUrl = url.href;
  docker([...args, `pg_dump --dbname="$PGURL" --schema=schedora --format=custom --no-owner --no-privileges --file=/work/${dumpName}`], { env: { ...process.env, PGURL: dumpUrl } });
  rmSync(caFile, { force: true });
  const dumpPath = join(directory, dumpName);
  writeFileSync(dumpPath, readFileSync(join(work, dumpName)));
  rmSync(join(work, dumpName), { force: true });
  report.bytes = statSync(dumpPath).size;
  report.sha256 = createHash('sha256').update(readFileSync(dumpPath)).digest('hex');
  const sourceCounts = await counts(source.href, config.databaseCa || undefined);

  // 2. The archive is readable.
  const list = docker(['run', '--rm', '-v', `${directory}:/backup:ro`, IMAGE, 'pg_restore', '--list', `/backup/${dumpName}`]).toString();
  report.archive_entries = list.split('\n').filter(line => line && !line.startsWith(';')).length;

  // 3. Restore into a disposable container and compare.
  const password = randomBytes(16).toString('hex');
  docker(['run', '-d', '--name', restoreName, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password, '-v', `${directory}:/backup:ro`, IMAGE]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(['exec', restoreName, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']); break; } catch { await new Promise(done => setTimeout(done, 1000)); }
  }
  docker(['exec', restoreName, 'pg_restore', '-U', 'postgres', '-h', '127.0.0.1', '-d', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error', `/backup/${dumpName}`]);
  const port = docker(['port', restoreName, '5432/tcp']).toString().trim().split(':').pop();
  const restoredCounts = await counts(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`, false);
  const tables = [...new Set([...Object.keys(sourceCounts), ...Object.keys(restoredCounts)])].sort();
  report.tables = tables.length;
  report.rows = Object.values(sourceCounts).reduce((sum, n) => sum + n, 0);
  report.differences = tables.filter(name => sourceCounts[name] !== restoredCounts[name]).map(name => ({ table: name, source: sourceCounts[name] ?? null, restored: restoredCounts[name] ?? null }));
  report.migrations = (await (async () => {
    const client = new pg.Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`, ssl: false });
    await client.connect();
    try { return (await client.query('SELECT name FROM schedora.schema_migrations ORDER BY applied_at DESC LIMIT 1')).rows[0]?.name; } finally { await client.end(); }
  })());
  report.verified = report.differences.length === 0 && report.archive_entries > 0;
  report.note = report.differences.length ? 'Counts differ: writes happened during the dump, or the restore is incomplete. Pause workers and traffic, then take the backup again.' : 'Restored row counts match the source exactly.';
} finally {
  try { docker(['rm', '-f', restoreName]); } catch { /* not started */ }
  rmSync(work, { recursive: true, force: true });
}
report.finished_at = new Date().toISOString();
writeFileSync(join(directory, dumpName.replace(/\.dump$/, '.verify.json')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exit(report.verified ? 0 : 1);
