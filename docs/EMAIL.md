# Transactional email

Resend sender domain: `notify.schedora.in`. Its DKIM TXT and two sending CNAME records were added in GoDaddy and verified by Resend on 24 October 2026. Existing website and mailbox records were preserved. The root domain's DMARC policy applies to this subdomain.

Backend Render settings:

- `EMAIL_PROVIDER=http`
- `EMAIL_HTTP_URL=https://api.resend.com/emails`
- `EMAIL_FROM=Schedora <appointments@notify.schedora.in>`
- `EMAIL_HTTP_TOKEN`: private sending-only Resend API key restricted to the sending domain. Enter only in Render, never in frontend settings, Git, or chat.

Meet → Delivery → Check email delivery lets workspace owners/admins send one persisted test per inbox per clock hour. Choose the signed-in account address or the signed-in user's active Google connection. The endpoint accepts no arbitrary recipient. API keys cannot invoke it. Checks use the normal durable email queue and provider credentials, with the same retry behavior and delivery history as other emails.

`sent` means the provider accepted the message; inspect Resend's delivery event and the receiving inbox to confirm delivery. Leave `EMAIL_DOMAIN_VERIFIED=false` until the inbox check succeeds. This configuration alone does not prove Google event creation, booking lifecycle behavior, or timely reminders on a sleeping free server.

Official provider reference: https://resend.com/docs/api-reference/emails/send-email
