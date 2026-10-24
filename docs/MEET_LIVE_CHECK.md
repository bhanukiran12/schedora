# Meet live provider check — 24 October 2026

Environment: schedora.in, Vercel frontend, Render backend, Supabase PostgreSQL, Google Calendar/Meet, Resend. Original build: d4e69ee. Times below are IST (Asia/Calcutta).

## Verified through the live browser

- Published a hidden, clearly labelled 15-minute release-check event with automatic Google Meet links.
- Booked 18:35–18:50. Schedora saved the appointment; Google Calendar showed one matching event and a working-format Meet conference link. The booked slot disappeared from public availability.
- Resend confirmed invitee confirmation delivery. Its message contained the correct time, Meet link, rescheduling/cancellation link, and invite.ics attachment. Provider message: 01a16dc9-d39d-75be-80f2-8ffe3fe690c1.
- The scheduled one-hour reminder was sent at 17:35 and marked Delivered by Resend. Provider message: 01a16dcc-d01e-759f-afdd-044e0295b156. The backend was awake during this check; this does not validate reminders after free-tier sleep.
- Rescheduled through the invitee UI to 13:35 UTC, equivalent to 19:05 IST. Google Calendar showed one replacement event at 13:35 UTC; Schedora displayed the invitee's UTC timezone. Rescheduled confirmation was Delivered. Provider message: 01a16dcd-c25a-7d15-bd84-373ce9e9b983.
- Canceled the replacement appointment. Schedora showed canceled status, withdrew its pending reminder, and Google Calendar search returned no matching events. The cancellation email was Delivered. Provider message: 01a16dce-f46e-773b-a8e2-5c4ffb4337dd.
- A conflict refresh released both original and replacement slots. The test booking link was disabled afterward; canceled records remain as test history.

## Defect found and correction

Calendar free/busy snapshots could keep a removed appointment blocked until the normal 15-minute refresh. Successful calendar event creation/deletion now marks that host's OAuth calendar snapshots due for refresh in the same worker pass. Regression coverage simulates the provider returning its own newly created event, then verifies cancellation removes the cached block and releases the slot without advancing the clock.

Validation: 66 automated tests passed, one opt-in PostgreSQL suite skipped; syntax checks passed for 76 files. The skipped suite requires separately supplied current database credentials. No rotated or stale credential was reused.

## Remaining release limits

- Provider Delivered means the receiving mail server accepted the invitee messages; inbox placement/read status was not inspected. Host notifications reached provider Sent status but were not confirmed Delivered. Use a verified, monitored host account address before onboarding customers.
- This was a single-owner, single-invitee live check. Live concurrency, calendar revocation/reconnection and multi-tenant load were not exercised; automated tests cover their relevant application behavior.
- Always-on hosting, off-site backup/restore evidence, operational alerts, legal operator details, and real commercial billing remain launch requirements. Do not enable readiness attestations simply because this check passed.
