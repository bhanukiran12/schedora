# Schedora Meet video (LiveKit) and Meet credits

Status (26 October 2026): implemented and tested against an in-memory fake provider and simulated payments. **Not production-ready.** Nothing has been verified against a real LiveKit project or real Razorpay payments, and no commercial prices are approved. Production starts with video **off**. See [MEET_VIDEO_PROGRESS.md](MEET_VIDEO_PROGRESS.md) for validation results and next steps.

"Meet" still means scheduling. Native video is an additional booking location (`schedora_meet`) plus instant meetings. All existing URLs, the `/book → /meet` redirect, booking `meetings` semantics, and the Google Meet/Zoom/Teams/manual-link locations are unchanged.

## 1. Inventory at the starting commit (`d3a5007`)

| Area | Where | What existed |
| --- | --- | --- |
| App wiring, providers | `backend/src/app.mjs` | Injected clock, email/SMS, fetch, payments, AI, worker; custom HTTP server |
| Routing, auth guard, CSRF/origin | `backend/src/api.mjs`, `http.mjs` | `member(ctx, permission)` resolves membership server-side; origin + `X-CSRF-Token` checks on mutations; per-IP fixed-window rate limits (in memory, single instance) |
| Scheduling API | `backend/src/api-meet.mjs`, `meet/*.mjs` | One-on-one/group/collective/round-robin, availability, conflict trigger on `meeting_hosts`, holds, payments (Stripe/Razorpay links per workspace), cancel/reschedule via hashed manage tokens, workflows, calendars, polls, analytics |
| Location types | `meet/event-types.mjs` | `video`, `in_person`, phones, `custom`, `google_meet`, `zoom`, `teams`; auto links via `platform/oauth.mjs` worker sync |
| Auth and teams | `platform/auth.mjs`, `platform/workspaces.mjs` | Sessions (hashed), owner/admin/member `PERMISSIONS`, workspace isolation (404 for non-members) |
| Billing | `billing/plans.mjs`, `entitlements.mjs`, `webhooks.mjs`, `razorpay.mjs` | Meet/Forms/Flow/Suite entitlements, monthly quotas (`usage_counters`), normalized billing events, Razorpay monthly subscription checkout and verified webhook, grace periods; prices unset |
| Database | `db.mjs`, `migrations/*.sql`, `postgres*.mjs` | SQLite (`BEGIN IMMEDIATE`) and PostgreSQL (schema generated from SQLite migrations on first init; later tables added by explicit upgrade steps; every transaction takes a global advisory lock); transactions must be synchronous |
| Worker | `worker.mjs` | One in-process loop: holds, outbox, Flow runs, calendars, email, webhooks, retention |
| Headers | `web.mjs`, `frontend/vercel.json` | `Permissions-Policy: camera=(), microphone=()`, strict CSP (`connect-src 'self'`) on every page |
| Frontend | `frontend/app.js`, `js/*.mjs` | Static ES modules, SPA routing, no build step; `studio.mjs`/`demo-store.mjs` are demo-only |

Absent at that commit: native video, any LiveKit code, credit balances, a credit ledger, credit recharge. Subscriptions had only `current_period_end` (no period start, no interval); Razorpay plans were monthly-only.

## 2. Architecture

```
browser (prejoin, room)  ──POST /join──▶  API ──(txn: authorize, limits, reserve credits)──▶ DB
        │                                   └──(after txn) provider.createRoom / issueToken
        └── WebSocket/WebRTC ──▶ LiveKit ──webhook──▶ /api/meet-video/webhooks/{deployment}
                                      ▲                    (verify raw body → persist → 200)
worker every 2s: process events → enforce (renew/expire/remove/end) → provider ops (retry) → reconcile (30s) → settle
```

New backend modules (all under `backend/src/video/`):

- `config.mjs` — configuration, validation, production gates, meeting-page CSP/permissions.
- `provider.mjs` — provider boundary: `createRoom`, `issueToken`, `listParticipants`, `removeParticipant`, `deleteRoom`, `verifyWebhook`, `capabilities`. LiveKit (Cloud and self-hosted share code) and an injectable fake.
- `rooms.mjs` — rooms, attendance credentials, admission, booking hooks, event processing, durable provider operations, enforcement, reconciliation, settlement, health.
- `credits.mjs` — wallet: lots, allocations, reservations, immutable ledger, grants, expiry, reconciliation.
- `recharge.mjs` — package catalog, calculator, Razorpay Payment Link orders, refunds/chargebacks, test provider.
- `api-video.mjs` — routes. Migration `005_meet_video.sql`; PostgreSQL upgrade step `postgres_v4_meet_video`.

Frontend: `frontend/js/meet-video.mjs` (prejoin, meeting, Video tab, credits panel) and the vendored SDK `frontend/vendor/livekit-client.esm.mjs`.

### Data model (migration 005)

| Table | Purpose |
| --- | --- |
| `video_rooms` | One meeting session per scheduled meeting occurrence (`UNIQUE meeting_id`, shared by group bookings) or instant meeting. Stores `provider`, `deployment` and `room_name` permanently (`UNIQUE(deployment, room_name)`), opaque `public_id`, status, join window, `max_ends_at` |
| `video_invites` | Guest attendance credentials: `token_hash` only. The secret is `HMAC(APP_ENCRYPTION_KEY-derived key, id:nonce)`, re-derivable for emails, never stored. One per booking (`UNIQUE booking_id`) or host-created links; `seats`, `expires_at`, `revoked_at` |
| `video_participants` | Admissions: principal (member/guest), role (host/participant), provider identity (`UNIQUE(room_id, identity)`), token expiry, `funded_until`, funding state, status |
| `video_usage_intervals` | One row per provider participant session (`UNIQUE(room_id, provider_sid)`): provider join/leave times, `last_seen_at` from reconciliation |
| `video_provider_events` | Verified webhook inbox (`UNIQUE(deployment, event_id)`), processed idempotently |
| `video_provider_ops` | Durable create/remove/delete operations with retries and backoff |
| `credit_accounts` | Per-workspace cache of available/reserved units, refreshed in every balance transaction; `restricted_reason` |
| `credit_lots` | Subscription, evaluation, purchase and adjustment lots; `UNIQUE source_key` (grant idempotency); CHECKs: no negative amounts, `granted = available + held + consumed + expired + revoked`, allowance lots must expire and purchased lots must not |
| `credit_reservations`, `credit_allocations` | Reservation windows per participant and which lots fund them |
| `credit_ledger` | Immutable entries (`UPDATE` blocked by trigger in SQLite and PostgreSQL), `UNIQUE idempotency_key`; `units` = change to total balance, `held_delta` = change to reserved |
| `video_usage_records` | One settlement record per reservation window (`UNIQUE usage_key`) with connected ms, units charged, unfunded units, estimated cost |
| `credit_recharge_orders`, `credit_payment_events` | Credit purchases (separate from `billing_checkouts` and booking payments) and applied refund/dispute events |

All rows reference `workspaces(id) ON DELETE CASCADE`; deleting a workspace deletes its wallet and video data.

## 3. Admission and token rules

Decided on the server inside one database transaction; nothing from the client is trusted as role, identity, room name or billing owner.

1. Video enabled for this deployment, kill switch `off`, provider deployment configured.
2. Room not canceled/ended, `join_opens_at ≤ now < max_ends_at`. Scheduled: the booking `meeting` is still active.
   - Join window: start − `MEET_VIDEO_JOIN_EARLY_MINUTES` (10). End: `min(end + MEET_VIDEO_OVERTIME_MINUTES (30), start + MEET_VIDEO_MAX_ROOM_MINUTES (180))`, never before the scheduled end. Instant: now to now + max room minutes.
3. **Members** (session only; API keys cannot mint tokens): current membership of the room's workspace. Host = owner/admin, an *active* host of the booking meeting, or the creator of an instant room. Non-host members may join instant rooms as participants; scheduled rooms are private to hosts/admins (404 otherwise).
4. **Guests**: attendance credential valid, not revoked, not expired; for booking credentials the booking must be `confirmed` (paid bookings only after payment), not canceled or rescheduled. Error precedence gives the specific reason (canceled, rescheduled, payment pending, revoked, ended). Guest pages show title, scheduled time and workspace branding only — no invitee name/email, no participant list, no room id.
5. `guest_policy = host_first` (default): guests are admitted only after a host is *connected* according to the provider (webhook), not merely admitted.
6. Limits (new admissions only): room participants (`MEET_VIDEO_MAX_PARTICIPANTS`, 10), seats per credential (booking: invitee + guests, max 11; link: 1–20), workspace participants (25), workspace concurrent rooms (3), global participants (200), monthly estimated-cost budget. Active = connected, or admitted with an unexpired token.
7. Entitlement: an active Meet or Suite entitlement. Purchased credits alone never grant access.
8. Funding: the monthly allowance is granted if due, then one reservation block (`MEET_VIDEO_RESERVATION_BLOCK_SECONDS`, 600 participant-seconds) must be reserved before a token is issued; otherwise `402 insufficient_credits`.
9. Duplicate tabs: a member's identity is stable per room (`m-<hash>`), so a second tab replaces the first connection (LiveKit disconnects it with `DUPLICATE_IDENTITY`) and reuses the same funding; no double charge. Guests get a new identity per seat; a reload in the same tab resumes its seat (tab-scoped `sessionStorage` seat id, useless without the credential).
10. Removal: a host-removed member cannot rejoin that room; a host-removed guest's credential (all its seats) is revoked. People removed for credits, time limits or lost access may rejoin once allowed again.

Tokens: issued after the transaction (provider calls never run inside a transaction), TTL `MEET_VIDEO_TOKEN_TTL_SECONDS` (120), grants limited to `roomJoin` for that one room, subscribe, publish camera/microphone/screen-share(-audio) only; `canPublishData`, `canUpdateOwnMetadata`, `roomAdmin`, `roomList`, `roomCreate`, `roomRecord`, recorder all false; no metadata (no PII). Returned only in `no-store` JSON; never in URLs, storage, analytics or logs (request logs record route pattern and status only). The browser drops its copy after connecting. Meeting pages send `Referrer-Policy: no-referrer`.

LiveKit token lifecycle (verified in LiveKit docs, October 2026): expiry only limits the *initial* connection; connected clients receive server-refreshed tokens (10-minute validity) for reconnects. Therefore application state alone never disconnects anyone. Enforcement uses provider operations: `RemoveParticipant` for host removal, budget exhaustion, cancellation and lost access; `DeleteRoom` for end-for-everyone, max duration and kill switch; plus application checks on every later admission and on every provider `participant_joined` (unknown/removed identities and non-standard participant kinds are removed again; recreated rooms of ended meetings are deleted again).

## 4. Booking integration

- Location type `schedora_meet` ("Schedora Meet"). Offered in the editor only when video is enabled; bookings for it keep working when video is disabled (the join page explains it is unavailable).
- On confirmation (inside the booking transaction, after payment for paid types) `ensureBookingVideo` creates the room row for the meeting (idempotent, shared by group bookings) and the booking's credential. No provider call; the provider room is created at the first admission (or retried by the worker).
- Emails: invitee and guests get their attendance link (`Location: Schedora Meet: <link>`); hosts get the signed-in host link; reminders and workflows (`{{video_url}}` placeholder) resolve to the attendee link at send time. Host calendar events (Google/Microsoft sync) include the host link only. The `.ics` location reads "Schedora Meet video (join link sent with confirmation)".
- Views: manage page and confirmation show **Join video meeting**; the host meetings list shows **Join video** (host link).
- Cancellation revokes that booking's credential and removes any guest admitted with it; when the meeting has no attendees left, the room is canceled and the provider room deleted. Rescheduling cancels the old booking (old link → "rescheduled") and confirms a new meeting with a new room and link. Host changes take effect at the next admission (hosts are read from `meeting_hosts`).
- No-shows cost nothing: only connected time is metered. Availability, conflicts, quotas, notifications and Flow events are unchanged (verified by the existing test suite).

## 5. Credit policy

**Only purchased credits carry forward. Subscription credits reset monthly.**

- Units: internal unit = 1 participant-second (integer). Customer credit = 1 participant-minute = 60 units. Displays round down to 0.1 credit.
- Allowance (configurable, `MEET_VIDEO_ALLOWANCES`, credits per period): keys `meet`, `suite` (other plans get none), `trial`, `evaluation` (open billing mode). Production default: none.
- Allowance periods are monthly windows anchored on the subscription's `current_period_end` (`allowanceWindow`): for a monthly plan one window per billing period; for an annual plan twelve windows, each one month long. No extra subscription columns are needed; the anchor is the paid-through date.
- One grant per period: the grant covers the highest eligible allowance; any allowance lot already covering `now` counts toward it, whichever subscription created it, so retries, webhook replays, overlapping subscriptions and plan changes never duplicate. `UNIQUE source_key` is the final guard.
- Eligibility: subscription `active` or `trialing` and `current_period_end > now`. `past_due`/grace, failed renewals, expired periods and cancellations open no new period. A late successful renewal grants the then-current period once.
- Upgrade: the current period is topped up to the higher allowance once. Downgrade: unchanged until the next period. Cancellation: no further periods; existing allowance expires at its period end; video access needs an entitlement anyway. Trial: `trial` allowance (default 0). Subscription refunds: no allowance claw-back (subscriptions are handled by the existing billing code).
- Expiry: unused allowance expires at its period end (ledger `expire`). Purchased and adjustment lots never expire automatically and survive renewal, plan changes, cancellation and access restrictions.
- Spending order: subscription/evaluation lots (earliest expiry first) → adjustments → purchased (oldest first).
- Booking quotas (`usage_counters`) are untouched.

## 6. Metering, settlement and enforcement

- Billing never trusts the browser. Connected time comes from provider timestamps (`joinedAt(Ms)` in participant info, webhook `createdAt` seconds), presence from `ListParticipants`. LiveKit exposes no historical usage API; none is assumed.
- Webhooks: `WebhookReceiver.receive(rawBody, Authorization)` verifies the JWT and the body's SHA-256; the event is stored (`UNIQUE(deployment, event id)`) before the 200; processing is ordered by provider time and idempotent. Handled: duplicates, out-of-order (a leave without its join rebuilds the interval from the provider's join time), missing leave (reconciliation closes at the last provider-confirmed presence; a later authentic leave event corrects it), missing join (reconciliation opens the session from the provider's join time), reconnects (a new SID for the same identity closes the old session at the new join time; usage is the union of sessions, so overlaps are never double counted), clock skew (events more than 5 minutes in the future or before room creation are rejected; join times are clamped), worker crashes (the inbox and ops tables are durable).
- Participant types: only `standard` participants are admitted. Ingress, egress, SIP and agent participants are removed; recording, transcription, telephony, streaming and bots are not part of this release and are not granted.
- Reservations: each connected participant is funded by sequential, non-overlapping windows of up to 600 participant-seconds. The worker renews when less than `MEET_VIDEO_RENEW_BEFORE_SECONDS` (240) remains. A window never outlives the allowance lot funding it (it ends at the period boundary and the next window draws from the next period's lots). If renewal fails, the time already reserved is the funded grace period; a low-credit notice is shown to hosts and emailed to the owner once per room; at `funded_until` the participant is removed at the provider.
- Settlement: a window settles once (`status held → settled`) after it ends plus `MEET_VIDEO_FINALIZE_DELAY_SECONDS` (300) and when all overlapping sessions are closed or confirmed present past the window end (unknown presence waits, at most 24 hours, then only provider-confirmed presence is charged). Consumed = `ceil(connected ms / 1000)` capped at the reservation; the remainder is released, or expires if its lot expired — a release never resurrects expired credits. Rounding happens once per window: at most 1 participant-second per 10 minutes.
- Overrun (connected beyond every funded window because removal was delayed) is charged once per participant after they leave, from spendable credits; anything uncovered is recorded as `units_unfunded` and logged (`video_unfunded_usage`). Balances never go negative.
- Limits enforced by the worker: max room duration (room ended and deleted at `max_ends_at`), unfunded participants removed, lost access removed, kill switch `terminate` ends all rooms. LiveKit rooms are created with `maxParticipants`, `emptyTimeout` 300 s and `departureTimeout` 20 s. The browser publishes at most `MEET_VIDEO_MAX_VIDEO_HEIGHT` (720p) with simulcast and dynacast; screen share is capped at 15 fps.
- Costs: `MEET_VIDEO_COST_PER_PARTICIPANT_MINUTE_MICROS` gives an *estimate* stored per usage record; it is not a provider invoice. `MEET_VIDEO_MONTHLY_COST_BUDGET_MICROS` stops new admissions when settled estimates plus held reservations reach it.

### Exposure analysis

Normal operation (provider and webhooks healthy, worker running):

- Credits: no overspend is possible. Every admission reserves before its token exists; all transactions are serialized (SQLite write lock, PostgreSQL global advisory lock), and CHECK constraints reject negative balances. Tested with 12 concurrent admissions against 5 blocks.
- Time beyond funding: worker tick (2 s) + provider removal latency (~1 s) ⇒ a few participant-seconds per removed participant, charged as overrun or recorded unfunded.
- Token issued but unused: credits stay reserved up to TTL + 2 minutes (≈4 minutes), then return.
- Replayed/forged joins: removed on the `participant_joined` webhook (seconds) or at the next reconciliation (≤ 30 s). They are never billed to a customer (no admission); the provider-cost exposure is that time.
- Auto-created rooms: a valid token can make LiveKit recreate a deleted room. `room_started` for an ended room deletes it again; unknown rooms are deleted.

Remaining risks (outages):

- LiveKit API unavailable: removals, deletions and reconciliation cannot run; participants already connected continue beyond funding for the outage duration (recorded as overrun/unfunded). Operations retry with backoff for ~hours (`failed` after 30 attempts → alert).
- Webhooks lost: reconciliation (30 s) still detects presence; leave times become "last confirmed presence" (customer is not overcharged).
- Database or worker down: new admissions fail; existing sessions continue on the provider without renewal or removal until the worker returns, then overrun is charged or recorded.
- The in-memory rate limiter is per instance (existing limitation).

Self-hosted LiveKit (AWS) residual replay window: LiveKit Cloud revokes a removed participant's token immediately (10-minute cutoff). Self-hosted LiveKit documents no such revocation. A removed participant can reconnect with their original token until it expires (≤ 120 s after issuance) and with the server-refreshed token (10-minute validity). Each reconnect is detected by webhook and removed again, and room deletions are repeated if a token recreates a room. Mitigations required before an AWS rollout (gate `MEET_VIDEO_SELF_HOSTED_REVIEWED`): set `room.auto_create: false` in the LiveKit server config and create rooms only through the API; verify on the exact LiveKit version whether `UpdateParticipant` permission revocation or room-scoped measures stop refreshed-token reconnects; measure webhook latency; keep the token TTL at or below 120 s. The provider reports `capabilities.removeRevokesToken = false` for self-hosted deployments.

## 7. Recharge and calculator

- Server-owned catalog (`MEET_VIDEO_PACKS`, versioned by `MEET_VIDEO_CATALOG_VERSION`): `{id, name, credits, amount_minor, currency: "INR", enabled}`. Development and tests use three packs labelled "development fixture" that only work with the simulated `test` billing provider; fixtures are rejected in production. Custom amounts are not offered.
- Checkout is available only when: billing provider `razorpay` is configured with a webhook secret, `MEET_VIDEO_RECHARGE_ENABLED=true`, `COMMERCIAL_BILLING_CONFIRMED=true`, `BILLING_MODE=enforced`, and the pack is not a fixture.
- Flow: owner only, `Idempotency-Key` required; the order (package snapshot, credits, amount, currency, catalog version) is stored `creating` before calling Razorpay; a hosted Payment Link is created with `reference_id = order id` and notes binding the workspace; an ambiguous failure leaves the order `uncertain`, and refresh recovers the link by `reference_id` instead of creating a second one.
- Credits are granted only after the server fetches the link from Razorpay and validates: reference, amount, currency, workspace, `status = paid`, a captured `pay_…` payment, and that the payment is not linked to another order. Triggers: the verified platform webhook (`payment_link.paid`, same endpoint and secret as subscriptions), the owner's **Check payment** button, the return redirect (which itself proves nothing), and the worker (orders open/uncertain for 10+ minutes). Exactly once: unique lot `source_key` plus the order state change in one transaction.
- Refunds (`refund.processed`, verified by fetching the refund) reverse unspent credits proportionally; disputes lost (`payment.dispute.lost`) reverse the whole purchase. Credits already used are recorded as `uncollectable_units`, and the account is flagged (`restricted_reason`), which pauses further purchases until support clears it. Balances never go negative; the purchased balance from other purchases is preserved.
- Calculator: participants × minutes = participant-minutes = credits required; shows available credits, shortfall and the smallest covering pack, and notes that admission also needs one reservation block per person.
- Records stay separate: subscriptions (`subscriptions`, `billing_checkouts`), invitee booking payments (`bookings.payment_*`, workspace's own Stripe/Razorpay), Meet credit purchases (`credit_recharge_orders`).

## 8. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEET_VIDEO_PROVIDER` | `fake` (dev), `none` (prod) | `livekit`, `fake` (refused in production), `none` |
| `MEET_VIDEO_ENABLED` | dev on, prod off | Explicit feature gate; production also needs the gates below |
| `MEET_VIDEO_DEPLOYMENT` | `livekit-cloud` | Deployment id stored on every room; webhook URL `/api/meet-video/webhooks/<id>` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | — | Server-only. URL must be `wss://` (`ws://localhost` only in development) without path/query; Cloud requires `*.livekit.cloud`; secret ≥ 32 characters |
| `LIVEKIT_HOSTING` | `cloud` | `cloud` or `self_hosted` |
| `MEET_VIDEO_DRAINING_DEPLOYMENTS` | `[]` | JSON `[{id,url,apiKey,apiSecret,hosting}]` kept so existing rooms finish on the deployment that created them |
| `MEET_VIDEO_KILL_SWITCH` | `off` | `admissions` (no new admissions) or `terminate` (also ends every open room) |
| `MEET_VIDEO_WEBHOOK_CONFIRMED`, `MEET_VIDEO_SMOKE_CONFIRMED`, `MONITORING_CONFIRMED`, `MEET_VIDEO_SELF_HOSTED_REVIEWED` | — | Production gates (with `APP_ENCRYPTION_KEY`); missing gates keep video off and appear in release warnings |
| `MEET_VIDEO_ALLOWANCES` | dev `{"evaluation":300,"meet":1000,"suite":3000,"trial":0}`, prod `{}` | Credits per allowance period |
| `MEET_VIDEO_PACKS`, `MEET_VIDEO_CATALOG_VERSION`, `MEET_VIDEO_RECHARGE_ENABLED` | dev fixtures, prod none | Credit packs |
| `MEET_VIDEO_TOKEN_TTL_SECONDS` 120 · `MEET_VIDEO_RESERVATION_BLOCK_SECONDS` 600 · `MEET_VIDEO_RENEW_BEFORE_SECONDS` 240 · `MEET_VIDEO_FINALIZE_DELAY_SECONDS` 300 · `MEET_VIDEO_RECONCILE_SECONDS` 30 | | Timing |
| `MEET_VIDEO_JOIN_EARLY_MINUTES` 10 · `MEET_VIDEO_OVERTIME_MINUTES` 30 · `MEET_VIDEO_MAX_ROOM_MINUTES` 180 | | Join window and room duration |
| `MEET_VIDEO_MAX_PARTICIPANTS` 10 · `MEET_VIDEO_MAX_CONCURRENT_ROOMS` 3 · `MEET_VIDEO_MAX_WORKSPACE_PARTICIPANTS` 25 · `MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS` 200 | | Limits |
| `MEET_VIDEO_GUEST_POLICY` | `host_first` | or `open` |
| `MEET_VIDEO_MAX_VIDEO_HEIGHT` | 720 | Highest published camera resolution |
| `MEET_VIDEO_LOW_BALANCE_CREDITS` | 30 | Low-credit notice threshold |
| `MEET_VIDEO_COST_PER_PARTICIPANT_MINUTE_MICROS`, `MEET_VIDEO_COST_CURRENCY`, `MEET_VIDEO_MONTHLY_COST_BUDGET_MICROS` | 0 | Operational cost estimate and budget (0 = no budget) |
| `MEET_VIDEO_CONNECT_SRC` | — | Extra `https://`/`wss://` origins for the meeting-page CSP (self-hosted TURN/edge hosts) |

Public config (`/api/config`) exposes only `video.enabled`, units per credit and max video height.

## 9. Deployment and operations

**LiveKit Cloud setup.** Create a project; create an API key/secret for this backend only; set `LIVEKIT_URL=wss://<project>.livekit.cloud`. Add a webhook to `https://<api host>/api/meet-video/webhooks/<MEET_VIDEO_DEPLOYMENT>` signed with the same API key. Do not enable recording/egress, ingress, SIP, agents or other billable features for this project.

**Headers.** Only `/meet/room/*` and `/meet/join/*` get `camera=(self) microphone=(self) display-capture=(self)`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and a CSP adding `media-src 'self' blob: mediastream:`, `worker-src 'self' blob:`, `img-src … blob:` and the provider origins in `connect-src`. Local/single-host serving computes this from config (`app.meetingCsp`). Vercel uses the static rule in `frontend/vercel.json` with `https://*.livekit.cloud wss://*.livekit.cloud` (Cloud picks regional edges); a test keeps it equal to the backend's. For self-hosted LiveKit, edit that rule to the exact origins. Every other page keeps `camera=()`, `microphone=()` and `connect-src 'self'`. Meeting pages are always full page loads (the SPA does not intercept links to or from them, and the service worker never serves them).

**Browser SDK.** `livekit-client` is pinned (devDependency, exact version) and vendored by `npm run vendor-livekit` into `frontend/vendor/livekit-client.esm.mjs` with a version and SHA-256 header; `npm run vendor-livekit -- --check` runs in CI. The bundle is self-contained and uses no `eval`. `livekit-server-sdk` is pinned in dependencies; `package-lock.json` is committed.

**Migrations.** SQLite applies `005_meet_video.sql` at start-up. PostgreSQL applies `postgres_v4_meet_video` (tables, foreign keys, indexes, ledger immutability trigger) at start-up, once, for both new and existing databases. Back up first (`npm run backup` / provider snapshot); the migration only adds tables.

**Secrets and logs.** LiveKit and Razorpay secrets stay in server environment variables. Tokens are never logged; attendance secrets are never stored; request logs contain route patterns, not paths with tokens.

**Health and alerts** (`GET /api/health` → `video`): alert when `failed_ops > 0`, `stuck_ops > 0` for 10 minutes, `pending_events > 100` or growing for 5 minutes, `overdue_settlements > 0` for 1 hour, `unfunded_units_24h > 0`, `connected_participants` near `MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS`, or the worker `last_tick_at` is older than 1 minute. Log events: `video_provider_op_failed`, `video_reconcile_failed`, `video_event_failed`, `video_unfunded_usage`, `recharge_mismatch`, `recharge_reversal_uncollectable`. The worker now raises these as operator alerts (`video_*` codes in [OPERATIONS.md](OPERATIONS.md#operator-alerts)); webhook backlog is measured by age (15 minutes) rather than count, and the worker heartbeat needs an external check on `worker.stale`. Delivery to a real channel is unverified until the test alert is confirmed in production.

**Kill switch and rollback.** `MEET_VIDEO_KILL_SWITCH=admissions` stops new joins (existing meetings finish); `terminate` also ends every open room through the provider. To roll back the feature, set `MEET_VIDEO_ENABLED=false` (scheduling continues; native-video bookings show "unavailable"). Keep the tables: they hold the ledger. Rolling back the code past migration 005 is safe for older code (it ignores the new tables).

**Recovery.** Pending payment: owner presses **Check payment**, or the worker refreshes open/uncertain orders older than 10 minutes; an `uncertain` order with no link at Razorpay after 15 minutes is closed as failed. Pending settlement: settlements wait for presence to be known; if `overdue_settlements` persists, check provider reachability; after 24 hours windows settle on provider-confirmed presence. Wallet integrity: `reconcileWallet(app, workspaceId)` must return `[]`; mismatches indicate manual database edits. Audited adjustments: `adjustCredits(app, workspaceId, { credits, note, actor, key })` (operator console only; no public endpoint).

**Retention.** Processed provider events and completed operations are deleted after 30 days; participant display names are replaced after the workspace retention period. The ledger, lots and usage records are financial records and are kept for the life of the workspace.

**Real-provider smoke test (before `MEET_VIDEO_SMOKE_CONFIRMED=true`).** With a LiveKit Cloud test project and two browsers: host joins an instant meeting; guest joins with a link; audio, video, screen share (stop it from the browser's own control), people list, mute; host removes the guest (guest disconnected, link revoked, rejoin refused); host ends for everyone; confirm webhooks arrive (`/api/health`), intervals match wall time ±2 s, and the wallet reconciles; book a `schedora_meet` appointment, join from the email links, cancel it and confirm both are disconnected; exhaust a small adjustment balance and confirm removal at the funded time; set the kill switch to `terminate` mid-meeting.

## 10. AWS self-hosted LiveKit migration plan (not executed)

Changing environment variables alone does not complete a migration. Required work:

1. **Infrastructure:** LiveKit server on EC2 (host networking) or EKS with `hostNetwork`; public IPs per node; Redis (ElastiCache) for multi-node routing; TURN/TLS (LiveKit embedded TURN on 443/TLS or a separate TURN service) for restrictive networks; Route 53 records; ACM/Let's Encrypt certificates for the signaling and TURN hostnames.
2. **Networking:** UDP 50000–60000 (or the configured RTC range), UDP/TCP 7881, TCP 443 (TURN/TLS), 7880 behind a TLS load balancer for signaling; security groups limited to these; NAT/external IP set correctly.
3. **Server configuration:** `room.auto_create: false`, webhook URL and API key, `room.max_participants`, `empty_timeout`, codec and bitrate limits matching `MEET_VIDEO_MAX_VIDEO_HEIGHT`, logging/Prometheus metrics.
4. **Regional placement:** an India region (ap-south-1) for current customers; latency tests from customer networks; decide single vs multi-region.
5. **Capacity:** load test participants per node with simulcast at 720p; autoscaling on CPU and bandwidth; drain behaviour for node replacement.
6. **Bandwidth cost:** model egress (≈ participants × subscribed streams × bitrate) and compare with the Cloud bill; set `MEET_VIDEO_COST_PER_PARTICIPANT_MINUTE_MICROS` for the new deployment.
7. **Monitoring and ownership:** node health, packet loss, TURN usage, webhook delivery, on-call ownership, upgrade policy, backups of configuration (LiveKit keeps no customer data at rest; Redis holds routing state only).
8. **Application:** add the new deployment as `MEET_VIDEO_DEPLOYMENT` with `LIVEKIT_HOSTING=self_hosted`; move the Cloud deployment into `MEET_VIDEO_DRAINING_DEPLOYMENTS` so existing rooms finish there (rooms never move providers once provisioned); update the Vercel meeting CSP and `MEET_VIDEO_CONNECT_SRC` with the new origins; complete the revocation review (section 6) and set `MEET_VIDEO_SELF_HOSTED_REVIEWED=true`.
9. **Rehearse:** staging with both deployments; verify removal/termination capability differences, webhook verification, reconciliation and settlement; rehearse rollback by swapping the deployment variables back (new rooms return to Cloud; AWS rooms drain).
