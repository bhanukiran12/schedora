# Schedora

Meet (scheduling), Forms (forms and intake) and Flow (automation) under one account and workspace. Make time for what matters.

## Documentation
- [Supabase persistent storage](docs/SUPABASE.md): DATABASE_URL now selects PostgreSQL through the session pooler.
- [Meet production release checklist](docs/MEET_RELEASE.md) · run `npm run production-check` in backend before release.
- [Product vision](VISION.md) · [Product requirements](PRD.md) · [Product design](PRODUCT_DESIGN.md) · [Brand](BRAND.md)
- [Sprint roadmap and implementation status](SPRINT_ROADMAP.md) · [Launch status](LAUNCH.md)
- [Deployment: GitHub → Vercel + Render](docs/DEPLOYMENT.md) · [Operations runbook](docs/OPERATIONS.md)
- [Authorization matrix](docs/AUTHORIZATION.md) · [Parity matrix](docs/PARITY_MATRIX.md) · [Pricing worksheet](docs/PRICING_WORKSHEET.md)

## Repository

| Path | Deployed to | Contents |
| --- | --- | --- |
| `frontend/` | Vercel (static) | Browser app: HTML shell, ES modules, styles, logos, `vercel.json` |
| `backend/` | Render (Node 24 web service) | API, background worker, SQLite migrations, tests, ops scripts |
| `render.yaml` | Render Blueprint | Service, persistent disk and environment definition |
| `.github/workflows/ci.yml` | GitHub Actions | Syntax check, shared-module check, tests, headless browser journeys |

One npm dependency, the official Anthropic SDK for the AI features; Node 24 supplies HTTP, crypto, fetch and SQLite. The REA research tool stays in the sibling `../rea` folder and is not part of this repository.

## Run locally

```sh
cd backend
npm install               # first time only
npm start                 # http://localhost:3000 (API + frontend), data in backend/data/
npm test                  # API and integration suite; see output for current count
npm run browser-check     # Chrome/Edge journeys at 320–1280 px, light and dark
npm run check             # syntax-check backend and frontend
```

Local defaults: evaluation billing (all products available, nothing charged), emails kept in the outbox and listed under Meet → Email delivery, and a test payment provider on the Plans page that sends signed events through the real webhook path.

## What works

- **Accounts and workspaces:** sign-up and sign-in with salted scrypt hashes and HttpOnly session cookies, CSRF tokens and origin checks, multiple workspaces per person, owner/admin/member roles, tenant isolation enforced on every request.
- **Meet:** one-on-one, group, collective and round-robin event types; one-off links and meeting polls; weekly hours, exceptions, date ranges, daily/weekly/monthly limits, buffers; DST-correct slots; conflict-safe booking for every host (database guard); invitee questions, location choices, guests and paid bookings; confirmations, reminders and email/SMS workflows; cancel and reschedule links; book on behalf; contacts with notes and follow-ups; routing forms with known-lead matching; managed event types; analytics; branded and embeddable booking pages; Google/Microsoft/Zoom calendars and video links; AI recaps, chat, meeting briefs and email scheduling (Meet Assist). Full list: [parity matrix](docs/PARITY_MATRIX.md).
- **Forms:** builder with live preview; short/long text, email, single/multiple choice, date and page breaks; conditional questions and pages; answer piping; draft and versioned publishing; classic and conversational presentation; server-side validation; response inbox; CSV export with spreadsheet-formula protection; iframe embedding.
- **Flow:** booking and response triggers; email and task actions with placeholders; draft, enabled and paused states; simulation; durable outbox; exactly-once side effects; retries with backoff; run history and manual retry.
- **Billing:** Meet, Forms, Flow and Suite plans; signed, replay-safe webhooks; entitlements, grace period, cancellation and downgrade; monthly usage metering and quotas. No prices are shown until approved.
- **Platform:** signed webhooks, REST API keys, MCP server for AI assistants, OpenID Connect SSO, audit log, installable web app, browser extension (`extensions/browser`). See [API.md](docs/API.md).
- **Operations:** health endpoint, structured logs, retention, account and workspace deletion, backup and restore scripts.

## Not done yet (needs owner decisions, accounts or real-world work)

Customer interviews and pricing approval; live provider accounts (email, Stripe, Twilio, Google/Microsoft/Zoom OAuth apps, Anthropic API key, inbound email for Meet Assist); a persistent database for production; legal operator details; external monitoring and off-site backups; a recorded restore drill on real infrastructure; formal accessibility and security reviews; load testing; the controlled beta. See [SPRINT_ROADMAP.md](SPRINT_ROADMAP.md#implementation-status) for the per-sprint status.
