# Flow v1 implementation

Authorized on 23 November 2026, lifting the earlier hold on Flow development. Direction: "From enquiry to appointment to follow-up." Flow is the glue between Forms, Meet and Sheets. It is built as reliable native multi-step workflows with plain language, job templates, one counted run per execution and evidence of what happened, not as a Zapier clone.

The implementation was committed and deployed to AWS staging on 23 November, with the shared database upgraded to v33 and Flow activation held. See [the executed release record](FLOW_V1_STAGING_RELEASE.md#10-executed-aws-staging-release--23-november-2026). Development verification below uses fake providers and sandbox fixtures; live provider delivery remains unverified.

## Starting point (verified in code, 23 November)

- `flows` had one trigger (booking created, canceled or rescheduled, or form response) and one action (email or task). Status was draft, enabled or paused, with no versions.
- `flow_runs` stored one run per (flow, outbox event), with five attempts and an interrupted-run requeue. Usage was one `flow_runs` unit per run.
- There were no waits, conditions, branches, approvals, step records or leases.

## Checklist

### Phase 1: durable execution engine (done)
- [x] Definition schema shared by server and browser (`backend/src/shared/flow-logic.mjs`):
  - steps: Only if (all/any rules), Choose a path (2–3 paths, last may be Otherwise), Wait, Wait until (event plus timeout), Ask for approval, Stop, and actions;
  - validation, plain-language sentence, and legacy conversion.
- [x] Immutable `flow_versions`. Runs record and finish on their version; drafts are saved explicitly with revision checks.
- [x] Durable step records (`flow_run_steps`) replayed on resume, so completed steps never repeat. Bounded retries (5 per step) with backoff.
- [x] Leases: worker claims with expiry. Expired leases are recovered; an external call that was in flight becomes **uncertain** and waits for a person (treat as done, or resend with the same idempotency key).
- [x] Persisted timers (`next_attempt_at`), event waits (`flow_waits`) and approvals (`flow_approvals`), each resolved exactly once by a conditional update. Restarts keep them (tested across two processes on one database).
- [x] Pause, resume, turn off (optionally canceling waiting runs), cancel a run, and explicit Stop.
- [x] Loop protection: sheet events from undo, redo and automation never start sheet workflows. Event depth is capped at 3 (also across outgoing to incoming webhooks via `X-Schedora-Depth`). Duplicate events are blocked by unique `(flow_id, event_id)` plus deterministic event ids.
- [x] Usage: one `flow_runs` count per execution, at creation, however many steps. Simulations, tests and retries never count.

### Phase 2: native triggers and actions (done)
- [x] All requested triggers (see "Event contracts").
- [x] All requested actions, plus AI draft, summarize and classify (see "Actions").
- [x] Incoming and outgoing webhooks: HMAC signing, a five-minute replay window and delivery ids, 64 KB bounds, 10 s timeouts, no payload logging, public-host checks (SSRF).

### Phase 3: builder and run history (done)
- [x] Vertical step list (`/flow/build/<id>`) with When / Only if / Then / Wait / Ask for approval, indented branch paths, keyboard controls (Edit, ↑, ↓, Delete buttons) and a live sentence.
- [x] Field pickers with masked sample values from the latest record the author may see. Text shows `[Field name]` chips, stored as references; nobody types tokens or JSON.
- [x] States: Draft, On, Paused, Off, plus Unpublished changes, Not saved and Failing.
- [x] Publish validation that explains missing connections, fields and destinations.
- [x] "Test with a recent record" (no side effects) and "Send test to me" (author's own destination, explicit confirmation).
- [x] Run statuses: Succeeded, Waiting, Needs approval, Skipped, Failed, Canceled.
- [x] Step timeline (`/flow/runs/<id>`): provider acceptance shown separately from delivery reports; retry preview; uncertain-step decisions; cancel.
- [x] Approvals page (`/flow/approvals`), phone-friendly: edit AI drafts, approve or reject with revision checks.
- [x] Bulk "Retry failed" per workflow (uncertain runs are listed, never resent in bulk). Alert email after 3 failures in a row, optional auto-pause, a Failing chip, and a usage meter with the reset date.
- [x] Entry points:
  - Forms → Settings → "Automate follow-up in Flow";
  - Meet event type → "Automations in Flow";
  - Sheets cell menu → "Run Flow on this row" (editable workbooks only);
  - Flow home templates grouped by job.

### Phase 4: the eight job templates (done)
All create editable, unpublished, inactive drafts (`backend/src/flow/templates.mjs`). Missing bindings are reported by publish validation, never guessed. Each is tested end to end.

1. **Speed-to-lead:** response → booking link → wait 1 day for *their* booking → if none, call task for the owner.
2. **Reminders and no-show recovery:** 60 minutes before → reminder → wait 25 h → if marked no-show, rebooking link and host task.
3. **Meeting preparation:** booking → host task with the form answers and private lead score from the booking's form handoff.
4. **After-meeting follow-up:** meeting ended → AI draft grounded in the meeting's recap → host approval (draft editable) → email → next task.
5. **Routing and ownership:** Hot lead → fair round-robin owner → email the owner.
6. **Status change in Sheets:** Status becomes Enrolled → welcome email → onboarding form → mark the row (that write never retriggers).
7. **Payment received:** verified payment → upsert the row as Paid → one confirmation email per payment. Forms' WhatsApp receipt is not resent.
8. **Feedback loop:** 2 days after → feedback form → wait for *their* response → rating below 3 → manager task.

The **qualify-then-book starter** now creates an inactive Flow speed-to-lead draft bound to its form and event, instead of a paused Meet email workflow. Earlier starters keep their paused workflow untouched (never enabled), so there are no duplicate follow-ups. Members without Flow permission get the form and event only, with a note.

### Phase 5: integrations and AI (done; live verification pending)
- [x] Honest states (`GET /flow/integrations`):
  - Not configured;
  - Connected, not tested yet;
  - Connected and tested (a confirmed "Send test to me" that the provider accepted);
  - Local outbox (non-production);
  - Built in.
  A workflow can be turned on only when every channel it uses is tested, local or built in. Simulation is always available.
- [x] "Describe your automation": AI builds a validated, sanitized, unpublished, inactive draft. Requests are idempotent and limited to 10 per day; AI-written messages without approval are refused. It never publishes.
- [x] AI steps: bounded input (8,000 characters of record text), structured output validated against an allow-list, token usage recorded per step. Record data is delimited as untrusted data. No autonomous tool-using agent.

## Architecture

| File | Role |
| --- | --- |
| `backend/src/shared/flow-logic.mjs` | Triggers, wait events, actions, rule operators, validation (`flowProblems`, `aiReviewProblems`), evaluation (`rulesHold`, `choosePath`, `renderText`), plain language (`describeFlow`, `stepTitle`), `legacyDefinition`. Synced to `frontend/shared/`. |
| `backend/src/flow/engine.mjs` | `startRun`, `dispatchFlowEvent`, wait resolution, `scanTimedTriggers`, the replaying step walker, `processFlowRuns` (leases, recovery), cancel, retry preview, retry, bulk retry, approvals, timeline, simulation, failure alerts. |
| `backend/src/flow/context.mjs` | Loads each run's record fresh: booking (with handoff answers, lead score and meeting recap), response (lead score, payment, WhatsApp consent), sheet row snapshot or webhook fields. Also wait keys, masked samples and permission-checked recent records. |
| `backend/src/flow/actions.mjs` | Each action, live or previewed, with skip, transient, permanent and uncertain outcomes. |
| `backend/src/flow/manage.mjs` | Drafts (key-by-key sanitizing), publish validation with workspace checks, status changes, tests, incoming webhooks, manual row runs, usage, AI describe. |
| `backend/src/flow/integrations.mjs` | Slack connection, Flow WhatsApp templates, provider states and checks, activation problems. |
| `backend/src/flow/templates.mjs` | The eight templates. |
| `backend/src/flow/routes.mjs` | API routes. |
| `backend/src/flow/events.mjs` | Outbox event helper; whether a workbook is watched. |
| `backend/src/flow/service.mjs` | The original one-step engine, still used for flows without a published v1 definition; delegates v1 retries. |
| Frontend | `frontend/js/flow-builder.mjs`, `frontend/js/flow-runs.mjs`; `frontend/js/flow.mjs` (home, list, runs, connections). |

## Execution model

1. A product change writes an outbox event in its own transaction. `dispatchEvent` (worker) resolves waits that event satisfies, then starts runs for enabled v1 workflows whose published trigger, source and config match. Each start is `INSERT` once per (flow, event) and consumes one usage unit in the same transaction.
2. `processFlowRuns` first recovers expired leases. A step left `running` (only Slack and webhook calls are marked before the call) becomes `uncertain`. It then claims due runs with a two-minute lease.
3. `executeRun` loads the record and replays the version's steps:
   - Recorded `succeeded` or `skipped` steps reuse their outputs, including branch choices.
   - Conditions that fail end the run as Skipped with the rule as the reason.
   - Waits, event waits and approvals hold the run with a timer.
   - Transient action errors retry the same step with backoff (5 attempts). Permanent errors fail the run.
   - A step skipped for a missing consent or recipient lets the run continue.
4. Pause holds runs before their next step. Approvals can still be decided while paused, and the run continues on resume.

## Event contracts

| Trigger (event type) | Emitted by | Event id / dedupe | Notes |
| --- | --- | --- | --- |
| Booking created, canceled, rescheduled | Meet (existing) | random, one per change | A cancellation stops that booking's unfinished Flow v1 runs (waiting, awaiting approval, queued or retrying) with "The booking was canceled."; workflows started by the cancellation still run. A run that reaches its next step first also stops. |
| Before a meeting (`meet.booking.before_start`), after (`after_end`), meeting ended (`ended`) | worker scan every 30 s | `<type>:<booking>:<time>` | Confirmed bookings only. Never for times before the workflow was turned on or more than 7 days ago. "Before" never fires after the start. The builder labels it "A meeting's scheduled end time passes": the booking's end time, whether or not a video call happened or ended early. |
| No-show (`meet.booking.no_show`) | attendance | `no_show:<booking>` | Setting no-show again (even after clearing it) cannot start a second run. |
| Form response completed (`forms.response.created`) | Forms (existing) | random | Paid forms emit it only when the server confirms the payment (the existing payment completion contract). |
| Response edited (`forms.response.edited`) | public response edit | `edited:<response>:<revision>` | One run per saved edit. |
| Form payment confirmed (`payments.captured`, labelled "Forms only") | Forms payments `markPaid` | `payment:<response>` | One event per confirmed payment; webhook redeliveries and late confirmations repeat nothing. Form payments only (Meet booking payments start "booking created"). |
| Sheet row added, column changes to a value (`sheets.row.added`, `sheets.cell.changed`) | `applyWorkbookChanges`, editable workbooks only, when a workflow watches the workbook | `row:` / `cell:<workbook>:<sheet>:<cell>:<revision>` | Each event carries `origin`: user, undo, redo or automation. Only user edits start workflows. Undo and redo are marked by the browser's sync layer; Flow writes are marked automation. Canonical Form Responses and Bookings tabs are derived, never emit, and cannot be chosen as write targets. |
| Run on this row (`sheets.row.manual`) | `POST /workbooks/:id/run-flow` | `manual:<request id>` | Read access to the workbook is required. |
| Schedule | worker | `schedule:<slot>` plus `flow_schedules.last_slot` | Hourly, daily or weekly at a wall-clock time in the chosen time zone (UTC for workflows saved without one). A time skipped when clocks go forward runs at the first time that exists; a repeated time runs once. After downtime only the latest missed slot runs. The builder shows the next three runs (`GET /flow/schedule-preview`). |
| Incoming webhook (`webhook.incoming`) | `POST /api/hooks/flows/<token>` | `webhook:<Schedora-Delivery>` | See "Webhooks". |

**Wait until something happens:** they book (`meet.booking.created`), they submit a form (optionally a specific form), or their payment is confirmed. Matching uses the run's contact email, or the response id for bookings made through that response's handoff. Another person's booking never resolves the wait. A matched form response's answers become fields (`steps.<id>.answer.<question>`).

## Actions

- **Messages:**
  - Email, booking link (prefilled name and email) and prefilled form go through the existing `emails` queue, keyed `flow:<run>:<step>`.
  - SMS (country code required) and WhatsApp use the same queue. WhatsApp needs an approved Flow template and the person's recorded consent (booking consent or form receipt consent); otherwise the step is skipped with the reason.
  - All messages honour withdrawal lists and delivery reports. Timelines show "accepted by the provider" separately from delivery reports.
  - Message, Slack and webhook steps are marked in flight before the call. If a worker dies mid-call, the step becomes uncertain and the email queue does not resend it on its own; a person chooses "send again" or "treat as done" in the retry preview.
- **Tasks** (assignee: nobody, host, the contact's owner or a member; optional deadline), **update contact** (tags, company, custom fields), **note**, and **assign owner** (fixed person or fair round-robin that skips people who left). Each commits atomically with its step record.
- **Sheet row:** add, update or update-or-add by a match column, in an editable workbook the publisher can still edit (checked at publish and at run time). Values are written as text. Writes are tagged automation and never retrigger.
- **Slack:** a workspace incoming-webhook address on `hooks.slack.com` only, stored encrypted.
- **Outgoing webhook:**
  - Public https only (checked at publish and before each call). 10 s timeout, payload up to 64 KB, record fields or minimal.
  - Headers: `Schedora-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (a per-workspace key derived from the server key), `Idempotency-Key: flow:<run>:<step>`, `X-Schedora-Depth`.
  - HTTP 429/5xx retry. Other 4xx fail. No answer means uncertain.
- **AI:** draft, summarize and classify (labels allow-list). Text that any message uses must pass an approval step first; the approver can edit it, and the approved text is what is sent.

## Webhooks (incoming)

Rotate an address in the builder: a private URL token (hash stored) and a signing secret (encrypted) are shown once. Each request must include:
- `Schedora-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, within 5 minutes;
- a unique `Schedora-Delivery` id (replays return `duplicate`);
- a JSON object up to 64 KB.

Only top-level text, number and true/false values (up to 50) become fields, each as text: rules compare them as text, nested objects and lists are ignored, and `email` and `name` identify the person. The builder explains this next to the trigger. Payloads are never logged. The workflow must be on.

## Usage and pricing

One run per workflow execution, counted when the run is created from a real event, against the existing `flow_runs` monthly quota (enforced only in `BILLING_MODE=enforced`). Simulations, "Send test to me", retries and bulk retries are free. No prices, plan limits or entitlements were changed.

AI cost guards are server settings, not plan terms:
- `FLOW_AI_DESCRIBE_DAILY`: "Describe your automation" requests per workspace per UTC day. Default 10, at most 1,000; 0 turns it off.
- `FLOW_AI_INPUT_CHARS`: record text sent per AI step. Default 8,000, range 1,000–50,000.

Empty or invalid values keep the defaults. AI steps count within the run that uses them.

## Migrations and compatibility

- **`037_flow_v1.sql` (SQLite):**
  - Rebuilds `flows` and `flow_runs` with foreign keys off to relax the old CHECKs (action type, run status). Every row and index is kept.
  - Adds definition and version columns plus `enabled_at`.
  - Adds `flow_versions`, `flow_run_steps`, `flow_waits` (with `source_id`), `flow_approvals`, `flow_round_robin`, `flow_inbound_hooks`, `flow_inbound_deliveries`, `flow_schedules` and `flow_provider_checks`.
  - Adds `outbox.payload`, `origin`, `depth` and `qualify_starters.flow_id`.
- **PostgreSQL `postgres_v33_flow_v1`:** drops `flows_action_type_check`, replaces `flow_runs_status_check`, adds the columns idempotently and creates the new tables.
- **Existing one-step flows** keep running unchanged on the original engine. Their editor (`/flow/new`, `/flow/<id>`) stays for compatibility. The v1 builder shows them converted, and publishing from it moves them to the new engine. Legacy runs (`version IS NULL`) still finish on the original path. The old `/runs/:id/retry` uses the safe v1 retry for v1 runs.
- **Retention** now also removes old skipped and canceled runs; steps, waits and approvals cascade. Inbound webhook payloads are not stored, only delivery ids.

## Permissions

| Role | Can do |
| --- | --- |
| All members (`flows.read`) | View workflows, runs, timelines and fields (samples masked); run row workflows on workbooks they can read |
| Owners and admins (`flows.manage`) | Create, edit, publish, turn on, test, retry, cancel; set the incoming webhook address |
| Approvers | Decide approvals: the named member, the host, the contact's owner, or admins |

Slack connections need `integrations.manage`. API keys can read but cannot test, rotate webhook secrets, connect Slack or decide approvals. Every query is workspace-scoped, and other workspaces get 404 (tested).

## Provider setup and live verification (pending your credentials)

1. **Email (Resend):** set `EMAIL_PROVIDER=http`, `EMAIL_HTTP_URL=https://api.resend.com/emails` and `EMAIL_HTTP_TOKEN=<Resend API key>`, with `EMAIL_FROM` set to a verified sender domain. In a workflow, use "Send test to me" once, which marks email as tested, and confirm it arrives.
2. **WhatsApp (Twilio):**
   - Get utility templates approved for Flow.
   - List them in `TWILIO_WHATSAPP_FLOW_TEMPLATES` as `{"name": {"sid": "HX…", "variables": ["Label", …]}}`, alongside the existing sender settings.
   - Test with your own number, which is already authorized.
3. **SMS (Twilio):** set `SMS_PROVIDER=twilio`, `TWILIO_FROM`, and the status callback. Test with your own number.
4. **Slack:** Flow → Connections → Connect Slack (incoming webhook address), then "Send test to me" from a workflow.
5. **Razorpay:** use the existing workspace connection; form payments start "Payment confirmed" workflows. Run one test-key payment.
6. **Google Calendar and Sheets:** use the existing connections (Meet calendars; one-way Sheets sync). Flow reacts to the bookings and rows they produce.
7. **AI:** set `ANTHROPIC_API_KEY`.

None of these were exercised live. Fake providers and sandbox fixtures were used throughout.

## Limitations and open decisions

- **Two builders:** the classic one-step editor and its tests stay in this release. New work uses the step builder; retiring the classic editor is a later decision.
- **Scheduling (resolved):** schedules have a time zone, a "Next runs" preview and tested daylight-saving rules. The time zone defaults to the browser's, shown with current IANA names. Workflows saved before this change keep UTC.
- **"Meeting ended":** labelled as the booking's scheduled end time. It does not depend on a video room.
- **Payment trigger:** labelled "Forms only" in the trigger list, the builder hint, the template and here. Meet session payments and plan billing do not start it.
- **Incoming webhooks:** only top-level scalar fields are read, and they arrive as text. The builder explains this.
- **AI limits:** configurable (see "Usage and pricing"). Prices and entitlements are unchanged.
- **Reordering:** the ↑/↓ buttons are kept and keyboard-tested; focus stays on the step. There is no drag.
- **Not included:** loops over lists, sub-flows, CRM connectors and a canvas (deferred per the research).
- **Not live-tested:** live delivery, charging, WhatsApp, Slack posting and AI stay unverified until credentials are added and live testing is authorized.
- **Shared database (decided 23 November):** AWS staging and production share one database, so this release is a production database migration. It is deployed with `FLOW_V1_ACTIVATION=held` until every service runs it. Follow the runbook in [the release package](FLOW_V1_STAGING_RELEASE.md#4-production-migration-runbook).

## Builder coverage (Chrome)

`npm run flow-builder-check` drives a real headless Chrome against a fresh server and database, with fake providers and synthetic records. It runs 12 journeys, each with light and dark layout checks at 320, 375, 768 and 1280 px:

1. **Drafts:** a draft from a template, bound to the form it was opened from, and a blank workflow. Both are unpublished drafts.
2. **Step editing:**
   - Add, edit and delete steps. Canceling a delete keeps the step, and focus returns to "Add a step".
   - Reorder with the mouse, and with Enter on the focused ↑/↓. Focus is kept at the top and bottom of the list.
3. **Field chips:** inserted at the caret inside existing text, one after another, and at the start of a multi-line field. They are stored as references.
4. **Logic steps:**
   - Conditions: field, comparison, value, any/all, adding and removing rules.
   - Branches: three paths, a step inside a path, removing a path.
   - Waits in hours, approvals (approver, title, expiry) and "wait until".
5. **Saving:**
   - Explicit save and reload persistence.
   - An edit typed while a save is in flight is kept and still shows "Not saved".
   - The unsaved-change prompt: staying keeps the edit, leaving discards it.
6. **Publishing and status:**
   - Publishing is blocked while problems remain.
   - With an unconfigured Slack connection, publishing is allowed but turning on is blocked.
   - Then publish, turn on, pause, resume, turn off, edit ("Unpublished changes") and republish. All three versions are kept.
7. **Test with this record:** previews use the record and name fields the way the builder does. Runs, emails, tasks, steps, outbox and usage are unchanged.
8. **Version pinning:** a run waiting for approval finishes on version 1 after version 2 is published. New runs use version 2.
9. **Run timeline:** an uncertain webhook step, the retry preview, "send again" calling the webhook once, and completed steps not repeated.
10. **Approvals:**
    - Tap to approve on a phone, with touch emulation and tap targets of 40 px or more.
    - Keyboard: Tab to Reject, Enter, type a reason, Enter.
    - Decisions and runs are recorded.
11. **Entry points:**
    - Forms settings → Flow for this form.
    - Meet event type → Flow for this event type; a blank draft is bound to it.
    - Sheets row menu with no row workflows → Flow for this sheet. "Run Flow on this row" then uses the row's values.
12. **Schedule and trigger hints:**
    - The time zone and "Next runs" in the chosen zone, and the sentence naming the zone.
    - The explanations for "scheduled end", "Forms only" payments and webhook field types.

The original browser regression keeps its Flow v1 journey and the classic editor's journeys.

## Migration and rollback rehearsal

`npm run flow-rehearsal` works only on disposable databases: SQLite files under `backend/backups/`, or a local PostgreSQL. It refuses non-local hosts. Add `-- --postgres` with `REHEARSAL_DATABASE_URL`, `REHEARSAL_DATABASE_CA_FILE` and `REHEARSAL_PG_CONTAINER` to include PostgreSQL.

1. It makes realistic previous-release data with the real application:
   - two tenants with bookings, form responses, and single-action workflows (on, paused and draft);
   - historical, failed, retrying and interrupted runs;
   - scheduled reminders and undispatched events.
2. It copies that data into a database built from SQLite migrations 001–036, or from PostgreSQL upgrades up to v32.
3. It then checks:
   - the upgrade on start, unchanged row counts in every table, foreign keys, the new indexes, and repeated starts;
   - legacy behaviour after the upgrade;
   - two worker processes racing on 24 runs;
   - a worker killed mid-send, restart recovery, and waits and approvals across restarts;
   - verified backup and restore;
   - both rollback routes: application rollback keeping data, and backup restore with its data loss.

The previous release's dispatcher is the committed `flow/service.mjs`. Results are in "Verification results" and in the [evidence file](evidence/flow-v1-migration-rehearsal-2026-11-23.json). The rollback commands are in [the staging release package](FLOW_V1_STAGING_RELEASE.md).

## Shared-database release preparation (23 November 2026, second pass)

- **Read-only inspection** of the shared database (`scripts/flow-release-inspect.mjs`, inside `BEGIN READ ONLY`):
  - The database is at v23, so v24–v33 are pending: ten upgrades, not five.
  - There are 2 paused classic workflows and no step workflows.
  - No emails are pending and no events are undispatched.
  - Evidence: [inspection](evidence/flow-v1-release-inspection-2026-11-23.json).
- **Schema drift:** none. The live structure (1,287 items) matches a v23 built from this code.
- **Rehearsal from v23:**
  - Fixed: the PostgreSQL baseline used to include later columns, because `postgres_v1` builds from the SQLite migrations it can see.
  - `--pg-from 23` passes 84 of 84 checks. All ten upgrades applied in one transaction in 377 ms ([evidence](evidence/flow-v1-migration-rehearsal-v23-2026-11-23.json)).
  - The default v32 run passes 83 of 83.
- **Compatibility on a shared queue:**
  - `FLOW_V1_ACTIVATION=held` blocks turning Flow v1 workflows on. The previous dispatcher would otherwise start broken runs on them and consume their events.
  - The classic `PATCH /flows/:id` API no longer accepts step workflows. It used to be able to turn one on without any checks.
- **Backup and recovery:** `scripts/flow-release-backup.mjs` dumps over verified TLS, checks the archive, restores it into a disposable container and compares every table's count. It was tested on a disposable PostgreSQL 17.11; it has not been run on the live database.

**Gates after these changes:**
- `npm run check`: 303 files.
- Sheets typecheck and shared-source sync: both passed.
- Unit suite: 556 tests, 549 passed, 0 failed, 7 skipped (the opt-in PostgreSQL tests).
- Verified-TLS PostgreSQL: 96 of 96 passed, 0 skipped.
- Builder journeys: 12 of 12 with 88 layout checks, in two consecutive runs.
- Full browser regression: 89 journeys and 1,200 layout checks, clean.
- The first run of the builder journeys and the browser regression failed. My own builder import edit had turned `$$` into `$`, so the builder page failed to load. After the fix, both reruns passed.

## Verification results (23 November 2026, after the verification pass)

All runs below happened after the last product-code change. The baseline from the first Flow v1 report was 547 unit tests, PostgreSQL 87/87, combined Chrome 52/52 and browser 89 journeys with 1,200 layout checks.

| Gate | Result |
| --- | --- |
| `npm run check` | 301 files, passed |
| `npm run typecheck:sheets` | Exit 0 |
| `npm run sync-shared -- --check` | In sync |
| Unit suite (`npm test`) | 555 tests: 548 passed, 0 failed, 7 skipped (the opt-in PostgreSQL tests). New in this pass: `flow-schedule` (5), plus tests for interrupted sends, canceled bookings and AI limits |
| Verified-TLS PostgreSQL | 95 of 95 passed, 0 skipped, in two consecutive runs. Eleven files: the earlier ten plus `flow-schedule`. Disposable local PostgreSQL 17 with a throwaway CA, removed afterwards. Never the Supabase URL in `.env` |
| Migration and rollback rehearsal | 83 of 83 checks passed: 42 SQLite and 41 PostgreSQL, both with verified TLS ([evidence](evidence/flow-v1-migration-rehearsal-2026-11-23.json)) |
| New-builder Chrome journeys (`flow-builder-check`) | 12 of 12 journeys and 88 layout checks, with no runtime errors or overflow. The first final run hit one harness race, because the worker ticked before the row-run request arrived. The fix waits for the server. A later run hit another race: a reload wait matched the old page. After both harness fixes, four consecutive runs passed 12/12 |
| Combined Sheets/product/expanded Chrome run | 52 of 52 passed |
| Full browser regression | 89 journeys and 1,200 layout checks at 320/375/768/1280 px in light and dark; no runtime errors, overflow or failed journeys |
| Staging journey, local rehearsal | 18 of 18 checks against a real local server process with the email outbox; both synthetic accounts deleted. Refuses production hosts, and refuses staging without authorization |

**Rehearsal measurements:**
- v33 applied in 281 ms, including the connection, on the rehearsal data.
- 037 applied in 23 ms on SQLite.
- Row counts were unchanged in every existing table: 155 foreign keys before and 171 after on PostgreSQL, with no violations.
- Two worker processes sent 24 messages exactly once.
- A killed worker's in-flight email became uncertain and was not resent.
- Waits and approvals completed once after restarts.
- `pg_restore` of the pre-upgrade dump matched the pre-upgrade counts exactly.
- Prepared rollback:
  - the previous dispatcher ignored Flow v1 workflows and left every v1 run untouched, while legacy workflows kept running;
  - roll-forward restored all statuses, did not catch up missed schedule slots, and continued pending approvals.
- Negative control: without preparation, the previous release started its own runs on Flow v1 workflows, and they crashed and retried.

**Defects found and fixed in this pass** (details in [the staging package](FLOW_V1_STAGING_RELEASE.md#9-changes-made-during-this-verification-pass)):
- interrupted emails could be resent automatically;
- canceled bookings did not stop pending runs;
- approval titles showed raw tokens;
- edits made during a save were lost;
- chips ignored the caret;
- keyboard focus was lost at the list ends;
- outdated time-zone names were stored;
- a damaged title regular expression;
- empty AI-limit settings turned the feature off.

No live provider was exercised. Nothing was committed, pushed, deployed or sent.

## Earlier verification results (first Flow v1 report, 23 November 2026)

| Gate | Result |
| --- | --- |
| `npm run check` | 296 files, passed |
| `npm run typecheck:sheets` | exit 0 |
| `npm run sync-shared -- --check` | in sync (includes the new `flow-logic.mjs`) |
| Unit suite (`npm test`) | 547 tests: 540 passed, 0 failed, 7 optional PostgreSQL tests skipped. New Flow tests: engine 12, triggers 6, templates 9 |
| Verified-TLS PostgreSQL | 87 of 87 passed, 0 skipped, in two consecutive runs. Files: postgres, forms-reliability, flow, flow-engine, flow-triggers, flow-templates, meet-product-tools, forms-payments, forms-workbooks, forms-freeze. Ran on a disposable local PostgreSQL 17 with a throwaway CA, removed afterwards; never against the Supabase URL in `.env` |
| Combined Sheets/product/expanded Chrome run | 52 of 52 passed (pointer-capture regression and cleanup preserved) |
| Full browser regression | 89 journeys and 1,200 layout checks at 320/375/768/1280 px in light and dark; no runtime errors, overflow or failed journeys. Includes the new Flow v1 journey: templates, builder edit with a field chip, save, publish, turn on, live run timeline, approval on a phone, integrations |

**Defects found and fixed by these gates:**
- A recipient set to “owner” did not see an owner assigned earlier in the same run.
- Single-key `{status}` API responses were treated as HTTP envelopes.
- Two sheet-event regular expressions had lost their backslashes.
- An inserted field chip was placed before the text after a re-render.
- Step labels for screen readers, the run timeline and the retry preview showed raw tokens; they now show [Field name].
- A duplicate unload guard caused a console error.
- Several Flow tests depended on the order of rows created in the same millisecond.

The browser journey's token check covers text the builder generates. Form question labels may legitimately contain Forms' own `{{name}}` piping, and those appear as form-authored labels in the field picker.

No live provider was exercised.
