# Sprint roadmap and final product goal
Version 1.0 · 24 October 2026 · Proposed execution plan
Related: [PRD](PRD.md), [Vision](VISION.md), [Design](PRODUCT_DESIGN.md).

## Final goal
Build an affordable Schedora suite that covers the everyday scheduling needs associated with Calendly and the form-building needs associated with Typeform and Fillout, with connected automation through Flow.

Meet, Forms and Flow must each work as an independent product and together under one account and billing relationship. Customers should pay less for a comparable paid feature-and-usage basket. Reliability, privacy, accessibility and support must not be sacrificed to reach that price.

This is a functional alternative objective, not a claim of complete feature parity or an authorization to copy proprietary code, branding or assets. Full competitor parity is a moving long-term backlog; the initial paid release targets the explicitly tested core journeys below.

## Planning assumptions
Use proposed two-week sprints, adjusted after estimating the backlog and confirming team capacity. Sprint numbers indicate sequence, not committed delivery dates. Each sprint starts with capacity-based selection and ends with a working demonstration, tests and updated documentation. Do not mark planned items complete based on the present demos.

Baseline at the time of writing: local product previews, brand assets, route mapping and launch scaffolding. See [Implementation status](#implementation-status) for what has since been built.

## Sprint plan
| Sprint | Goal | Main deliverables | Exit demonstration / final goal of sprint |
| --- | --- | --- | --- |
| 0 — Research and scope | Establish evidence and a feasible release basket | Public workflow comparison; feature matrix; competitor pricing snapshots; customer interviews; provider shortlist; cost model; backlog estimates | A prioritized scope and matched paid-plan comparison, with observed facts separated from assumptions |
| 1 — Foundation | Make the suite maintainable and consistent | Consolidated scripts/styles; fixed logo component; responsive shells; browser verification; automated CI; staging plan | Suite and three products work at mobile/desktop sizes without runtime errors or broken assets |
| 2 — Shared identity and data | Establish secure workspace ownership | Auth provider integration; database migrations; workspace/member roles; secret handling; tenant authorization; restore procedure | Two test workspaces cannot access each other's records through UI or direct API requests |
| 3 — Meet event setup | Let a host publish real availability | Event-type CRUD; weekly hours; date exceptions; host timezone; notice, horizon and buffers | Host publishes a link whose available slots match the stored schedule and DST fixtures |
| 4 — Meet booking engine | Create dependable appointments | Server validation; atomic overlap prevention; booking persistence; timezone confirmation; idempotency | Two concurrent requests cannot double-book a host; successful confirmation references a persisted record |
| 5 — Meet integrations and management | Complete the real appointment lifecycle | One calendar provider; one email provider; busy sync; cancellation/rescheduling; reminders; delivery status | Invitee books, receives a test email, reschedules and cancels; host calendar stays consistent |
| 6 — Forms builder and publishing | Save and publish useful forms | Field model; short/long text, email, choice and date fields; draft/publish versions; single-page and conversational rendering | The same saved form works in both presentation modes and validates required fields |
| 7 — Forms logic and responses | Cover core Typeform/Fillout-style journeys | Multi-page flow; conditional logic; answer piping; response inbox; CSV export; accessible progress/errors | A branching intake form records correct responses and exports only authorized data |
| 8 — Flow core | Connect products with reliable automation | Durable event outbox/queue; booking/response triggers; email/task actions; run history; pause; retries and idempotency | One event causes one intended side effect despite duplicate delivery; failures are visible and recoverable |
| 9 — Pricing and billing | Enable affordable commercial access | Metering; individual plans and Suite; verified payment webhooks; limits; downgrade/grace rules; invoice/cancellation experience | Test purchase, renewal, failed payment and cancellation update entitlements correctly without cross-workspace effects |
| 10 — Launch readiness | Prove the paid release can operate safely | Security/accessibility review; load and browser tests; legal operator details; retention/deletion; monitoring; recovery drill; TLS/DNS; support process | Staging passes release gates and a recorded restore/recovery exercise; no unresolved critical defects |
| 11 — Controlled beta and release | Validate value, cost and reliability with customers | Opt-in pilot; funnel and delivery measurements; support triage; pricing validation; launch checklist | Pilot evidence supports the price and operational plan; explicitly approve production rollout and publish known limitations |

## Implementation status
Updated 24 October 2026. "Built and tested" means code exists and automated checks pass locally: 32 API/integration tests (`backend/test/`) and 23 headless-Chrome journeys with 184 layout checks at 320/375/768/1280 px in light and dark themes (`backend/scripts/browser-check.mjs`). Nothing has been deployed, and no item relying on real providers, real users or owner decisions is marked complete.

| Sprint | Status | Built and tested | Still open |
| --- | --- | --- | --- |
| 0 — Research and scope | Partly done | [Parity matrix](docs/PARITY_MATRIX.md) with observed/specified/implemented/tested/deferred statuses; [pricing worksheet](docs/PRICING_WORKSHEET.md) template | Customer interviews, dated competitor price snapshots, cost model with measured usage, provider shortlist decision, backlog estimates |
| 1 — Foundation | Done locally | One stylesheet and modular scripts replacing layered files; fixed 28 px logo component; responsive shells; browser verification script; CI workflow; frontend/backend split for Vercel and Render | Staging environment (plan in [DEPLOYMENT.md](docs/DEPLOYMENT.md#preview-deployments-and-staging)) |
| 2 — Shared identity and data | Done locally | Email/password auth, sessions, CSRF, migrations, workspaces with owner/admin/member roles, [authorization matrix](docs/AUTHORIZATION.md), server-side secrets, backup/restore scripts; cross-workspace tests over every private endpoint | External auth provider (decision), recorded restore on real infrastructure |
| 3 — Meet event setup | Done | Event-type CRUD, weekly hours, date exceptions, host time zone, notice, horizon, buffers, slot interval; DST fixtures for New York, London, Kolkata and Lord Howe | — |
| 4 — Meet booking engine | Done | Server validation, transactional slot check, database overlap trigger, idempotency keys, persisted confirmation, concurrent-request test | — |
| 5 — Meet integrations and management | Built; providers not connected | iCalendar-feed busy sync with revocation surfaced; email delivery queue with retries and status; cancel/reschedule links; reminders; .ics | Choose and connect a real email provider (HTTP adapter ready); Google/Microsoft OAuth calendar adapters; test with real inboxes and calendars |
| 6 — Forms builder and publishing | Done | Field model, five field types plus page breaks, draft/publish versions, classic and conversational rendering from one saved form, required-field validation | — |
| 7 — Forms logic and responses | Done | Multi-page flow, conditional questions and pages, answer piping, response inbox, CSV export limited to workspace members, accessible errors and progress | Owner decision on response visibility per role |
| 8 — Flow core | Done | Transactional outbox, booking/response triggers, email and task actions, run history, pause, simulation, bounded retries, exactly-once side effects under duplicate delivery | — |
| 9 — Pricing and billing | Built against a test provider | Plans for Meet, Forms, Flow and Suite; signed and replay-safe webhooks; entitlements; grace, cancellation, downgrade; metering and quotas; owner-only controls | Payment provider adapter, approved prices, taxes, invoices, real renewal and failure testing |
| 10 — Launch readiness | Partly done | Security headers and CSP, rate limits, retention and deletion, health and logs, operations runbook, deployment configuration | Legal operator details, formal security and accessibility review (WCAG 2.2 AA audit with assistive technology), load tests, monitoring and alerting, off-site backups, DNS/TLS, recorded recovery drill, support process |
| 11 — Controlled beta and release | Not started | — | Pilot users, funnel and delivery measurement, pricing validation, release approval |

Final release acceptance: items 1–5 are met in local automated tests; item 6 is met with the test payment provider only; items 7–10 are open.

## Research and reverse-engineering workstream
Run as needed in Sprint 0 and before implementing unfamiliar workflows:
1. Inspect public product pages, official documentation and legitimately accessible product interfaces.
2. Record task, source URL, observation date, account/plan scope, user steps, states, validation behavior and limitations.
3. Use the separate REA tool in ../rea when runtime or shipped-artifact evidence is actually needed and the available tools support that target. Keep Schedora implementation inside this project.
4. Do not assume access to private accounts, paid features, internal APIs or binaries. Do not bypass access controls. Mark unavailable behavior unknown.
5. Derive a functional specification, then implement original code, text, interface and approved Schedora assets.
6. Maintain a parity matrix with statuses: observed, specified, implemented, tested, deferred. An observed competitor feature is not an implemented Schedora feature.
7. Preserve evidence and confidence. Compare workflow behavior, not screenshots alone.

No competitor runtime reverse-engineering has been performed for this roadmap. Its research baseline is official public documentation and pricing pages.

## Feature comparison backlog
| Capability | Meet | Forms | Flow / platform | Release level |
| --- | --- | --- | --- | --- |
| One-to-one scheduling, timezone handling, availability | Core | Optional intake connection | Booking event | Initial paid release |
| Calendar busy sync, email confirmations, cancel/reschedule | Core | — | Durable delivery | Initial paid release |
| Standard and conversational forms | — | Core | Response event | Initial paid release |
| Multi-page logic, answer piping, exports | Intake consumption | Core | Authorized data transfer | Initial paid release |
| Product branding and embedding | Booking page | Form embed | Shared settings | Define embed scope during Sprint 0 |
| Team scheduling and round robin | Later | — | Team permissions | After first launch |
| File uploads, calculated fields, scoring and payments | Paid appointments later | Later | Storage/payment integrations | Post-launch prioritization |
| Extensive third-party integrations and enterprise SSO | Later | Later | Connector catalog / identity | Longer-term parity |

## Affordable pricing strategy
Competitor free tiers already exist; “cheaper” applies to a comparable paid offer, not a promise to undercut a zero-cost plan.

Before approving prices:
- Capture official plan, billing term, currency, seats, usage allowance, required features, taxes and add-ons.
- Compare Meet against a corresponding scheduling plan, Forms against corresponding Typeform and Fillout plans, and Suite against the cost of the customer's actual replacement basket. Do not add mutually exclusive competitor subscriptions to inflate savings.
- Propose a working target of at least 20% lower comparable paid cost, subject to owner approval and unit economics. This percentage is a planning hypothesis, not an approved customer claim.
- Calculate net revenue after discounts, payment fees, taxes borne by the company, refunds, hosting, database, email, storage, automation execution and support.
- Test typical and heavy usage; define fair usage and transparent quotas before offering a low fixed fee. Do not promise unlimited paid infrastructure.
- Recheck competitor prices before publishing savings. Document lower feature coverage alongside lower pricing.
- If the cost floor is too high, narrow the release or change quotas rather than quietly reducing reliability.

Price approval output: matched comparison worksheet, cost/usage assumptions, proposed plans, expected contribution margin and owner decision. No final currency amounts are set by this document.

## Completion definition for every sprint
- Reviewed acceptance criteria and a reproducible demo.
- Appropriate automated and manual checks, including actual integration checks where applicable.
- Workspace authorization and sensitive-data implications checked.
- Documentation, migrations, configuration and known limitations updated.
- Failure/retry behavior verified for operations with external effects.
- No claim of production readiness based only on simulated or mocked services.

## Final release acceptance
1. Host can onboard, publish availability and accept a conflict-safe booking.
2. Invitee can book in their timezone, receive confirmation and cancel/reschedule.
3. Form owner can publish a branching form, receive persisted responses and export them.
4. Forms supports both conventional and conversational presentation for the initial field set.
5. A booking or response can trigger a durable Flow action with traceable retry behavior.
6. One account/workspace can access individually purchased products or the Suite using verified entitlements.
7. Domain routing, HTTPS, privacy/terms, consent, security checks, accessibility, monitoring and recovery are complete.
8. Comparable paid pricing is demonstrably lower and sustainable under measured usage.
9. Real pilot users complete these journeys; limitations and support contact are published.
10. No critical security, data-loss or double-booking defects remain open.

## Dependencies and decisions
Owner decisions: target audience, first providers, team capacity, feature basket, pricing/margins, support promise and legal operator.
Access needed: repository, hosting project, DNS, database, auth, email, calendar OAuth and payments. Use secret managers/environment configuration.
Optional later access: authorized competitor accounts for specific comparison questions.
Do not treat missing credentials as a reason to stop independent UI, domain modeling, test or documentation work.

## Research baseline, checked 24 October 2026
- [Calendly official pricing](https://calendly.com/pricing): scheduling plan structure, free/paid tiers and seat-based comparison.
- [Typeform official pricing](https://www.typeform.com/pricing): form plans, response allowances and collaboration limits.
- [Fillout official pricing](https://www.fillout.com/pricing): free/paid forms, response allowances and form features.
These pages can change. Save a fresh dated snapshot for the actual price approval; no live price promise is derived from this roadmap.

