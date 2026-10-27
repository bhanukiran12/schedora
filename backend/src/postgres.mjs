import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { FORMS_V5_COLUMNS, FORMS_V5_TABLES, postgresSchema, postgresUpgrade, VIDEO_TABLES } from './postgres-sql.mjs';
import { openDatabase } from './db.mjs';

export function openPostgres(connectionString, { ca, schemaName = 'schedora' } = {}) {
  if (!/^schedora(?:_test_[a-z0-9]+)?$/.test(schemaName)) throw new Error('Invalid Schedora database schema.');
  const template = openDatabase(':memory:');
  let schema;
  let upgrades;
  try {
    const tables = template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'");
    const indexes = template.all("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
    // Tables added after the first PostgreSQL release are created by versioned upgrade steps, the
    // same way for new and existing databases.
    const later = [...VIDEO_TABLES, ...FORMS_V5_TABLES];
    schema = postgresSchema(tables.filter(table => !later.includes(table.name)), indexes.filter(index => !later.includes(index.tbl_name)));
    upgrades = [{ name: 'postgres_v4_meet_video', statements: postgresUpgrade(tables.filter(table => VIDEO_TABLES.includes(table.name)), indexes.filter(index => VIDEO_TABLES.includes(index.tbl_name)), [
      "CREATE FUNCTION credit_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credit_ledger_immutable'; END $$",
      'CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION credit_ledger_immutable()'
    ]) }, { name: 'postgres_v5_forms_reliability', statements: [...FORMS_V5_COLUMNS,
      ...postgresUpgrade(tables.filter(table => FORMS_V5_TABLES.includes(table.name)), indexes.filter(index => FORMS_V5_TABLES.includes(index.tbl_name)))] }];
  } finally { template.close(); }
  const { port1, port2 } = new MessageChannel();
  const state = new SharedArrayBuffer(4);
  const signal = new Int32Array(state);
  const worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), { workerData: { port: port2, state, connectionString, ca, schemaName, upgrades }, transferList: [port2], execArgv: [] });
  worker.unref();
  worker.on('error', () => {});
  let closed = false;
  function call(request) {
    if (closed) throw new Error('PostgreSQL connection is closed.');
    Atomics.store(signal, 0, 0);
    port1.postMessage(request);
    if (Atomics.wait(signal, 0, 0, 45000) === 'timed-out') {
      closed = true; worker.terminate(); port1.close();
      throw new Error('PostgreSQL request timed out; connection closed. Check the database before retrying writes.');
    }
    const response = receiveMessageOnPort(port1)?.message;
    if (!response) throw new Error('PostgreSQL worker returned no response.');
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  try { call({ operation: 'init', schema }); }
  catch (error) { closed = true; worker.terminate(); port1.close(); throw error; }
  let depth = 0;
  const query = (sql, params = []) => call({ operation: 'query', sql, params });
  return {
    dialect: 'postgres',
    get: (sql, ...params) => query(sql, params).rows[0],
    all: (sql, ...params) => query(sql, params).rows,
    run: (sql, ...params) => ({ changes: query(sql, params).changes }),
    exec: sql => query(sql),
    transaction(fn) {
      const previousDepth = depth;
      const savepoint = 'sp' + previousDepth;
      query(previousDepth === 0 ? 'BEGIN' : 'SAVEPOINT ' + savepoint);
      depth = previousDepth + 1;
      try {
        if (previousDepth === 0) query('SELECT pg_advisory_xact_lock(724516, 2)');
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('Database transaction callbacks must be synchronous.');
        query(previousDepth === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        try {
          if (previousDepth === 0) query('ROLLBACK');
          else { query('ROLLBACK TO SAVEPOINT ' + savepoint); query('RELEASE SAVEPOINT ' + savepoint); }
        } catch {}
        throw error;
      } finally { depth = previousDepth; }
    },
    close() { if (!closed) { try { call({ operation: 'close' }); } finally { closed = true; worker.terminate(); port1.close(); } } }
  };
}
