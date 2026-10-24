// Applies pending migrations to DATABASE_PATH (also done automatically at server start).
import { openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { openPostgres } from '../src/postgres.mjs';

const config = loadConfig();
const path = process.argv[2] || config.databasePath;
const db = config.databaseUrl && !process.argv[2] ? openPostgres(config.databaseUrl, { ca: config.databaseCa }) : openDatabase(path);
console.log(db.all('SELECT name, applied_at FROM schema_migrations ORDER BY name').map(row => `${row.name} applied ${new Date(row.applied_at).toISOString()}`).join('\n'));
db.close();
