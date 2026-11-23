# Product research implementation — 21 November 2026

User authorized implementing Claude's Forms/Meet recommendations and the connected Sheets improvements. Preserve current work. Flow engine/build changes remain on hold; product features must not pretend to support unimplemented Flow triggers or controls.

## Delivery checklist

- Implemented locally: private rules-based Forms lead scoring, thresholds, explanations, response edits, priority sorting over loaded responses, CSV and linked Sheets.
- Implemented locally: live booking sheets and native row actions (send published form/booking links or assign contact owner), with permissions, audit and duplicate-message protection.
- Implemented locally: AI form drafts from descriptions/PDFs and grounded response summaries. Outputs are validated and unpublished; usage is recorded and a shared Forms/Sheets daily budget enforced.
- Implemented locally: Forms payments (see "Continuation results" below).
- Implemented locally: opt-in private respondent resume links with seven-day expiry, hashed tokens, deletion, version checks and clearing saved answers on submission. Activity metrics cover opted-in saved drafts only; inactive does not mean proven abandonment. Uploads, quizzes, sign-in forms and forms using link parameters are excluded.
- Implemented locally: WhatsApp share composer and guidance above ten questions. Automated WhatsApp form receipts remain pending.
- Implemented locally: Meet no-show attendance and optional idempotent recovery email; draft-only qualify-then-book starter with unpublished round-robin event, scored form, routing and paused follow-up. Additional video budget/fallback guidance remains pending.
- Implemented locally: reviewed AI column for up to 20 rows/five literal source columns in standalone Sheets. Results preview before saving as editable text through normal conflict/protection checks. Source formulas must first be copied as values.
- Implemented locally: Twilio WhatsApp adapter with approved templates, booking opt-in/opt-out, reschedule/cancel handling and signed SMS/WhatsApp delivery reports. Live delivery remains unverified: user selected Twilio WhatsApp and confirmed it is not connected yet. Own Indian test number ending 9278 is already supplied. No live messages sent.
- Fixed: Sheets controls remain inactive until workbook data, linked sources and saved view have finished loading.
- Separate gates: raising paid limits needs load evidence and approved entitlements. Google Sheets sync needs its OAuth scope/connection flow and recovery handling. Current limits must not be silently raised.
- Flow-dependent recommendations (new triggers, multi-step automations, delays, approvals, row-run actions) stay recorded but unavailable until that engine is authorized and implemented.

## Verification

Each slice needs meaningful server/permission/version/retry tests and real browser journeys. Run relevant shared-source synchronization. Final regression gates remain the ordinary suite, verified-TLS PostgreSQL tests, Sheets and full browser suites and staging preflight. Do not call provider features connected until an authorized own-account delivery/payment test proves them. No Git commit/push or production cutover is included.

## Twilio setup still required

Use the deployment's existing secret store for `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (SMS), `TWILIO_WHATSAPP_FROM` and `TWILIO_WHATSAPP_CONTENT_SID`. Enable `SMS_PROVIDER=twilio` and/or `WHATSAPP_PROVIDER=twilio` only after sender readiness. `TWILIO_STATUS_CALLBACK_URL` is the external HTTPS API origin plus `/api/messaging/twilio/status`, without query/fragment; it must match the exact address Twilio signs.

The approved utility template must use four variables: 1 invitee name, 2 event title, 3 meeting start, 4 private change link. Only confirmation/before-start invitee reminders are supported. The reminder editor explains that the approved template replaces its free-text body for WhatsApp. After sender/template approval, use the already authorized own-number test and verify actual receipt. The official SDK validates callbacks.

References: [Twilio templates](https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder), [request validation](https://www.twilio.com/docs/usage/security), [delivery reports](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).

## Remaining roadmap

Forms checkout/payment question and its ledger/reconciliation are not implemented by this change. Google Sheets OAuth/sync is not implemented. Automatic WhatsApp form receipts, additional video budget/fallback guidance and reviewed AI post-meeting follow-up remain open. Existing Meet payments and existing AI recap UI are not proof of those new features. Flow and paid-limit gates above still apply. This document is an implementation checkpoint, not a claim that the entire market-research roadmap is complete. Changes are local until a separately verified staging rollout.

## Verified results for this implementation checkpoint

- Ordinary suite: 497 tests, 490 passed, seven optional PostgreSQL checks skipped, zero failures.
- Separate verified-TLS PostgreSQL run: 30 selected checks passed, zero skips/failures. After the booking-tab name collision fix, all 21 affected workbook/product/AI-column checks passed on both SQLite and PostgreSQL.
- Combined Chrome Sheets/product journeys: 47 passed. A final focused rerun also passed all six new product journeys plus setup after the name-collision fix.
- Full existing browser regression: all journeys passed; 1,160 layouts at 320/375/768/1280 pixels in light/dark themes, no runtime errors or overflow.
- Syntax check: 267 files; Sheets type checking and shared-source mirror checks passed. Changed tracked implementation files passed whitespace checks.
- New migrations: 028–032; PostgreSQL upgrades v24–v28. The WhatsApp workflow migration preserves existing email/SMS workflow rows.
- Screenshot evidence: `docs/evidence/product-tools-2026-11-21/product-live-booking-sheet.png` (synthetic local data, not production).
- No live AI-provider, WhatsApp/SMS delivery or payment was tested. No staging rollout, commit, push or production change was performed. The complete research roadmap remains unfinished as listed above.

## Continuation checklist — remaining areas (started 21 November 2026)

Derived from the current code: Meet payments use Razorpay Payment Links (`meet/razorpay.mjs`) with server re-fetch on webhook/verify; Forms downstream actions run from `submitResponse` (contact upsert, `forms.response.created` outbox event for Flow/webhooks, booking handoff); Google OAuth is per-user `integrations` rows (`platform/oauth.mjs`) with calendar scopes; Twilio WhatsApp sends one four-variable booking template; video funding reserves credit blocks per participant (`video/rooms.mjs`); recaps already draft a follow-up email that is never sent.

1. Forms payments
   - [x] Definition `payment` (fixed INR amount, description, payment window) validated in shared logic, import/export and publish checks; immutable once published like the rest of the version.
   - [x] Publish requires Razorpay (or the non-production test checkout); Stripe-only workspaces get a clear problem.
   - [x] Response row `payment_status`; payment request + attempts + provider events tables; PostgreSQL upgrade.
   - [x] Submission defers contact upsert, outbox event, booking handoff and receipts until server-verified payment.
   - [x] Public checkout/verify/status endpoints with a private payment token; retry within the window; expiry.
   - [x] Razorpay webhook routing (`fp_` reference ids), signature check, event idempotency, refund handling.
   - [x] Worker reconciliation of pending attempts; host "check payment" refresh including refunds.
   - [x] Responses list, CSV and linked Sheets payment columns; response limits ignore expired unpaid responses.
   - [x] Builder payment card, public payment receipt/retry UI, test checkout page; Razorpay credential replacement blocked while form payments are pending.
2. Google Sheets sync (one-way)
   - [x] Separate `google_sheets` OAuth provider (`drive.file` only, no granted-scope merge), granted-scope check.
   - [x] Per-form destination (new spreadsheet or one this connection can access), new tab, sync table + row map.
   - [x] Backfill and incremental passes keyed by response ID column, RAW writes (no formula evaluation), update of edited responses, blanking of deleted responses, retry/backoff and 429 handling.
   - [x] Expiry/revocation → reconnect required; disconnect stops syncs; membership and workspace checks every pass.
   - [x] UI card in Responses; docs for edits, deletions and retention.
3. WhatsApp form receipts
   - [x] Separate approved receipt template config; provider template selection without changing the booking template.
   - [x] Form setting (phone question), explicit unchecked respondent opt-in, E.164 validation, consent records.
   - [x] One receipt per response (idempotent), after payment for paid forms; opt-out list honoured for all WhatsApp sends; private withdrawal link and inbound STOP.
   - [x] Status shown as queued / provider accepted / delivered / failed.
4. Meet video guidance
   - [x] Host-facing budget guidance in the room view: participant/time limits, estimate vs. available credits, what happens on exhaustion, recovery steps; no provider/link changes.
5. Reviewed post-meeting AI follow-up
   - [x] Follow-up drafts grounded in transcript quotes (validated verbatim), measured tokens, idempotent request ids, daily budget.
   - [x] Edit with revision checks; explicit review step before sending email or creating tasks; idempotent send/task creation; nothing automatic.

## Continuation results (21 November 2026)

All five remaining areas are now implemented locally (server, UI, migrations, docs and tests). Everything was tested with fake providers and sandbox fixtures. No live payment, message, Google account or AI provider was used. Nothing was committed, pushed or deployed. The checklist above is complete except for the provider steps listed below.

### What was built

1. **Forms payments**: `backend/src/forms/payments.mjs`, migration 033, `frontend/js/forms-payments.mjs`.
   - Fixed INR amounts using the workspace's Razorpay connection.
   - A simulated checkout is available only outside production, and only when Razorpay is not connected.
   - The amount is part of the immutable published version.
   - A response is complete only when the server first records it as paid after reading it back from Razorpay. Only then do the contact, Flow/webhook event, next step and receipt run, once.
   - The browser redirect only triggers a server check.
   - Supporting pieces: webhook event idempotency, a reconciliation worker, retry after a decline, expiry, refund tracking, a review state for mismatches, and Responses, CSV and linked-Sheets columns.
   - Existing Meet payments are unchanged.
   - Details: docs/FORMS.md, "Payments".
2. **Google Sheets one-way sync**: `backend/src/forms/google-sheets.mjs`, migration 035, `frontend/js/forms-google-sheets.mjs`.
   - A separate `google_sheets` OAuth connection with `drive.file` only and no merging of previously granted scopes.
   - Destination is a new spreadsheet or a new tab; rows are mapped by response ID; values are written RAW, so no formula is ever evaluated.
   - Covered: backfill, updates, blanking of deleted responses, backoff and Retry-After, reconnect and disconnect (with revocation), and workspace and owner checks.
   - Two-way sync is not built.
3. **WhatsApp form receipts**: `backend/src/forms/receipts.mjs`, migration 034, Twilio template selection, inbound STOP replies.
   - A separate approved receipt template; an unchecked opt-in with stored consent; international-format numbers only.
   - One receipt per response, with duplicate suppression.
   - A private stop link plus STOP replies, honoured by every WhatsApp send.
   - Status shown as queued, provider accepted, delivered or failed.
4. **Meet video guidance**: `videoGuidance` in `backend/src/video/rooms.mjs`, `frontend/js/meet-video-guidance.mjs`.
   - Hosts see participant and time limits, a credit estimate against spendable credits (the exact balance only for billing readers), what happens when credits run out, and recovery steps.
   - No provider, link or LiveKit change. Details: docs/MEET_VIDEO.md §11.
5. **Reviewed AI follow-up**: `backend/src/ai/followups.mjs`, migration 036, `frontend/js/meet-followups.mjs`.
   - Drafts are grounded in quotes that must appear in the transcript; unsupported items are removed and counted.
   - Token usage is measured, requests are idempotent, and there is a daily budget of 20 per workspace.
   - Edits use revision checks. Sending requires explicit confirmation of the reviewed revision, sends emails and creates tasks idempotently, and never happens automatically. Details: docs/MEET_VIDEO.md §12.

PostgreSQL upgrades v29–v32 cover the new tables and the `responses.payment_status` column. docs/AUTHORIZATION.md and `backend/.env.example` are updated.

### Verification (exact results)

- **Ordinary suite:** 520 tests: 513 passed, 0 failed, 7 optional PostgreSQL tests skipped. This includes 25 new tests: payments 7, receipts 6, Sheets sync 5, follow-ups 3, video guidance 2, plus the updated freeze classification.
- **Verified-TLS PostgreSQL:** 75 of 75 passed, 0 skipped. Covered: `postgres.test`, `forms-reliability`, all new test files, `forms-workbooks`, `forms-lead`, `razorpay`, `twilio` and `forms-freeze`.
  - This ran on a disposable local PostgreSQL 17 with a throwaway CA, which was removed afterwards.
  - It did **not** use `backend/.env`, whose DATABASE_URL points at hosted Supabase.
- **Syntax, type checking and shared sync:** syntax check 280 files; Sheets type checking passed; shared-source sync check passed.
- **Chrome product journeys (`sheets-check --product-only`):** 11 of 11 passed, including the 5 new journeys: paid form with decline then retry, WhatsApp receipt and stop link, Sheets sync, reviewed follow-up, and builder payment settings.
  - Screenshots: `docs/evidence/product-tools-2026-11-21/forms-payment-confirmed.png` and `forms-google-sheets-sync.png`. `product-live-booking-sheet.png` was regenerated from synthetic data.
- **Combined Sheets/product/expanded Chrome run:** 45 passed, 6 failed.
  - The failures are core Sheets editor journeys. The first is a row-height drag on the read-only linked Form Responses tab: pointer capture is lost immediately after the press, so the view preference is never saved. That leaves the session on the read-only tab, and the five following edit journeys time out (conflict, offline, recalculation, fill down, insert row).
  - It reproduced in five runs. It also reproduced with this batch's frontend CSS/routes and its worker and Sheets-signature changes removed, and Chrome is unchanged since the last passing run. Cause not yet found; **open, not claimed as passing.** One core-only run passed all 29.
  - The harness now waits for the linked tab before resizing (the same assertion).
- **Full browser regression:** 88 journeys and 1,160 layout checks at 320/375/768/1280 px in light and dark themes; no runtime errors, overflow or failed journeys. It includes the new host video guidance assertion.
- **Live-provider verification:** not done for Razorpay form payments, the Twilio receipt template, Google Sheets OAuth or AI drafting.

### Provider setup still required

- **Razorpay (form payments):** use the existing workspace connection. The webhook must subscribe to `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.failed` and `refund.processed`. Then run an own-account ₹1 test-key payment, a decline, an expiry and a refund.
- **Twilio receipts:** get a utility template approved with variables 1 name, 2 form title, 3 receipt code, 4 stop link. Set `TWILIO_WHATSAPP_RECEIPT_CONTENT_SID`. Optionally set `TWILIO_INBOUND_URL` (`<API origin>/api/messaging/twilio/inbound`) as the sender's inbound webhook. Then verify on the authorised own number.
- **Google Sheets:** add `drive.file` to an OAuth consent screen and the redirect `<API origin>/api/oauth/google_sheets/callback`. Set `GOOGLE_SHEETS_SYNC=enabled`, plus `GOOGLE_SHEETS_CLIENT_ID/SECRET` (or reuse the Google client). Complete Google verification if required, then test with an own account.
- **AI follow-ups:** they use the existing `ANTHROPIC_API_KEY`.

### Open decisions and limitations

- Payments are fixed-amount INR only, with no per-option pricing, coupons or Stripe for Forms.
- A paid form that routes to a paid Meet event charges twice; publishing does not warn about this yet.
- Late payments complete the response rather than being refunded automatically.
- Payment, receipt and Sheets-sync routes are allowed during an authoring freeze; this is my classification and needs owner confirmation.
- Sheets sync limits: one destination per form; the first 4,999 responses; no Google Picker for files Schedora did not create. Data deleted in Schedora remains in Google's version history and in copies.
- Follow-up recipients are free-form emails confirmed by the reviewer.
- The 6 Sheets editor journey failures above were resolved on 23 November (see "Sheets browser gate fix").

## Sheets browser gate fix (23 November 2026)

This resolves the 6 Sheets journey failures recorded in "Continuation results" above.

### Root cause (from traces, not presumed)

Temporary tracing in the editor's pointer handlers recorded the event sequence; it has since been removed.

**In a failing run:**
1. The press lands on the row-resize handle of the linked Form Responses tab. The editor starts a `row-resize` drag and calls `grid.setPointerCapture`.
2. About 9 ms later, Chrome fires `lostpointercapture` on the grid itself (target = grid, at-target phase). At that moment:
   - the grid is still connected, and is the same element;
   - the grid and the document still have focus;
   - no render, blur or visibility change happens first;
   - no pointermove reaches the grid.
3. The editor had `grid.addEventListener('lostpointercapture', cancelResize)`. That listener discarded the drag.
4. The release (`pointerup`) still arrived at the grid, but with no drag left, so nothing was saved.

**In a passing run:** the same press, then a pointermove and a pointerup, and the height was saved. The only difference was whether Chrome dropped capture.

The editor depended on pointer capture surviving and treated any capture loss as a cancel, even though the button was still held and the release still came. Why Chrome intermittently drops capture here was not established; the editor no longer depends on it.

### Which failures cascaded

The earlier "Saw" diagnostics captured the failure; the cleanup run below establishes which failures were cascades.

- **Root failure:** resizing the linked-tab row (the view preference was never written; `rowHeights` stayed empty).
- **Cascades:** conflict recovery, offline edits, response recalculation, fill down and row insertion. They failed only because the failed journey left the session on the read-only linked tab.
- **Evidence:** with the new cleanup but the **original** editor code, the run gave 28 passed, 2 failed. The two failures were the linked resize journey and the new regression. All 5 editing journeys passed.

### Fix

**In `frontend/js/sheets.mjs`, each grid drag now owns its pointer:**
- Applies to cell selection, row/column header selection, column resize and row resize.
- `ownPointer` adds window `pointermove`/`pointerup`/`pointercancel` listeners for that pointer ID, using an AbortController. Pointer capture is still requested, but only as a hint.
- `releasePointer` removes the listeners at release or cancel, and also if the page context is gone.
- **Releasing:** the final size comes from the release position, so it no longer depends on a move event having been delivered. A mouse move with no buttons pressed finishes the drag, for example after a release outside the window.
- **Cancelling:** only Escape or `pointercancel` cancels a resize. A lost capture alone no longer does.

**Preserved:**
- Read-only canonical response data. Linked-tab sizes stay a per-viewer view preference (`view.rowHeights` / `view.widths`, `saveView`).
- Editable-sheet resizing through synced `sheet-prop` operations, undo/redo, zoom scaling, Escape cancellation and reload persistence.
- The fill handle already used the same document-listener pattern.

### Test changes (`backend/scripts/sheets-check.mjs`)

- **Tracing removed:** Codex's temporary tracing (`window.resizeTrace`, `originalCapture`, "Linked resize events:") and my app-side tracing are both gone.
- **Assertions unchanged:** the resize journey asserts the same things. It now runs in try/finally and returns to Sheet1/A1 if it fails, so it can't hide later independent failures.
- **New regression,** "a resize survives losing pointer capture mid-drag and a release outside the grid":
  - Removes the grid's pointer capture mid-drag on purpose. Then it checks that the linked row height changes, survives a reload and keeps the tab read-only.
  - On Sheet1, it drags a column edge, drops capture, and releases over the toolbar, outside the grid. Then it checks that the width is saved once, a later move doesn't keep resizing, and one undo restores it.
  - It also cleans up in finally.
  - **Against the original code it fails deterministically.**

### Verification (exact results)

| Check | Result |
| --- | --- |
| `npm run check` | 281 files checked |
| `npm run typecheck:sheets` | exit 0 |
| `npm run sync-shared -- --check` | in sync |
| `npm run sheets-check -- --expanded --products`, 5 consecutive runs | 52/52 passed each time, 0 failures (previously 45 passed, 6 failed) |
| Unit suite | 520 tests: 513 passed, 0 failed, 7 optional PostgreSQL skipped |
| Full browser regression | 88 journeys and 1,160 layout checks at 320/375/768/1280 px in light and dark; no runtime errors, overflow or failed journeys |

### Remaining limitations

- Why Chrome drops capture is not established. The editor no longer depends on capture surviving.
- The harness still sends CDP `mouseMoved` with `button: 'none'` during existing drags; it was left as is, and the editor now handles that path.
- **Separate from this:** live provider verification (Razorpay, Twilio, Google, Anthropic) is still outstanding, as listed above. Nothing was committed, pushed or deployed.
