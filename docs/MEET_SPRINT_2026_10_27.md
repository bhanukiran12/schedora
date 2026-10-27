# Meet sprint verification — 27 October 2026

Status: real-provider automated verification passed; physical-device acceptance is pending. Production video and recharge remain disabled. This is not a production-readiness certification.

## Fix from real-provider testing

Ending a room marks its participants removed as part of teardown. The client previously checked that participant status before the room's terminal status, so an external/provider-driven end could show the host a removal message instead of the meeting-ended screen. The room's ended/cancelled state now takes precedence. A browser regression covers a server end followed by a provider participant-removal disconnect; individual removal from an open room retains its existing behaviour.

## Provider evidence

The final automated run used the real LiveKit Cloud staging project and Chrome synthetic camera/microphone streams. It did not use the fake Room fixture.

- Two foreground-visible browser processes, six consecutive ten-second windows. Each direction decoded 145–203 frames per window and received increasing video/audio bytes. This exceeds the threshold of 30 frames per direction per ten seconds for at least one minute.
- Microphone/camera controls, synthetic canvas screen sharing and remote decoding, participant removal, rejected removed-guest links and room termination passed.
- A browser offline toggle was followed by resumed video. This does not establish a physical network outage or prove ICE transport interruption; a real network reconnect check remains required.
- Signed callbacks across six diagnostic/acceptance runs: 12 joins, 12 leaves (three corrected), six room starts and six room finishes. Track events were deliberately ignored for billing.
- All 14 reservations settled; zero held; 582,955 connected participant-milliseconds charged as 590 participant-second units across records; zero unfunded units; zero wallet reconciliation issues. Rounding is per usage record.
- An approximately 89-second silent screen recording was captured from the acceptance run. Its media is synthetic, not physical-device evidence.

Earlier failures were retained in the local evidence: a two-tab run decoded only three frames in one direction; separate browsers restored visible receivers. The test also needed to wait for microphone preview readiness before joining. These changes improve the test harness; they do not disable application adaptive streaming or substitute synthetic media for hardware acceptance.

## Local verification

With the preserved uncommitted Forms work present:

- Syntax: 112 files passed.
- Shared-module and vendored LiveKit 2.22.4 consistency checks passed.
- Unit/API suite: 131 total, 128 passed, zero failed, three PostgreSQL checks skipped.
- Browser journeys, including the new server-end regression, passed; 408 layout checks, no reported runtime errors or overflow.

Upstream baseline `e7571d2` passed GitHub Actions run 40465524563. Later changes require their own CI result.

The exact staged sprint changes were also exported to a clean copy without the unrelated Forms work: syntax passed for 109 files; vendored SDK consistency passed; 117 tests (115 passed, two PostgreSQL checks skipped); all browser journeys and 344 layout checks passed, including the new server-end regression.

## Repeating staging checks

Use the opt-in `backend/scripts/livekit-staging.mjs` runner with the ignored staging environment. It uses an in-memory database, outbox email, test billing, four-participant cap and disabled recharge. Its webhook-only relay accepts only the expected callback path.

The optional `STAGING_PUBLIC_BASE_URL` accepts only a temporary HTTPS trycloudflare.com origin. Set it only after explicit permission to expose the disposable staging app for remote-device testing. The default remains local-only. Register only the staging callback and retire it and all tunnels after testing. Never publish environment files or attendance links.

`backend/scripts/livekit-cloud-browser.mjs` measures sustained media, uses separate browsers and captures failure diagnostics. Optional `LIVEKIT_DEMO_DIR` records silent JPEG screencast frames plus their timing manifest. It does not record microphone audio or the user's desktop; the share stream is synthetic canvas content.

## Still required

Human confirmation of two-way speech and physical camera video; phone layout and recovery from a physical network interruption; real device/speaker switching and unplugging; native screen-picker cancellation and macOS denial; Safari/iOS as applicable; screen-reader review. Production additionally needs PostgreSQL verification, permanent callbacks, monitoring, approved commercial configuration and the existing release gates. Do not enable video/recharge based solely on this report.
