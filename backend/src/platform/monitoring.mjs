import { estimatedMonthCostMicros, videoHealth } from '../video/rooms.mjs';

// Operator alerts built from the same records /api/health reports. The worker evaluates every
// condition once a minute, keeps its state in monitor_alerts and notifies when it starts firing,
// every REMIND_MS while it keeps firing, and once when it resolves. Notifications carry codes and
// counts only: no workspace names, addresses, answers or message bodies.
// A stopped worker cannot report itself: an external uptime check on /api/health (worker.stale)
// covers that case.

export const MONITOR_INTERVAL_MS = 60000;
const REMIND_MS = 6 * 3600000;
const OVERDUE_MS = 15 * 60000;
const DAY = 86400000;

const count = (app, sql, ...params) => Number(app.db.get(sql, ...params).count);

// Each check returns a count; anything above zero fires. Summaries are fixed text plus that count.
export const CHECKS = [
  { code: 'worker_error', summary: 'The background worker\'s last pass failed', value: app => app.worker?.state.lastError ? 1 : 0 },
  { code: 'email_failed', summary: 'Emails created in the last 24 hours failed permanently', value: app => count(app, "SELECT COUNT(*) AS count FROM emails WHERE status = 'failed' AND created_at > ?", app.now() - DAY) },
  { code: 'email_undelivered', summary: 'The email provider reported bounced, failed, suppressed or spam-flagged emails in the last 24 hours', value: app => count(app, "SELECT COUNT(*) AS count FROM emails WHERE delivery_status IN ('bounced', 'provider_failed', 'suppressed', 'complained') AND delivery_event_at > ?", app.now() - DAY) },
  { code: 'email_overdue', summary: 'Emails are waiting more than 15 minutes past their send time', value: app => count(app, "SELECT COUNT(*) AS count FROM emails WHERE status IN ('queued', 'sending') AND next_attempt_at < ?", app.now() - OVERDUE_MS) },
  { code: 'flow_failed', summary: 'Flow runs failed in the last 24 hours', value: app => count(app, "SELECT COUNT(*) AS count FROM flow_runs WHERE status = 'failed' AND updated_at > ?", app.now() - DAY) },
  // Paused flows hold their runs on purpose, so they are not overdue.
  { code: 'flow_overdue', summary: 'Flow runs are waiting more than 15 minutes past their due time', value: app => count(app, "SELECT COUNT(*) AS count FROM flow_runs r JOIN flows f ON f.id = r.flow_id WHERE r.status IN ('queued', 'retrying') AND f.status <> 'paused' AND r.next_attempt_at < ?", app.now() - OVERDUE_MS) },
  { code: 'events_overdue', summary: 'Product events are undispatched after 15 minutes', value: app => count(app, 'SELECT COUNT(*) AS count FROM outbox WHERE dispatched_at IS NULL AND created_at < ?', app.now() - OVERDUE_MS) },
  { code: 'video_events_overdue', summary: 'Video provider webhooks are unprocessed after 15 minutes', value: app => count(app, 'SELECT COUNT(*) AS count FROM video_provider_events WHERE processed_at IS NULL AND received_at < ?', app.now() - OVERDUE_MS) },
  { code: 'video_ops_failed', summary: 'Video provider operations failed', value: (app, video) => Number(video.failed_ops) },
  { code: 'video_ops_stuck', summary: 'Video provider operations are still pending after 5 attempts', value: (app, video) => Number(video.stuck_ops) },
  { code: 'video_settlement_overdue', summary: 'Video credit reservations are unsettled more than an hour after they ended', value: (app, video) => Number(video.overdue_settlements) },
  { code: 'video_unfunded_usage', summary: 'Video units were used without credit in the last 24 hours', value: (app, video) => Number(video.unfunded_units_24h) },
  // Admissions stop at the global cap; warn at 80% of it (value is the percentage).
  { code: 'video_capacity', summary: 'Connected video participants are at or above 80% of the global cap (percent)', value: (app, video) => {
    const percent = Math.floor(Number(video.connected_participants) * 100 / app.config.video.maxGlobalParticipants);
    return percent >= 80 ? percent : 0;
  } },
  // Fires at 80% of the configured monthly provider budget; admissions stop at 100%.
  { code: 'video_budget', summary: 'Estimated video provider cost this month is at or above 80% of the budget (percent)', value: app => {
    const budget = app.config.video.monthlyCostBudgetMicros;
    if (!budget) return 0;
    const percent = Math.floor(estimatedMonthCostMicros(app) * 100 / budget);
    return percent >= 80 ? percent : 0;
  } }
];

export function alertChannels(app) {
  return [...(app.config.alerts?.webhookUrl ? ['webhook'] : []), ...(app.config.alerts?.email && (app.alertEmailProvider || app.emailProvider).name === 'http' ? ['email'] : [])];
}

export function firingAlerts(app) {
  return app.db.all("SELECT code FROM monitor_alerts WHERE state = 'firing' ORDER BY code").map(row => row.code);
}

function message(app, alerts, { test = false } = {}) {
  const where = new URL(app.config.baseUrl).host;
  const lines = alerts.map(alert => `${alert.state === 'firing' ? 'FIRING' : 'RESOLVED'} ${alert.code}: ${alert.summary} (${alert.value})`);
  const text = test
    ? `[TEST] Schedora alert channel check from ${where}. No action needed; nothing is wrong.`
    : `Schedora alerts on ${where}:\n${lines.join('\n')}\nDetails: ${app.config.baseUrl}/api/health`;
  return { subject: test ? `[TEST] Schedora alert check (${where})` : `Schedora: ${alerts.filter(alert => alert.state === 'firing').length} alert(s) firing on ${where}`, text, alerts };
}

// Sends one message to every configured channel. Returns per-channel results; never throws.
export async function notify(app, { subject, text, alerts = [] }, { test = false } = {}) {
  const results = {};
  for (const channel of alertChannels(app)) {
    try {
      if (channel === 'webhook') {
        // `text` suits Slack-style and `content` Discord-style incoming webhooks; `alerts` is for scripts.
        const response = await app.fetchProvider(app.config.alerts.webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'schedora', test, text, content: text.slice(0, 1900), alerts: alerts.map(({ code, state, value }) => ({ code, state, value })) }),
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Alert webhook returned ${response.status}`);
      } else {
        await (app.alertEmailProvider || app.emailProvider).send({ to: app.config.alerts.email, subject, body: text, idempotencyKey: `alert:${subject}:${app.now()}` });
      }
      results[channel] = 'sent';
    } catch (error) {
      results[channel] = 'failed';
      app.log('error', 'alert_delivery_failed', { channel, error: error.message });
    }
  }
  return results;
}

export function sendTestAlert(app) {
  return notify(app, message(app, [], { test: true }), { test: true });
}

// Evaluates every check, records transitions and delivers pending notifications.
export async function runMonitoring(app) {
  const now = app.now();
  const video = videoHealth(app);
  const values = CHECKS.map(check => ({ ...check, value: check.value(app, video) }));
  app.db.transaction(() => {
    for (const { code, summary, value } of values) {
      const row = app.db.get('SELECT * FROM monitor_alerts WHERE code = ?', code);
      if (value > 0) {
        if (row?.state !== 'firing') app.log('warn', 'alert_firing', { code, value });
        if (!row) app.db.run("INSERT INTO monitor_alerts (code, state, summary, value, first_seen_at, last_seen_at, notify) VALUES (?, 'firing', ?, ?, ?, ?, 'firing')", code, summary, value, now, now);
        else if (row.state === 'resolved') app.db.run("UPDATE monitor_alerts SET state = 'firing', summary = ?, value = ?, first_seen_at = ?, last_seen_at = ?, resolved_at = NULL, notify = 'firing' WHERE code = ?", summary, value, now, now, code);
        else app.db.run("UPDATE monitor_alerts SET summary = ?, value = ?, last_seen_at = ?, notify = CASE WHEN notify IS NULL AND notified_at < ? THEN 'firing' ELSE notify END WHERE code = ?", summary, value, now, now - REMIND_MS, code);
      } else if (row?.state === 'firing') {
        app.log('info', 'alert_resolved', { code });
        // A condition that cleared before anyone was told needs no "resolved" message.
        app.db.run("UPDATE monitor_alerts SET state = 'resolved', resolved_at = ?, notify = CASE WHEN notified_at IS NULL THEN NULL ELSE 'resolved' END WHERE code = ?", now, code);
      }
    }
  });
  const pending = app.db.all('SELECT * FROM monitor_alerts WHERE notify IS NOT NULL ORDER BY code').map(row => ({ ...row, state: row.notify, value: Number(row.value) }));
  if (!pending.length || !alertChannels(app).length) return { pending: pending.length, results: {} };
  const results = await notify(app, message(app, pending));
  // One delivered channel is enough; a failing channel is logged and others are not repeated.
  if (Object.values(results).includes('sent')) {
    for (const alert of pending) app.db.run('UPDATE monitor_alerts SET notify = NULL, notified_at = ? WHERE code = ? AND notify = ?', now, alert.code, alert.notify);
  }
  return { pending: pending.length, results };
}
