# Forms uploads and Sheets staging checkpoint — 18 November 2026

## Scope

The user authorized finishing respondent file editing, configuring persistent private attachment storage and real scanning, and deploying the current Sheets/Forms checkout to AWS staging. The current working tree was preserved; this work does not commit, merge or push Git changes. Production service and DNS changes are outside this release. Staging continues to use the shared Supabase database by the user's explicit decision.

## Delivered behavior

- Sheets editing starts at the selected cell's width and expands with text only into empty neighboring cells, bounded by the grid; font and line-height follow the cell, and Escape discards the edit.
- File questions accept up to two PDF/JPEG/PNG/WebP files, each at most 2 MB. Storage budgets are 10 MB/workspace and 100 MB/service.
- Private response edit links support retaining, removing and replacing existing attachments. Saves update the original response and linked Sheets row, preserve the original submission time, reject stale revisions, and do not emit another response-created event.
- Five-minute upload capabilities are bound to the form, published version, field and submission. Editing uploads are additionally bound to the original response. Downloads require a current workspace session and response-reading permission.
- File metadata stays in PostgreSQL; the files live outside the public frontend directory. Removal revokes downloads immediately; the worker removes physical files before releasing the ledger reservation. Physical cleanup and failure retries are covered locally; live acceptance checks access revocation, not a direct filesystem inventory.

## AWS staging release

- Storage stack: `schedora-uploads-staging`, `CREATE_COMPLETE`.
- Encrypted EFS: `fs-057ce9a3c64bd24e3`, automatic backups enabled. Two mount targets use the existing staging subnets. NFS access is limited to the existing app task security group; there is no public file endpoint.
- Web stack: `schedora-web-staging`, `UPDATE_COMPLETE` after deploying task definition `schedora-web:10`.
- Immutable app image: `255948905492.dkr.ecr.ap-south-1.amazonaws.com/schedora-web@sha256:8a32e7fd5e9c4d28e4f0183b2f1b9dd2cf14604b43ba92930af1bbaceae15881`.
- Task CPU stays at 1024; memory increases from 2048 to 4096 MB for the actual scanner. The volume mounts at `/mnt/schedora-uploads` with transit encryption enabled; the app writes private files under `/mnt/schedora-uploads/files`.
- `FORM_UPLOAD_SCANNER=/usr/bin/clamscan`; production persistent-storage confirmation is enabled for this mounted volume. Existing email, LiveKit pilot, secret references and all unrelated runtime settings were preserved. No secret plaintext was retrieved.
- The image bundles the signed ClamAV database from a pinned official image. FreshClam refreshes it in the background; a scan fails closed if unavailable, timed out, rejected, or the database is older than seven days. One scan is claimed at a time to bound memory use.
- This volume is independent of the app task lifecycle. Retain policies protect storage if the stack is later deleted. EFS backups do not imply that the shared database backup or a broader production readiness review has been verified.

## Verification

- Full local unit/integration suite: 468 tests, 461 passed, seven opt-in PostgreSQL tests skipped, zero failures.
- All seven private upload tests passed on a disposable PostgreSQL 17 database over verified TLS, including retained/replaced files and idempotent edits. A separate v21-to-v22 upload migration/reconnect check passed.
- The broader PostgreSQL run passed 18 of 19 tests. The existing Meet video concurrency test expected five admissions and received ten. Both that test and `backend/src/video` are unchanged from HEAD. This release does not claim a fully green broader PostgreSQL suite.
- Chrome Sheets journeys passed, including cell editor sizing, collaboration/conflicts, formulas, charts, pivots, linked responses, phone layouts, private file submission, and response edit/replacement updating the same Sheets row.
- Real container ClamAV accepted a clean PDF, rejected a properly embedded standard harmless antivirus test fixture, and removed the test files.
- Syntax checks, Sheets type checks and shared-module synchronization passed.
- Staging preflight passed all 11 checks: intended staging identities, matching frontend/backend configuration, PostgreSQL and healthy API.
- Live staging clean upload, scanner rejection, owner-only download, anonymous/cross-workspace denial, retained/replaced files, stale edit rejection, one-row Sheets update and filename-only CSV checks passed.
- Restart persistence passed: the replacement deployment had one running task and the old deployment had zero running tasks; the same attachment downloaded successfully through the new task. Response deletion immediately revoked access, and both disposable QA workspaces were removed. The live Sheets JavaScript, stylesheet and upload frontend module exactly matched the checked source by SHA-256. AWS then confirmed the final ECS deployment COMPLETED, running=desired=1 with no pending tasks; the web stack remains UPDATE_COMPLETE.

## Revisit before production

Keep the existing production release process separate. Review production storage, scanning/signature freshness, budgets, backups and outstanding product acceptance. An older app image has no attachment APIs; do not roll back an active upload deployment and promise that new file forms will continue working. Retain the EFS volume and use a forward fix or explicitly disable affected file forms if a rollback is necessary.

Staging Forms: https://forms.staging.schedora.in/forms
Staging Sheets: https://forms.staging.schedora.in/sheets
