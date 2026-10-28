import { deliverDueEmails } from './platform/email.mjs';
import { dispatchOutbox, processDueRuns } from './flow/service.mjs';
import { syncDueCalendars } from './meet/calendar.mjs';
import { expireHolds } from './meet/bookings.mjs';
import { deliverWebhooks } from './platform/developer.mjs';
import { syncMeetingCalendars } from './platform/oauth.mjs';
import { videoTick } from './video/rooms.mjs';
import { expireLots } from './video/credits.mjs';
import { reconcileRecharges } from './video/recharge.mjs';
import { MONITOR_INTERVAL_MS, runMonitoring } from './platform/monitoring.mjs';

const DAY = 86400000;

// Applies retention rules: responses and past bookings older than the workspace retention period,
// delivered email copies after 30 days, expired sessions and old dispatched events.
export function applyRetention(app) {
  const now = app.now();
  const removed = { responses: 0, bookings: 0, emails: 0 };
  app.db.transaction(() => {
    for (const workspace of app.db.all('SELECT id, retention_days FROM workspaces')) {
      const cutoff = now - workspace.retention_days * DAY;
      removed.responses += app.db.run('DELETE FROM responses WHERE workspace_id = ? AND created_at < ?', workspace.id, cutoff).changes;
      removed.bookings += app.db.run(`UPDATE bookings SET invitee_name = 'Removed after retention period', invitee_email = 'removed@invalid', invitee_phone = NULL, notes = '', answers = '{}', guests = '[]', cancel_reason = NULL, anonymized_at = ?
        WHERE workspace_id = ? AND ends_at < ? AND anonymized_at IS NULL`, now, workspace.id, cutoff).changes;
      app.db.run('DELETE FROM flow_runs WHERE workspace_id = ? AND created_at < ? AND status IN (\'succeeded\', \'failed\')', workspace.id, cutoff);
      app.db.run('DELETE FROM transcripts WHERE workspace_id = ? AND created_at < ?', workspace.id, cutoff);
      app.db.run('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE workspace_id = ? AND created_at < ?)', workspace.id, cutoff);
      app.db.run("UPDATE video_participants SET display_name = 'Removed after retention period' WHERE workspace_id = ? AND created_at < ? AND status IN ('left', 'removed', 'expired')", workspace.id, cutoff);
    }
    removed.emails = app.db.run("DELETE FROM emails WHERE created_at < ? AND status IN ('sent', 'failed', 'canceled')", now - 30 * DAY).changes;
    app.db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    app.db.run('DELETE FROM outbox WHERE dispatched_at IS NOT NULL AND dispatched_at < ?', now - 30 * DAY);
    app.db.run("DELETE FROM webhook_deliveries WHERE status IN ('delivered', 'failed') AND created_at < ?", now - 30 * DAY);
    app.db.run('DELETE FROM email_provider_events WHERE received_at < ?', now - 30 * DAY);
    // Video: provider event and operation records are kept 30 days; participant names follow workspace retention.
    app.db.run('DELETE FROM video_provider_events WHERE processed_at IS NOT NULL AND processed_at < ?', now - 30 * DAY);
    app.db.run("DELETE FROM video_provider_ops WHERE status = 'done' AND updated_at < ?", now - 30 * DAY);
  });
  return removed;
}

export function createWorker(app, { intervalMs = 2000 } = {}) {
  let timer = null;
  let running = false;
  let again = false;
  let lastRetention = 0;
  let lastMonitor = 0;
  const state = { lastTickAt: null, lastError: null };

  async function tick() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        expireHolds(app);
        dispatchOutbox(app);
        await processDueRuns(app);
        await syncMeetingCalendars(app);
        await deliverDueEmails(app);
        await deliverWebhooks(app);
        await syncDueCalendars(app);
        await videoTick(app);
        expireLots(app);
        await reconcileRecharges(app);
        if (app.now() - lastRetention > 3600000) { applyRetention(app); lastRetention = app.now(); }
      } while (again);
      state.lastTickAt = app.now();
      state.lastError = null;
    } catch (error) {
      state.lastError = error.message;
      app.log('error', 'worker_tick_failed', { error: error.message });
    }
    // Runs after a failed pass too, so the failure itself can raise worker_error.
    try {
      if (app.now() - lastMonitor >= MONITOR_INTERVAL_MS) { lastMonitor = app.now(); await runMonitoring(app); }
    } catch (error) {
      app.log('error', 'monitoring_failed', { error: error.message });
    } finally {
      running = false;
    }
  }

  return {
    state,
    tick,
    nudge() { if (timer) setImmediate(tick); },
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref(); setImmediate(tick); } },
    stop() { clearInterval(timer); timer = null; }
  };
}
