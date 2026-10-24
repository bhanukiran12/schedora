import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { postgresSchema } from './postgres-sql.mjs';
import { openDatabase } from './db.mjs';

export function openPostgres(connectionString, { ca, schemaName = 'schedora' } = {}) {
  if (!/^schedora(?:_test_[a-z0-9]+)?$/.test(schemaName)) throw new Error('Invalid Schedora database schema.');
  const template = openDatabase(':memory:');
  let schema;
  try {
    schema = postgresSchema(template.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'"), template.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"));
  } finally { template.close(); }
  const { port1, port2 } = new MessageChannel();
  const state = new SharedArrayBuffer(4);
  const signal = new Int32Array(state);
  const worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), { workerData: { port: port2, state, connectionString, ca, schemaName }, transferList: [port2], execArgv: [] });
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
