# Meet production release checklist
Updated 24 October 2026. Google Calendar / Google Meet selected by the owner.

## Present state
Core booking and management code is covered by automated tests. Provider tests substitute external responses; they do not prove delivery to real inboxes or real Google accounts. No deployment or live provider changes were made in this stabilization pass.

## Release gate
From backend, run `npm run production-check` with the intended deployment environment. It reports missing requirements by name, without printing secrets. `RELEASE_MODE=production` makes server startup run the same gate before opening the database or starting workers. Evaluation mode remains available for safe staging with disposable data; it is not approval to accept real customers.

Required production settings:
- NODE_ENV=production; BASE_URL=https://schedora.in.
- DATABASE_URL uses the Supabase session pooler, or DATABASE_PATH is an absolute path on a mounted persistent volume. PERSISTENT_STORAGE_CONFIRMED=true only after restart/redeploy persistence is tested. See [Supabase storage](SUPABASE.md).
- APP_ENCRYPTION_KEY is stable and at least 32 characters. Back up the key separately and securely; do not regenerate it on deployments.
- EMAIL_PROVIDER=http with HTTPS EMAIL_HTTP_URL, EMAIL_HTTP_TOKEN, and EMAIL_FROM. The endpoint must accept the documented JSON relay contract and honor Idempotency-Key. EMAIL_DOMAIN_VERIFIED=true only after sender DNS and inbox checks.
- GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the owner's Google OAuth app. Callback is BASE_URL + /api/oauth/google/callback. Connect the host's Google account from Meet after deployment.
- OPERATOR_NAME, OPERATOR_CONTACT and OPERATOR_JURISDICTION set to reviewed legal details.
- BILLING_MODE=enforced; ALLOW_TEST_PAYMENTS=false; no test billing provider. Subscription billing still needs a selected live adapter and approved prices. COMMERCIAL_BILLING_CONFIRMED=true only after live-mode provisioning, renewal, failed-payment and cancellation tests. This flag records an operational attestation; it does not implement a payment adapter.
- BACKUPS_CONFIRMED=true after an off-site snapshot and isolated restore; MONITORING_CONFIRMED=true after alert delivery; PROVIDER_SMOKE_CONFIRMED=true after the lifecycle below passes.

Confirmation flags are evidence records, not substitutes for checks. A successful preflight checks configuration and attestations; it does not certify security, availability or legal compliance.

## Staging provider lifecycle
Use a separate database, Google test users and an email sandbox or authorized inboxes. Use staging callback URLs registered separately; never point preview builds at real production data.
1. Sign up two workspaces and confirm tenant isolation.
2. Connect Google, verify busy events hide booking slots and a new appointment creates its calendar event/Meet link.
3. Book from a second browser in a different timezone. Confirm one persisted booking, correct local display and one confirmation message.
4. Send concurrent requests for the same host slot; only one booking succeeds.
5. Reschedule; check original time is free, replacement is blocked, Google event updates and email shows the correct time.
6. Cancel; verify calendar cleanup, suppressed reminder and visible canceled status.
7. Revoke Google access; verify the host sees the failure and stale calendar data is not silently represented as current.
8. Exercise email failure/timeouts and inspect retry status with the provider's own delivery/idempotency records.
9. Restart and redeploy; bookings and integration access must survive. Run a due reminder through the continuously running worker.
10. Restore an off-site backup to an isolated service, verify known records and record recovery time/data loss window.

Record date, build SHA, test accounts, provider event/message IDs, result and remaining defects. Exclude tokens and personal invitee data from evidence committed to Git.

## Deployment decision
Current render.yaml is explicitly evaluation-only. DATABASE_URL now selects persistent Supabase PostgreSQL; without it SQLite still needs a persistent disk. A free sleeping backend still delays workers and reminders even with persistent PostgreSQL. A paid hosting change requires owner selection; this checklist does not provision or purchase anything.

Remaining launch work: real provider tests, subscription payment adapter/prices, password recovery/email verification assessment, security and assistive-technology review, peak-load test, alerts, backup automation and a controlled beta.

## Source control
Existing uncommitted work has been preserved. Run checks and review the complete diff before a stabilization commit. This pass does not create commits or push without a new instruction.
