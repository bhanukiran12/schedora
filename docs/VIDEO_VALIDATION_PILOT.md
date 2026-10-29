# Workspace video validation pilot

29 October 2026. Owner requests zero upfront infrastructure spending, limited video and recharge enabled after its checks. Paid infrastructure upgrades are not authorized. Recharge remains part of the work; this first validation stage does not certify checkout, prices, payment capture, refunds or service capacity.

## Purpose and boundaries

The pilot is an explicitly labelled acceptance stage in one selected workspace. It is separate from general production video and does not set or bypass `MEET_VIDEO_SMOKE_CONFIRMED`. `MEET_VIDEO_ENABLED` must remain false. Other workspaces cannot create or admit video participants, even if they forge client fields or reuse old room links. Invited guests use existing room-scoped credentials; existing membership and room authorization remain unchanged.

Production pilot prerequisites: LiveKit Cloud credentials, a stable meeting-link encryption key, verified permanent webhook and verified monitoring. General public availability stays false in `/api/config`. Only an authenticated member's workspace list includes that workspace's pilot availability. The meeting's own view carries availability for its guests.

## Enforced validation limits

- Exactly one selected workspace; two participants per room and globally, one concurrent room, 15 minutes per instant meeting.
- 60 free participant-minutes per UTC month in the selected workspace only. Refreshing the wallet does not grant twice. This is a separate evaluation allowance, not a commercial subscription allowance or purchased credit price. Existing lots/ledger are not rewritten.
- Instant rooms only. Scheduled native-video bookings are rejected for the pilot; existing scheduling with external meeting links is unaffected.
- Shared LiveKit Build/free quotas still apply across projects. This does not reserve free capacity or guarantee availability. Verify the actual project is Build/free before activation; no card/paid upgrade or overage purchase.
- Recharge is not certified by this stage. Do not sell development fixtures or arbitrarily turn on suite-wide subscription enforcement. Measured replacement/support cost, a supported sales/admission cap, approved packs and actual capture/webhook/refund evidence remain required for the owner's requested recharge.

Configuration: `MEET_VIDEO_PILOT_ENABLED=true` and `MEET_VIDEO_PILOT_WORKSPACES=["<selected-workspace-uuid>"]`. Both are private server settings, not editable through workspace settings or client requests. Production limits are clamped by the server despite larger general-video configuration. The pilot must be explicitly removed before a general launch; configuring both modes fails startup.

## Validation and rollback

Test real provider connection, scoped admission, guest waits-for-host, two-way media, controls, removal, end, permanent webhooks and wallet settlement. Separate no-media connection/control-plane evidence, synthetic media evidence and human audio/device evidence. The owner is not available for physical-device checks at the current checkpoint, so that evidence must remain open.

To stop new pilot admissions, remove/disable the pilot selection. To end connected rooms immediately, first use host End for everyone or the existing `MEET_VIDEO_KILL_SWITCH=terminate`, verify provider removal and settlement, then disable the pilot. Disabling admission alone does not forcibly disconnect an already connected participant. Keep financial ledger tables intact.

Tests cover prerequisite/limit configuration, cross-workspace refusal, free-credit idempotency, host and guest admission/revocation, and broad availability staying off. The browser journey checks the limited-pilot message/controls and non-pilot unavailable state. Passing local tests does not claim production media or paid recharge readiness.

`node scripts/check-livekit-pilot.mjs` is a no-media provider check for the configured scoped pilot. It creates one uniquely named empty diagnostic room with two seats, reads only that room, verifies no participants and deletes it in cleanup. It opens no application database, issues no participant tokens and activates no paid features. Its sanitized result explicitly excludes media, application webhook processing and wallet settlement. Never use it alone to set the smoke confirmation flag.
