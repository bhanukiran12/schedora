// Flow v1 application rollback that keeps the migrated data (docs/FLOW_V1_STAGING_RELEASE.md, "Rollback").
//
// The previous application image can run on the migrated schema, but its single-action dispatcher would
// pick up enabled or paused Flow v1 workflows and fail their runs. Before starting the previous image,
// `prepare` records every Flow v1 workflow's status and switches on/paused ones to draft, which the
// previous image ignores. After the new image is running again, `restore` puts the recorded statuses back.
//
//   Stop the new image first (no worker may be running), then:
//   node scripts/flow-rollback.mjs prepare <state.json> [--sqlite <database-path>]
//   node scripts/flow-rollback.mjs restore <state.json> [--sqlite <database-path>]
//
// Without --sqlite it uses DATABASE_URL/DATABASE_CA from the environment (PostgreSQL). It never deletes
// workflows, runs, waits, approvals or queued messages.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const UNCERTAIN = 'The worker stopped during this call, so it may or may not have happened.';

export function prepareRollback(db, now = Date.now()) {
  const live = db.get("SELECT COUNT(*) AS count FROM flow_runs WHERE version IS NOT NULL AND status = 'running' AND lease_until >= ?", now);
  if (Number(live.count)) throw new Error('A Flow worker still holds a run lease. Stop the new application image, wait for leases to expire (2 minutes), then try again.');
  return db.transaction(() => {
    const flows = db.all("SELECT id, workspace_id, name, status, published_version FROM flows WHERE action_type = 'steps' ORDER BY created_at, id");
    // Crashed runs: resolve them the way the new worker would, before the previous image's recovery can
    // move them back to retrying. In-flight external calls become uncertain and need review.
    const crashed = db.all("SELECT id FROM flow_runs WHERE version IS NOT NULL AND status = 'running'");
    for (const run of crashed) {
      db.run("UPDATE flow_runs SET status = 'queued', lease_owner = NULL, lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", now, now, run.id);
      db.run("UPDATE flow_run_steps SET status = 'uncertain', error = ?, finished_at = ? WHERE run_id = ? AND status = 'running'", UNCERTAIN, now, run.id);
    }
    const switched = db.run("UPDATE flows SET status = 'draft', updated_at = ? WHERE action_type = 'steps' AND status IN ('enabled', 'paused')", now).changes;
    const pending = db.all("SELECT status, COUNT(*) AS count FROM flow_runs WHERE version IS NOT NULL AND status IN ('queued', 'retrying', 'waiting', 'needs_approval') GROUP BY status")
      .map(row => ({ status: row.status, count: Number(row.count) }));
    return { prepared_at: now, flows, switched_to_draft: Number(switched), crashed_runs_resolved: crashed.length, pending_runs_kept: pending };
  });
}

export function restoreRollback(db, state, now = Date.now()) {
  if (!state || !Array.isArray(state.flows)) throw new Error('This is not a Flow rollback state file.');
  return db.transaction(() => {
    const restored = [];
    const skipped = [];
    for (const flow of state.flows) {
      if (!['enabled', 'paused'].includes(flow.status)) continue;
      // Only workflows nobody changed while rolled back. enabled_at = now stops timed triggers from
      // catching up on bookings and schedule slots that passed during the rollback.
      const changed = db.run(`UPDATE flows SET status = ?, enabled_at = CASE WHEN ? = 'enabled' THEN ? ELSE enabled_at END, updated_at = ?
        WHERE id = ? AND action_type = 'steps' AND status = 'draft' AND published_version IS NOT DISTINCT FROM ?`, flow.status, flow.status, now, now, flow.id, flow.published_version ?? null).changes;
      (changed ? restored : skipped).push({ id: flow.id, name: flow.name, status: flow.status });
    }
    return { restored_at: now, restored, skipped };
  });
}

async function main() {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!['prepare', 'restore'].includes(command) || !file) {
    console.error('Usage: node scripts/flow-rollback.mjs prepare|restore <state.json> [--sqlite <database-path>]');
    process.exit(1);
  }
  const sqlite = rest[0] === '--sqlite' ? rest[1] : null;
  let db;
  if (sqlite) {
    const { openDatabase } = await import('../src/db.mjs');
    db = openDatabase(sqlite);
  } else {
    const { loadConfig } = await import('../src/config.mjs');
    const config = loadConfig();
    if (!config.databaseUrl) throw new Error('Set DATABASE_URL for PostgreSQL, or pass --sqlite <database-path>.');
    const { openPostgres } = await import('../src/postgres.mjs');
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa });
  }
  try {
    if (command === 'prepare') {
      if (existsSync(file)) throw new Error(`${file} already exists; keep it and choose a new file name.`);
      const state = prepareRollback(db);
      writeFileSync(file, JSON.stringify(state, null, 2));
      console.log(`Prepared: ${state.switched_to_draft} Flow v1 workflow(s) set to draft, ${state.crashed_runs_resolved} crashed run(s) resolved. State saved to ${file}. Pending runs kept: ${JSON.stringify(state.pending_runs_kept)}.`);
    } else {
      const result = restoreRollback(db, JSON.parse(readFileSync(file, 'utf8')));
      console.log(`Restored ${result.restored.length} workflow status(es); skipped ${result.skipped.length} that changed during the rollback.`);
      for (const flow of result.skipped) console.log(`  skipped: ${flow.name} (${flow.id})`);
    }
  } finally { db.close(); }
}

if (process.argv[1]?.endsWith('flow-rollback.mjs')) main().catch(error => { console.error(error.message); process.exit(1); });
