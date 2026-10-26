# Authorization matrix

Source of truth in code: `PERMISSIONS` in `backend/src/platform/workspaces.mjs`. Keep this table in sync with it.

Every private API route resolves the caller's membership of the workspace in the URL on the server. A non-member receives **404** (workspace ids cannot be probed); a member without the permission receives **403**. Resource ids are always matched together with the workspace id, so a valid id from another workspace is not found. Hidden navigation is never treated as authorization.

| Permission | Owner | Admin | Member | Notes |
| --- | :-: | :-: | :-: | --- |
| View workspace, members | ✓ | ✓ | ✓ | |
| Rename workspace, set retention | ✓ | ✓ | | |
| Delete workspace | ✓ | | | Requires typing the workspace name |
| Add/remove members | ✓ | ✓ | | Only owners add admins, change owner/admin roles or remove admins; at least one owner must remain |
| Leave a workspace | ✓ | ✓ | ✓ | The last owner cannot leave |
| View billing, usage | ✓ | ✓ | | |
| Change subscriptions | ✓ | | | |
| Manage own event types, bookings, calendar | ✓ | ✓ | ✓ | Members see only event types and bookings they host |
| Manage everyone's event types and bookings | ✓ | ✓ | | Including assigning another member as host |
| Create, edit, publish forms | ✓ | ✓ | ✓ | |
| View and export responses | ✓ | ✓ | ✓ | |
| Delete responses | ✓ | ✓ | | |
| View flows and run history | ✓ | ✓ | ✓ | |
| Create, edit, enable, pause, retry flows | ✓ | ✓ | | |
| View and complete tasks | ✓ | ✓ | ✓ | |
| View email delivery log | ✓ | ✓ | ✓ | |
| View and edit contacts, notes, follow-ups | ✓ | ✓ | ✓ | |
| Delete contacts | ✓ | ✓ | | |
| Team event types (collective, round robin), managed templates, assign templates | ✓ | ✓ | | Members edit their copies except locked fields |
| Workspace-wide workflows | ✓ | ✓ | | Members create workflows for event types they host |
| Polls, transcripts, recaps, AI chat and meeting prep | ✓ | ✓ | ✓ | Members see their own polls and meetings |
| Connect Stripe, webhooks, audit log | ✓ | ✓ | | |
| Connect own calendars and video apps, create own API keys | ✓ | ✓ | ✓ | API keys act with the creator's role in one workspace |
| Single sign-on settings | ✓ | | | |
| Start instant video meetings; join instant meetings of the workspace | ✓ | ✓ | ✓ | Video needs an active Meet or Suite entitlement; API keys cannot mint browser tokens |
| Host a scheduled video meeting (end for everyone, remove people, guest links) | ✓ | ✓ | ✓ | Members: only meetings they are an active booking host of, or instant rooms they created. Owners/admins: all |
| View Meet credits, ledger, usage, calculator | ✓ | ✓ | | |
| Buy Meet credits | ✓ | | | Server-owned package catalog; `Idempotency-Key` required |

## Public (no account)

| Action | Capability |
| --- | --- |
| View a booking page and its free times | Published event type, active Meet entitlement |
| Book | Same, plus an `Idempotency-Key` header and server-side revalidation of the slot |
| View, cancel, reschedule, download .ics | Manage token from the confirmation (stored only as a SHA-256 hash; expires when the appointment starts) |
| Join a Schedora Meet video meeting | Attendance link (`/meet/join/…`): separate from the manage token, one per booking (seats = invitee + guests) or a host-created guest link; only its SHA-256 is stored. Works from the join window to the room's end; stops on cancellation, rescheduling, host removal or meeting end. Shows no booking personal data |
| View and submit a form | Published form version, active Forms entitlement |
| Billing webhook | Valid HMAC signature within 5 minutes |

Rate limits (per client address, per minute): global 600, sign-in 10, sign-up 10 per hour, booking 20, manage 20–60, form submission 30, slot lookups 120.

Open questions for the owner before launch: whether members should see responses for forms they did not create, and whether admins may export all responses.
