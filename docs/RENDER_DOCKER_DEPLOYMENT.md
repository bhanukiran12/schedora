# Render Docker deployment

This is the proposed single-host deployment: Render builds one Docker image containing the Schedora frontend and Node API. The API serves the web pages and `/api` from the same service, so the browser does not pass through Vercel. Product subdomains can point to this Render web service after its custom domains and TLS are configured.

This repository change prepares the application and Blueprint. It does not create Render resources, move a database, load dashboard secrets, change DNS, or deploy. Keep `RELEASE_MODE=evaluation` until every production gate below has evidence.

## What is prepared

- Root `Dockerfile` builds from the repository root, installs the backend's locked runtime dependencies, and copies both `backend/` and `frontend/` into one image.
- `render.yaml` uses the Docker runtime, serves the frontend from `/app/frontend`, and configures the one-hop Render proxy.
- The service's health check remains `/api/health`.
- `DATABASE_URL` remains a private dashboard setting. No database credentials or local data are included in the image.

## Before creating the production service

1. In Render, choose a paid, always-on web service plan. The Blueprint currently says `free` and `evaluation`; the free plan is not suitable for customer data or background reminders.
2. Create a separate Render PostgreSQL database in the same region. Use its **internal** connection string for the service's `DATABASE_URL`. Do not point this at the local SQLite file or copy production credentials into a test service.
3. Before moving any existing records, take a verified backup and rehearse restoring it into a separate database. This code change does not migrate SQLite records into PostgreSQL.
4. Set the service's custom domains to the Schedora product domains; check DNS and TLS in Render. Then set `BASE_URL`, `PRODUCT_DOMAIN`, and `COOKIE_DOMAIN=.schedora.in` to match the final domains.
5. Load secrets only in Render's environment settings. Keep the generated `APP_ENCRYPTION_KEY` stable across deploys and keep a protected recovery copy.
6. Restrict `ALLOWED_ORIGINS` to the exact owned production domains. With one host, `TRUST_PROXY_HOPS=1` is configured.

## Production release gates

The service must keep `RELEASE_MODE=evaluation` until all of these are complete. Then set it to `production`; startup will refuse to run if the checks fail.

- **Durable data:** `DATABASE_URL` points to the intended paid Render PostgreSQL database. Set `PERSISTENT_STORAGE_CONFIRMED=true` only after restart/deploy persistence is verified.
- **Recovery:** configure scheduled off-site backups, retention and access controls; restore a backup in an isolated database and record the result. Then set `BACKUPS_CONFIRMED=true`. Render's same-provider snapshots alone are not the off-site copy.
- **Email:** choose and configure an HTTPS transactional email provider, verify sender SPF/DKIM/DMARC, and confirm real booking, cancellation, reminder and retry delivery.
- **Billing:** configure live Razorpay credentials, webhook secret and approved plan IDs; turn off test payments; verify checkout, renewal, failed payment, cancellation and entitlement changes. Set enforced billing only after that.
- **Calendar and booking:** configure the Google OAuth client and callbacks; test connect, availability, booking, reschedule and cancellation with real test accounts.
- **Legal and support:** fill the operator name, contact and jurisdiction; review the privacy and terms pages, data retention, backup retention and support process.
- **Security:** confirm stable encryption key, restricted origins, cookie/domain behavior, least-privilege dashboard access, and review the production logs for startup warnings. Complete an external security review and accessibility review appropriate to the launch.
- **Monitoring:** configure external uptime checks and an alert channel, send a test alert, and confirm the service can be recovered. Then set `MONITORING_CONFIRMED=true`.
- **Release evidence:** run the PostgreSQL migration/upgrade checks on a disposable database, complete end-to-end browser checks on staging, record a rollback/recovery rehearsal, and run `npm run production-check` against the actual intended production environment without exposing its values.

The current `production-check` also requires commercial billing, real Google configuration and provider smoke evidence because this repository contains the full Schedora suite. A passing local test suite is not a substitute for those provider and hosting checks.

## Environment values to load in Render

The Blueprint lists many values, but `sync: false` means the value is supplied in the dashboard and is not verified by the repository. At minimum, review these groups against [Meet release checklist](MEET_RELEASE.md):

- Database: `DATABASE_URL`, `PERSISTENT_STORAGE_CONFIRMED`, `BACKUPS_CONFIRMED`.
- Identity/security: stable `APP_ENCRYPTION_KEY`, `ALLOWED_ORIGINS`, final domain and cookie settings.
- Email and legal: `EMAIL_PROVIDER`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN`, `EMAIL_FROM`, sender-verification confirmation, and operator details.
- Billing: `BILLING_MODE`, `BILLING_PROVIDER`, live Razorpay credentials, webhook secret, approved plan IDs, and confirmation flags.
- Calendar, monitoring and recovery confirmation flags listed in the release checklist.
- Respondent sign-in and native video remain disabled until their own provider and rollback gates pass.

Do not paste secret values into chat, commit them, or add them to the Docker image.

## Validation before the first deployment

1. Build the Docker image locally and start it with disposable PostgreSQL and evaluation settings.
2. Check `/api/health`, sign-in, the Meet overview, booking pages, Forms, Flow, privacy/terms and static assets through the same Render host.
3. Test the production domain and secure cookies after DNS/TLS are configured.
4. Run the complete CI and browser suite on the exact commit intended for deployment.
5. Take a pre-deploy backup and have the rollback revision and restore procedure ready.

The deployment is **not ready for production** until all release gates pass and the actual Render settings have been verified.
