# Schedora Meet video: progress

Updated 26 October 2026. Design and runbooks: [MEET_VIDEO.md](MEET_VIDEO.md).

## Phases

| Phase | State | Notes |
| --- | --- | --- |
| 0 Inventory and architecture | Done | `MEET_VIDEO.md` §1–2 |
| 1 Secure video foundation | Implemented, mock-verified | Provider boundary, config and gates, rooms, admission, tokens, instant meetings, prejoin and meeting UI. Production stays gated |
| 2 Booking integration | Implemented, mock-verified | `schedora_meet` location, per-attendee links, group rooms, cancel/reschedule/paid handling, emails, calendar host link |
| 3 Credits and metering | Implemented, mock-verified | Lots, ledger, reservations, grants, expiry, verified events, reconciliation, settlement, enforcement |
| 4 Recharge and billing UI | Implemented, simulated payments only | Razorpay Payment Links path tested with a fake Razorpay API; no real payment made |
| 5 Production hardening | Partly done | Headers (backend and Vercel), gates, kill switch, health signals, runbooks. Not done: real LiveKit smoke test, alert wiring, commercial values |
| 6 AWS preparation | Documented only | `MEET_VIDEO.md` §10; nothing provisioned |

## Validation (this checkout)

| Check | Result |
| --- | --- |
| `npm run check` (syntax, backend and frontend) | Pass |
| `npm run sync-shared -- --check` | Pass |
| `npm run vendor-livekit -- --check` | Pass (livekit-client 2.22.4) |
| `npm test` | 110 tests: 108 pass, 2 skipped (opt-in PostgreSQL), 0 fail. Baseline before this work: 88 tests, 87 pass, 1 skipped |
| New tests | `test/meet-video.test.mjs` (8), `test/meet-credits.test.mjs` (9), `test/meet-recharge.test.mjs` (3), `test/postgres.test.mjs` (+2: upgrade SQL, opt-in PostgreSQL concurrency) |
| `npm run browser-check` (Chrome, fake camera/microphone) | Pass: 39 steps including prejoin preview, camera toggle, join with clean failure (fake provider has no media server), guest waiting for host, credits calculator and simulated recharge; 312 layout checks at 320/375/768/1280 px, light and dark |

Mocked vs real: every video test uses the in-memory fake provider; Razorpay recharge uses a fake HTTP API or the `test` provider. **Not verified:** a real LiveKit connection (media, reconnection, screen share, `DisconnectReason` handling, webhook signatures from LiveKit, `ListParticipants`/`RemoveParticipant`/`DeleteRoom` against a real server), real Razorpay Payment Links, refunds and disputes, and PostgreSQL (opt-in tests need `RUN_POSTGRES_TESTS=true` and `DATABASE_URL`). The meeting room UI after connection (grid, controls, end-for-all from the browser) has not run against a real room.

## Also changed

- `backend/src/web.mjs` now serves `design.css`, `product-minimal.css` and `suite-theme.css` locally. They were missing from the static whitelist, so the existing browser check failed on every page at the starting commit (Vercel was unaffected).
- `credit_ledger.reservation_id` cascades instead of setting null, so workspace deletion works with the immutable ledger (covered by a test).

## Unresolved

- Commercial values: allowances per plan and credit pack prices (see `PRICING_WORKSHEET.md`). Production defaults are none; checkout is disabled.
- Self-hosted token revocation behaviour must be verified on the chosen LiveKit version before AWS use.
- Rate limiting is per instance (existing limitation); a multi-instance deployment needs a shared limiter.
- The in-process worker runs every component on one instance; running several API instances would duplicate worker passes (state changes are idempotent, but provider calls could repeat).

## Next concrete step

Create a LiveKit Cloud test project, configure `LIVEKIT_*`, `MEET_VIDEO_PROVIDER=livekit` and the webhook in a staging deployment with `NODE_ENV` not production, run the smoke test in `MEET_VIDEO.md` §9 with two real browsers, and fix anything it finds before setting any production gate.
