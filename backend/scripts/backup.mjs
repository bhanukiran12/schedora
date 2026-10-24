// Creates a consistent online snapshot with VACUUM INTO and verifies it.
// Usage: npm run backup [-- <database> <backup-directory>]
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';

export function backup(source, directory) {
  mkdirSync(directory, { recursive: true });
  const target = resolve(join(directory, `schedora-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
  const db = new DatabaseSync(source);
  db.prepare('VACUUM INTO ?').run(target);
  db.close();
  const copy = new DatabaseSync(target, { readOnly: true });
  const check = copy.prepare('PRAGMA integrity_check').get();
  copy.close();
  if (Object.values(check)[0] !== 'ok') throw new Error('Backup integrity check failed: ' + JSON.stringify(check));
  return target;
}

if (process.argv[1]?.endsWith('backup.mjs')) {
  if (loadConfig().databaseUrl && !process.argv[2]) throw new Error('PostgreSQL is configured. Use pg_dump for the schedora schema; SQLite backup is not a PostgreSQL backup.');
  const source = process.argv[2] || loadConfig().databasePath;
  console.log('Backup written and verified: ' + backup(source, process.argv[3] || './backups'));
}
