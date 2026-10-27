# Enquiry trail: backend contract (proposal)

Status: **proposal, not implemented.** Slice 3 of the [implementation log](RESEARCH_IMPLEMENTATION.md) ships a per-form trail built in the browser from existing APIs. This document specifies what a workspace-wide, owned, reliable trail would need. Nothing here is promised to customers until it is built and verified.

## Why the current frontend trail is not enough

| Limit today | Consequence |
| --- | --- |
| Built per form, in the browser, from `GET /runs` and `GET /tasks` (latest 200 each) plus three `GET /bookings` scopes | Older follow-ups fall out of view; there is no workspace-wide "needs attention" queue across forms |
| Linking a response to its booking goes through the booking reference from `next_step`, then a booking list lookup | Members who do not host the booking cannot see its follow-ups (shown as "not visible to your role") |
| No owner or assignment | "Needs attention" cannot say who should act |
| Attention rules are computed client-side | Rules can drift between screens; counts are not available to notifications or reports |
| Bookings made directly (not through a form) and their runs are not enquiries | A consultant using only Meet + Flow has no trail view |

## Data and state model

- **Enquiry:** one per accepted response, or per booking without a response.
  - **Fields:** `id`, `workspace_id`, `origin` (`response` or `booking`), `response_id?`, `booking_id?` (latest, following reschedules), `owner_id?`, `state`, `attention_reasons[]`, `opened_at`, `resolved_at?`, `updated_at`.
  - **Creation:** written in the same transaction as the response or booking.
  - **Updates:** applied from the existing outbox events plus booking, handoff, run and task changes.
- **States:** `open` → `waiting` (booking offered or held, follow-up queued) → `needs_attention` → `resolved`. `resolved` is set by a person (with an optional note), or automatically when every follow-up is done and the booking is confirmed or explicitly not required.
- **Attention reasons** (closed list, computed on the server):
  - `booking_unavailable`
  - `booking_canceled`
  - `followup_failed`
  - `followup_retrying` (over a threshold)
  - `task_open` (past a due time once tasks have due dates)
  - `offer_unanswered` (the booking offer expired without a booking)
- **Activity log:** append-only rows (`enquiry_id`, `kind`, `ref_id`, `status`, `at`) for received, offered, booked, canceled, run started/succeeded/failed, task created/done, and owner changed. No answers, contact details or message bodies.

## API (workspace-scoped, existing auth and CSRF)

- `GET /api/workspaces/:ws/enquiries?state=&reason=&owner=&form=&before=&limit=` returns `{ items: [{ id, origin, state, attention_reasons, owner, opened_at, response: { id, form_id, reference }, booking: { id, reference, status, starts_at }?, followups: [{ run_id, flow_name, status, outcome, task: { id, status }? }] }], next }`
- `GET /api/workspaces/:ws/enquiries/:id` returns the same item plus the activity log.
- `PATCH /api/workspaces/:ws/enquiries/:id` with `{ owner_id?, state: 'resolved'|'open', note? }`. Idempotent; it carries a revision, and a stale revision returns 409.
- `GET /api/workspaces/:ws/enquiries/summary` returns counts by state and reason, for navigation badges.

## Permissions

- **Members:** see enquiries for forms they can read. Booking details follow the existing Meet host scoping: a member who does not host the booking sees its status but not invitee details.
- **Owners and admins:** see all enquiries and may reassign or resolve any of them.
- **Members:** may resolve or take ownership of enquiries they can see (to be confirmed with the owner).
- **API keys:** act with their creator's role.
- **Cross-workspace ids:** return 404.

## Validation and failure handling

- `owner_id` must be a current workspace member.
- Resolving requires an explicit action and is never inferred from page views.
- **Projection updates** are idempotent per source event id (reuse the outbox and run ids). Duplicate events must not duplicate activity rows.
- **Reconciliation:** a periodic job recomputes state from the source records (responses, handoffs, bookings, runs, tasks), records drift, and fixes it. The projection never becomes the source of truth for bookings or runs.
- **Deletion and retention:** deleting a response deletes its enquiry. Booking anonymisation keeps the status but drops personal fields. Retention follows the workspace setting.
- **Partial outages:** if run or task data cannot be read, the API returns `followups_available: false` rather than an empty list.

## Acceptance tests

1. A response with routing to a booking creates an enquiry in `waiting`; booking it records the booking and leaves the enquiry open until its follow-ups finish.
2. A failed flow run adds `followup_failed` within one worker pass; a successful manual retry removes it.
3. An open task keeps `task_open`; completing it clears the reason.
4. Rescheduling follows `rescheduled_to`; canceling adds `booking_canceled`.
5. Duplicate outbox delivery produces exactly one activity row per source event.
6. **Permissions:** a member who does not host the booking cannot read invitee details through enquiries; a cross-workspace id returns 404.
7. Reconciliation repairs a projection row that was edited directly to a wrong state.
8. **Load:** 10,000 enquiries list under the agreed latency budget, with stable pagination.

## Operational dependencies

- **Migration:** a new migration with PostgreSQL support (follow the existing upgrade-step pattern), plus a backfill from existing responses and bookings.
- **Worker:** worker time for projection updates and reconciliation.
- **Monitoring:** reconciliation drift and failed projection updates.
- **Privacy:** activity rows must contain no answer text, contact details or message bodies, consistent with the analytics rules in the [UX research plan](UX_RESEARCH_PLAN.md).
- **Research gate:** confirm that operators find the queue faster or more accurate than their current tools in moderated sessions before building notifications or reports on top of it.
