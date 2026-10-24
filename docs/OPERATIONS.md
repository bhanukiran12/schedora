# Operations runbook

## Monitoring

- **Health:** `GET /api/health` returns database status, the worker's last tick time and error, and pending queue sizes (`events`, `emails`, `runs`). Render uses it as the health check. Alert when `status` is not `ok`, when `worker.last_tick_at` is more than 2 minutes old, or when pending counts keep growing.
- **Logs:** one JSON line per API request (`method`, route pattern, `status`, `ms`) with no query strings, bodies or personal data. Errors are logged as `request_failed` or `worker_tick_failed`. Set `LOG_LEVEL=warn` to drop request lines.
- **Release warnings:** logged at start-up for missing operator details, outbox email, missing webhook secret and open billing mode.
- **Product views:** hosts see email delivery status per booking (Meet → Email delivery); Flow shows every run with attempts and the last error.

Not yet connected: an external uptime monitor, alerting and log retention. Choose these with the hosting setup (Render offers log streams to external providers).

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
