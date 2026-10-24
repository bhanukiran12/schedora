# Launch status
Updated 24 October 2026. The product runs end to end locally. It has not been deployed and must not take real customer bookings or payments until the blockers below are cleared.

## Ready
- Deployment configuration for Vercel (`frontend/vercel.json`) and Render (`render.yaml`); steps in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- HTTPS redirect and HSTS in production (`NODE_ENV=production`, `TRUST_PROXY=true` behind Render). TLS certificates are issued by Vercel for the custom domains.
- Security headers: CSP with no inline scripts or styles, `frame-ancestors 'none'` except published forms, nosniff, referrer and permissions policies.
- Session cookies: HttpOnly, Secure, SameSite=Lax; CSRF token and origin allowlist on every change.
- Rate limits per client address (global and per action), request-size limits, honeypot fields, server-side validation of every booking and response.
- Consent banner with accept/reject and a permanent settings link; Global Privacy Control respected; analytics optional and off by default.
- Retention, workspace and account deletion, backup and restore scripts, health endpoint, structured logs.

## Blockers before commercial release
1. Legal operator name, privacy contact and jurisdiction (`OPERATOR_*`); final privacy notice and terms reviewed by counsel.
2. Email provider connected and sender domain verified (SPF, DKIM, DMARC).
3. Payment provider adapter, approved prices and tax handling ([pricing worksheet](docs/PRICING_WORKSHEET.md)).
4. Render persistent disk, off-site backups and a recorded restore drill ([operations](docs/OPERATIONS.md)).
5. External uptime monitoring and alerting.
6. Formal accessibility audit (keyboard, screen reader, zoom) and security review.
7. Load test of booking and form submission at expected peak.
8. Controlled beta with real users.

Release warnings for items 1–3 are logged each time the backend starts.
