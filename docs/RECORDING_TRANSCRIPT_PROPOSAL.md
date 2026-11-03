# Recording and transcripts: bounded proposal

Status (30 October 2026): **proposal only.** Nothing is built, provisioned, priced or advertised. Spending stays at ₹0. Prices, providers and release need separate owner approval. It applies to Schedora's own meeting room, which production keeps off apart from the owner pilot.

## Five separate capabilities

Each is released, priced and switched on on its own. None implies another.

| Capability | What it is | Runs where | Stores | Cost to Schedora |
| --- | --- | --- | --- | --- |
| 1. Local recording | The host's browser records the meeting to the host's device | Host browser (`MediaRecorder`) | Nothing on Schedora | None directly; host device CPU and disk |
| 2. Cloud recording | The provider composites the room into a file | LiveKit Egress | Temporarily at the provider, then storage (3) | Per transcode minute plus bandwidth |
| 3. Cloud storage and downloads | Keeping files and letting authorised people download them | Object storage (not the shared database) | Recording files | Per GB-month plus egress per GB |
| 4. Transcription | Speech to text from the audio only; needs no video recording | A speech-to-text API on an audio-only export | Transcript text (small) | Per audio minute |
| 5. Summary | A summary generated from a transcript | Existing AI provider path | Summary text | Per token |

## 1. Local recording (lowest-risk first candidate)

- **Supported browsers:** current desktop Chrome, Edge and Firefox; Safari support for `MediaRecorder` with WebM/MP4 differs, so it needs testing before it is named. Mobile browsers are not offered at first.
- **Remote audio:** record a `MediaStream` mixed through Web Audio from the remote audio tracks the page already plays, plus the host's microphone.
  - Video: either the active speaker tile drawn to a canvas, or the host's screen via `getDisplayMedia` with tab audio.
  - Capturing tab audio is browser-dependent and must be verified on each named browser.
- **Notice:** every participant, including late joiners, sees a persistent *Recording by the host* indicator from durable room state (the same pattern as session offers). The server records start and stop times. A recording that starts without a server-recorded notice is a defect.
- **Interruption:** chunks every few seconds into memory. If the tab crashes, the partial recording is lost; say so before starting. The file is offered for download on stop, and playback is verified by loading it into a `<video>` element before *Saved* is claimed.
- **Permissions:** hosts only (the room's existing host rule), and only when the workspace setting allows it.
- **Retention:** Schedora never holds the file; the host is responsible for it.

## 2–3. Cloud recording and storage (later; needs a cost owner)

- LiveKit Egress composite recording to a private bucket, with server-side credentials only.
- One recording per room at a time. A workspace monthly minute cap and a service-wide cap are enforced before egress starts, and an egress is stopped when the room's maximum duration passes.
- **Access:** downloads go through short-lived signed URLs issued to room hosts holding a new `recordings.read` permission. There are no durable links.
- **Deletion:** host-initiated, plus a workspace retention default of 30 days proposed. Deleting a workspace deletes its recordings.
- **Failure:** provider egress status webhooks are persisted; a failed or partial egress is shown as such, never as *Recorded*. Playback is verified from storage before *Available*.

## 4. Transcription without video

- An audio-only track egress to batch speech-to-text after the meeting. Streaming live captions are a separate, more expensive product.
- **Notice:** a separate *Transcription on* indicator, also shown to late joiners. The transcript is private to hosts with the new permission.
- **Accuracy limits:** stated plainly. Speaker labels from diarization are guesses; names are not assigned automatically, and accuracy drops with crosstalk, accents, background noise and code-switching (for example Hindi–English). The language is chosen per meeting.
- **Summary (5):** separately generated, labelled as AI-generated, and editable before it is shared. A summary never creates tasks without host confirmation.

## Indicative unit costs (third-party and vendor pages, checked 30 October 2026; verify before pricing)

| Item | Indicative rate | Source |
| --- | --- | --- |
| LiveKit Cloud transcode minute, video (beyond plan allotment) | about US$0.015–0.02 | [LiveKit pricing](https://livekit.com/pricing.md) |
| LiveKit transcode minute, audio only | about US$0.004–0.005 | [LiveKit pricing](https://livekit.com/pricing.md) |
| LiveKit track egress | about US$0.001 per minute, plus bandwidth per GB | [LiveKit pricing](https://livekit.com/pricing.md), [billing](https://docs.livekit.io/deploy/admin/billing.md) |
| Batch speech-to-text (e.g. Deepgram Nova-3 monolingual) | about US$0.0043–0.0048 per audio minute; diarization extra | Aggregators such as [convertaudiototext.com](https://convertaudiototext.com/blog/deepgram-nova-3-explained) and [activepieces.com](https://www.activepieces.com/blog/deepgram-pricing-2026-per-minute-rates-and-add-ons.md); vendor page not directly confirmed |

Example (illustrative only): a 45-minute meeting.
- Video recording: about US$0.68–0.90 in transcode.
- Audio-only transcript: about US$0.18–0.22 (audio egress and transcription), plus storage.

Apply the owner's cost-plus-30%-after-fees rule only to measured costs.

**Spending controls before any release:**
- workspace caps;
- a service-wide monthly budget that refuses new recordings;
- alerts at 50/80/100%;
- no automatic overage.

## Release gates

1. The owner approves the provider, budget and price.
2. Notices are tested with late joiners.
3. Playback is verified on each named browser and device.
4. Deletion is verified end to end.
5. The privacy policy and terms are updated.
6. Consenting human tests are run.

None of these has started.
