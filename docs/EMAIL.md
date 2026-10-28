# Transactional email

Resend sender domain: `notify.schedora.in`. Its DKIM TXT and two sending CNAME records were added in GoDaddy and verified by Resend on 24 October 2026. Existing website and mailbox records were preserved. The root domain's DMARC policy applies to this subdomain.

Backend Render settings:

- `EMAIL_PROVIDER=http`
- `EMAIL_HTTP_URL=https://api.resend.com/emails`
- `EMAIL_FROM=Schedora <appointments@notify.schedora.in>`
- `EMAIL_HTTP_TOKEN`: private sending-only Resend API key restricted to the sending domain. Enter only in Render, never in frontend settings, Git, or chat.

Meet → Delivery → Check email delivery lets workspace owners/admins send one persisted test per inbox per clock hour. Choose the signed-in account address or the signed-in user's active Google connection. The endpoint accepts no arbitrary recipient. API keys cannot invoke it. Checks use the normal durable email queue and provider credentials, with the same retry behavior and delivery history as other emails.

## What each state proves

| Shown as | Evidence | What it does not prove |
| --- | --- | --- |
| Recorded in the local outbox | `EMAIL_PROVIDER=outbox` stored the message on this server | Nothing was sent |
| Accepted by the email provider | The provider's API accepted the message (`accepted_transport = http`) | That any mail server or inbox received it |
| Delivered to the recipient's mail server | A signed provider report (`email.delivered`) | Inbox vs spam placement, or that it was read |
| Delayed / Bounced / Spam report / Provider failed / Suppressed | The matching signed provider report | — (bounced, spam, failed and suppressed raise the `email_undelivered` operator alert and an enquiry attention reason) |

Messages sent before a state was recorded stay "not verified"; nothing is backfilled from today's configuration. Opens and clicks are never tracked.

## Delivery reports (Resend webhook)

1. In Resend → Webhooks, add the endpoint `https://schedora.in/api/email/events` with the events `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`.
2. Copy its signing secret (`whsec_…`) into Render as `EMAIL_WEBHOOK_SECRET`. Never paste it in Git or chat. An invalid value stops the server from starting.
3. Until the secret is set, the endpoint returns 404 and Meet → Delivery says reports are not connected.

Requests are verified with the Svix scheme (HMAC-SHA256 over id, timestamp and raw body; 5-minute timestamp tolerance; duplicate ids ignored). Only the event type and Resend email id are used; addresses and subjects in the payload are not stored. Event keys are deleted after 30 days. The payload fields read (`type`, `created_at`, `data.email_id`) follow Resend's documentation; the first real report confirms them.

## Controlled test to your own inbox (for manual validation)

1. Complete the webhook steps above.
2. Signed in as a workspace owner, open Meet → Delivery → Check email delivery and choose "My Schedora account email". The test only reaches your own signed-in address or your connected Google address, never a customer.
3. Expected: the toast says the provider accepted it; within minutes the row shows "Delivered to the recipient's mail server"; the message is in your inbox. Note whether it landed in spam.
4. Record the date, the row's state and inbox placement. Only then set `EMAIL_DOMAIN_VERIFIED=true`.

If the row stays at "Accepted … no delivery report yet" for more than 10 minutes, check the Resend webhook's delivery log for 401 (secret mismatch) or 404 (secret not set). This configuration alone does not prove Google event creation, booking lifecycle behavior, or timely reminders on a sleeping free server.

Official provider reference: https://resend.com/docs/api-reference/emails/send-email
