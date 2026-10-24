# Schedora product requirements
Version 1.0 · 24 October 2026 · Proposed requirements unless marked implemented
Related documents: [Vision](VISION.md), [Product design](PRODUCT_DESIGN.md), [Launch status](LAUNCH.md).

## Objective
Deliver Meet first as a dependable appointment scheduling product while keeping Forms, Flow, shared accounts and combined billing architecturally compatible.

## Current implementation
Updated 24 October 2026. Verified by local automated tests and headless-browser journeys; not yet deployed.

| Area | Implemented and tested | Requirement IDs |
| --- | --- | --- |
| Meet | Event types, availability, DST-correct slots, atomic idempotent booking, confirmation after persistence, email status, cancel/reschedule links, host lists, iCalendar busy sync with revocation, .ics, reminders | M01–M10 (M07 via iCalendar feeds; OAuth providers pending) |
| Forms | Draft and versioned publishing, five field types, server validation, field-specific errors, inbox, CSV export, response event without personal data; also multi-page logic, piping and conversational mode | F01–F05 |
| Flow | Booking/response triggers, email and task actions, draft/enabled/paused, simulation, run history, idempotent bounded retries, workspace-scoped events | W01–W05 |
| Platform | Multi-workspace identity, explicit workspace selection, server-side membership checks, verified idempotent billing webhooks (test provider), Suite and single-product entitlements, grace/cancel/downgrade rules, product subdomain routing | P01–P07 (P03 with test provider; P05 for current secrets) |
| Quality | CSP without inline scripts or styles, rate limits, request-size limits, honeypots, retention, deletion, backup/restore scripts, no horizontal overflow at 320/375/768/1280 px in both themes | Partial: formal WCAG audit, load tests, monitoring, legal details open |

The data store is SQLite (`node:sqlite`) with migrations in `backend/migrations/`. Email uses a local outbox until a provider is configured; payments use a signed test provider until one is chosen. See [Sprint roadmap](SPRINT_ROADMAP.md#implementation-status) for open items and [Deployment](docs/DEPLOYMENT.md) for the Vercel + Render setup.

## Roles
- Visitor/invitee: books a published appointment or submits a published form without a workspace account.
- Member/host: manages permitted event types, availability and bookings.
- Workspace administrator: manages members, products and integrations.
- Owner: manages workspace ownership and subscription.
Exact role permissions require an explicit authorization matrix before implementation.

## Meet MVP requirements
| ID | Priority | Requirement and acceptance condition |
| --- | --- | --- |
| M01 | P0 | Host creates and publishes an event type with title, duration, location and description; unpublished types cannot be booked. |
| M02 | P0 | Host configures weekly hours, date exceptions, timezone, minimum notice, booking horizon and buffers; generated slots honor all settings. |
| M03 | P0 | Invitee chooses date and slot in an explicit IANA timezone; display and confirmation represent the same UTC instant across daylight-saving transitions. |
| M04 | P0 | Invitee submits validated name and email; server revalidates all values and does not trust browser availability. |
| M05 | P0 | Booking commits atomically; two simultaneous requests for an overlapping host interval cannot both succeed. A conflict returns refreshed options. |
| M06 | P0 | Confirmation appears only after durable persistence. Email delivery failure is reported separately and retries never create another booking. |
| M07 | P0 | Connect one selected calendar provider; busy periods suppress slots and revoked access is surfaced to the host. Provider remains undecided. |
| M08 | P0 | Invitee can cancel or reschedule using a scoped expiring capability; rescheduling protects the replacement interval atomically. |
| M09 | P0 | Hosts can list upcoming and canceled appointments only within their authorized workspace. |
| M10 | P1 | Offer calendar download and configurable reminders; cancellation and timezone handling remain consistent. |

## Shared platform requirements
- P01: one authenticated identity can belong to multiple workspaces. Every private read and write checks membership and resource ownership on the server.
- P02: select a workspace explicitly; a changed identifier never exposes another workspace's data.
- P03: verified payment webhook events update subscription state idempotently; individual plans grant one product, Suite grants all three.
- P04: define trial, payment failure, cancellation and downgrade behavior before activating billing.
- P05: keep provider secrets and refresh credentials on the server; use encrypted secret storage, least-privilege scopes and revocation.
- P06: support the three product subdomains with TLS and allowlisted navigation. Choose a secure cross-product sign-in design; do not assume browser local storage shares across subdomains.
- P07: shared account and billing screens use Schedora branding, while products retain their own identity.

## Forms first release
F01: save drafts with title and supported fields: short text, long text, email and single choice.
F02: publish a stable public form link, validate on the server and store submissions in the owning workspace.
F03: mark required fields clearly and show field-specific errors without deleting answers.
F04: authorized members can inspect and export responses under an agreed retention policy.
F05: emit a response-created event after persistence; no event should contain unnecessary personal information.
Later: conditional logic, file uploads, advanced themes and payment collection.

## Flow first release
W01: configure a Meet booking-created or Forms response-created trigger.
W02: offer one selected email provider action and an internal follow-up task action.
W03: support draft, enabled and paused states; previews never execute actions.
W04: record each run and action status with idempotency keys, bounded retries and actionable failure details.
W05: verify event source and workspace scope. Duplicate delivery must not duplicate side effects.
Later: visual branching, marketplace connectors and arbitrary code execution are outside the first release.

## Quality and safety acceptance
- Keyboard-complete workflows, semantic labels, visible focus and WCAG 2.2 AA as the design target; test manually and with automated tooling.
- No horizontal overflow at 320, 375, 768 and 1280 CSS pixels; test light/dark and reduced motion.
- Performance targets after deployment: p75 LCP <= 2.5 s, INP <= 200 ms and CLS <= 0.1; these are targets, not measured results.
- Server validation, request-body limits, abuse controls and durable conflict prevention before real submissions.
- HTTPS at deployment edge, trusted proxy configuration, no frontend secrets, dependency checks and tested backup/restore.
- Privacy notice must name the legal operator/contact and actual providers, purposes and retention. Current draft is demo-only.
- Consent rejection blocks optional analytics; withdrawal prevents future collection.
- Tests cover tenant isolation, duplicate requests, concurrent bookings, DST, provider failures and billing webhook replay.

## Delivery and release gates
The expanded execution plan, research workstream, affordability criteria and final sprint outcomes are in [Sprint roadmap](SPRINT_ROADMAP.md). Longer-term competitor parity does not expand the first-launch scope below without prioritization.
1. Foundation: consolidate UI modules/styles, approved logos and responsive product shells; verify browser execution.
2. Meet alpha: auth, database, availability, durable bookings and one calendar/email integration.
3. Meet launch: security/accessibility review, operator/legal details, staging end-to-end checks, billing rules and production monitoring.
4. Forms release: saved forms, submissions, authorization, retention and export.
5. Flow release: durable event delivery, idempotent actions, retries and run history.

No dates or effort estimates are committed.

## Deployment prerequisites and open decisions
Repository ownership and push access; deployment host/project; DNS access for schedora.in; selected database/auth/calendar/email/payment providers and credentials; operator name/contact/jurisdiction; pricing and tax treatment; cancellation and retention rules; analytics reporting needs. Supply credentials through environment/secret managers, never chat or browser code.

## Out of scope for first launch
Round-robin teams, paid appointments, native mobile applications, multi-language support, enterprise SSO and unrestricted automation integrations.

