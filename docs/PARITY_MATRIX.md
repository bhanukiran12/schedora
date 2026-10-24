# Functional parity matrix

Updated 24 October 2026. Status values follow the roadmap: **observed** (seen in a competitor's public documentation), **specified** (written Schedora requirement), **implemented** (code exists), **tested** (automated tests cover it), **deferred**.

Evidence base: official public documentation and pricing pages only. No competitor account, private API or runtime was inspected. An observed competitor capability is not a Schedora feature until it is implemented and tested. Schedora's code, text and interface are original.

## Meet (scheduling)

| Capability | Schedora status | Where |
| --- | --- | --- |
| Event types with title, duration, location, description, publish switch | tested | `meet.test.mjs` |
| Weekly hours, date exceptions, host time zone | tested | `time-availability.test.mjs` |
| Minimum notice, booking horizon, buffers, start-time interval | tested | `time-availability.test.mjs` |
| DST-correct slots and confirmation in invitee time zone | tested | `time-availability.test.mjs`, `meet.test.mjs` |
| Conflict-safe booking under concurrency; idempotent retries | tested | `meet.test.mjs` |
| Confirmation, host notification, .ics attachment and download | tested | `meet.test.mjs` |
| Invitee cancel and reschedule via expiring link | tested | `meet.test.mjs` |
| Reminder emails | tested | `meet.test.mjs` |
| Calendar busy sync | tested for iCalendar feeds | `meet.test.mjs`; Google/Microsoft OAuth APIs deferred |
| Writing bookings into the host's calendar | deferred | Needs OAuth provider; invitees and hosts receive .ics files instead |
| Video-conference link generation | deferred | Location field accepts any link |
| Booking page branding | specified | Product branding only; per-workspace themes deferred |
| Embedding the booking page | deferred | Forms embedding is implemented first |
| Intake questions on booking | specified | Notes field implemented; linking a Forms form is planned |
| Team scheduling, round robin, collective events | deferred | After first launch |
| Paid appointments | deferred | Out of first-launch scope |
| Routing forms | deferred | |

## Forms

| Capability | Schedora status | Where |
| --- | --- | --- |
| Short text, long text, email, single and multiple choice, date | tested | `forms.test.mjs` |
| Classic (paged) and conversational (one question at a time) presentation | tested | `browser-check.mjs` |
| Multi-page forms, conditional questions and pages | tested | `forms.test.mjs`, `browser-check.mjs` |
| Answer piping into later questions | tested | `forms.test.mjs`, `browser-check.mjs` |
| Draft and published versions | tested | `forms.test.mjs` |
| Response inbox, deletion, CSV export with formula protection | tested | `forms.test.mjs` |
| Embed on another site (iframe) | implemented | `frame-ancestors` allowed only on `/f/*` |
| File uploads, calculated fields, scoring, payments | deferred | Post-launch prioritization |
| Custom themes, custom domains | deferred | |
| Partial (unsubmitted) response capture | deferred | Privacy decision needed |
| Spreadsheet/CRM integrations | deferred | Flow connector catalog |

## Flow and platform

| Capability | Schedora status | Where |
| --- | --- | --- |
| Booking-created and response-created triggers, optional source filter | tested | `flow.test.mjs` |
| Email and follow-up task actions with placeholders | tested | `flow.test.mjs` |
| Draft, enabled, paused; simulation without side effects | tested | `flow.test.mjs` |
| Run history, retries with backoff, manual retry, exactly-once side effects | tested | `flow.test.mjs` |
| Multi-step flows, branching, third-party connectors, webhooks out | deferred | |
| Accounts, workspaces, roles, tenant isolation | tested | `platform.test.mjs` |
| Individual plans and Suite, verified webhooks, grace, cancellation, quotas | tested | `billing.test.mjs` (test provider; real provider deferred) |
| Enterprise SSO, audit log export | deferred | |

## Not yet researched

Exact free-tier limits, current plan prices and feature gating of Calendly, Typeform and Fillout must be captured with dated snapshots in [PRICING_WORKSHEET.md](PRICING_WORKSHEET.md) before any price or savings claim.
