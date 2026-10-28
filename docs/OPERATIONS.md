# Operations runbook

## Monitoring

- **Health:** `GET /api/health` returns database status, the worker's last tick time and error, and pending queue sizes (`events`, `emails`, `runs`). Render uses it as the health check. Alert when `status` is not `ok`, when `worker.last_tick_at` is more than 2 minutes old, or when pending counts keep growing.
- **Logs:** one JSON line per API request (`method`, route pattern, `status`, `ms`) with no query strings, bodies or personal data. Errors are logged as `request_failed` or `worker_tick_failed`. Set `LOG_LEVEL=warn` to drop request lines.
- **Release warnings:** logged at start-up for missing operator details, outbox email, missing webhook secret and open billing mode.
- **Product views:** hosts see email delivery status per booking (Meet → Email delivery); Flow shows every run with attempts and the last error.

### Operator alerts

The worker evaluates these conditions once a minute (`backend/src/platform/monitoring.mjs`). Each one fires when its count is above zero:

| Code | Fires when |
| --- | --- |
| `worker_error` | The worker's last pass failed |
| `email_failed` | An email created in the last 24 hours failed permanently |
| `email_overdue` | An email is more than 15 minutes past its send time |
| `flow_failed` | A Flow run failed in the last 24 hours |
| `flow_overdue` | A run of an enabled flow is more than 15 minutes overdue (paused flows hold runs on purpose) |
| `events_overdue` | A product event is undispatched after 15 minutes |
| `video_events_overdue` | A video provider webhook is unprocessed after 15 minutes |
| `video_ops_failed` / `video_ops_stuck` | A video provider operation failed, or is still pending after 5 attempts |
| `video_settlement_overdue` | A credit reservation is unsettled more than an hour after it ended |
| `video_unfunded_usage` | Video units were used without credit in the last 24 hours |
| `video_capacity` | Connected participants reach 80% of `MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS` |
| `video_budget` | The month's estimated provider cost reaches 80% of `MEET_VIDEO_MONTHLY_COST_BUDGET_MICROS` |

State is kept in `monitor_alerts`. A notification is sent when a condition starts firing, again every 6 hours while it stays firing, and once when it resolves. A condition that clears before any notification was delivered sends nothing. Undelivered notifications are retried on the next pass. Messages contain codes and counts only: no workspace names, addresses, answers or message bodies. `/api/health` shows `alerts.channels` and `alerts.firing`; logs show `alert_firing`, `alert_resolved` and `alert_delivery_failed`.

Channels (either or both):
- `ALERT_WEBHOOK_URL`: HTTPS incoming webhook. The JSON body has `text` (Slack-style), `content` (Discord-style) and `alerts` (`code`, `state`, `value`).
- `ALERT_EMAIL`: one operator address. By default it inherits the customer email provider; the local outbox would deliver nothing. Set `ALERT_EMAIL_PROVIDER=http` to send operator alerts using the existing `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN` and `EMAIL_FROM` while keeping customer mail at `EMAIL_PROVIDER=outbox`. This opt-in does not deliver or replay customer messages, change their stored transport evidence, or change video/billing confirmation flags. In production the alert HTTP endpoint must use HTTPS. Alert email still depends on the same HTTP service it may be reporting on, so prefer an independent webhook as well.

**Test a channel safely:** `node --env-file=<private env file> scripts/alert-test.mjs` (or `npm run alert-test` with the variables set). It sends one message labelled `[TEST]` to each configured channel, uses no database and changes no alert state.

**What in-process alerts cannot cover:** a stopped process, a crashed instance or a host outage cannot alert about itself. Add an external uptime check on `GET /api/health` that alerts on a non-200 response, on `"database":"error"` or on `"stale":true` (the worker has not completed a pass for 2 minutes).

**Before setting `MONITORING_CONFIRMED=true`:** configure at least one alert channel on the production service, run the test alert and confirm it arrived, and configure the external uptime check and see it alert once (for example by checking a deliberately wrong URL). Record the dates in the release checklist. Code alone does not satisfy this gate. It also gates Meet video (`MEET_VIDEO_ENABLED`), together with the webhook and smoke confirmations.

Not yet connected: log retention (Render offers log streams to external providers).

## Background work

The worker runs inside the web process every 2 seconds (`WORKER_INTERVAL_MS`):
1. Dispatch outbox events to matching enabled or paused flows (one run per flow per event).
2. Execute due Flow runs (5 attempts, exponential backoff from 30 seconds up to 1 hour).
3. Deliver due emails (6 attempts, same backoff; 4xx responses other than 429 fail at once).
4. Sync calendar feeds every 15 minutes.
5. Apply retention hourly.

Work claimed by a process that crashed is released and retried automatically (runs after 5 minutes, emails after 2 minutes).

## Backups and restore

SQLite file: `DATABASE_PATH` (`/var/data/schedora.db` on Render).

```sh
cd backend
npm run backup -- /var/data/schedora.db /var/data/backups     # consistent online snapshot + integrity check
npm run restore -- /var/data/backups/<file>.db /var/data/schedora.db   # stop the service first
```

`backup` uses `VACUUM INTO`, so it is safe while the server runs. `restore` refuses a file that fails the integrity check and keeps the replaced database beside it (`.before-restore-<time>`).

Render takes daily snapshots of persistent disks (kept for 7 days). Those snapshots are on the same provider, so also copy the output of `npm run backup` to separate storage on a schedule (for example a Render cron job uploading to object storage). That off-site copy is **not yet set up**.

### Recovery drill (required before launch, repeat quarterly)
1. On staging, create sample bookings, forms and responses.
2. Run `npm run backup` and copy the file off the server.
3. Stop the service, delete or corrupt the database file, and run `npm run restore` with the copy.
4. Start the service, check `/api/health`, and confirm the sample records and sign-in work.
5. Record the date, the time taken and any problems in the release checklist.

The automated test `backup and restore round-trip (recovery drill)` covers the scripts; it does not replace the recorded drill on real infrastructure.

## Retention and deletion

- Each workspace sets a retention period (30–3650 days, default 365). Responses older than it are deleted; appointments that ended before it have invitee name, email and notes replaced; finished Flow runs are deleted.
- Copies of sent, failed or canceled emails are deleted after 30 days; dispatched outbox events after 30 days; expired sessions immediately.
- Deleting a workspace deletes all of its records. Deleting an account deletes workspaces where that person is the only owner and removes them from the rest.
- Backups age out on their own schedule; state that period in the privacy notice once it is decided.

## Incidents

| Symptom | Check | Action |
| --- | --- | --- |
| Emails not arriving | Meet → Email delivery; `pending.emails` in health | Check provider credentials and status; failed messages show the provider's error. Bookings are unaffected. |
| Flow runs stuck in retrying | Flow → Run history | Fix the cause (recipient, provider), then **Retry**. Side effects are never duplicated. |
| A host's calendar shows revoked | Meet → Calendar | The host reconnects the calendar. Busy times from it are not applied until then. |
| Double booking reported | `bookings` for that host | Should be impossible (transaction plus database trigger). Treat as a critical defect and keep the database copy for analysis. |
| Disk full | Render metrics | Increase disk size; run retention; check for very large calendar feeds. |
