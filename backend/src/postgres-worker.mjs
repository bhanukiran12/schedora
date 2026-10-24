import { workerData } from 'node:worker_threads';
import { Client, types } from 'pg';
import { postgresQuery } from './postgres-sql.mjs';

types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds JavaScript safe range.');
  return number;
});
const { port, state, connectionString, ca, schemaName } = workerData;
const signal = new Int32Array(state);
let client;
async function initialize(schema) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  if (url.hostname.endsWith('.pooler.supabase.com') && url.port !== '5432') throw new Error('Use the Supabase session pooler on port 5432.');
  for (const name of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(name);
  client = new Client({ connectionString: url.href, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 15000, query_timeout: 20000, application_name: 'schedora' });
  client.on('error', () => {});
  await client.connect();
  await client.query('SET statement_timeout = 20000');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(724516, 1)");
    await client.query('CREATE SCHEMA IF NOT EXISTS "' + schemaName + '"');
    await client.query('SET LOCAL search_path TO "' + schemaName + '"');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const applied = await client.query("SELECT name FROM schema_migrations WHERE name = 'postgres_v1'");
    if (!applied.rowCount) {
      const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations'", [schemaName]);
      if (existing.rowCount) throw new Error('The schedora schema contains unrecognized tables; migration stopped without changing them.');
      for (const statement of schema) await client.query(statement);
      await client.query("CREATE FUNCTION prevent_host_overlap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.active = 1 THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.host_id, 0)); IF EXISTS (SELECT 1 FROM meeting_hosts h WHERE h.host_id = NEW.host_id AND h.active = 1 AND h.meeting_id <> NEW.meeting_id AND ((NEW.block_start < h.ends_at AND NEW.block_end > h.starts_at) OR (NEW.starts_at < h.block_end AND NEW.ends_at > h.block_start))) THEN RAISE EXCEPTION 'booking_overlap'; END IF; END IF; RETURN NEW; END $$");
      await client.query('CREATE TRIGGER meeting_hosts_no_overlap BEFORE INSERT OR UPDATE ON meeting_hosts FOR EACH ROW EXECUTE FUNCTION prevent_host_overlap()');
      await client.query("INSERT INTO schema_migrations VALUES ('postgres_v1', $1)", [Date.now()]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  await client.query('SET search_path TO "' + schemaName + '"');
  return { connected: true };
}

port.on('message', async request => {
  let result;
  try {
    if (request.operation === 'init') result = await initialize(request.schema);
    else if (request.operation === 'close') { await client.end(); result = null; }
    else {
      const response = await client.query(postgresQuery(request.sql), request.params);
      result = { rows: response.rows, changes: response.rowCount };
    }
    port.postMessage({ result });
  } catch (error) { port.postMessage({ error: { message: error.message, code: error.code } }); }
  finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});
