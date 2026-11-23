import { randomUUID } from 'node:crypto';

// Product events for Flow (docs/FLOW_V1_IMPLEMENTATION.md, "Event contracts"). Events go through the
// outbox in the same transaction as the change they describe. An `id` given here is deterministic, so
// repeating the change (marking the same no-show twice, a redelivered payment confirmation) cannot start
// a second run.
export function emitEvent(app, { id = randomUUID(), workspaceId, type, subjectId, sourceId, payload = null, origin = 'user', depth = 0 }) {
  app.db.run('INSERT OR IGNORE INTO outbox (id, workspace_id, type, subject_id, source_id, created_at, payload, origin, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, workspaceId, type, subjectId, sourceId, app.now(), payload ? JSON.stringify(payload) : null, origin, depth);
}

/** Sheet events are only worth recording when an enabled workflow watches that workbook. */
export const workbookWatched = (app, workspaceId, workbookId) => Boolean(app.db.get(
  "SELECT 1 FROM flows WHERE workspace_id = ? AND status = 'enabled' AND action_type = 'steps' AND trigger_type IN ('sheets.row.added', 'sheets.cell.changed') AND trigger_source = ?", workspaceId, workbookId));
