// Read-only verification before a shared-database cutover. Credentials stay in
// environment variables. Output contains schema metadata and hashes, never rows.
// SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node scripts/database-compare.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function snapshotDatabase(connectionString, ca) {
  const url = new URL(connectionString);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  const client = new pg.Client({ connectionString: url.href,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 15000, query_timeout: 120000,
    application_name: 'schedora-readonly-database-comparison' });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL search_path TO schedora, public');
    const encrypted = (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl;
    if (!encrypted) throw new Error('Encrypted database connection was not confirmed.');
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'schedora' ORDER BY tablename COLLATE \"C\"")).rows;
    if (!tables.length) throw new Error('No Schedora application tables found.');
    const columns = (await client.query(`SELECT table_name, column_name, ordinal_position, data_type, udt_name,
      is_nullable, column_default, is_identity, is_generated FROM information_schema.columns
      WHERE table_schema = 'schedora' ORDER BY table_name COLLATE "C", ordinal_position`)).rows;
    const indexes = (await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'schedora' ORDER BY tablename COLLATE "C", indexname COLLATE "C"`)).rows;
    const constraints = (await client.query(`SELECT rel.relname AS table_name, c.conname AS name,
      pg_get_constraintdef(c.oid) AS definition, c.convalidated AS valid FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'schedora' ORDER BY rel.relname COLLATE "C", c.conname COLLATE "C"`)).rows;
    const result = { encrypted: true, read_only: true,
      schema_sha256: digest({ columns, indexes, constraints }), tables: {} };
    for (const { tablename } of tables) {
      // Stable PostgreSQL JSONB text and C ordering avoid locale-dependent hashes.
      // A cursor bounds client memory even when a table has many responses.
      await client.query(`DECLARE comparison_rows NO SCROLL CURSOR FOR
        SELECT to_jsonb(t)::text AS value FROM schedora.${quote(tablename)} t
        ORDER BY to_jsonb(t)::text COLLATE "C"`);
      const hash = createHash('sha256');
      let count = 0;
      while (true) {
        const batch = (await client.query('FETCH FORWARD 500 FROM comparison_rows')).rows;
        if (!batch.length) break;
        for (const row of batch) hash.update(row.value).update('\n');
        count += batch.length;
      }
      await client.query('CLOSE comparison_rows');
      result.tables[tablename] = { rows: count, sha256: hash.digest('hex') };
    }
    return result;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

export function compareSnapshots(source, target) {
  const names = [...new Set([...Object.keys(source.tables), ...Object.keys(target.tables)])].sort();
  const differences = names.filter(name => JSON.stringify(source.tables[name]) !== JSON.stringify(target.tables[name]));
  return { verified: source.schema_sha256 === target.schema_sha256 && differences.length === 0,
    schema_matches: source.schema_sha256 === target.schema_sha256,
    table_count: names.length, row_count: Object.values(source.tables).reduce((n, table) => n + table.rows, 0),
    differing_tables: differences };
}

async function main() {
  const source = process.env.SOURCE_DATABASE_URL;
  const target = process.env.TARGET_DATABASE_URL;
  if (!source || !target) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL privately.');
  const from = new URL(source), to = new URL(target);
  if (from.host === to.host && from.pathname === to.pathname) throw new Error('Source and target must be different databases.');
  const config = (url, ca) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, DATABASE_CA_CERT: ca || '' });
  const left = await snapshotDatabase(source, config(source, process.env.SOURCE_DATABASE_CA_CERT).databaseCa);
  const right = await snapshotDatabase(target, config(target, process.env.TARGET_DATABASE_CA_CERT).databaseCa);
  const report = { compared_at: new Date().toISOString(), ...compareSnapshots(left, right), source: left, target: right };
  const index = process.argv.indexOf('--json');
  if (index >= 0 && process.argv[index + 1]) writeFileSync(process.argv[index + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, source: undefined, target: undefined }, null, 2));
  process.exitCode = report.verified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Connection errors may contain connection details. Keep them out of logs.
    console.error(JSON.stringify({ verified: false, error: error.code || 'comparison_failed' }));
    process.exitCode = 1;
  });
}
