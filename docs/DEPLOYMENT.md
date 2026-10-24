# Deployment: GitHub → Vercel (frontend) + Render (backend)

Updated 24 October 2026. Nothing below has been deployed yet; these are the steps and settings the repository is prepared for.

## Architecture

```
Browser ── https://schedora.in, meet./forms./flow.schedora.in ──▶ Vercel (frontend/, static)
                                     │  /api/* rewrite (same origin for the browser)
                                     ▼
                         Render web service (backend/, Node 24)
                         API + background worker + SQLite on a persistent disk
```

- **Vercel** serves `frontend/` as static files. `frontend/vercel.json` adds the SPA fallback, security headers and a rewrite that forwards `/api/*` to Render.
- **Render** runs `backend/` as one long-running web service: the HTTP API and the in-process worker (Flow runs, email delivery and retries, reminders, calendar sync, retention).
- Because the browser only ever talks to the Vercel domain, the session cookie is first-party, `SameSite=Lax` works, and no CORS is needed. The API checks the `Origin` header against an allowlist for every change.

## Repository layout

```
schedora/
├─ frontend/                 Vercel project root
│  ├─ index.html, app.js, app.css, js/*.mjs, shared/forms-logic.mjs (copy)
│  ├─ robots.txt, sitemap.xml, logos, favicon
│  └─ vercel.json
├─ backend/                  Render service root
│  ├─ server.mjs, src/, migrations/, scripts/, test/
│  ├─ src/shared/forms-logic.mjs (source of truth, also used by the browser)
│  └─ package.json, .env.example
├─ render.yaml               Render Blueprint
├─ .github/workflows/ci.yml  checks, tests, browser journeys
└─ docs/, *.md               product and operations documents
```

`forms-logic.mjs` runs on both sides so form validation and branching behave identically. Edit `backend/src/shared/forms-logic.mjs`, then run `npm run sync-shared` in `backend/`. CI and the Render build fail if the copies differ.

There are no npm dependencies. Node 24 provides HTTP, crypto, `fetch` and SQLite (`node:sqlite`).

## 1. GitHub

```sh
cd schedora
git init -b main
git add .
git commit -m "Schedora suite"
git remote add origin git@github.com:<owner>/schedora.git
git push -u origin main
```

Protect `main` and require the **Schedora checks** workflow before merging. CI runs the syntax check, the shared-module sync check, 32 API/integration tests and the headless-Chrome journey check on every push and pull request. Vercel and Render deploy through their own GitHub integrations, so the workflow needs no deploy secrets.

## 2. Render (backend)

### Free evaluation setup (current `render.yaml`)
`render.yaml` uses Render's **free** plan so the Blueprint can be applied without payment:
- No persistent disk: the SQLite database is erased on every deploy, restart and spin-down. Use it to test the deployment, not for real bookings or responses.
- The service sleeps after 15 idle minutes. The first request then takes up to about a minute, and the background worker (reminders, Flow retries, calendar sync) pauses while asleep.
- `BILLING_MODE=open` (all products available, nothing charged) and no `COOKIE_DOMAIN`, so sign-in works on the `*.vercel.app` address before `schedora.in` is connected.

To keep real data, either move to a paid plan and uncomment the `disk` block (set `DATABASE_PATH=/var/data/schedora.db`), or move the database to a free hosted one (Turso or Neon), which needs the async database change described in the project history. Before launch also set `BILLING_MODE=enforced`, `COOKIE_DOMAIN=.schedora.in` and `BASE_URL` to the live domain.

### Steps

1. Render dashboard → **New → Blueprint** → select the repository. Render reads `render.yaml` and creates `schedora-api`.
2. Enter the values marked `sync: false`:
   - `ALLOWED_ORIGINS`: your Vercel production domain, e.g. `https://schedora.vercel.app` (custom `schedora.in` domains are already allowed).
   - `OPERATOR_NAME`, `OPERATOR_CONTACT`, `OPERATOR_JURISDICTION`: shown on the privacy and terms pages. Required before any commercial use.
   - Email: set `EMAIL_PROVIDER=http`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN` once a provider is chosen. Until then the outbox provider records emails without sending them.
   - `BILLING_WEBHOOK_SECRET`: once a payment provider adapter exists.
3. After the first deploy, open `https://<service>.onrender.com/api/health`. It should return `"status":"ok"`.
4. Note the service URL. If it is not `https://schedora-api.onrender.com`, update the rewrite destination in `frontend/vercel.json` (step 3).

Important Render facts for the paid setup:
- **Persistent disk is required for real data.** SQLite lives at `/var/data/schedora.db` on the attached disk. Without it, every deploy or restart erases all data. Disks need a paid instance type (the Blueprint uses `starter`).
- **One instance only.** A service with a disk cannot scale horizontally, and deploys have a short gap while the old instance stops. The in-memory rate limiter also assumes one instance.
- **Do not use the free plan for real data.** Free services sleep when idle (the worker stops, so reminders and Flow retries pause) and have no disk.
- `render.yaml` uses region `singapore` and builds only when `backend/**` changes. Change either to suit you.
- To outgrow these limits, move to Render PostgreSQL. The schema in `backend/migrations/` is portable, but `src/db.mjs` would need a Postgres driver; that is a planned change, not done.

## 3. Vercel (frontend)

1. Vercel → **Add New → Project** → import the repository.
2. **Root Directory: `frontend`**. Framework preset: **Other**. Build command: none. Output directory: `.` (the default for a static project).
3. Confirm the `/api/:path*` destination in `frontend/vercel.json` points at your Render URL. Commit if you change it.
4. Deploy, then open the Vercel URL. The home page loads `/api/config` through the rewrite; if Render is unreachable, the page says so.

## 4. Domains

In Vercel → Project → Domains, add `schedora.in`, `meet.schedora.in`, `forms.schedora.in`, `flow.schedora.in` (and optionally `book.schedora.in`). Follow Vercel's DNS records at your registrar. Vercel issues TLS certificates automatically.

The frontend opens Meet, Forms or Flow at the root of each product subdomain. Sign-in is shared across them because Render sets the session cookie with `COOKIE_DOMAIN=.schedora.in`. Keep the API on Render's own domain; it only needs to be reachable by Vercel.

## Environment reference (backend)

| Variable | Production value | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | HTTPS redirect, secure cookies, enforced billing by default |
| `HOST` / `PORT` | `0.0.0.0` / set by Render | Listen address |
| `DATABASE_PATH` | `/var/data/schedora.db` | SQLite file on the persistent disk |
| `SERVE_FRONTEND` | `false` | API only; Vercel serves the web app |
| `TRUST_PROXY` / `TRUST_PROXY_HOPS` | `true` / `2` | Read client IP and protocol from Vercel + Render proxy headers |
| `BASE_URL` | `https://schedora.in` | Links in emails (manage/reschedule links) |
| `PRODUCT_DOMAIN` | `schedora.in` | Product subdomains and default allowed origins |
| `COOKIE_DOMAIN` | `.schedora.in` | Share sign-in across product subdomains |
| `ALLOWED_ORIGINS` | your Vercel domain(s) | Extra origins allowed to make changes; `*` matches one DNS label |
| `BILLING_MODE` | `enforced` | Only verified subscriptions grant access (`open` = evaluation) |
| `BILLING_PROVIDER` / `BILLING_WEBHOOK_SECRET` | `none` / provider secret | Test provider is disabled in production unless `ALLOW_TEST_BILLING=true` |
| `EMAIL_PROVIDER`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN`, `EMAIL_FROM` | provider values | Transactional email |
| `OPERATOR_NAME`, `OPERATOR_CONTACT`, `OPERATOR_JURISDICTION` | legal details | Shown in privacy notice and terms |
| `ANALYTICS_ENABLED` | `false` | Optional, consent-gated in-memory page counts |

The backend logs a `release_warning` at start-up for each missing item that blocks a commercial release.

## Preview deployments and staging

Vercel preview deployments also forward `/api` to the production Render service. Their `*.vercel.app` hosts cannot receive a cookie scoped to `.schedora.in`, so signing in on a preview does not work. Public booking and form pages do work.

Recommended staging setup: a second Render service (`schedora-api-staging`, its own disk, `BILLING_MODE=open`, `BILLING_PROVIDER=test`, no `COOKIE_DOMAIN`, `ALLOWED_ORIGINS=https://*-<team>.vercel.app`) and a `staging` branch whose `frontend/vercel.json` rewrites to it. Run the recovery drill in [OPERATIONS.md](OPERATIONS.md) on staging before launch.

## Local development

```sh
cd backend
cp .env.example .env    # optional; defaults work
npm start               # http://localhost:3000, serves ../frontend and the API together
npm test                # 32 API/integration tests
npm run browser-check   # headless Chrome journeys (set CHROME_PATH if not auto-detected)
```

Locally, billing is in evaluation mode, emails go to the outbox (Meet → Email delivery shows them), and the test payment provider is available on the Plans page.
