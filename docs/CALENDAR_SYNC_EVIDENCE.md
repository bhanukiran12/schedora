# Calendar successful-check evidence

28 October 2026 increment. Code/local evidence only until the exact CI and release checkpoint confirms more.

## Contract and user outcome

`calendar_connections.last_synced_at` keeps its existing meaning: the latest attempt, successful or failed, for retry scheduling and backwards compatibility. New nullable `last_success_at` advances only after busy periods are fetched, parsed and committed successfully. A successful empty calendar also records success. Transient failure preserves the last successful timestamp and cached busy periods; revocation preserves the historical timestamp but removes cached busy periods and is never shown as ready. Re-authorizing an OAuth calendar resets both timestamps and sets Pending, so a newly authorized account cannot inherit old success evidence.

Calendar list/onboarding APIs return both fields to the existing authorized host; no tokens or feed addresses are added. Meet readiness uses only `last_success_at` for its existing one-hour freshness rule. A legacy/missing/future timestamp is unverified. Settings label Last attempt and Last successful check separately. Team-host visibility remains unchanged and unverified; this is not the future shared team readiness endpoint.

Live onboarding now posts the correct `feed_url` key. Previously it posted `url`, which the backend rejected. A saved connection whose first busy-time check failed stays on the calendar step, with a warning. It advances to Availability only when the returned connection is active and has success evidence. Optional skip remains available and is not called verified.

## Migration and rollback

SQLite migration 013_calendar_success.sql and PostgreSQL step postgres_v12_calendar_success add one nullable timestamp column; no data, allowance or credentials are changed. No historical backfill: an old attempt does not prove success. Existing active connections may show successful check not recorded until their next actual sync. The existing worker schedule is unchanged; Check now in calendar settings can request a new check.

Fresh and upgraded databases use the same schema. Startup applies the additive PostgreSQL step transactionally through the existing application migration runner; do not run independent remote SQL or replace that runner with CLI migrations. A rollback to the prior application should retain the column; dropping it would discard new evidence and is unnecessary. Do not claim production migration verification from local SQLite alone.

## Verification scope

Local tests exercise failure before any success, success with zero busy periods, later failure, revocation, recovery, own-workspace scope, unknown legacy and future readiness timestamps, OAuth reconnection invalidation, and SQLite upgrade/reopen preserving attempt timestamps and busy periods. A PostgreSQL 17 CI test reconstructs an older schema by removing the new column only in a throwaway schema, then verifies additive upgrade, no invented backfill, preserved rows, and idempotent reconnect. Meet readiness tests are also included in the PostgreSQL CI job.

Browser regression uses an injected fake feed: failed first connection does not advance; a subsequent good feed advances, persists both timestamps, and exposes them in settings. Full local run: 215 tests / 210 pass / five optional PostgreSQL skips, 760 layout checks. Screenshot evidence is in outputs/calendar-evidence-2026-10-28 in the report workspace. Real Google/Microsoft calendar behavior, screen reader/human comprehension, team-host readiness and production migration remain separate gates.

## Reference check

Reviewed official Supabase migration guidance and changelog on 28 October 2026. This application uses its existing private-schema direct PostgreSQL migration runner, not Supabase Auth/Data API or CLI migration tracking. No platform SDK or permissions change is introduced. References: https://supabase.com/docs/guides/deployment/database-migrations and https://supabase.com/changelog.md. The relevant current changelog breaking-change notice concerned HTTP API TLS ciphers; this timestamp addition does not change HTTP API clients or TLS settings.
