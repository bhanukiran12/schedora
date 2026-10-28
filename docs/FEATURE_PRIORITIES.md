# Schedora feature priorities

Evidence reconciled 28 October 2026 · Frontend first, backend contracts before live promises

Current release and unresolved gates: [release acceptance](RELEASE_ACCEPTANCE.md). Earlier slice labels describe implementation history; they are not the current deployment status.

Related: [Suite strategy](SUITE_STRATEGY_2026_10_27.md), [UX research](UX_RESEARCH_PLAN.md), [Pricing](PRICING_PROPOSAL.md). This matrix distinguishes code/local evidence, interactive preview and provider/production gates. It supersedes neither test output nor a later release checklist.

## Capability truth table

| Capability | Current evidence class | Safe presentation | Gate before broader claim |
| --- | --- | --- | --- |
| Meet event types, availability, timezone slots, booking/cancel/reschedule | Implemented with local tests; provider lifecycle has separate dated evidence | Explain supported tasks and current integration status | Recheck deployed persistence, concurrency and provider lifecycle |
| Meet native video/prejoin/devices/sharing | Real LiveKit synthetic tests; physical desktop/phone screenshots; user reports voice good on retest | Staging-verified subsets; production video remains gated | Video sharpness, network recovery, device/browser/accessibility and operational gates |
| Forms draft/publish, classic/conversational, logic, receipts, CSV, Meet handoff | Released in c06330e with readiness and server checks through eb7fd06; local and Linux CI evidence | Show actual saved/live/version/receipt states | PostgreSQL concurrency is exercised in passing disposable CI; real-provider and human task verification remain. Production health and check-only validation are verified; CI is not a production data audit |
| Flow booking-created/response-created → one email OR one task | Existing one-trigger/one-action engine, drafts/paused/enabled, saved-definition simulation, runs/retries; per-message transport and signed provider delivery reports | Native follow-up; local outbox vs provider acceptance vs mail-server delivery shown separately | Production currently reports the local outbox (28 October); provider configuration, delivery webhook and an own-inbox test are needed before any delivery claim; no universal exactly-once provider promise |
| Shared workspace identity/roles/entitlements | Implemented with local authorisation/test-provider evidence | Reflect actual membership/access responses | Production provider, restore/security and operational verification |
| Demo dashboards/onboarding/product previews | Browser-local sample data and simulations at `/start` and `/demo`; persisted live workspace onboarding at `/setup` (`012_live_onboarding.sql`) | Explicit demo vs live labels; live onboarding saves unpublished drafts and reflects actual saved records without auto-publishing, auto-enabling or granting entitlements | Never present sample metrics as customer traction; human onboarding task completion remains to be measured |
| Linked enquiry/response/booking/run exception trail | Released read-only Enquiries list on a server-paginated feed (every response and direct booking reachable, arrival-ordered, stored offer expiry, all follow-ups per item); per-response trail | Describe loaded pages and unknown states; counts cover loaded pages; no assigned-owner claim | Server-computed states and counts, enquiry ownership/resolve, reconciliation and human usability evidence (task deadlines and assignees exist) |
| Multiple Flow actions/branches/delays/approvals/external connector marketplace | Not supported by the current native action model | Roadmap only | Durable execution/version/retry model and connector operations |
| Prices, budgets, variable-service packs | Prices unapproved; test billing/meters exist | Research proposal; no live checkout amounts | Unit economics, owner-approved rates/tax terms, enforced quotas/spending and payment tests |

Sources for implementation scope: [README](../README.md), [Forms contract](FORMS.md), [Meet verification](MEET_SPRINT_2026_10_27.md), [Flow source](../frontend/js/flow.mjs). Documentation presence is not production certification.

## Adopt, adapt and avoid

| Priority | Decision | Change | Frontend deliverable | Backend/operation dependency |
| --- | --- | --- | --- | --- |
| P0 now | Adopt | Truthful system state | Saved vs published; preview vs live; queued/outbox vs delivered; current provider status | Use actual API states; no invented delivery |
| P0 released (slice 1) | Adopt | Meaningful entry points | Booking → preparation task; response → review task; booking → existing-host notification email; offered from the empty Flows list and the editor; plain-language summary of source/action/recipient; blank remains available | Released on main; see [implementation log](RESEARCH_IMPLEMENTATION.md). Respondent acknowledgement awaits a source-form/email-field choice. Real email delivery evidence still needed |
| P0 now | Adopt | Functional visual delivery | Serve existing tracked assets and valid frontend routes; fix broken marks/fonts/images | Narrow static delivery routing; preserve security/path checks |
| P0 now | Adapt | Task-led positioning | Concrete consultancy/agency/training journeys; independent product CTAs | Do not imply full orchestration or unbuilt services |
| P1 released (slice 2) | Adopt | Forms goal templates | Consultation request, project brief, programme enquiry, session feedback plus Blank; each creates an unpublished, editable draft | Uses the existing draft API and field schema; publishing remains explicit. See [implementation log](RESEARCH_IMPLEMENTATION.md) |
| P1 released for Meet (slice 5) | Adapt | Readiness/checklist | Meet editor "Ready to share?": event details, availability (server slot check over the stated range), own calendar status and sharing; Required / Optional / Not verified; no percentage; Preview and Copy change nothing | Existing APIs only. Team and admin views need a server-side readiness endpoint, calendars need `last_success_at`, and email needs delivery evidence: see the [implementation log](RESEARCH_IMPLEMENTATION.md). Forms: released (slice 6): draft vs live with named differences, shared-validator problems, unreachable required questions, preview actions, receipt vs booking offer vs confirmed appointment, share/embed in one place; slice 8 adds authenticated `published_routing` and a revision-bound check-only endpoint sharing Publish validation; provider and human outcomes remain unverified |
| P1 partly implemented (slice 6) | Adapt | Branch preview | Human-readable rule summary and test answers; no stored response | Reuse shared evaluator; server still validates submit/publish |
| P1 released (slices 3 and 7) | Adapt | Enquiry trail | Per form (slice 3), and workspace-wide at `/enquiries` (slice 7): form responses and direct bookings, receipt → booking → follow-up run → task, with needs attention first (failed or retrying follow-up, open task, canceled or unavailable booking, offer expired unused) and stated coverage | Workspace list now uses the paginated server feed, server booking creation time and stored offer expiry; Flow tasks have deadlines and assignees. Attention states and loaded-page counts remain client-side; enquiry ownership/resolve, server-wide state/counts, reconciliation and large-history latency remain; per-form history coverage and tied-arrival paging are fixed in the CI-verified a6d0fc8 increment: [contract](ENQUIRY_TRAIL_CONTRACT.md) |
| P1 prototype (slice 4) | Adopt | Cost comprehension | `/pricing/proposal`: "Proposed pricing — not available for purchase"; per-product meters, what counts, exact reset, current limit outcomes, full annual totals, month estimator | Interview material only; checkout/entitlements unchanged. Warnings, opt-in overage and spending limits need backend work and approval |
| P2 later | Adapt | Multi-step automation | Accessible sequence/canvas only for executable steps | Versioned durable graph, conditions/delays, retries and permissions |
| P2 later | Demand-gate | Payments, uploads, signatures, AI, enterprise | Prototype separately only after proven use case | Storage/scanning, ledgers/refunds, legal/compliance and measured compute costs |
| Avoid | Reject | Mimicry without value | No cloned assets/brand, fake success rates, artificial scarcity or decorative connectors | Functional patterns can be implemented originally |
| Avoid | Reject | Paywall essential logic as the central wedge | Keep basic utility understandable | Tally/Fillout already offer logic free; validate another reason to pay |
| Avoid | Reject | Universal guarantees | No cheapest/unlimited/never-duplicated/production-ready claims | Qualify exact verified scope and operational limits |

Tally's free logic and Fillout's native scheduling/workflows make basic feature parity a weak differentiator. Paperform's existing suite makes integration alone insufficient. ([Tally](https://tally.so/pricing), [Fillout](https://www.fillout.com/pricing), [Paperform](https://paperform.com/pricing/))

## Acceptance for each frontend slice

A control produces the advertised supported action; permissions and dirty-state protection remain intact; templates start as Draft; preview/simulation cannot send; loading/empty/error/success paths have useful text; keyboard/focus/mobile layouts are verified; missing backend contracts are labelled rather than simulated as facts. Record source/reference and after screenshots at matched viewport/state. Run relevant syntax/browser/regression checks and document skipped coverage. Do not mark production ready from local or synthetic-media evidence.


### 28 October release reconciliation

`328ed25` is deployed: product sidebar/context, persisted live onboarding, split-screen real `/login` and `/signup`, paginated Enquiries, task deadlines/assignees and email evidence. Both branch and main CI passed, including PostgreSQL and Linux browser jobs. Product auth/signup/return paths have automated evidence; real Google cross-subdomain sign-in and human comprehension do not. Pricing remains an interview proposal. Operational email, alert receipt and production video are open gates; see [release acceptance](RELEASE_ACCEPTANCE.md).
