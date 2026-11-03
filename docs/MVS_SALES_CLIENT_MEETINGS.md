# Schedora MVS: sales and client meetings

Updated 30 October 2026. MVS means minimum viable scope here. This is a product-scope update, not an implemented feature, price approval or release. Existing production, provider, privacy and spending gates remain in force.

## Product focus

Help sales and service teams prepare for a conversation, collect the right information during it, and leave with a clear next step. Meet schedules and hosts the conversation, Forms collects its context, and Flow records supported follow-up. Each product remains useful independently.

Proposed positioning: **Book the conversation. Collect the details. Keep the next step moving.** This is a positioning hypothesis, not a validated superiority or conversion claim.

The owner's firsthand pain: during a live session, attendees have to find an external form link, and late joiners require the host to repeat it. The proposed response is a persistent session resource and form workflow, rather than another chat link. Broader demand is unvalidated.

## Sales and client meeting coverage

| Meeting job | Information to collect | Useful next step |
| --- | --- | --- |
| Sales discovery / qualification | Goals, current problem, requirements and timing | Owner reviews answers and records the next action |
| Product demo / evaluation | Questions, intended use and evaluation feedback | Create a follow-up task; offer a next meeting explicitly |
| Proposal / commercial discussion | Scope questions, objections and requested changes | Assigned proposal-review task; a form is not contract acceptance |
| Client onboarding / kickoff | Project brief, preferences, responsibilities and outstanding inputs | Assigned preparation tasks using supported actions |
| Client review / support / renewal | Progress, blockers, satisfaction and requested help | Clear owner and due date for the supported follow-up |
| Group client session / workshop | Attendee details, questions and feedback | Persistent resources for late joiners and response review |

These are candidate use cases, not six separate products. First implementation should prove one sales-discovery journey and one client-kickoff journey. Group use cases do not authorize large-room capacity, webinars or a 150-person promise.

## Minimum viable experience: next proposed slice

1. Host selects an authorized, published Forms form for a meeting. A draft or inaccessible form cannot be offered to attendees. Private answers never appear in the shared meeting view.
2. Host chooses whether to offer it automatically after joining or launch it during the session. Existing attendees and late joiners receive the current offer from saved session state, not just an ephemeral chat broadcast.
3. Attendee sees an accessible form panel with a short purpose statement. The meeting remains audible; the panel can be minimized and reopened from a persistent session card. Show the automatic prompt once per offer, with reconnect handling and clear progress preservation limits.
4. Host can set a persistent instruction or resource link. A late joiner sees the current version. Host can replace or remove it, and arbitrary links must not execute scripts or expose private resources.
5. Submission uses Forms validation and durable receipt behavior. Announce success only after server acceptance; failed/offline submission retains entered answers in the active view and offers retry without double-counting accepted responses. Do not silently introduce browser-persistent storage of sensitive answers.
6. Host sees private response evidence: submitted, not yet submitted, or identity unconfirmed. Joining, viewing a form and submitting it are separate events. Display names alone must not link answers to attendees; define a secure guest/session binding before implementation. Do not duplicate answers merely to populate a meeting status list.
7. An accepted response can use an existing supported Flow trigger/action. Show its actual task or delivery outcome. Do not promise automatic multi-step orchestration, transcript-generated tasks or a new meeting-end trigger before backend support exists.

Default: offer rather than block. If a host needs required pre-entry information, disclose that before joining and define it as a separate admission policy; do not unexpectedly lock someone out mid-meeting. Form completion is not proof of attendance, consent to marketing, or consent to recording.

## Scope boundaries

- First build targets Schedora's own meeting room. An external Zoom/Google Meet link can use existing standalone Forms sharing, but we cannot inject a panel into those products without a separately researched and supported integration. Do not present external-link sharing as the native in-room experience.
- Keep current pilot capacity and spending limits unchanged. New session features do not enable general video, recharge, paid infrastructure or new customer messaging.
- Do not copy Zoom assets or claim pinning is unique. Zoom now documents pinned meeting messages, with client/version and other restrictions. Our differentiation hypothesis is durable information collection plus a traceable follow-up.
- Reuse current Forms and Flow permissions, quota rules and saved-state evidence. Linking products must not grant extra access or make a paid or disabled capability appear available.

## Later additions: separate cost and validation gates

| Addition | Proposed value | Required before release |
| --- | --- | --- |
| Local recording | Host saves a recording to their own device | Browser/device support, remote audio capture, recording notice, disk/failure recovery and actual file playback; not advertised as universally supported or cost-free |
| Cloud recording and storage | Recording available after the session | Processing and storage unit costs, download/egress costs, private access, retention/deletion, quota and spending controls, owner-approved prices |
| Transcript without video recording | Searchable record of the conversation | Explicit notices including late joiners, audio-minute costing, language/speaker accuracy checks, access/deletion policy; transcript and summary are different outputs |

Billing hypothesis: core workflow subscription, a clear native-video allowance, and separately priced recording/storage/transcription. No unlimited claims, surprise overages, approved pack amounts or immediate expiry of purchased credits. Measure costs before choosing prices; retain the owner's approved cost-plus-30%-after-fees rule.

## Acceptance and evidence

- First attendee and late joiner can find the active form and instructions without the host resending a link.
- Joining after an offer is removed does not show an obsolete prompt; reconnecting does not repeat a completed offer or create another accepted response.
- A host replacing the form creates a clear new offer; existing responses retain the original form/offer association. Define published-version behavior before coding.
- Respondents cannot read other participants' answers. Unauthorized hosts, removed members, unrelated workspaces and API-key sessions cannot acquire session-management privileges through the new feature.
- At phone widths and with keyboard navigation, the form can be opened, minimized, submitted and retried with visible focus and useful announcements; controls do not hide the meeting's Leave action.
- Interrupted network, rejected submission, closed form and quota exhaustion have truthful recoverable states. A failure does not claim receipt or silently remove an accepted response.
- Test on the supported database and provider paths, then record consenting human completion tasks for discovery and kickoff. Targets: no host reposting in the tested late-join journey, no lost accepted response, and no repeated completion prompt. These are acceptance targets, not achieved metrics.

Next deliverable: a session-offer API/data and permission contract plus a small reviewed responsive prototype. Do not start recording infrastructure or broad sales-CRM expansion to complete this slice.

### Status, 30 October 2026 (local only, not committed or released)

- **Contract written:** [MEET_SESSION_OFFERS.md](MEET_SESSION_OFFERS.md).
- **First vertical slice built and tested locally** in Schedora's own room. It is exercised against the fake video provider and a fake-connected room in headless Chrome, never real media, devices or people.
  - Items 1–7 above are covered: host-only attach, auto or manual launch, durable state for late joiners, one prompt per offer, an in-room panel that can be minimised, seat-bound submissions through the ordinary Forms path, private status, and a pinned plain-text note with https links.
  - Item 6's *identity unconfirmed* state is not shown separately. A guest who reopens the link in a new tab counts as a new seat, as the contract states.
- **Both proof journeys pass as API tests** (`backend/test/sales-client-journeys.test.mjs`):
  - Sales discovery → booking offer → assigned preparation task.
  - Client brief → meeting session offer → supplementary answers → assigned next action.
- **Templates:** *Proposal questions* and *Support and renewal feedback* were added to the existing sales and client set. Both say plainly that sending is not acceptance, renewal or cancellation.
- **Recording and transcripts:** a proposal only, in [RECORDING_TRANSCRIPT_PROPOSAL.md](RECORDING_TRANSCRIPT_PROPOSAL.md).
- **Still unverified:** real media and devices, screen readers, human completion tasks, and PostgreSQL (added to the CI job but not run here).

## Sources and status

Owner-reported pain and scope direction: 30 October 2026. No customer interviews fabricated. Official competitor capability checked the same day: [Zoom pinned in-meeting messages](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0088614). Current delivery claims remain governed by [release acceptance](RELEASE_ACCEPTANCE.md); existing strategy is [suite strategy](SUITE_STRATEGY_2026_10_27.md).
