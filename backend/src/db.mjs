import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const migrationsDir = new URL('../migrations/', import.meta.url);

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return wrap(db);
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(row => row.name));
  for (const name of readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(new URL(name, migrationsDir), 'utf8');
    // Table rebuilds follow SQLite's procedure: enforcement off (so dropping a parent table does not
    // cascade), then a foreign key check before commit. The pragma only works outside a transaction.
    const rebuild = sql.includes('-- migrate: foreign_keys_off');
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      if (rebuild) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error('foreign key violations: ' + JSON.stringify(violations.slice(0, 3)));
      }
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`);
    } finally {
      if (rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// Thin helper around node:sqlite with cached statements and nestable transactions.
function wrap(db) {
  const cache = new Map();
  let depth = 0;
  const statement = sql => {
    let prepared = cache.get(sql);
    if (!prepared) { prepared = db.prepare(sql); cache.set(sql, prepared); }
    return prepared;
  };
  return {
    raw: db,
    get: (sql, ...params) => statement(sql).get(...params),
    all: (sql, ...params) => statement(sql).all(...params),
    run: (sql, ...params) => statement(sql).run(...params),
    exec: sql => db.exec(sql),
    // BEGIN IMMEDIATE takes the write lock up front, so check-then-insert sequences are atomic
    // across connections and processes, not only within this event loop.
    transaction(fn) {
      const savepoint = 'sp' + depth;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + savepoint);
      depth++;
      try {
        const result = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : 'RELEASE ' + savepoint);
        return result;
      } catch (error) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint);
        throw error;
      }
    },
    close: () => db.close()
  };
}
