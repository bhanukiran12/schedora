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

## Public (no account)

| Action | Capability |
| --- | --- |
| View a booking page and its free times | Published event type, active Meet entitlement |
| Book | Same, plus an `Idempotency-Key` header and server-side revalidation of the slot |
| View, cancel, reschedule, download .ics | Manage token from the confirmation (stored only as a SHA-256 hash; expires when the appointment starts) |
| View and submit a form | Published form version, active Forms entitlement |
| Billing webhook | Valid HMAC signature within 5 minutes |

Rate limits (per client address, per minute): global 600, sign-in 10, sign-up 10 per hour, booking 20, manage 20–60, form submission 30, slot lookups 120.

Open questions for the owner before launch: whether members should see responses for forms they did not create, and whether admins may export all responses.
