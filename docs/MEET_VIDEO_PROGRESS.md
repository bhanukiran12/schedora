# Schedora Meet video: progress

Updated 26 October 2026. Design and runbooks: [MEET_VIDEO.md](MEET_VIDEO.md).

## Phases

| Phase | State | Notes |
| --- | --- | --- |
| 0 Inventory and architecture | Done | `MEET_VIDEO.md` §1–2 |
| 1 Secure video foundation | Implemented; local Cloud acceptance passed | Real Cloud synthetic audio/video, screen publishing, controls, guest removal/rejoin denial and room termination. Production stays gated |
| 2 Booking integration | Implemented, mock-verified | `schedora_meet` location, per-attendee links, group rooms, cancel/reschedule/paid handling, emails, calendar host link |
| 3 Credits and metering | Implemented; local Cloud usage settled | Six test reservations settled, no held reservations, zero unfunded units and no reconciliation mismatches; failure scenarios remain covered by fake-provider tests |
| 4 Recharge and billing UI | Implemented, simulated payments only | Razorpay Payment Links path tested with a fake Razorpay API; no real payment made |
| 5 Production hardening | Partly done | Local real Cloud smoke and signed webhook delivery passed. Permanent hosted webhook, alert wiring, PostgreSQL verification and commercial values remain |
| 6 AWS preparation | Documented only | `MEET_VIDEO.md` §10; nothing provisioned |

## Validation (this checkout)

| Check | Result |
| --- | --- |
| `npm run check` (syntax, backend and frontend) | Pass |
| `npm run sync-shared -- --check` | Pass |
| `npm run vendor-livekit -- --check` | Pass (livekit-client 2.22.4) |
| `npm test` | Current combined checkout: 127 tests, 124 pass, 3 skipped (opt-in PostgreSQL), 0 fail. Includes concurrent Forms reliability work |
| New tests | `test/meet-video.test.mjs` (8), `test/meet-credits.test.mjs` (9), `test/meet-recharge.test.mjs` (3), `test/postgres.test.mjs` (+2: upgrade SQL, opt-in PostgreSQL concurrency) |
| `npm run browser-check` (Chrome, fake camera/microphone) | All journeys pass, including pending media permission regression; 376 layout checks at 320/375/768/1280 px, light and dark |

Automated unit/integration tests still use fake video and payment services, except the offline genuine SDK cryptographic contract tests. Separately, the opt-in staging scripts contacted the actual free LiveKit Cloud project on 26 October 2026. Two headless Chrome clients sent synthetic camera/microphone tracks through Cloud; both received audio bytes and decoded remote video. Synthetic canvas screen publishing/stopping, mic/camera controls, recovery after a four-second network interruption, provider guest removal with link revocation, and room termination passed. Actual signed room/participant webhooks were processed successfully. This validates transport and playback state, not human-perceived audiovisual quality, physical devices or the operating-system screen picker.

The staging run found and fixed remote audio tracks never being attached to playback elements, and a prejoin submit handler that was installed too late while media permission remained pending. Production flags remain unchanged.

After delayed finalization, all six reservations across three synthetic runs settled. The final two runs received four signed participant joins, four leaves and two room starts/finishes. Track notifications were intentionally ignored for billing. Across all three runs, connected time totalled 69,209 participant-milliseconds and 73 whole participant-second units were charged after per-window rounding; no unfunded units or wallet/ledger reconciliation issues remained. These short tests do not establish long-duration renewal, production concurrency or outage exposure guarantees.

**Still unverified:** real Razorpay payments/refunds/disputes, live PostgreSQL concurrency (local credentials fail authentication), physical/mobile devices, long-lived meetings and a permanent hosted callback/alert setup. No production gate may be set based only on these local Cloud results.

## Repeatable isolated Cloud smoke

Use the ignored `backend/.env.meet-staging` with the explicitly authorized test project credentials. From `backend`, set `RUN_LIVEKIT_STAGING=true` and run `node --env-file=.env.meet-staging --disable-warning=ExperimentalWarning scripts/livekit-staging.mjs`. This forces an in-memory database, development mode, outbox messages, simulated billing and disabled recharge. It serves the UI on localhost:3100 and exposes only the signed webhook route on a separate loopback relay at port 3101. Never tunnel the full app.

Register a temporary HTTPS callback to the port-3101 relay using the same staging signing key, then run `node --disable-warning=ExperimentalWarning scripts/livekit-cloud-browser.mjs` with the same opt-in variable. It launches a separate headless Chrome profile with synthetic media, never the user's camera/microphone/desktop. A report and screenshot are saved under ignored `backend/data/livekit-cloud-media-smoke.*`. Send `status` to the staging runner to inspect events, intervals, reservations, usage and ledger reconciliation. Allow reservation windows plus finalization delay to finish. Remove the temporary webhook before stopping the tunnel; send `stop` to clean rooms and shut down the runner. Keep Cloud credentials and generated reports out of Git.

## Also changed

- `backend/src/web.mjs` now serves `design.css`, `product-minimal.css` and `suite-theme.css` locally. They were missing from the static whitelist, so the existing browser check failed on every page at the starting commit (Vercel was unaffected).
- `credit_ledger.reservation_id` cascades instead of setting null, so workspace deletion works with the immutable ledger (covered by a test).

## Unresolved

- Commercial values: allowances per plan and credit pack prices (see `PRICING_WORKSHEET.md`). Production defaults are none; checkout is disabled.
- Self-hosted token revocation behaviour must be verified on the chosen LiveKit version before AWS use.
- Rate limiting is per instance (existing limitation); a multi-instance deployment needs a shared limiter.
- The in-process worker runs every component on one instance; running several API instances would duplicate worker passes (state changes are idempotent, but provider calls could repeat).

## Next concrete step

Move the verified local Cloud flow to a permanent HTTPS staging backend with valid PostgreSQL credentials and monitoring; repeat acceptance there. The AWS Free-plan account still returns EC2 `OptInRequired`. The user will supply monthly allowances and recharge pack prices; recharge stays disabled until then and until live payment verification is completed.
