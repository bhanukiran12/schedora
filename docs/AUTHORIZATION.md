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
| View and export responses | ✓ | ✓ | ✓ | Checked when the export runs; a removed member's next request fails |
| Delete responses | ✓ | ✓ | | Does not restore the monthly allowance or cancel a booking made from the response |
| View flows and run history | ✓ | ✓ | ✓ | |
| Create, edit, enable, pause, retry flows | ✓ | ✓ | | |
| Flow v1: build, publish, turn on, test, cancel and retry runs, set the incoming webhook address | ✓ | ✓ | | Members view workflows, runs and masked samples. API keys cannot test, rotate webhook secrets or decide approvals |
| Decide a Flow approval | ✓ | ✓ | Named approver only | The named member, the host or the contact’s owner; admins can always decide. One decision, against the latest revision |
| Run a Flow workflow on a sheet row | ✓ | ✓ | ✓ | Needs read access to that workbook; counts as one run |
| View and complete tasks | ✓ | ✓ | ✓ | |
| View email delivery log | ✓ | ✓ | ✓ | |
| View and edit contacts, notes, follow-ups | ✓ | ✓ | ✓ | |
| Delete contacts | ✓ | ✓ | | |
| Team event types (collective, round robin), managed templates, assign templates | ✓ | ✓ | | Members edit their copies except locked fields |
| Workspace-wide workflows | ✓ | ✓ | | Members create workflows for event types they host |
| Polls, transcripts, recaps, AI chat and meeting prep | ✓ | ✓ | ✓ | Members see their own polls and meetings |
| Draft, edit, review and send an AI meeting follow-up | ✓ | ✓ | ✓ | Only the author or an owner/admin can edit, send or discard a draft. Sending requires confirming the reviewed revision; API keys cannot draft or send |
| Set up, pause, resume or retry a form's Google Sheets sync | ✓ | ✓ | ✓ | Uses the member's own `google_sheets` connection (drive.file only). Stopping someone else's sync needs owner/admin. Viewing the sync status needs response access |
| Check a response's payment with Razorpay | ✓ | ✓ | ✓ | Response access; reads the provider, never marks a payment paid from the browser |
| Connect Stripe, webhooks, audit log | ✓ | ✓ | | |
| Connect own calendars and video apps, create own API keys | ✓ | ✓ | ✓ | API keys act with the creator's role in one workspace |
| View event host setup summaries | ✓ | ✓ | Own setup only | Must already be allowed to view the event. Other co-hosts are restricted for ordinary members; former-member setup is hidden for everyone. No calendar contents, accounts, tokens or private errors. API keys cannot use this browser-only endpoint |
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
| View and submit a form | Published form version, active Forms entitlement and remaining monthly response allowance. A respondent may submit the version they opened for 24 hours after it is replaced; a retry with the same submission id returns the original acceptance |
| Pay for a form response, check its payment | Private payment token from the receipt (HMAC of the response ID; only its SHA-256 is stored). Shows amount, state and deadline only. Status changes only after the server reads Razorpay |
| Stop WhatsApp messages | Private link in each receipt (only its SHA-256 is stored); withdraws that number from the workspace's WhatsApp messages |
| Razorpay and Twilio callbacks | Razorpay: HMAC of the raw body with the workspace webhook secret, then an API read. Twilio status and inbound: Twilio request signature for the exact configured URL and account |
| Continue from a form response to booking | Handoff token from the receipt (only its SHA-256 is stored; expires 2 hours after the response; one booking per response). Returns only the name, email and answers to the booking page's own questions; after booking, only that a booking exists |
| Billing webhook | Valid HMAC signature within 5 minutes |

Rate limits (per client address, per minute): global 600, sign-in 10, sign-up 10 per hour, booking 20, manage 20–60, form submission 30, slot lookups 120.

Open questions for the owner before launch: whether members should see responses for forms they did not create, and whether admins may export all responses.
