# External monitoring acceptance

Prepared 28 October 2026. This is a configuration and verification contract, not evidence that an external monitor is running.

## Zero-spend candidate

UptimeRobot's official free-plan guidance currently allows commercial use, 50 monitors and five-minute checks, including HTTP and keyword monitors, without a card. Its account was not signed in in this session. The owner must complete sign-in/account creation and any terms acceptance before configuration. Select Free, with no trial upgrade or paid notifications.

Source checked 28 October 2026: https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan

## Monitors to configure

Use GET https://schedora-api.onrender.com/api/health without authentication, cookies or query tokens. Send downtime and recovery email to the owner's approved operator address. Do not publish a public status page containing internal diagnostics.

| Monitor | Success condition | Purpose |
| --- | --- | --- |
| Schedora API/database | Successful HTTP response AND keyword `"database":"ok"` present | Detect HTTP outage, invalid response or database failure |
| Schedora worker | Successful HTTP response AND keyword `"stale":false,"error":null` present | Detect stopped, never-started or failing background worker |

The keywords match the current compact JSON response. Do not search for `false` or `null` alone: other fields can contain them. Recheck keywords if the response formatting/field order changes. A basic HTTP-only monitor cannot replace the worker monitor.

Use five-minute checks on Free. Detection can take at least one polling interval plus provider confirmation/delivery time; this is not a two-minute alert SLA. The application marks a worker stale after two minutes, but polling adds latency. Review the available request timeout against Render's documented 50-second-or-longer cold start; record any false startup alerts instead of masking them as uptime. Account-wide Render free compute allowance and other services must be reviewed before relying on continuous polling; no paid capacity is approved.

## Evidence before MONITORING_CONFIRMED

1. Save each monitor and verify its exact URL, interval, keyword mode and recipient. Record IDs and plan.
2. Observe healthy checks from the independent service. A screenshot of a saved form alone is insufficient.
3. Test notification delivery without interrupting production: temporarily point one monitor to a deliberately nonexistent path on the same app, wait for its actual failure check and notification, then restore the health URL. Confirm the failure and recovery notifications reached the recipient. Do not stop the real worker or break the database.
4. Independently verify the worker keyword fails for a stale/error response. The local contract check below proves the current response semantics; it does not prove the external provider's saved settings or email delivery.
5. Preserve receipt times, monitor history and restoration evidence. Only then consider the monitoring confirmation flag. It does not close production video, capacity, media settlement, pricing or payment gates.

## Current evidence

- Production operator test used the existing `alert-test` script in one temporary build command, with no database access. Provider accepted the message; owner explicitly confirmed Inbox receipt in this chat on 28 October 2026. Resend message ID: `01a182d4-3d83-7506-92e8-889fdd907f2a`. Normal build command was restored and its deployment succeeded. This proves this test's receipt, not continuous external monitoring.
- Isolated operator transport is implemented in `ec3ccdc`; customer email remains outbox. Production health reports the email channel configured. No confirmation flag has been set for the external service.
- Local in-memory application check exercised the real `/api/health` endpoint: before first worker tick, healthy tick, worker error and stale tick. All returned HTTP 200; the worker keyword failed, passed, failed and failed respectively. The database keyword passed in these four database-healthy scenarios. No production failure was induced and no email was sent by this local check.
- External account sign-in, saved monitors, actual failure/recovery checks and their receipts are still incomplete. The owner was asked to finish account sign-in; no credentials were reset or exported.
