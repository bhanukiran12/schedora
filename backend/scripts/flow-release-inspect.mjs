// Read-only release inspection for the Flow v1 PostgreSQL migration (release package §3).
// Usage: node --env-file=.env scripts/flow-release-inspect.mjs [--json out.json]
// Every query runs inside BEGIN READ ONLY with verified TLS. It prints upgrade names, counts and ages only:
// never the connection string, credentials, workspace names or personal data.
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
const source = readFileSync(new URL('../src/postgres.mjs', import.meta.url), 'utf8');
const expected = ['postgres_v1', 'postgres_v2_billing_checkouts', 'postgres_v3_google_signin',
  ...[...source.matchAll(/name: ?'(postgres_v\d+_[a-z0-9_]+)'/g)].map(match => match[1])];
const version = name => Number(/^postgres_v(\d+)/.exec(name)?.[1] || 0);

const url = new URL(config.databaseUrl);
for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(name);
const client = new pg.Client({ connectionString: url.href, ssl: { rejectUnauthorized: true, ...(config.databaseCa ? { ca: config.databaseCa } : {}) },
  connectionTimeoutMillis: 15000, query_timeout: 20000, application_name: 'schedora-release-inspect' });
const rows = async (sql, params = []) => (await client.query(sql, params)).rows;
const exists = async table => (await rows("SELECT to_regclass($1) IS NOT NULL AS ok", ['schedora.' + table]))[0].ok;

const now = Date.now();
const report = { inspected_at: new Date(now).toISOString(), read_only: true };
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  report.server_version = (await rows('SHOW server_version'))[0].server_version;
  report.transaction_read_only = (await rows('SHOW transaction_read_only'))[0].transaction_read_only;
  const applied = await rows('SELECT name, applied_at FROM schedora.schema_migrations ORDER BY applied_at');
  const names = new Set(applied.map(row => row.name));
  report.latest_applied = applied.slice(-8).map(row => ({ name: row.name, applied_at: new Date(Number(row.applied_at)).toISOString() }));
  report.pending = expected.filter(name => !names.has(name));
  report.unexpected = applied.map(row => row.name).filter(name => !expected.includes(name));
  report.highest_applied = Math.max(0, ...applied.map(row => version(row.name)));
  report.flows = await rows('SELECT action_type, status, COUNT(*)::int AS count FROM schedora.flows GROUP BY 1, 2 ORDER BY 1, 2');
  report.flow_runs = await rows('SELECT status, COUNT(*)::int AS count FROM schedora.flow_runs GROUP BY 1 ORDER BY 1');
  report.emails_pending = await rows(`SELECT status, COUNT(*)::int AS count, MIN(CASE WHEN status = 'sending' THEN COALESCE(claimed_until, next_attempt_at) END) AS oldest FROM schedora.emails
    WHERE status IN ('scheduled', 'queued', 'sending') GROUP BY 1 ORDER BY 1`);
  for (const row of report.emails_pending) { row.oldest_age_minutes = row.oldest == null ? null : Math.round((now - Number(row.oldest)) / 60000); delete row.oldest; }
  const outbox = (await rows('SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest FROM schedora.outbox WHERE dispatched_at IS NULL'))[0];
  report.outbox_undispatched = { count: outbox.count, oldest_age_minutes: outbox.oldest == null ? null : Math.round((now - Number(outbox.oldest)) / 60000) };
  report.flow_v1_tables_present = {};
  for (const table of ['flow_versions', 'flow_run_steps', 'flow_waits', 'flow_approvals', 'flow_schedules']) report.flow_v1_tables_present[table] = await exists(table);
  report.schema_size_mb = Math.round(Number((await rows(`SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'schedora' AND c.relkind = 'r'`))[0].bytes) / 1048576);
  report.table_count = Number((await rows("SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'schedora'"))[0].n);
  // Connections by application name, counts only, no addresses. Through the Supabase pooler the app shows as
  // "Supavisor", so this cannot count Schedora services; use worker_activity to confirm workers are paused.
  report.app_connections = await rows(`SELECT application_name, COUNT(*)::int AS connections, COUNT(DISTINCT client_addr)::int AS distinct_clients,
    MIN(backend_start) AS since FROM pg_stat_activity WHERE datname = current_database()
    AND pid <> pg_backend_pid() GROUP BY 1 ORDER BY 1`);
  // Minutes since each worker-only write. With every worker paused these stop moving (compare two runs).
  const ago = value => value == null ? null : Math.round((now - Number(value)) / 60000);
  const [last] = await rows(`SELECT (SELECT MAX(dispatched_at) FROM schedora.outbox) AS outbox_dispatched, (SELECT MAX(sent_at) FROM schedora.emails) AS email_sent,
    (SELECT MAX(updated_at) FROM schedora.flow_runs) AS flow_run_updated`);
  report.worker_activity_minutes_ago = { outbox_dispatched: ago(last.outbox_dispatched), email_sent: ago(last.email_sent), flow_run_updated: ago(last.flow_run_updated) };
  // Per-table row counts, compared with the restored backup by flow-release-backup.mjs.
  report.row_counts = {};
  for (const { tablename } of await rows("SELECT tablename FROM pg_tables WHERE schemaname = 'schedora' ORDER BY tablename")) {
    report.row_counts[tablename] = Number((await rows(`SELECT COUNT(*) AS n FROM schedora."${tablename}"`))[0].n);
  }
  for (const row of report.app_connections) row.since = row.since?.toISOString?.() ?? row.since;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
const output = JSON.stringify(report, null, 2);
console.log(output);
const at = process.argv.indexOf('--json');
if (at > 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1], output + '\n');
