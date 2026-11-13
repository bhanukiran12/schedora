# Meet production readiness plan

**Purpose:** organize the remaining work to take Meet from the current local product to a deliberate production release.  
**Order:** product design and usability → feature behavior → pricing → production operations → future roadmap.  
**Status date:** 11 November 2026. The working tree has uncommitted UI and product changes; this plan does not claim that any release gate has passed.

## Release principle

Do not move to the next stage because a screen merely exists. Each stage needs reviewable evidence against its exit criteria. Keep local, staging and production results separate. Production release applies only to the exact revision that has passed the agreed checks.

## Stage 1 — Product design and usability

**Current focus.** Reduce the effort required to create and manage a meeting. Keep one clear primary action, plain labels, short forms, progressive disclosure and consistent responsive behavior. Use original Schedora design, informed by familiar patterns and customer feedback.

### Screens in scope

- Meet event types: list, create, edit, publish status and share link.
- Event setup: meeting type, essential details, saved working hours, optional limits/reminders, invitee questions, payments, confirmation and visibility.
- Meet overview, bookings, availability, polls and instant meeting room.
- Contacts, reminders, analytics, Notes & AI, connections, email delivery and guided setup.
- Shared account, workspace, subscription, usage and Meet credits.
- Public booking, confirmation, cancel/reschedule, poll and join flows.

### Design acceptance

- A first-time host can create a basic one-on-one booking link using the workspace's saved working hours without re-entering a weekly schedule.
- Event-specific hours are a clear override. Optional settings are presented as a compact, icon-led options grid, not a long vertical list.
- Expanding an option with its plus control keeps it inside its own grid column; it must not stretch across the full row or viewport. Verify Availability, Limits and reminders, Invitee questions, Payment, After booking, Link visibility and Team template at desktop and phone widths.
- Event URL fields and availability time ranges have bounded widths and enough spacing; adjacent inputs must not touch or overlap.
- Poll creation explains that invitees select the times they can attend, places meeting details beside candidate times on desktop, and reflows to one column on phones.
- Subscription rows summarize product, renewal and status without tall nested cards. The profile control opens account, setup and billing links; Connections and Email delivery stay in product navigation.
- Payment setup is hidden until an admin chooses to configure it; provider credentials are shown only after the provider is selected.
- “Connections” is one navigation destination. Do not show two labels that open the same page.
- Event type labels explain who meets whom and how a team booking is assigned, in customer language.
- Remove redundant actions, repeated setup links and visual boxes that do not help users distinguish tasks.
- Typography, spacing, borders and icons are consistent across Meet; status states are readable without relying on color alone.
- Important tasks work at phone, tablet and desktop widths, with keyboard navigation and visible focus.
- Empty, loading, error, permission-denied, disconnected, draft and published states explain what happened and the next useful action.

### Evidence to collect

- Route-by-route design review with screenshots at desktop and phone widths.
- Task walkthrough: create a basic event, publish, book it as an invitee, then cancel or reschedule.
- Keyboard-only pass and screen-reader spot checks for the event editor and booking flow.
- Defect list with severity, route, steps, expected behavior and screenshot.

## Stage 2 — Feature and workflow correctness

After the design is reviewed, confirm each feature still behaves correctly through both the interface and server. Do not treat a visual preview or simulated provider response as a live integration.

### Meet functional checks

- Event types: one-on-one, group, collective and round robin; host selection and assignment rules; drafts and publishing.
- Availability: personal working hours, event overrides, time zones, date exceptions, booking limits, buffers, minimum notice and booking horizon.
- Booking integrity: one successful booking for a contested slot, correct invitee/host details, idempotent retries and no cross-workspace access.
- Lifecycle: confirmation, reminders, calendar event, cancel, reschedule, payment, join link and ended/closed states.
- Connected providers: calendar busy-time sync, provider revocation and errors; video link generation; payment webhooks and reconciliation.
- Contacts, enquiries, polls, analytics, notes/AI and follow-up actions show accurate status and enforce role access.
- Meet video: host/guest controls, join readiness, media permissions, reconnect, participant/session controls and safe room termination.

### Shared product checks

- Authentication, workspace switching, roles, tenant isolation and session expiry.
- Email delivery distinguishes queued, accepted, delivered, bounced and failed where provider evidence exists.
- Billing entitlements agree with the selected subscription; payment webhook replay cannot duplicate a charge or entitlement change.
- Reload, browser back/forward, phone layouts, offline/network errors and recovery preserve user input where appropriate.

### Evidence to collect

- Automated CI and browser journey results for the exact candidate revision.
- A role-based acceptance report using synthetic data in isolated staging.
- Provider evidence from approved sandbox/test accounts; label anything simulated.
- Open defects triaged as release-blocking, follow-up or accepted limitation by the product owner.

## Stage 3 — Pricing and commercial model

Review the customer price against actual hosting, database, email, video, payment processing, taxes, support and expected usage. Model low, expected and high usage, including heavy video usage. Confirm the credit conversion and what happens when credits run out before taking live payment.

Monthly plan prices and a 12% annual discount are owner-approved. The owner also approved 100 included video credits per month for both Meet and Suite, with additional credits purchased separately at the approved rate. Annual checkout and video recharge remain unavailable until the payment catalog and release gates are ready. Keep customer-facing credit explanations plain and distinguish included monthly credits from purchased credits.

### Pricing acceptance

- Owner-approved prices, billing interval, currency, tax treatment, renewal, failed-payment grace, cancellation and refund behavior.
- Meet credit grant, usage calculation, reservation, expiry and top-up behavior reconcile with provider usage and ledger records.
- Pricing page, checkout, invoices/receipts and support copy agree.
- Live Razorpay plan IDs and webhook lifecycle are verified in a controlled staging account before production activation.
- No test provider, sandbox key or test checkout is reachable as a live customer payment path.

Source documents: [Pricing proposal](PRICING_PROPOSAL.md), [pricing worksheet](PRICING_WORKSHEET.md), [video credit pricing](VIDEO_RECHARGE_PRICING.md), [Razorpay subscriptions](RAZORPAY_SUBSCRIPTIONS.md).

## Stage 4 — Production operations and release

The local app or a green CI run is not enough to approve production. Use the [Meet release checklist](MEET_RELEASE.md), [Release acceptance](RELEASE_ACCEPTANCE.md), [Deployment](DEPLOYMENT.md) and [Operations](OPERATIONS.md) as operational source documents.

### Required release evidence

- Staging uses a disposable database and separate OAuth, email, video, SSO and payment test configuration.
- Real staging lifecycle passes for booking, calendar sync, email delivery, video join, payment test events and recovery from provider failures.
- Database snapshot is taken and restored to an isolated environment; backup encryption and key recovery are documented.
- Production secrets are stored in the hosting secret manager, separated by environment, and never copied into code, screenshots or chat.
- Migration and rollback are rehearsed. Compatibility with older frontend tabs and backend versions is understood.
- HTTPS/domain routing, session/CSRF protections, authorization boundaries, rate limits, data retention and deletion are reviewed.
- Accessibility review, privacy/legal details, incident contacts, external monitoring and actionable alerts are ready.
- Production checks and CI pass on the exact release revision; rollout order, owner and rollback trigger are recorded.
- Production smoke test uses an approved workspace and synthetic data. No destructive customer action is used as a smoke test.

### Release decision record

Record the candidate revision, approver, staging evidence, unresolved risks, backup reference, rollout time, monitoring owner and rollback decision. If any required gate is blocked, state the blocker and keep the release decision open rather than implying readiness.

## Stage 5 — Future product direction

Meet's longer-term vision should be prioritized from customer evidence after core reliability and launch. Candidate directions from existing product capabilities include:

1. Improve team scheduling and round-robin clarity using observed setup and booking completion data.
2. Expand calendar and video provider coverage only where customer demand and provider support are verified.
3. Make booking-to-Forms-to-Flow handoffs easier to configure and explain, while preserving workspace permissions and data minimization.
4. Improve analytics around booking completion, cancellations, rescheduling, host load and follow-up outcomes, with clear definitions and privacy controls.
5. Improve self-serve onboarding, help and recovery for disconnected providers, failed emails, missed reminders and payment issues.
6. Validate demand for larger-team administration, audit controls and service-level needs before calling the product enterprise-ready.

These are candidates, not commitments. Prioritize them using interviews, observed task failures, support requests, product usage and operating cost. Do not invent customer quotes, adoption numbers or revenue forecasts.

## Current progress and next checkpoint

- **Design work:** in progress in the local working tree. The current pass simplifies event setup and list language, uses saved hours by default, consolidates Connections, reveals payment-provider setup only when requested, reduces card-heavy layouts, and adds quick reporting periods to Analytics. The latest visual changes have not yet had a human screenshot review.
- **Feature audit:** not complete for a production release. Local syntax checks do not replace the full browser, database, provider and staging evidence.
- **Pricing:** the local plan catalog and future monthly grants reflect the approved 100-credit allowance for Meet and Suite. Live billing configuration and the payment catalog still need verification before release.
- **Production:** not approved by this document. Staging, provider, backup/restore, legal, monitoring, accessibility and exact-revision gates must be checked against current evidence.
- **Next checkpoint:** review the event-type list/editor, poll creation, profile menu, subscription rows and Analytics at desktop and phone widths. Specifically confirm expanded event options remain in their own grid column, inputs do not touch, and the poll form adapts cleanly on phones. Then continue the same design pass through the remaining Meet routes; after design acceptance, begin the functional release audit. No test suite or production deployment is claimed for this local checkpoint.

## Working cadence

1. State the current checkpoint and the reason for it.
2. Make a small, reviewable change that preserves existing behavior unless a product decision requires changing it.
3. Report what changed, what was checked, what was not checked and the next checkpoint.
4. Do not claim complete, production-ready or deployed without evidence from the corresponding environment.
