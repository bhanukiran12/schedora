# Enquiry trail: backend contract (proposal)

Status: **partly implemented (28 October 2026).** `GET /api/workspaces/:ws/enquiries` now lists every form response and direct booking newest arrival first with keyset pagination (`created_at`, ties by id), so nothing falls outside a loading window. Each page includes every Flow run and task for its items, the stored offer `expires_at` and the server clock, and booking `created_at` gives direct bookings an authoritative arrival time. The `/enquiries` page loads 50 at a time with "Load older enquiries". Still not built: the stored projection, server-computed states and attention reasons, workspace-wide counts/filters before everything is loaded, ownership/resolve, reconciliation and the 10,000-row latency test. The next per-form history increment replaces the capped loaders with response-page-scoped follow-ups and stable timestamp/id response paging; see FORMS.md. Exact-commit PostgreSQL/Linux CI passed for a6d0fc8; the release checkpoint records deployment status. Tasks now have an optional deadline and assignee (Flow task action, or edited in Flow › Tasks): an open task before its deadline is `waiting`, after it `task_overdue`, and an open task without a deadline still counts as `task_open`. Enquiry-level ownership and resolve are not built. This document specifies what a workspace-wide, owned, reliable trail would need. Nothing here is promised to customers until it is built and verified.

## Why the current frontend trail is not enough

| Limit today | Consequence |
| --- | --- |
| Workspace Enquiries uses a keyset-paginated server feed with every follow-up for loaded items; the per-form history branch now uses the same scoped follow-up loader | Workspace history is reachable page by page, but counts describe loaded pages only; per-form history coverage has PostgreSQL/browser evidence; production/human validation and large-history latency remain separate |
| Linking a response to its booking goes through the booking reference from `next_step`, then a booking list lookup | Members who do not host the booking cannot see its follow-ups (shown as "not visible to your role") |
| Flow tasks have assignees, but an enquiry itself has no owner or resolve control | A task owner is visible; responsibility for an entire enquiry is not established |
| Attention rules are computed client-side | Rules can drift between screens; counts are not available to notifications or reports |
| Direct bookings and their follow-ups use server `created_at` and stable cursor pagination | Arrival ordering is implemented; workspace-wide attention sorting/counts and a 10,000-row latency result are still missing |

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

## Focused competitor check: ownership and next actions
Checked official pages on 27 October 2026; documentation evidence only, no hands-on competitor account test or customer study.

- [Jotform Inbox approval tracking](https://www.jotform.com/help/how-to-track-approval-process-in-jotform-inbox/) documents workflow-state filtering and saved filtered tabs, plus taking over/reassigning, canceling and restarting in-progress approvals. Article date: 22 October 2024; retrieved current page. This is evidence of the documented interaction model, not proof of customer success, current plan inclusion or latency.
- [Fillout approvals](https://www.fillout.com/blog/automate-job-applications/approvals) describes choosing approvers, task delegation, testing before publication and actions from Results. The retrieved page carries a Draft metadata marker and a 15 November 2024 update, so treat it as an older official description requiring a current help/account check before claiming present availability or plan coverage.

Decision implication (inference): a needs-attention list by itself is weak differentiation. Test whether a service operator can identify the correct next action and responsible person across a response, booking and follow-up, then recover when that person is unavailable. Schedora currently has a read-only cross-product trail but no assignment or explicit resolve control. Do not claim equivalent approval/reassignment behavior. Use the existing Enquiries permissions and source records as constraints before adding ownership; competitor feature existence does not prove Schedora customers need a full approvals engine.

Next comparison task: ask an operator to handle a consultation enquiry with a confirmed booking and a failed follow-up, then an unbooked enquiry with an expired offer. Measure correct next action, correct owner, mistaken completion and recovery steps. Compare appropriately configured alternatives rather than marketing screenshots. No participants contacted and no demand/conversion result inferred.
