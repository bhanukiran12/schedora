# Flow v1 release package: shared-database production migration

Prepared on 23 November 2026. **Nothing has been deployed, committed, pushed or sent.** Use this package together with [the Flow v1 implementation record](FLOW_V1_IMPLEMENTATION.md) and the evidence files in [docs/evidence](evidence/).

## 1. Decisions and open items

**Decided (23 November): keep the shared database.**
- AWS staging and production on Render both use the same Supabase database.
- So this release is a **production database migration**, even when only staging is deployed. It follows §4 step by step: inspect, back up and verify recovery, pause every worker, migrate and deploy compatible code, then run acceptance.
- A separate staging database is no longer required.

**What "compatible code" means on a shared database.**
- Every service with a worker reads the same event queue. The previous release's dispatcher (production's `main`, identical to the dispatcher used in the rehearsal) claims events and marks them done.
- On an enabled Flow v1 workflow, that dispatcher starts broken single-action runs. The rehearsal's negative control shows this.
- If any older build is running, Flow v1 triggers would be split unpredictably between the two dispatchers.
- The release image is therefore deployed with **`FLOW_V1_ACTIVATION=held`**:
  - Flow v1 workflows can be built, saved, published and tested with a record, but not turned on or resumed.
  - The legacy single-action API refuses step workflows, so nothing can bypass the hold.
  - Classic workflows are unaffected.
- With the hold in place, the older production build stays compatible with the upgraded schema. The rehearsal showed that it keeps running, listing and creating classic workflows.
- The hold is lifted (§4, phase 6) only once every service on this database runs the release.

**Still open:**
1. **Deployment access.**
   - The AWS keys on this machine are root keys for a different account and cannot see staging. Deploy through the GitHub Actions role or the staging deploy identity, and retire the local root keys.
   - Pausing production needs Render dashboard or API access, which has not been used or tested from here.
2. **Source for the image.** The release is an uncommitted working tree (§2). It must be committed to a reviewed branch before an image is built. That needs separate authorization.
3. **Maintenance window.** Phases 2–5 pause production on Render for about 10–20 minutes. Announce it.
4. **Provider verification.** WhatsApp Flow templates, AI, Slack and Google Sheets sync are not configured (§8). Email delivery reports are off, so only provider acceptance can be checked. Workflows that use an unconfigured provider stay unable to turn on, which is correct.
5. **Live acceptance** (§7) needs the hold lifted and explicit authorization. A live payment check needs separate authorization and Razorpay test keys.

## 2. Release manifest

| Item | Value |
| --- | --- |
| Source | Branch `codex/worktree-checkpoint` at `42c3763`, plus the uncommitted working tree, including all of Flow v1. Suggested tag after commit and review: `release-20261123-flowv1` |
| Currently on staging | ECS task definition **18**, image `sha256:775c0647e692b28d8fb1ba811983bcc16fe6d9be202fdd61be5c1b1903f18977`. On 23 November `/api/health` reported ok, PostgreSQL storage, worker not stale, and 0 pending events, emails and runs |
| Currently on production | Render service `schedora-api`, auto-deployed from its tracked branch (expected `main`, last commit `989cda5`, 10 November). Its exact running version could not be read: `/api/health` returns a Cloudflare challenge to scripts. Confirm it in the Render dashboard |
| Database state (read-only inspection, 23 November 11:38 UTC) | PostgreSQL 17.11. Highest applied upgrade **v23** (`postgres_v23_workbook_trash`, 19 November). Workflows: 2 classic `task` workflows, both paused, and no step workflows. Runs: 2 succeeded. Nothing in `scheduled`/`queued`/`sending`, and 0 undispatched events. Schema size about 4 MB, 82 tables |
| PostgreSQL upgrades pending (applied on start, in order, **in one transaction**) | **Ten:** `v24_product_tools`, `v25_message_consent`, `v26_whatsapp_workflows`, `v27_form_resume`, `v28_qualify_starters`, `v29_form_payments`, `v30_form_message_consent`, `v31_google_sheets_sync`, `v32_meeting_followups`, `v33_flow_v1`. The earlier package assumed v29–v33; the inspection corrected this |
| Schema drift | None. The live structure, 1,287 columns, constraints and indexes, matches exactly a v23 built from this code on a disposable PostgreSQL 17.11 |
| Rehearsal from the real starting point | `npm run flow-rehearsal -- --postgres --pg-from 23`: **84 of 84** checks. All ten upgrades applied in one transaction in 377 ms, including the connection. Row counts unchanged, foreign keys went from 124 to 171 with no violations, and `pg_restore` matched the pre-upgrade counts ([evidence](evidence/flow-v1-migration-rehearsal-v23-2026-11-23.json)) |
| SQLite migrations | `033`–`037`. Not used by staging or production; rehearsed for local and self-hosted installs |
| New settings | **`FLOW_V1_ACTIVATION=held`** (required for this release, see §1). Optional and may stay empty: `TWILIO_WHATSAPP_FLOW_TEMPLATES`, `FLOW_AI_DESCRIBE_DAILY` (default 10), `FLOW_AI_INPUT_CHARS` (default 8000), `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET`, `GOOGLE_SHEETS_SYNC`, `TWILIO_WHATSAPP_RECEIPT_CONTENT_SID` |
| Not changed | Prices, plan entitlements, billing mode, LiveKit settings, OAuth scopes. The legacy Flow editor and its single-action workflows are kept |

**Already true before this release:** staging's worker, with `EMAIL_PROVIDER=http`, delivers email queued by production workspaces, because both read the same queue. This release does not change that, but the window in §4 pauses it too.

## 3. Read-only inspection

`scripts/flow-release-inspect.mjs` runs every query inside `BEGIN READ ONLY` with verified TLS. It prints only upgrade names, counts, ages and per-table row counts: no connection details, names or personal data. Run it from the release operator's environment with the database URL in an env file that is never committed:

```
node --env-file=<release env> scripts/flow-release-inspect.mjs --json inspect-<time>.json
```

It reports:
- applied and pending upgrades, and any unexpected ones;
- workflows by type and status, and runs by status;
- pending emails, with the age of the oldest `sending` claim;
- undispatched events;
- whether the Flow v1 tables exist;
- minutes since the last worker write (event dispatched, email sent, run updated);
- row counts per table.

**Stop if:**
- `pending` is not exactly v24–v33;
- `unexpected` is not empty;
- step workflows already exist;
- a `sending` claim is older than five minutes.

The 23 November results are in §2 and [the inspection evidence](evidence/flow-v1-release-inspection-2026-11-23.json).

Through the Supabase pooler the application's connections show as "Supavisor", so the connection list cannot count Schedora services. Use `worker_activity_minutes_ago` from two runs a few minutes apart to confirm workers are paused.

Then confirm that the staging endpoints answer (GET only):

```
npm run staging-preflight -- --frontend https://staging.schedora.in --backend https://staging.schedora.in
```

Today 11 of 11 checks pass against task definition 18. After phase 4, add `--expect-flow-held`. Run against the current build, that check fails as expected, because the build predates the setting.

## 4. Production migration runbook

Each phase lists its command, its expected result and what to do if that result isn't met. `<cluster>`, `<service>` and `<family>` come from the staging stack outputs. Record every result in the deployment ticket.

**Phase 0: prerequisites (before the window).**
- The working tree is committed, reviewed, and built into an image by CI. Note the digest.
- The deploy identity can call `ecs:*` on the staging service. Render access is available.
- Freeze merges to Render's tracked branch during the window. Auto-deploy would otherwise start old or new code unannounced.
- The maintenance notice is out.

**Phase 1: inspect** (§3). The result must match §2. Stop on any stop condition.

**Phase 2: pause every worker on the database.**
1. Staging: `aws ecs update-service --cluster <cluster> --service <service> --desired-count 0`, then `aws ecs wait services-stable --cluster <cluster> --services <service>`.
2. Production: suspend `schedora-api` in the Render dashboard (service → Settings → Suspend), or through the Render API. Its health URL then stops answering.
3. Run the inspection twice, three minutes apart.
   - Expected: `worker_activity_minutes_ago` keeps growing between the runs, there are no `sending` emails, and nothing pending changes.
   - If anything is still being written, find the remaining worker before continuing.

**Phase 3: back up and verify recovery.**

```
node --env-file=<release env> scripts/flow-release-backup.mjs <protected backup folder> --live
```

The script:
- runs `pg_dump --schema=schedora -Fc` with a PostgreSQL 17 client over `verify-full` TLS;
- checks the archive with `pg_restore --list`;
- restores it into a disposable local container and compares every table's row count with the live database, read in a read-only transaction;
- writes `<dump>.verify.json` with the size, SHA-256, table and row totals and any differences.

It must print `"verified": true`. If counts differ, writes happened during the dump: return to phase 2.

Two more steps:
- Also confirm that a Supabase scheduled backup or point-in-time recovery exists from the last 24 hours.
- Keep the dump in protected storage, because it holds customer data, until roll-forward is accepted. Then delete it.

Tested on 23 November against a disposable PostgreSQL 17.11 with verified TLS: 105 tables restored with identical counts. It has not been run against the live database.

**Phase 4: migrate and deploy compatible code (staging).**
1. Register task definition 19 as a clone of 18 that changes only:
   - the image, set to the new digest;
   - one environment entry, `FLOW_V1_ACTIVATION=held`.

   ```
   aws ecs describe-task-definition --task-definition <family>:18 --query taskDefinition > td18.json
   # Edit: set containerDefinitions[0].image to the new digest; add {"name":"FLOW_V1_ACTIVATION","value":"held"} to environment;
   # remove taskDefinitionArn, revision, status, requiresAttributes, compatibilities, registeredAt, registeredBy.
   aws ecs register-task-definition --cli-input-json file://td19.json
   aws ecs update-service --cluster <cluster> --service <service> --task-definition <family>:19 --desired-count 1
   aws ecs wait services-stable --cluster <cluster> --services <service>
   ```

2. On start, the task applies v24–v33 in one transaction before it serves traffic or starts its worker. Rehearsed time: 377 ms; expect seconds. If the transaction fails, nothing is applied. The schema stays at v23 and the task fails health. Then go to §6 B or fix forward. Do not resume Render until the cause is known.
3. Health:
   - `/api/health` reports ok, PostgreSQL storage, worker not stale, and pending counts that do not grow;
   - `/api/config` reports `deployment: staging` and `flowActivationHeld: true`;
   - the inspection shows `pending: []` and `highest_applied: 33`, with row counts equal to the backup's;
   - preflight passes with `--expect-flow-held`.

**Phase 5: resume production on the previous build.**
- Resume `schedora-api` on Render. It runs the previous code against the v33 schema, which the rehearsal shows is compatible while no Flow v1 workflow is on.
- Check that its health page loads in a browser, and that a test booking or form response appears from both hosts.
- The window ends here.

**Phase 6: lift the hold** (separate decision; not part of this window).
- Only when every service on the database runs this release. That means production on Render must be deployed with the same build, which is a production deployment needing its own approval.
- Then set `FLOW_V1_ACTIVATION=on` (or remove it) on both services and confirm `/api/config` no longer reports `flowActivationHeld`.
- Until then, Flow v1 can be built, published and tested, but not turned on.

**Phase 7: acceptance.**
- While held: run the builder journeys by hand on staging with the synthetic workspace (§5): drafts, publish, "Test with this record", and the timeline. Then run preflight.
- After phase 6, with authorization: run the live journey (§7).

**No surprise activity:**
- The upgrade changes no workflow's status. Row counts and statuses were unchanged in the rehearsal.
- New workflows from templates, "Describe your automation", the Forms qualify starter, and the Meet, Forms and Sheets entry points are always inactive drafts.
- Events queued before the window are dispatched once, after it.
- Do not set `EMAIL_PROVIDER=outbox` on staging to "hold" messages. On the shared database that would also swallow production's mail.

## 5. Synthetic workspace and cleanup

`scripts/flow-staging-journey.mjs` creates two new accounts and workspaces named `Flow QA <stamp> owner` and `Flow QA <stamp> other`, and deletes both at the end, even when a check fails. If a run is interrupted, delete them as their owner: Account → delete workspace, then delete account. Their workflows, runs, forms, bookings and sheets are deleted with the workspace. The script prints the cleanup result for each account.

## 6. Rollback

Rolling back this release does not reverse the database upgrade. On the shared database, both routes are production operations: pause workers first (§4, phase 2). The upgraded schema stays, and the previous code runs on it. This was rehearsed on SQLite and PostgreSQL with the committed previous dispatcher.

**A. Application rollback, keeping data (preferred).** Downtime is one ECS task replacement, a few minutes.

1. Stop the new task: set the service's desired count to 0, or deploy a placeholder.
2. Wait 2 minutes for Flow leases to expire.
3. With the staging `DATABASE_URL` and `DATABASE_CA_CERT` in the environment, run `node scripts/flow-rollback.mjs prepare flow-rollback-<date>.json`.
   - It records each Flow v1 workflow's status and switches on or paused ones to draft.
   - It resolves crashed runs as uncertain.
   - It deletes nothing.
   - While `FLOW_V1_ACTIVATION=held` is in place, no Flow v1 workflow can be on, so it switches nothing. Run it anyway: it records the state and resolves crashed runs.
4. Redeploy task definition 18: `aws ecs update-service --cluster <EcsClusterName> --service <EcsServiceName> --task-definition <family>:18`, using the stack outputs. Check health.
5. **Roll forward:** deploy the new image again, then run `node scripts/flow-rollback.mjs restore flow-rollback-<date>.json`.
   - Statuses come back with `enabled_at` set to now, so timed triggers do not catch up.
   - Workflows edited during the rollback are skipped and listed.
   - `restore` writes statuses directly and does not check `FLOW_V1_ACTIVATION`. Run it only after the hold has been lifted, when every service runs the release.

What this route means for data:
- Bookings, responses, payments, sheets and legacy workflows keep working throughout.
- While rolled back, Flow v1 workflows do not run. Events from that period do **not** start Flow v1 runs after roll-forward; they are marked dispatched by the previous release.
- Waits whose time passes during the rollback resume late, after roll-forward.
- Approvals that expire during the rollback close as expired.
- Messages already queued are still sent by the previous release.

Without step 3, the previous release starts its own single-action runs on enabled Flow v1 workflows, and those runs crash and retry. The rehearsal's negative control shows this.

**B. Restoring the pre-upgrade backup (last resort).**
- Pause every worker (§4, phase 2) before restoring.
- It returns the schema to v23 (the pre-window backup from §4, phase 3) but discards **every write after the backup**: bookings, responses, payments, sheet edits and workflow runs.
- In the rehearsal, a restore discarded 26 responses, 84 emails, 87 workflow runs and every Flow v1 table.
- Payments confirmed by Razorpay in that window would have to be reconciled from Razorpay.
- On a database shared with production this is a production data loss. Use it only for corruption, never just to undo the release.

## 7. Staging journey (only when live testing is authorized)

Precondition: the hold has been lifted (§4, phase 6). The journey turns workflows on, which `FLOW_V1_ACTIVATION=held` refuses with `activation_held`.

```
FLOW_QA_LIVE_AUTHORIZED=yes FLOW_QA_EMAIL=<your own test inbox> node scripts/flow-staging-journey.mjs --base https://staging.schedora.in --live
```

- The script refuses production hosts, refuses staging without both settings, and never takes a payment.
- It was rehearsed locally against a real server process with the local email outbox: **18 of 18 checks passed**, and both synthetic accounts were deleted.
- At most two emails are sent, both to plus-addresses of `FLOW_QA_EMAIL`: the approved follow-up, plus the approval request to the synthetic owner.

| Acceptance item | How it is proven |
| --- | --- |
| Form → private lead score → booking | Script: lead points absent from the public form; Hot score visible to the owner; booking linked through the form's handoff |
| Flow condition and wait | Script: "only if Hot" passes, the run waits on the server for 1 minute |
| Human approval | Script: the approval title names the person; approved once; a second decision returns 409 |
| Follow-up and Sheets update | Script: the email step is accepted by the provider; the sheet row is written once with "Followed up" |
| Acceptance is not delivery | Script: the step reports `accepted` and its transport. Delivery reports are off on staging (`email_reports: false`), so delivery is not claimed |
| Cancellation stops pending work | Script: canceling the second booking cancels its waiting run with "The booking was canceled." Unit test covers approvals and the cancellation-started workflow |
| No repeated effects | Script: one run per booking, usage 2. Rehearsal: two worker processes sent 24 messages exactly once |
| Tenant and workbook permissions | Script: the second tenant gets 404 for the workflow, run, approval and workbook |
| Worker restart preserves waits and approvals | Rehearsal (SQLite and PostgreSQL): a killed worker's in-flight email became uncertain and was not resent; the wait and approval survived restarts and completed once |
| Uncertain effects need review | Rehearsal and browser journey: the run stops as failed with "may or may not have happened"; resend calls once; "treat as done" sends nothing |
| Paid responses only after server-confirmed payment | Unit tests (`forms-payments`, `flow-triggers`). A live payment check needs separate authorization and Razorpay test keys; not part of this journey |
| Consent withdrawal | Unit test (`flow-engine` messaging and consent). WhatsApp is not configured on staging, so there is no live check |

## 8. Provider readiness (setting names and status only)

Source: staging `/api/config` on 23 November (true/false flags only), the documented secret keys, and this checkout. No values were read.

| Provider | Settings | Staging status |
| --- | --- | --- |
| Email | `EMAIL_PROVIDER`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN`, `EMAIL_FROM` | Configured (`http`). A Meet confirmation was accepted and received in November. Delivery reports (`EMAIL_WEBHOOK_SECRET`) are not configured |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Local outbox: not a real provider |
| WhatsApp (Flow templates, receipts) | `TWILIO_WHATSAPP_FROM`, `TWILIO_WHATSAPP_FLOW_TEMPLATES`, `TWILIO_WHATSAPP_RECEIPT_CONTENT_SID` | Not reported by the deployed version; not in the documented secret. Treat as not configured |
| Slack | Per-workspace incoming webhook, connected in Flow → Connections | Not connected in any workspace; nothing is needed on the server |
| AI (Describe, AI steps, follow-ups) | `ANTHROPIC_API_KEY`, optional `FLOW_AI_DESCRIBE_DAILY`, `FLOW_AI_INPUT_CHARS` | Not configured (`ai: false`). AI steps stay unable to turn on |
| Google Sheets sync | `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET`, `GOOGLE_SHEETS_SYNC` | Not in the documented secret. Treat as not configured. Separate from calendar sign-in (`google: true`) |
| Form payments | Per-workspace Razorpay keys (encrypted in the database); `ALLOW_TEST_PAYMENTS` | Test payments allowed (`testPayments: true`); no live keys verified |
| Outgoing webhooks | None; per workflow | Available; private addresses refused |

## 9. Changes made during this verification pass

After the shared-database decision (23 November, second pass):
- **Inspection corrected the plan.** The database is at v23, so ten upgrades are pending (v24–v33), not five.
- **The PostgreSQL rehearsal baseline was not faithful.** The `postgres_v1` step builds tables from the SQLite migrations it can see. The earlier PostgreSQL baseline therefore already contained later columns.
  - `--pg-from <n>` now limits both the upgrades and the migrations to version n.
  - The faithful v23 baseline passes 84 of 84 checks.
  - The default v32 run still passes 83 of 83.
- **Release hold.** `FLOW_V1_ACTIVATION=held` keeps Flow v1 workflows from being turned on while an older build shares the database. The builder shows the hold, and `/api/config` reports `flowActivationHeld`.
- **Bypass closed.** `PATCH /api/workspaces/:ws/flows/:id`, the classic API, could turn on a step workflow without publishing, connection checks or the hold. It now returns 409 `use_flow_builder` for step workflows. The interface never used it for them.
- **New scripts:**
  - `flow-release-inspect.mjs`: read-only inspection;
  - `flow-release-backup.mjs`: dump with verified restore;
  - `staging-preflight --expect-flow-held`.

Earlier in the verification pass:

Defects found and fixed before release:
- An email interrupted mid-send would have been resent automatically by the email queue. Flow message steps are now recorded as in flight, and a person chooses resend or done.
- A canceled booking did not stop its waiting or approval runs. It does now, at dispatch and again at run time.
- Approval titles showed raw `{{field}}` tokens to approvers and in approval emails.
- Builder edits made while a save was in flight were overwritten, and Publish could publish without them.
- Field chips were appended at the end instead of at the caret.
- Keyboard focus was lost when a step reached the top or bottom of the list.
- Older browser time-zone names (Asia/Calcutta) were stored and shown.
- Run, retry and test titles could show lowercase field keys after a damaged regular expression.
- An empty or invalid `FLOW_AI_DESCRIBE_DAILY` turned the feature off; it now uses the default.

Launch limitations addressed:
- Schedules have a time zone, a "Next runs" preview and daylight-saving rules.
- "Meeting ended" now reads "A meeting's scheduled end time passes".
- The payment trigger reads "A form payment is confirmed (Forms only)".
- Incoming webhook field types are explained.
- The AI cost guards are configurable.
- Reorder buttons and the legacy builder are kept.
