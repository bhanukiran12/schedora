// Restores a backup file into the database path. Stop the server first.
// Usage: npm run restore -- <backup-file> [database-path]
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';

export function restore(backupFile, target) {
  const check = new DatabaseSync(backupFile, { readOnly: true });
  const result = Object.values(check.prepare('PRAGMA integrity_check').get())[0];
  check.close();
  if (result !== 'ok') throw new Error('Backup failed integrity check; not restored.');
  if (existsSync(target)) renameSync(target, `${target}.before-restore-${Date.now()}`);
  for (const suffix of ['-wal', '-shm']) rmSync(target + suffix, { force: true });
  copyFileSync(backupFile, target);
  return target;
}

if (process.argv[1]?.endsWith('restore.mjs')) {
  if (loadConfig().databaseUrl) throw new Error('PostgreSQL is configured. Restore a reviewed PostgreSQL backup into an isolated database using pg_restore.');
  const [backupFile, target = loadConfig().databasePath] = process.argv.slice(2);
  if (!backupFile) { console.error('Usage: npm run restore -- <backup-file> [database-path]'); process.exit(1); }
  console.log('Restored into ' + restore(backupFile, target) + '. The previous file was kept beside it. Start the server to apply any newer migrations.');
}
