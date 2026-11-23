// Flow v1 migration and rollback rehearsal (docs/FLOW_V1_STAGING_RELEASE.md, "Rehearsal evidence").
//
// Builds a database at the previous schema (SQLite migrations up to 036, PostgreSQL upgrades up to v32)
// holding realistic legacy data made by the real application: tenants, bookings, form responses,
// single-action workflows, historical/failed/retrying/stale runs, scheduled reminders and undispatched
// events. It then applies SQLite 037 / PostgreSQL v33 and checks row counts, foreign keys, indexes,
// repeated starts, concurrent workers in separate processes, crash and restart recovery, backup and
// verified restore, and both rollback routes. Fake email provider; nothing is sent.
//
//   node scripts/flow-migration-rehearsal.mjs                 SQLite only
//   node scripts/flow-migration-rehearsal.mjs --postgres      also PostgreSQL: REHEARSAL_DATABASE_URL
//        (+ REHEARSAL_DATABASE_CA_FILE, REHEARSAL_PG_CONTAINER for pg_dump/pg_restore). Local hosts only.
//   --pg-from <n>   start PostgreSQL at upgrade v<n> instead of v32. The shared database is at v23, so
//                   use --pg-from 23 to rehearse v24–v33 applied together on one start.
//
// Output and disposable databases go to backend/backups/flow-rehearsal-<time>/ (git- and Docker-ignored).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const backend = fileURLToPath(new URL('..', import.meta.url));
const MINUTE = 60000;
const PASSWORD = 'a sufficiently long password';

// ---- Worker child: one separate process running the real worker against a database --------------------
if (process.argv[2] === '--worker') {
  const [, , , kind, target, schema, now, ticks, hang] = process.argv;
  const { createApp } = await import('../src/app.mjs');
  const sent = [];
  let db;
  if (kind === 'sqlite') db = (await import('../src/db.mjs')).openDatabase(target);
  else db = (await import('../src/postgres.mjs')).openPostgres(target, { ca: process.env.REHEARSAL_DATABASE_CA || undefined, schemaName: schema });
  const app = createApp({
    db, databasePath: ':memory:', now: () => Number(now), log: () => {},
    emailProvider: { name: 'fake', async send(message) { if (hang && message.subject.includes(hang)) { process.stdout.write('HANGING\n'); await new Promise(() => {}); } sent.push(message.subject); return { id: 'msg-' + randomUUID() }; } },
    configOverrides: { billingMode: 'open', billingProvider: 'test', baseUrl: 'http://localhost:3000' }
  });
  for (let index = 0; index < Number(ticks); index++) await app.worker.tick();
  process.stdout.write('SENT ' + JSON.stringify(sent) + '\n');
  app.worker.stop();
  db.close();
  process.exit(0);
}

const { setup, signUp, publishedEventType, idem, START } = await import('../test/helpers.mjs');
const { openDatabase } = await import('../src/db.mjs');
const { backup } = await import('./backup.mjs');
const { restore } = await import('./restore.mjs');
const { prepareRollback, restoreRollback } = await import('./flow-rollback.mjs');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const work = join(backend, 'backups', `flow-rehearsal-${stamp}`);
mkdirSync(work, { recursive: true });
const checks = [];
const notes = [];
function check(area, name, ok, detail = '') {
  checks.push({ area, name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok ? '✓' : '✗'} [${area}] ${name}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

// ---- Previous-schema helpers ------------------------------------------------------------------------------

const MIGRATIONS = join(backend, 'migrations');
const previousMigrations = readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql') && name < '037').sort();

function migrateFrom(db, names) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const name of names) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    const rebuild = sql.includes('-- migrate: foreign_keys_off');
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    db.exec('COMMIT');
    if (rebuild) db.exec('PRAGMA foreign_keys = ON');
  }
}

const userTables = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
function sqliteCounts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(userTables(db).filter(name => name !== 'schema_migrations').map(name => [name, db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count])); }
  finally { db.close(); }
}
function sqliteOne(path, sql, ...params) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

// ---- 1. Realistic legacy data, made by the real application -------------------------------------------

async function generate(path) {
  const db = openDatabase(path);
  const env = await setup({ db });
  const owner = env.client();
  const { ws, email: ownerEmail } = await signUp(owner, 'Rehearsal Owner');
  const other = env.client();
  const { ws: ws2, email: otherEmail } = await signUp(other, 'Second Tenant');
  const type = await publishedEventType(owner, ws, { timezone: 'UTC' });
  const type2 = await publishedEventType(other, ws2, { timezone: 'UTC' });
  const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, { title: 'Contact' })).body;
  await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
  const legacy = async (http, wsId, body) => { const response = await http.post(`/api/workspaces/${wsId}/flows`, body); if (response.status !== 201) throw new Error('legacy flow: ' + JSON.stringify(response.body)); return response.body; };
  const flows = {
    prep: await legacy(owner, ws.id, { name: 'Prep task', trigger_type: 'meet.booking.created', trigger_source: type.id, action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}}', details: 'Ref {{booking.reference}}' }, status: 'enabled' }),
    reply: await legacy(owner, ws.id, { name: 'Reply email', trigger_type: 'forms.response.created', trigger_source: form.id, action_type: 'email', action_config: { to: 'field:email', subject: 'Got it, {{answer.name}}', body: 'Topic: {{answer.topic}}' }, status: 'enabled' }),
    held: await legacy(owner, ws.id, { name: 'Held task', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Held {{invitee.email}}' }, status: 'paused' }),
    draft: await legacy(owner, ws.id, { name: 'Draft task', trigger_type: 'meet.booking.canceled', action_type: 'task', action_config: { title: 'Draft' } }),
    other: await legacy(other, ws2.id, { name: 'Other tenant task', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Tenant two {{invitee.name}}' }, status: 'enabled' })
  };
  const slots = (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body.slots;
  const slots2 = (await env.client().get(`/api/public/meet/${ws2.slug}/${type2.slug}/slots`)).body.slots;
  const book = (index, name) => env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name, email: `${name.toLowerCase()}@example.com`, timezone: 'UTC', start: slots[index] }, idem());
  const respond = name => env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name, email: `${name.toLowerCase()}@example.com`, topic: 'support' } });
  for (let index = 0; index < 8; index++) await book(index, 'Guest' + index);
  await env.client().post(`/api/public/meet/${ws2.slug}/${type2.slug}/bookings`, { name: 'Tenant', email: 'tenant@example.com', timezone: 'UTC', start: slots2[0] }, idem());
  for (let index = 0; index < 6; index++) await respond('Reply' + index);
  for (let tick = 0; tick < 3; tick++) await env.app.worker.tick();
  // Retrying and failed runs.
  env.emailProvider.mode = 'transient';
  await respond('Retry0'); await respond('Retry1');
  await env.app.worker.tick();
  env.emailProvider.mode = 'permanent';
  await respond('Rejected');
  await env.app.worker.tick();
  env.emailProvider.mode = 'ok';
  // A run interrupted mid-execution, and events not yet dispatched.
  const stale = env.app.db.get("SELECT id FROM flow_runs WHERE status = 'retrying' ORDER BY id LIMIT 1");
  env.app.db.run("UPDATE flow_runs SET status = 'running', updated_at = ? WHERE id = ?", env.clock.now - 10 * MINUTE, stale.id);
  env.clock.now += MINUTE;
  await book(8, 'Pending0'); await book(9, 'Pending1'); await respond('Pending2');
  const end = env.clock.now;
  await env.close();
  db.close();
  return { ws, ws2, type, type2, form, flows, ownerEmail, otherEmail, slots, staleRun: stale.id, end };
}

// Copies every column the previous schema has, table by table, from the generated database.
function derivePrevious(previousPath, generatedPath) {
  const db = new DatabaseSync(previousPath);
  db.exec('PRAGMA foreign_keys = ON');
  migrateFrom(db, previousMigrations);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`ATTACH DATABASE '${generatedPath.replaceAll("'", "''")}' AS gen`);
  db.exec('BEGIN');
  for (const name of userTables(db).filter(item => item !== 'schema_migrations')) {
    const previous = db.prepare(`PRAGMA main.table_info("${name}")`).all().map(column => column.name);
    const generated = new Set(db.prepare(`PRAGMA gen.table_info("${name}")`).all().map(column => column.name));
    const columns = previous.filter(column => generated.has(column)).map(column => `"${column}"`).join(', ');
    if (columns) db.exec(`INSERT INTO main."${name}" (${columns}) SELECT ${columns} FROM gen."${name}"`);
  }
  db.exec('COMMIT');
  db.exec('DETACH DATABASE gen');
  db.exec('PRAGMA foreign_keys = ON');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
  db.close();
  return { violations, integrity };
}

// ---- Separate worker processes ---------------------------------------------------------------------------

function worker(kind, target, schema, now, ticks, hang = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--worker', kind, target, schema || '-', String(now), String(ticks), hang], { cwd: backend, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; if (hang && out.includes('HANGING')) { child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => {
      const line = out.split('\n').find(item => item.startsWith('SENT '));
      if (hang) return resolve({ killed: out.includes('HANGING'), sent: line ? JSON.parse(line.slice(5)) : [] });
      if (code !== 0) return reject(new Error('worker failed: ' + err.slice(-800)));
      resolve({ sent: JSON.parse(line.slice(5)) });
    });
  });
}

// ---- Application behaviour on a migrated database -------------------------------------------------------

async function login(env, email) {
  const http = env.client();
  const response = await http.post('/api/auth/login', { email, password: PASSWORD });
  if (response.status !== 200) throw new Error('login failed: ' + JSON.stringify(response.body));
  return http;
}

async function v1Flow(http, wsId, name, definition) {
  const created = await http.post(`/api/workspaces/${wsId}/flow/workflows`, { name, definition });
  if (created.status !== 201) throw new Error(`${name}: ${JSON.stringify(created.body)}`);
  const published = await http.post(`/api/workspaces/${wsId}/flow/workflows/${created.body.id}/publish`, { revision: created.body.draft_revision });
  if (published.status !== 200) throw new Error(`${name} publish: ${JSON.stringify(published.body)}`);
  const on = await http.post(`/api/workspaces/${wsId}/flow/workflows/${created.body.id}/status`, { status: 'enabled' });
  if (on.status !== 200) throw new Error(`${name} on: ${JSON.stringify(on.body)}`);
  return on.body;
}
const task = (id, title) => ({ id, type: 'action', action: 'create_task', config: { title } });
const mail = (id, subject) => ({ id, type: 'action', action: 'send_email', config: { to: 'contact', subject, body: 'Hello {{contact.name}}' } });

async function behaviour(area, db, world, { kind, target, schema, counts }) {
  const env = await setup({ db });
  env.clock.now = world.end + 24 * 60 * MINUTE;
  try {
    const owner = await login(env, world.ownerEmail);
    for (let tick = 0; tick < 3; tick++) await env.app.worker.tick();
    const legacyRuns = db.all('SELECT flow_id, status, version FROM flow_runs');
    check(area, 'undispatched events were dispatched once by the new release', Number(db.get('SELECT COUNT(*) AS count FROM outbox WHERE dispatched_at IS NULL').count) === 0);
    check(area, 'legacy runs stay legacy (version NULL) and no Flow v1 run was created from them', legacyRuns.every(run => run.version == null));
    check(area, 'retrying and interrupted legacy runs completed after the upgrade', db.get('SELECT status FROM flow_runs WHERE id = ?', world.staleRun).status === 'succeeded' && !legacyRuns.some(run => run.status === 'retrying' || run.status === 'running'), JSON.stringify(db.all('SELECT status, COUNT(*) AS count FROM flow_runs GROUP BY status')));
    check(area, 'paused legacy workflow still holds its runs', legacyRuns.filter(run => run.flow_id === world.flows.held.id).every(run => run.status === 'queued'));
    check(area, 'one legacy run per (workflow, event): no duplicates', Number(db.get('SELECT COUNT(*) AS count FROM (SELECT flow_id, event_id FROM flow_runs GROUP BY flow_id, event_id HAVING COUNT(*) > 1) d').count) === 0);
    check(area, 'tenant isolation: the second tenant’s workflow ran only on its own booking', Number(db.get('SELECT COUNT(*) AS count FROM flow_runs WHERE flow_id = ?', world.flows.other.id).count) === 1
      && Number(db.get('SELECT COUNT(*) AS count FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE r.workspace_id <> f.workspace_id').count) === 0);
    check(area, 'one task per succeeded legacy task run', Number(db.get("SELECT COUNT(*) AS count FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE f.action_type = 'task' AND r.status = 'succeeded'").count) === Number(db.get('SELECT COUNT(*) AS count FROM tasks WHERE source_run_id IS NOT NULL').count));
    const remindersBefore = counts.emails;
    check(area, 'scheduled booking emails from the previous release were kept', Number(db.get('SELECT COUNT(*) AS count FROM emails').count) >= remindersBefore);

    // Flow v1 on the migrated data: wait, approval, a schedule, many runs for concurrent workers.
    const waitFlow = await v1Flow(owner, world.ws.id, 'Wait then email', { trigger: { type: 'meet.booking.created', source: world.type.id }, steps: [task('t', 'V1 prep {{contact.name}}'), { id: 'w', type: 'wait', mode: 'duration', minutes: 1440 }, mail('m', 'Day after {{contact.name}}')] });
    const approvalFlow = await v1Flow(owner, world.ws.id, 'Approve reply', { trigger: { type: 'forms.response.created', source: world.form.id }, steps: [{ id: 'a', type: 'approval', approver: 'admins', expires_hours: 336, title: 'Reply to {{contact.name}}' }, mail('m', 'Approved reply {{contact.name}}')] });
    const scheduleFlow = await v1Flow(owner, world.ws.id, 'Daily review', { trigger: { type: 'schedule', config: { every: 'day', time: '09:00', timezone: 'UTC' } }, steps: [task('t', 'Daily review')] });
    const slots = (await env.client().get(`/api/public/meet/${world.ws.slug}/${world.type.slug}/slots`)).body.slots;
    const booked = await env.client().post(`/api/public/meet/${world.ws.slug}/${world.type.slug}/bookings`, { name: 'Wanda', email: 'wanda@example.com', timezone: 'UTC', start: slots[slots.length - 1] }, idem());
    if (booked.status !== 201) throw new Error('booking: ' + JSON.stringify(booked.body));
    const avery = await env.client().post(`/api/public/forms/${world.form.slug}/responses`, { answers: { name: 'Avery', email: 'avery@example.com', topic: 'support' } });
    for (let tick = 0; tick < 3; tick++) await env.app.worker.tick();
    const runOf = flowId => db.all('SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY created_at, id', flowId);
    const averyRun = () => db.get("SELECT * FROM flow_runs WHERE flow_id = ? AND subject_id IN (SELECT id FROM responses WHERE answers LIKE '%avery@%')", approvalFlow.id);
    check(area, 'Flow v1 wait run is waiting with a persisted timer', runOf(waitFlow.id)[0]?.status === 'waiting');
    check(area, 'Flow v1 approval run is waiting for a person', averyRun()?.status === 'needs_approval', averyRun()?.status || JSON.stringify({ response: avery.status, body: avery.body, events: db.all('SELECT type, dispatched_at FROM outbox ORDER BY created_at DESC LIMIT 3'), flow: db.get('SELECT status, trigger_type, trigger_source, published_version FROM flows WHERE id = ?', approvalFlow.id) }));

    // Concurrent workers in two separate processes on many runs.
    const concurrent = await v1Flow(owner, world.ws.id, 'Concurrent mail', { trigger: { type: 'forms.response.created', source: world.form.id }, steps: [mail('m', 'Concurrent {{contact.name}}')] });
    const statuses = [];
    for (let index = 0; index < 24; index++) statuses.push((await env.client().post(`/api/public/forms/${world.form.slug}/responses`, { answers: { name: 'Many' + index, email: `many${index}@example.com`, topic: 'support' } })).status);
    if (statuses.some(status => status !== 201)) throw new Error('responses: ' + JSON.stringify(statuses));
    // Nothing has been dispatched yet: both processes race from the outbox onwards.
    await env.close();
    const [first, second] = await Promise.all([worker(kind, target, schema, env.clock.now, 8), worker(kind, target, schema, env.clock.now, 8)]);
    const subjects = [...first.sent, ...second.sent].filter(subject => subject.startsWith('Concurrent'));
    const unique = new Set(subjects);
    check(area, 'two worker processes: each of 24 messages sent exactly once', subjects.length === 24 && unique.size === 24, `process A sent ${first.sent.length}, process B sent ${second.sent.length}`);
    check(area, 'two worker processes: every concurrent run finished once', runOf(concurrent.id).length === 24 && runOf(concurrent.id).every(run => run.status === 'succeeded'));

    // Crash: a worker process is killed while its email provider call is in flight.
    const env2 = await setup({ db });
    env2.clock.now = env.clock.now + MINUTE;
    const owner2 = await login(env2, world.ownerEmail);
    const crashFlow = await v1Flow(owner2, world.ws.id, 'Crash probe', { trigger: { type: 'forms.response.created', source: world.form.id }, steps: [mail('m', 'Crash probe {{contact.name}}')] });
    await env2.client().post(`/api/public/forms/${world.form.slug}/responses`, { answers: { name: 'Crash', email: 'crash@example.com', topic: 'support' } });
    await env2.close();
    const crashed = await worker(kind, target, schema, env2.clock.now, 1, 'Crash probe Crash');
    const crashRun = runOf(crashFlow.id)[0];
    void owner2;
    check(area, 'killed worker left its run leased and its step in flight', crashed.killed && crashRun?.status === 'running', crashRun?.status);

    // Restart: new application instances after the lease expires and after the wait is due.
    const env3 = await setup({ db });
    env3.clock.now = env2.clock.now + 3 * MINUTE;
    try {
      const owner3 = await login(env3, world.ownerEmail);
      await env3.app.worker.tick();
      const after = db.get('SELECT status, reason FROM flow_runs WHERE id = ?', crashRun.id);
      const step = db.get("SELECT status FROM flow_run_steps WHERE run_id = ? AND step_id = 'm'", crashRun.id);
      check(area, 'restart: the in-flight email became uncertain and was not resent', step?.status === 'uncertain' && !env3.sent.some(message => message.subject.startsWith('Crash probe')), `run ${after.status}, step ${step?.status}`);
      check(area, 'restart: the wait and approval survived', runOf(waitFlow.id)[0].status === 'waiting' && averyRun().status === 'needs_approval');
      const approval = (await owner3.get(`/api/workspaces/${world.ws.id}/flow/approvals`)).body.find(item => item.run_id === averyRun().id);
      const decided = await owner3.post(`/api/workspaces/${world.ws.id}/flow/approvals/${approval.id}`, { decision: 'approve', revision: approval.revision });
      const again = await owner3.post(`/api/workspaces/${world.ws.id}/flow/approvals/${approval.id}`, { decision: 'approve', revision: approval.revision });
      env3.clock.now += 24 * 60 * MINUTE + MINUTE;
      for (let tick = 0; tick < 3; tick++) await env3.app.worker.tick();
      check(area, 'restart: approval decided once after restart; email sent once', decided.status === 200 && again.status === 409 && env3.sent.filter(message => message.subject === 'Approved reply Avery').length === 1, `first ${decided.status}, second ${again.status}, sent ${JSON.stringify(env3.sent.map(message => message.subject))}, run ${db.get('SELECT status, reason FROM flow_runs WHERE id = ?', approval.run_id).status}`);
      check(area, 'restart: the wait resumed when due and sent once', runOf(waitFlow.id)[0].status === 'succeeded' && env3.sent.filter(message => message.subject === 'Day after Wanda').length === 1);
      check(area, 'schedule started one run for the passed slot', runOf(scheduleFlow.id).length >= 1, `${runOf(scheduleFlow.id).length} run(s)`);
    } finally { await env3.close(); }
    return { waitFlow, approvalFlow, scheduleFlow, crashFlow, concurrent };
  } catch (error) { try { await env.close(); } catch { /* closed */ } throw error; }
}

// ---- Rollback -------------------------------------------------------------------------------------------

async function legacyService() {
  // A rehearsal must keep testing the deployed dispatcher after the release is committed.
  const revision = process.env.FLOW_REHEARSAL_LEGACY_REF || '989cda5fc7972a6a907e97b4936faf30aa6327b6';
  const source = execFileSync('git', ['show', `${revision}:backend/src/flow/service.mjs`], { cwd: backend, encoding: 'utf8' });
  const dir = join(work, 'legacy');
  mkdirSync(dir, { recursive: true });
  const src = pathToFileURL(join(backend, 'src') + '/').href;
  writeFileSync(join(dir, 'service.mjs'), source.replace(/from '\.\.\//g, `from '${src}`));
  return import(pathToFileURL(join(dir, 'service.mjs')).href);
}

async function rollbackRehearsal(area, path, world, flows, existing = null) {
  const legacy = await legacyService();
  if (!existing) notes.push(`Previous-release dispatcher: ${process.env.FLOW_REHEARSAL_LEGACY_REF || '989cda5fc7972a6a907e97b4936faf30aa6327b6'} backend/src/flow/service.mjs, run against the migrated database with current helper modules.`);
  // Negative control: the previous release without preparation, on a copy (SQLite only; the SQL is shared).
  if (path) {
    const control = path.replace(/\.db$/, '-control.db');
    copyFileSync(path, control);
    const db = openDatabase(control);
    const env = await setup({ db });
    env.clock.now = world.end + 4 * 24 * 60 * MINUTE;
    try {
      const before = Number(db.get('SELECT COUNT(*) AS count FROM flow_runs WHERE flow_id = ?', flows.waitFlow.id).count);
      const slots = (await env.client().get(`/api/public/meet/${world.ws.slug}/${world.type.slug}/slots`)).body.slots;
      await env.client().post(`/api/public/meet/${world.ws.slug}/${world.type.slug}/bookings`, { name: 'Control', email: 'control@example.com', timezone: 'UTC', start: slots[slots.length - 2] }, idem());
      legacy.dispatchOutbox(env.app);
      await legacy.processDueRuns(env.app);
      const bogus = db.all('SELECT status, last_error, version FROM flow_runs WHERE flow_id = ?', flows.waitFlow.id).slice(before);
      check(area, 'control: without preparation the previous release starts its own runs on Flow v1 workflows', bogus.length > 0 && bogus.every(run => run.version == null), JSON.stringify(bogus.map(run => [run.status, run.last_error])));
    } finally { await env.close(); db.close(); }
  }
  // Prepared rollback.
  const db = existing || openDatabase(path);
  const now = world.end + 4 * 24 * 60 * MINUTE;
  const pendingBefore = db.all("SELECT id, status, next_attempt_at FROM flow_runs WHERE version IS NOT NULL AND status IN ('queued', 'retrying', 'waiting', 'needs_approval') ORDER BY id");
  const state = prepareRollback(db, now);
  writeFileSync(join(work, `${area}-rollback-state.json`), JSON.stringify(state, null, 2));
  check(area, 'prepare: Flow v1 workflows that were on or paused are now drafts', state.switched_to_draft === state.flows.filter(flow => ['enabled', 'paused'].includes(flow.status)).length && state.switched_to_draft > 0, `${state.switched_to_draft} switched`);
  const env = await setup({ db });
  env.clock.now = now;
  try {
    await login(env, world.ownerEmail);
    const slots = (await env.client().get(`/api/public/meet/${world.ws.slug}/${world.type.slug}/slots`)).body.slots;
    await env.client().post(`/api/public/meet/${world.ws.slug}/${world.type.slug}/bookings`, { name: 'During', email: 'during@example.com', timezone: 'UTC', start: slots[slots.length - 3] }, idem());
    await env.client().post(`/api/public/forms/${world.form.slug}/responses`, { answers: { name: 'DuringForm', email: 'duringform@example.com', topic: 'support' } });
    const v1Before = Number(db.get('SELECT COUNT(*) AS count FROM flow_runs WHERE version IS NOT NULL').count);
    const v1RunsBefore = db.all('SELECT id, status, updated_at FROM flow_runs WHERE version IS NOT NULL ORDER BY id');
    for (let pass = 0; pass < 3; pass++) { legacy.dispatchOutbox(env.app); await legacy.processDueRuns(env.app); env.clock.now += 6 * MINUTE; }
    const onV1 = Number(db.get("SELECT COUNT(*) AS count FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE f.action_type = 'steps'").count);
    check(area, 'previous release ignores prepared Flow v1 workflows (no runs started on them)', onV1 === v1Before);
    check(area, 'previous release left every Flow v1 run untouched', JSON.stringify(db.all('SELECT id, status, updated_at FROM flow_runs WHERE version IS NOT NULL ORDER BY id')) === JSON.stringify(v1RunsBefore));
    const legacyTask = db.get("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Prepare for During'");
    check(area, 'previous release keeps running legacy workflows on new events', Number(legacyTask.count) === 1);
    const listed = legacy.listFlows(env.app, world.ws.id);
    check(area, 'previous release lists every workflow, including Flow v1 drafts', listed.length === Number(db.get('SELECT COUNT(*) AS count FROM flows WHERE workspace_id = ?', world.ws.id).count));
    const made = legacy.createFlow(env.app, world.ws.id, { name: 'Made during rollback', trigger_type: 'meet.booking.canceled', action_type: 'task', action_config: { title: 'x' } });
    check(area, 'previous release can still create single-action workflows on the migrated schema', Boolean(made.id));

  } finally { await env.close(); }
  // Roll forward.
  const forward = await setup({ db });
  forward.clock.now = now + 2 * 24 * 60 * MINUTE;
  try {
    const result = restoreRollback(db, state, forward.clock.now);
    check(area, 'restore: recorded statuses are back', result.restored.length === state.switched_to_draft && result.skipped.length === 0, `${result.restored.length} restored`);
    const scheduleRunsBefore = Number(db.get('SELECT COUNT(*) AS count FROM flow_runs WHERE flow_id = ?', flows.scheduleFlow.id).count);
    for (let tick = 0; tick < 3; tick++) await forward.app.worker.tick();
    const { scanTimedTriggers } = await import('../src/flow/engine.mjs');
    scanTimedTriggers(forward.app, { force: true });
    check(area, 'restore: schedule slots missed during the rollback are not caught up', Number(db.get('SELECT COUNT(*) AS count FROM flow_runs WHERE flow_id = ?', flows.scheduleFlow.id).count) === scheduleRunsBefore);
    const duringRuns = Number(db.get("SELECT COUNT(*) AS count FROM flow_runs WHERE flow_id = ? AND subject_id IN (SELECT id FROM bookings WHERE invitee_email = 'during@example.com')", flows.waitFlow.id).count);
    check(area, 'restore: events that happened during the rollback do not start Flow v1 runs afterwards (documented gap)', duringRuns === 0);
    const pendingAfter = db.all('SELECT id, status FROM flow_runs WHERE id IN (' + pendingBefore.map(() => '?').join(',') + ')', ...pendingBefore.map(run => run.id));
    check(area, 'restore: runs pending before the rollback continue', pendingBefore.length === 0 || pendingAfter.every(run => !['running'].includes(run.status)), JSON.stringify(pendingAfter.map(run => run.status)));
  } finally { await forward.close(); if (!existing) db.close(); }
}

// ---- PostgreSQL --------------------------------------------------------------------------------------------

const pgFromAt = process.argv.indexOf('--pg-from');
const PG_FROM = pgFromAt > 0 ? Number(process.argv[pgFromAt + 1]) : 32;
if (!Number.isInteger(PG_FROM) || PG_FROM < 23 || PG_FROM > 32) throw new Error('--pg-from must be a version from 23 to 32.');
// From v23 on, PostgreSQL upgrade vN matches SQLite migration N + 4 (v23 = 027_workbook_trash, v33 = 037_flow_v1).
// postgres_v1 builds its tables from the SQLite migrations it can see, so the previous module must see only those.
const pgMigrations = previousMigrations.filter(name => Number(name.slice(0, 3)) <= PG_FROM + 4);
const pgVersion = name => Number(/^postgres_v(\d+)/.exec(name)?.[1] || 0);

function previousPostgresModule() {
  const dir = join(work, 'prev-pg');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  for (const name of pgMigrations) copyFileSync(join(MIGRATIONS, name), join(dir, 'migrations', name));
  for (const name of readdirSync(join(backend, 'src')).filter(file => /^(db|postgres|postgres-worker|postgres-sql)\.mjs$/.test(file))) copyFileSync(join(backend, 'src', name), join(dir, 'src', name));
  let source = readFileSync(join(dir, 'src', 'postgres.mjs'), 'utf8').replace(/\r\n/g, '\n');
  // The previous release knows upgrades up to v<PG_FROM> only.
  const handoff = 'workerData: { port: port2, state, connectionString, ca, schemaName, upgrades }';
  if (!source.includes(handoff)) throw new Error('upgrade hand-off not found in postgres.mjs');
  source = source.replace(handoff, 'workerData: { port: port2, state, connectionString, ca, schemaName, upgrades: upgrades.filter(upgrade => Number(/^postgres_v(\\d+)/.exec(upgrade.name)?.[1] || 0) <= ' + PG_FROM + ') }');
  // Other imports resolve to the current modules.
  const src = pathToFileURL(join(backend, 'src') + '/').href;
  source = source.replace(/from '\.\/(?!db\.mjs|postgres-worker|postgres-sql)([^']+)'/g, `from '${src}$1'`);
  writeFileSync(join(dir, 'src', 'postgres.mjs'), source);
  return import(pathToFileURL(join(dir, 'src', 'postgres.mjs')).href);
}

function pgCopy(db, generatedPath) {
  const source = new DatabaseSync(generatedPath, { readOnly: true });
  const tables = db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'").map(row => row.table_name);
  db.exec('SET session_replication_role = replica');
  try {
    for (const name of tables) {
      const columns = db.all('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', name).map(row => row.column_name);
      const generated = new Set(source.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name));
      const shared = columns.filter(column => generated.has(column));
      if (!generated.size || !shared.length) continue;
      for (const row of source.prepare(`SELECT ${shared.map(column => `"${column}"`).join(', ')} FROM "${name}"`).all()) {
        db.run(`INSERT INTO "${name}" (${shared.map(column => `"${column}"`).join(', ')}) VALUES (${shared.map(() => '?').join(', ')})`, ...shared.map(column => row[column]));
      }
    }
  } finally { db.exec('SET session_replication_role = DEFAULT'); source.close(); }
}

function pgCounts(db) {
  return Object.fromEntries(db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name")
    .map(row => [row.table_name, Number(db.get(`SELECT COUNT(*) AS count FROM "${row.table_name}"`).count)]));
}

function pgForeignKeyViolations(db) {
  const keys = db.all(`SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
      (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
      (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = current_schema()`);
  const violations = [];
  for (const key of keys) {
    const childColumns = Array.isArray(key.child_columns) ? key.child_columns : String(key.child_columns).replace(/[{}]/g, '').split(',');
    const parentColumns = Array.isArray(key.parent_columns) ? key.parent_columns : String(key.parent_columns).replace(/[{}]/g, '').split(',');
    const join = childColumns.map((column, index) => `p."${parentColumns[index]}" = c."${column}"`).join(' AND ');
    const present = childColumns.map(column => `c."${column}" IS NOT NULL`).join(' AND ');
    const count = Number(db.get(`SELECT COUNT(*) AS count FROM ${key.child} c WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${key.parent} p WHERE ${join})`).count);
    if (count) violations.push({ constraint: key.conname, count });
  }
  return { checked: keys.length, violations };
}

async function postgresRehearsal(generatedPath, world) {
  const url = process.env.REHEARSAL_DATABASE_URL;
  if (!url) throw new Error('Set REHEARSAL_DATABASE_URL to a disposable local PostgreSQL.');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Refusing: PostgreSQL rehearsals run only against a local disposable server.');
  const ca = process.env.REHEARSAL_DATABASE_CA_FILE ? readFileSync(process.env.REHEARSAL_DATABASE_CA_FILE, 'utf8') : undefined;
  process.env.REHEARSAL_DATABASE_CA = ca || '';
  const schema = 'schedora_test_rehearsal' + randomUUID().replaceAll('-', '').slice(0, 12);
  const area = 'postgres';
  const previous = await previousPostgresModule();
  const { openPostgres } = await import('../src/postgres.mjs');
  let db = previous.openPostgres(url, { ca, schemaName: schema });
  try {
    const applied = db.all('SELECT name FROM schema_migrations ORDER BY name').map(row => row.name);
    check(area, `previous schema stops at v${PG_FROM}`, Math.max(...applied.map(pgVersion)) === PG_FROM, `${applied.length} upgrades`);
    pgCopy(db, generatedPath);
    const before = pgCounts(db);
    const fkBefore = pgForeignKeyViolations(db);
    check(area, 'previous-schema data loaded with valid foreign keys', fkBefore.violations.length === 0, `${fkBefore.checked} keys, rows: flows ${before.flows}, flow_runs ${before.flow_runs}, bookings ${before.bookings}, responses ${before.responses}, emails ${before.emails}, outbox ${before.outbox}`);
    // Logical backup before the upgrade (pg_dump inside the disposable container).
    const container = process.env.REHEARSAL_PG_CONTAINER;
    const dump = join(work, `pg-before-v${PG_FROM}-upgrade.dump`);
    if (container) {
      const password = new URL(url).password;
      const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
      const output = execFileSync('docker', ['exec', '-e', `PGPASSWORD=${decodeURIComponent(password)}`, container, 'pg_dump', '-U', 'postgres', '-h', '127.0.0.1', '-d', 'postgres', '-n', schema, '-Fc'], { env, maxBuffer: 1 << 28 });
      writeFileSync(dump, output);
      check(area, 'pg_dump backup written before the upgrade', output.length > 1000, `${output.length} bytes`);
    } else notes.push('PostgreSQL backup/restore skipped: REHEARSAL_PG_CONTAINER not set.');
    db.close();
    const started = Date.now();
    db = openPostgres(url, { ca, schemaName: schema });
    const elapsed = Date.now() - started;
    const upgraded = db.all('SELECT name FROM schema_migrations ORDER BY name').map(row => row.name);
    check(area, `v${PG_FROM + 1}–v33 applied in one transaction on open`, upgraded.includes('postgres_v33_flow_v1') && upgraded.length === applied.length + (33 - PG_FROM), `${33 - PG_FROM} upgrades, ${elapsed} ms including connection`);
    const after = pgCounts(db);
    const changed = Object.keys(before).filter(name => before[name] !== after[name]);
    check(area, 'row counts unchanged in every existing table', changed.length === 0, changed.join(', '));
    const added = Object.keys(after).filter(name => !(name in before));
    const flowTables = ['flow_versions', 'flow_run_steps', 'flow_waits', 'flow_approvals', 'flow_round_robin', 'flow_inbound_hooks', 'flow_inbound_deliveries', 'flow_schedules', 'flow_provider_checks'];
    check(area, 'new Flow v1 tables created empty', flowTables.every(name => added.includes(name) && after[name] === 0), added.filter(name => flowTables.includes(name)).join(', '));
    if (PG_FROM < 32) check(area, `tables added by v${PG_FROM + 1}–v32 created`, added.length > flowTables.length, added.filter(name => !flowTables.includes(name)).map(name => `${name} ${after[name]}`).join(', '));
    const fk = pgForeignKeyViolations(db);
    check(area, 'foreign keys valid after the upgrade', fk.violations.length === 0, `${fk.checked} keys checked`);
    const indexes = db.all("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()").map(row => row.indexname);
    const expected = [...readFileSync(join(MIGRATIONS, '037_flow_v1.sql'), 'utf8').matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]);
    const missing = expected.filter(name => !indexes.includes(name));
    check(area, 'every Flow v1 index exists', missing.length === 0, missing.length ? 'missing ' + missing.join(', ') : `${expected.length} indexes`);
    const constraint = db.get("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'flow_runs_status_check' AND connamespace = current_schema()::regnamespace");
    check(area, 'run status check accepts the new states', /needs_approval/.test(constraint?.def || ''));
    check(area, 'single-action check removed so steps workflows fit', !db.get("SELECT 1 AS present FROM pg_constraint WHERE conname = 'flows_action_type_check' AND connamespace = current_schema()::regnamespace"));
    db.close();
    db = openPostgres(url, { ca, schemaName: schema });
    check(area, 'repeat start applies nothing and changes no rows', db.all('SELECT name FROM schema_migrations').length === upgraded.length && JSON.stringify(pgCounts(db)) === JSON.stringify(after));
    const flows = await behaviour(area, db, world, { kind: 'postgres', target: url, schema, counts: after });
    await rollbackRehearsal(area, null, world, flows, db);
    if (container) {
      const restored = schema.replace('rehearsal', 'restored');
      const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
      const password = decodeURIComponent(new URL(url).password);
      execFileSync('docker', ['exec', container, 'mkdir', '-p', '/tmp/rehearsal'], { env });
      execFileSync('docker', ['cp', dump, `${container}:/tmp/rehearsal/before.dump`], { env });
      // Restore into a separate schema name: pg_restore writes the original name, so rename it after.
      db.exec(`ALTER SCHEMA "${schema}" RENAME TO "${restored}"`);
      execFileSync('docker', ['exec', '-e', `PGPASSWORD=${password}`, container, 'pg_restore', '-U', 'postgres', '-h', '127.0.0.1', '-d', 'postgres', '--no-owner', '/tmp/rehearsal/before.dump'], { env });
      db.exec(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_backup"`);
      db.exec(`ALTER SCHEMA "${restored}" RENAME TO "${schema}"`);
      const restoredCounts = Object.fromEntries(Object.keys(before).map(name => [name, Number(db.get(`SELECT COUNT(*) AS count FROM "${schema}_backup"."${name}"`).count)]));
      const lost = Object.fromEntries(Object.keys(before).map(name => [name, Number(db.get(`SELECT COUNT(*) AS count FROM "${schema}"."${name}"`).count) - restoredCounts[name]]).filter(([, diff]) => diff));
      check(area, 'pg_restore of the pre-upgrade dump matches the pre-upgrade row counts exactly', JSON.stringify(restoredCounts) === JSON.stringify(before));
      const restoredMigrations = db.all(`SELECT name FROM "${schema}_backup".schema_migrations`).map(row => row.name);
      check(area, `restored backup is at the previous schema (v${PG_FROM})`, Math.max(...restoredMigrations.map(pgVersion)) === PG_FROM);
      notes.push(`PostgreSQL backup restore would discard every write after the upgrade. In this rehearsal: ${JSON.stringify(lost)}.`);
      db.exec(`DROP SCHEMA "${schema}_backup" CASCADE`);
      execFileSync('docker', ['exec', container, 'rm', '-rf', '/tmp/rehearsal'], { env });
    }
  } finally {
    try { db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* closed */ }
    try { db.close(); } catch { /* closed */ }
  }
}

// ---- Run -----------------------------------------------------------------------------------------------------

const generated = join(work, 'generated.db');
const previous = join(work, 'previous.db');
const migrated = join(work, 'migrated.db');
console.log('Rehearsal directory: ' + work);
const world = await generate(generated);
const derived = derivePrevious(previous, generated);
const area = 'sqlite';
check(area, 'previous-schema database built (migrations 001–036) with realistic data', derived.violations.length === 0 && derived.integrity === 'ok', `${previousMigrations.length} migrations`);
const before = sqliteCounts(previous);
check(area, 'previous data includes legacy workflows, historical, failed, retrying and interrupted runs, pending emails and undispatched events',
  before.flows === 5 && before.flow_runs > 10 && sqliteOne(previous, "SELECT COUNT(*) AS count FROM flow_runs WHERE status IN ('failed', 'retrying', 'running', 'queued')")[0].count >= 4
  && sqliteOne(previous, 'SELECT COUNT(*) AS count FROM outbox WHERE dispatched_at IS NULL')[0].count === 3 && sqliteOne(previous, "SELECT COUNT(*) AS count FROM emails WHERE status = 'scheduled'")[0].count > 0,
  `workspaces ${before.workspaces}, bookings ${before.bookings}, responses ${before.responses}, flows ${before.flows}, flow_runs ${before.flow_runs}, emails ${before.emails}, tasks ${before.tasks}, outbox ${before.outbox}`);
const backupFile = backup(previous, join(work, 'backups'));
check(area, 'pre-migration backup written and integrity-checked', JSON.stringify(sqliteCounts(backupFile)) === JSON.stringify(before), backupFile.replace(backend, 'backend/'));
copyFileSync(previous, migrated);
const started = Date.now();
let db = openDatabase(migrated);
const elapsed = Date.now() - started;
const applied = db.all('SELECT name FROM schema_migrations ORDER BY name').map(row => row.name);
check(area, '037 applied on start', applied.at(-1) === '037_flow_v1.sql' && applied.length === previousMigrations.length + 1, `${elapsed} ms for ${before.flow_runs} runs and ${Object.values(before).reduce((sum, count) => sum + count, 0)} rows`);
db.close();
const after = sqliteCounts(migrated);
const changed = Object.keys(before).filter(name => before[name] !== after[name]);
check(area, 'row counts unchanged in every existing table', changed.length === 0, changed.join(', '));
const added = Object.keys(after).filter(name => !(name in before));
check(area, 'new Flow v1 tables created empty', added.length === 9 && added.every(name => after[name] === 0), added.join(', '));
check(area, 'foreign_key_check clean and integrity ok', sqliteOne(migrated, 'PRAGMA foreign_key_check').length === 0 && Object.values(sqliteOne(migrated, 'PRAGMA integrity_check')[0])[0] === 'ok');
const indexes = sqliteOne(migrated, "SELECT name FROM sqlite_master WHERE type = 'index'").map(row => row.name);
const expected = [...readFileSync(join(MIGRATIONS, '037_flow_v1.sql'), 'utf8').matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]);
check(area, 'every Flow v1 index exists, and indexes on rebuilt tables were recreated', expected.every(name => indexes.includes(name)) && sqliteOne(previous, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('flows', 'flow_runs') AND sql IS NOT NULL").every(row => indexes.includes(row.name)), `${expected.length} new indexes`);
check(area, 'legacy rows keep their shape (no definition, no version)', sqliteOne(migrated, "SELECT COUNT(*) AS count FROM flows WHERE definition IS NOT NULL OR action_type NOT IN ('email', 'task')")[0].count === 0 && sqliteOne(migrated, 'SELECT COUNT(*) AS count FROM flow_runs WHERE version IS NOT NULL')[0].count === 0);
db = openDatabase(migrated);
check(area, 'repeat start applies nothing and changes no rows', db.all('SELECT name FROM schema_migrations').length === applied.length && JSON.stringify(sqliteCounts(migrated)) === JSON.stringify(after));
const flows = await behaviour(area, db, world, { kind: 'sqlite', target: migrated, counts: after });
db.close();

// Backup restore: proves recovery and measures what it discards.
const afterWrites = sqliteCounts(migrated);
const restoreTarget = join(work, 'restore-target.db');
copyFileSync(migrated, restoreTarget);
restore(backupFile, restoreTarget);
const restoredCounts = sqliteCounts(restoreTarget);
check(area, 'restore of the pre-migration backup matches its row counts exactly', JSON.stringify(restoredCounts) === JSON.stringify(before));
check(area, 'restored database is at the previous schema (036)', !sqliteOne(restoreTarget, 'SELECT name FROM schema_migrations').some(row => row.name === '037_flow_v1.sql'));
const lost = Object.fromEntries(Object.keys(afterWrites).filter(name => name in before).map(name => [name, afterWrites[name] - before[name]]).filter(([, diff]) => diff));
notes.push(`SQLite backup restore would discard every write made after the migration. In this rehearsal: ${JSON.stringify(lost)} plus all Flow v1 tables.`);
const reopened = openDatabase(restoreTarget);
check(area, 'restored database migrates forward again on the next start', reopened.get("SELECT 1 AS ok FROM schema_migrations WHERE name = '037_flow_v1.sql'")?.ok === 1);
reopened.close();

await rollbackRehearsal(area, migrated, world, flows);

if (process.argv.includes('--postgres')) await postgresRehearsal(generated, world);

const failed = checks.filter(item => !item.ok);
writeFileSync(join(work, 'report.json'), JSON.stringify({ at: new Date().toISOString(), checks, notes }, null, 2));
for (const note of notes) console.log('note: ' + note);
console.log(`\n${checks.length - failed.length} of ${checks.length} rehearsal checks passed. Report: ${join(work, 'report.json')}`);
if (!process.argv.includes('--keep')) for (const name of readdirSync(work).filter(file => file.endsWith('.db') || file.endsWith('-wal') || file.endsWith('-shm'))) rmSync(join(work, name), { force: true });
process.exit(failed.length ? 1 : 0);
